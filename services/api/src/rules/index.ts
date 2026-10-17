// The store's security rules: a line-for-line port of the old
// firestore.rules (kept in git history; its long comments explain the WHY
// of each rule and still apply). Same decisions, same field allow-lists,
// same caps (8 checkout lines, 6 variants x 6 sizes on legacy array-shaped
// products) — only the syntax changed. Anything not matched here is denied.
//
// Conventions: `after` = request.resource.data, `before` = resource.data,
// `uid` = request.auth.uid. Documents are strict() (a missing field
// throws -> denied); optional fields are read with getOr(), as the rules
// did with .get(field, default).
import {
  affectedKeys,
  any,
  eq,
  getOr,
  has,
  hasOnly,
  inList,
  isBool,
  isInt,
  isList,
  isMap,
  isNumber,
  isString,
  isTimestamp,
  keys,
  RuleError,
  size,
  strict,
} from "./cel.ts";
import type { ReadCtx, Rules, WriteCtx } from "./types.ts";
import { timestamp } from "../values.ts";

type Doc = Record<string, any>;
type Ctx = (ReadCtx | WriteCtx) & { kind?: string };

const MAX_LINES = 8;
const INVALID = -1000000;
const ORDER_ACTOR_FIELDS = [
  "statusUpdatedByUid",
  "cancelledByUid",
  "linesUpdatedByUid",
  "internalNoteUpdatedByUid",
  "customerShippingUpdatedByUid",
  "createdByUid",
  "cashierUid",
  "nonDeliveryMarkedByUid",
  "branchStockNoteUpdatedByUid",
  "deliverySentByUid",
];

// Shared helpers bound to one request (the role checks read admins/{uid}
// through ctx.get, which caches per request).
function helpers(ctx: Ctx) {
  const auth = ctx.auth;
  const signedIn = () => auth != null;
  const uid = () => {
    if (!auth) throw new RuleError("request.auth is null");
    return auth.uid;
  };
  const doc = async (path: string): Promise<Doc> => {
    const d = await ctx.get(path);
    if (!d) throw new RuleError(`get(${path}): no such document`);
    return strict(d) as Doc;
  };
  const exists = async (path: string) => (await ctx.get(path)) != null;
  const docAfter = async (path: string): Promise<Doc> => {
    const d = await (ctx as WriteCtx).getAfter(path);
    if (!d) throw new RuleError(`getAfter(${path}): no such document`);
    return strict(d) as Doc;
  };
  const adminDoc = () => doc(`admins/${uid()}`);
  const withRole = async (roles: string[]) =>
    any(async () => signedIn() && (await exists(`admins/${uid()}`)) && (await adminDoc()).active === true && inList((await adminDoc()).role, roles));
  const isAnyAdmin = () => withRole(["owner", "admin", "editor", "viewer", "cashier"]);
  const isEditorOrAbove = () => withRole(["owner", "admin", "editor"]);
  const isCashierOrAbove = () => withRole(["owner", "admin", "cashier"]);
  const isAdminOrAbove = () => withRole(["owner", "admin"]);
  const isBranchNoteEditorOrAbove = () => withRole(["owner", "admin", "editor", "cashier"]);
  const isOwner = () => withRole(["owner"]);
  const myBranchIds = async () => getOr(await adminDoc(), "branchIds", []);
  const canSellAtBranch = async (branchId: unknown) =>
    (await isCashierOrAbove()) && ((await adminDoc()).role !== "cashier" || inList(branchId, await myBranchIds()));
  const identified = () => signedIn() && auth!.provider !== "anonymous";
  return {
    signedIn,
    uid,
    doc,
    docAfter,
    exists,
    adminDoc,
    withRole,
    isAnyAdmin,
    isEditorOrAbove,
    isCashierOrAbove,
    isAdminOrAbove,
    isBranchNoteEditorOrAbove,
    isOwner,
    myBranchIds,
    canSellAtBranch,
    identified,
  };
}

// --- Checkout ------------------------------------------------------------

const firstLines = (lines: any): any[] => {
  if (!isList(lines)) throw new RuleError("lines is not a list");
  return Array.from({ length: Math.min(lines.length, MAX_LINES) }, (_, i) => lines[i]);
};

function effectiveVariants(data: Doc): any {
  return size(getOr(data, "colorVariants", [])) > 0
    ? data.colorVariants
    : [{ id: "default", colorName: getOr(data, "colorName", ""), colorHex: getOr(data, "colorHex", "#000000"), sizeStock: getOr(data, "stock", []) }];
}

const upTo = (n: number, cap: number) => Array.from({ length: Math.min(n, cap) }, (_, i) => i);

function sizeInList(sizeStock: any, sz: unknown) {
  return upTo(sizeStock.length, 6).some((i) => sizeStock[i].size === sz);
}

function variantSizeExists(variants: any, variantId: unknown, sz: unknown) {
  return upTo(variants.length, 6).some((i) => variants[i].id === variantId && sizeInList(variants[i].sizeStock, sz));
}

const effectiveStockByCellFlat = (data: Doc): Doc => (size(getOr(data, "stockByCell", {})) > 0 ? data.stockByCell : {});

function variantSizeExistsFlat(product: Doc, variantId: string, sz: string) {
  return has(getOr(product, "colorVariants", {}), variantId) && has(effectiveStockByCellFlat(product), `${variantId}::${sz}`);
}

async function claimLineValid(h: ReturnType<typeof helpers>, line: any) {
  const product = await h.doc(`products/${line.productId}`);
  return (
    isInt(line.qty) &&
    line.qty > 0 &&
    line.qty <= 20 &&
    line.price === product.price &&
    product.status === "active" &&
    (isList(getOr(product, "colorVariants", []))
      ? variantSizeExists(effectiveVariants(product), line.variantId, line.size)
      : variantSizeExistsFlat(product, line.variantId, line.size))
  );
}

async function isValidClaim(h: ReturnType<typeof helpers>, data: Doc) {
  if (!isList(data.lines) || data.lines.length === 0 || data.lines.length > MAX_LINES) return false;
  for (const line of data.lines) if (!(await claimLineValid(h, line))) return false;
  return true;
}

function sizeStockDiffOrInvalid(before: any, after: any): number {
  if (before.length !== after.length || before.length > 6) return INVALID;
  let sum = 0;
  for (let i = 0; i < before.length; i++) {
    const b = before[i];
    const a = after[i];
    sum += b.size === a.size && a.qty <= b.qty && a.qty >= 0 ? b.qty - a.qty : INVALID;
  }
  return sum;
}

function variantsDiffOrInvalid(before: any, after: any): number {
  if (before.length !== after.length || before.length > 6) return INVALID;
  let sum = 0;
  for (let i = 0; i < before.length; i++) {
    const b = before[i];
    const a = after[i];
    sum +=
      b.id === a.id && b.colorName === a.colorName && b.colorHex === a.colorHex
        ? sizeStockDiffOrInvalid(b.sizeStock, a.sizeStock)
        : INVALID;
  }
  return sum;
}

const claimedQtyForProduct = (lines: any, productId: unknown) =>
  firstLines(lines).reduce((s, l) => s + (l.productId === productId ? l.qty : 0), 0);

const claimSubtotal = (lines: any) => firstLines(lines).reduce((s, l) => s + l.price * l.qty, 0);

const touchedCellKeysForProduct = (lines: any, productId: unknown) =>
  upTo(MAX_LINES, MAX_LINES).map((i) =>
    i < lines.length && lines[i].productId === productId ? `${lines[i].variantId}::${lines[i].size}` : "__none__"
  );

function cellDeltaForKeyOrInvalid(before: Doc, after: Doc, key: string): number {
  if (key === "__none__") return 0;
  return has(before, key) && has(after, key) && after[key].qty <= before[key].qty && after[key].qty >= 0
    ? before[key].qty - after[key].qty
    : INVALID;
}

async function stockDecreaseMatchesClaimFlat(h: ReturnType<typeof helpers>, w: WriteCtx, productId: unknown) {
  const lines = (await h.docAfter(`checkoutClaims/${h.uid()}`)).lines;
  const before = effectiveStockByCellFlat(strict(w.before!) as Doc);
  const after = (strict(w.after!) as Doc).stockByCell;
  const claimed = claimedQtyForProduct(lines, productId);
  const ks = touchedCellKeysForProduct(lines, productId);
  return (
    claimed > 0 &&
    hasOnly(affectedKeys(after, before), ks) &&
    ks.reduce((s, k) => s + cellDeltaForKeyOrInvalid(before, after, k), 0) === claimed
  );
}

async function stockDecreaseMatchesClaim(h: ReturnType<typeof helpers>, w: WriteCtx, id: string) {
  const claimed = claimedQtyForProduct((await h.docAfter(`checkoutClaims/${h.uid()}`)).lines, id);
  return claimed > 0 && variantsDiffOrInvalid(effectiveVariants(strict(w.before!) as Doc), (strict(w.after!) as Doc).colorVariants) === claimed;
}

async function isValidStockDecrement(h: ReturnType<typeof helpers>, w: WriteCtx) {
  if (!h.signedIn()) return false;
  const after = strict(w.after!) as Doc;
  const changed = affectedKeys(w.after, w.before);
  return any(
    async () => hasOnly(changed, ["colorVariants", "updatedAt"]) && isList(after.colorVariants) && stockDecreaseMatchesClaim(h, w, w.id),
    async () => hasOnly(changed, ["stockByCell", "updatedAt"]) && isMap(after.stockByCell) && stockDecreaseMatchesClaimFlat(h, w, w.id)
  );
}

const lineMatchesClaim = (o: any, c: any) =>
  o.productId === c.productId && o.variantId === c.variantId && o.size === c.size && o.qty === c.qty && o.price === c.price;

const orderLinesMatchClaim = (orderLines: any, claimLines: any) =>
  orderLines.length === claimLines.length && firstLines(orderLines).every((l, i) => lineMatchesClaim(l, claimLines[i]));

const isValidPolicyConsent = (c: any) => isInt(c.policyVersion) && inList(c.lang, ["en", "ar"]);

async function isValidDiscountForOrder(h: ReturnType<typeof helpers>, discountId: unknown, amount: unknown, subtotal: any) {
  const d = await h.doc(`discounts/${discountId}`);
  // CEL integer division when both are ints, as the old rule computed it.
  const pct = isInt(subtotal) && isInt(d.value) ? Math.trunc((subtotal * d.value) / 100) : (subtotal * d.value) / 100;
  const maxAmount = d.type === "percent" ? pct : d.value;
  return (
    d.active === true &&
    isNumber(amount) &&
    amount >= 0 &&
    amount <= subtotal &&
    amount <= maxAmount &&
    (getOr(d, "minSubtotal", null) == null || subtotal >= d.minSubtotal) &&
    (getOr(d, "usageLimit", null) == null || (getOr(d, "usageCount", 0) as number) < d.usageLimit)
  );
}

async function isValidShippingForOrder(h: ReturnType<typeof helpers>, subtotal: any, shipping: unknown, zoneId: unknown) {
  const freeThreshold = (await h.exists("settings/shipping"))
    ? getOr(await h.doc("settings/shipping"), "freeShippingThreshold", 500)
    : 500;
  const zoneExists = await h.exists(`deliveryZones/${zoneId}`);
  const zone = zoneExists ? await h.doc(`deliveryZones/${zoneId}`) : {};
  return subtotal >= (freeThreshold as number)
    ? shipping === 0
    : zoneExists && getOr(zone, "active", false) === true && isNumber(shipping) && shipping === getOr(zone, "fee", -1);
}

const CHECKOUT_ORDER_KEYS = [
  "orderNumber", "customerId", "customerName", "customerEmail", "customerPhone", "lines", "subtotal", "discount",
  "discountId", "shipping", "total", "status", "source", "shippingAddress", "notes", "policyConsent", "deliveryZoneId",
  "deliveryZoneName", "deliveryZoneNameAr", "createdAt", "updatedAt",
];

async function isValidCheckoutOrder(h: ReturnType<typeof helpers>, w: WriteCtx) {
  const d = strict(w.after!) as Doc;
  if (
    !(
      h.signedIn() &&
      d.customerId === h.uid() &&
      d.status === "pending" &&
      hasOnly(keys(d), CHECKOUT_ORDER_KEYS) &&
      size(d.lines) > 0 &&
      size(d.lines) <= MAX_LINES &&
      isString(d.deliveryZoneId) &&
      d.deliveryZoneId.length > 0
    )
  ) {
    return false;
  }
  if (!(await isValidShippingForOrder(h, d.subtotal, d.shipping, d.deliveryZoneId))) return false;
  const discount = getOr(d, "discount", 0) as number;
  const discountOk =
    getOr(d, "discountId", null) == null ? discount === 0 : await isValidDiscountForOrder(h, d.discountId, discount, d.subtotal);
  if (!discountOk) return false;
  if (d.total !== d.subtotal - discount + d.shipping) return false;
  if (!isValidPolicyConsent(d.policyConsent)) return false;
  const claim = await h.docAfter(`checkoutClaims/${h.uid()}`);
  return orderLinesMatchClaim(d.lines, claim.lines) && d.subtotal === claimSubtotal(claim.lines);
}

async function isValidOrderStatsIncrement(h: ReturnType<typeof helpers>, w: WriteCtx) {
  const claimed = claimSubtotal((await h.docAfter(`checkoutClaims/${w.id}`)).lines);
  const a = strict(w.after!) as Doc;
  const b = strict(w.before!) as Doc;
  return (
    hasOnly(affectedKeys(a, b), ["ordersCount", "totalSpent", "updatedAt"]) &&
    a.ordersCount === b.ordersCount + 1 &&
    a.totalSpent === b.totalSpent + claimed
  );
}

function isValidAddressesUpdate(w: WriteCtx) {
  const a = strict(w.after!) as Doc;
  return hasOnly(affectedKeys(w.after, w.before), ["addresses", "updatedAt"]) && isList(a.addresses) && a.addresses.length <= 10;
}

// --- POS -----------------------------------------------------------------

async function isValidPosDeviceClaim(h: ReturnType<typeof helpers>, w: WriteCtx, uid: string) {
  const d = strict(w.after!) as Doc;
  const link = await h.docAfter(`posLinks/${d.posLink}`);
  return (
    h.uid() === uid &&
    hasOnly(keys(d), ["email", "displayName", "role", "active", "branchIds", "registerIds", "posLink", "createdAt", "updatedAt"]) &&
    d.role === "cashier" &&
    d.active === true &&
    d.email === "" &&
    isString(d.displayName) &&
    d.displayName.length > 0 &&
    d.displayName.length <= 80 &&
    link.active === true &&
    eq(d.branchIds, [link.branchId]) &&
    eq(d.registerIds, [link.registerId])
  );
}

async function isValidRegisterLockChange(h: ReturnType<typeof helpers>, w: WriteCtx) {
  const b = strict(w.before!) as Doc;
  const before = getOr(b, "openSessionId", null);
  const after = getOr(strict(w.after!), "openSessionId", null);
  if (!hasOnly(affectedKeys(w.after, w.before), ["openSessionId", "updatedAt"])) return false;
  if (!(await h.canSellAtBranch(b.branchId))) return false;
  return any(
    async () => {
      if (!(before == null && isString(after))) return false;
      const s = await h.docAfter(`registerSessions/${after}`);
      return s.registerId === w.id && s.cashierId === h.uid() && s.status === "open";
    },
    async () => {
      if (!(isString(before) && after == null)) return false;
      const s = await h.docAfter(`registerSessions/${before}`);
      return s.cashierId === h.uid() && s.status === "closed";
    }
  );
}

async function isValidBranchStockWrite(h: ReturnType<typeof helpers>, w: WriteCtx) {
  const a = await h.adminDoc();
  const before = strict(w.before!) as Doc;
  const after = strict(w.after!) as Doc;
  if (a.active !== true) return false;
  return inList(a.role, ["owner", "admin", "editor"])
    ? after.branchId === before.branchId && after.productId === before.productId && isMap(after.stockByCell)
    : a.role === "cashier" &&
        inList(before.branchId, getOr(a, "branchIds", [])) &&
        hasOnly(affectedKeys(w.after, w.before), ["stockByCell", "updatedAt"]) &&
        isMap(after.stockByCell) &&
        stockDecreaseMatchesClaimFlat(h, w, before.productId);
}

// --- Orders ----------------------------------------------------------------

function isValidNonDeliveryUpdate(w: WriteCtx) {
  const a = strict(w.after!) as Doc;
  if (!has(a, "nonDeliveryFlagged")) return true;
  return (
    isBool(a.nonDeliveryFlagged) &&
    (getOr(strict(w.before!), "nonDeliveryFlagged", false) !== true || a.nonDeliveryFlagged === true) &&
    (!has(a, "nonDeliveryNote") || (isString(a.nonDeliveryNote) && a.nonDeliveryNote.length <= 500))
  );
}

function isValidCashierBranchNoteUpdate(w: WriteCtx) {
  const a = strict(w.after!) as Doc;
  return (
    hasOnly(affectedKeys(w.after, w.before), ["lineBranchStockNotes", "updatedAt"]) &&
    isMap(a.lineBranchStockNotes) &&
    size(a.lineBranchStockNotes) <= 20
  );
}

function orderActorUidFieldsValid(h: ReturnType<typeof helpers>, w: WriteCtx) {
  const a = strict(w.after!) as Doc;
  return ORDER_ACTOR_FIELDS.every((f) => !has(a, f) || a[f] === h.uid());
}

async function isValidStaffOrderBranch(h: ReturnType<typeof helpers>, w: WriteCtx) {
  if ((await h.adminDoc()).role !== "cashier") return true;
  const a = strict(w.after!) as Doc;
  if (
    !(
      getOr(a, "source", "") === "pos" &&
      inList(getOr(a, "branchId", ""), await h.myBranchIds()) &&
      getOr(a, "discount", 0) === 0 &&
      isString(getOr(a, "registerSessionId", null))
    )
  ) {
    return false;
  }
  const s = await h.docAfter(`registerSessions/${a.registerSessionId}`);
  return s.branchId === a.branchId && s.cashierId === h.uid() && getOr(a, "operatorId", null) === getOr(s, "operatorId", null);
}

// --- Returns -----------------------------------------------------------------

const returnCounterId = (o: unknown, p: unknown, v: unknown, s: unknown) => `${o}::${p}::${v}::${s}`;
const RETURN_REASONS = ["defective", "wrong_size", "wrong_color", "changed_mind", "fulfillment_error", "shipping_error", "other"];
const nonEmpty = (v: unknown) => isString(v) && v.length > 0;

const orderLineQtyForReturn = (lines: any, p: unknown, v: unknown, s: unknown) =>
  firstLines(lines).reduce((sum, l) => sum + (l.productId === p && l.variantId === v && l.size === s ? l.qty : 0), 0);

async function returnCounterMatchesIntake(h: ReturnType<typeof helpers>, a: Doc) {
  const path = `returnCounters/${returnCounterId(a.orderId, a.productId, a.variantId, a.size)}`;
  const before = (await h.exists(path)) ? (await h.doc(path)).returnedQty : 0;
  return (await h.docAfter(path)).returnedQty === before + a.qty;
}

// --- Registers / cash ------------------------------------------------------------

async function isValidShiftOperator(h: ReturnType<typeof helpers>, operatorId: unknown, branchId: unknown) {
  const op = await h.doc(`admins/${operatorId}`);
  return op.active === true && getOr(op, "posLink", null) == null && op.role === "cashier" && inList(branchId, getOr(op, "branchIds", []));
}

async function isValidCashWithdrawal(h: ReturnType<typeof helpers>, w: WriteCtx) {
  const d = strict(w.after!) as Doc;
  const before = await h.doc(`registerSessions/${d.sessionId}`);
  const after = await h.docAfter(`registerSessions/${d.sessionId}`);
  return (
    before.status === "open" &&
    (before.cashierId === h.uid() || (await h.isAdminOrAbove())) &&
    d.branchId === getOr(before, "branchId", "") &&
    d.registerId === getOr(before, "registerId", "") &&
    Math.abs((getOr(after, "cashOutTotal", 0) as number) - ((getOr(before, "cashOutTotal", 0) as number) + d.amount)) < 0.005
  );
}

const isCounterInt = (v: unknown) => isInt(v) && v >= 0;
const optCounter = (a: Doc, f: string) => !has(a, f) || isCounterInt(a[f]);

// --- Per-collection rules ------------------------------------------------------

type H = ReturnType<typeof helpers>;
interface CollectionRules {
  get?(h: H, c: ReadCtx, data: Doc): boolean | Promise<boolean>;
  list?(h: H, c: ReadCtx, data: Doc): boolean | Promise<boolean>;
  read?(h: H, c: ReadCtx, data: Doc): boolean | Promise<boolean>;
  create?(h: H, w: WriteCtx, after: Doc): boolean | Promise<boolean>;
  update?(h: H, w: WriteCtx, after: Doc, before: Doc): boolean | Promise<boolean>;
  delete?(h: H, w: WriteCtx, before: Doc): boolean | Promise<boolean>;
}

const publicRead_editorWrite: CollectionRules = {
  read: () => true,
  create: (h) => h.isEditorOrAbove(),
  update: (h) => h.isEditorOrAbove(),
  delete: (h) => h.isEditorOrAbove(),
};

const COLLECTIONS: Record<string, CollectionRules> = {
  checkoutClaims: {
    read: (h, c) => h.signedIn() && h.uid() === c.id,
    create: async (h, w, a) => h.signedIn() && h.uid() === w.id && any(() => h.isCashierOrAbove(), () => isValidClaim(h, a)),
    update: async (h, w, a) => h.signedIn() && h.uid() === w.id && any(() => h.isCashierOrAbove(), () => isValidClaim(h, a)),
    delete: (h, w) => h.signedIn() && h.uid() === w.id,
  },

  // No self-serve sign-up: admin accounts are only ever created by the
  // owner (Team page) or by a POS device claiming a link. The first owner
  // of a fresh database is created with scripts/create-owner.ts.

  posLinks: {
    get: () => true,
    list: (h) => h.isAdminOrAbove(),
    create: async (h, w, a) =>
      (await h.isAdminOrAbove()) && w.id.length >= 32 && isString(a.branchId) && isString(a.registerId) && a.active === true,
    update: async (h, w) => (await h.isAdminOrAbove()) && hasOnly(affectedKeys(w.after, w.before), ["active", "revokedAt", "updatedAt"]),
    delete: (h) => h.isAdminOrAbove(),
  },

  admins: {
    read: (h, c) => h.signedIn() && any(() => h.uid() === c.id, () => h.isAnyAdmin()),
    create: (h, w, a) =>
      any(
        () => h.isOwner(),
        () => isValidPosDeviceClaim(h, w, w.id)
      ),
    update: (h, w, a, b) =>
      any(
        () => h.isOwner(),
        async () =>
          (await h.isAdminOrAbove()) && isString(getOr(b, "posLink", null)) && getOr(a, "posLink", null) === b.posLink && a.role === "cashier",
        () => isString(getOr(b, "posLink", null)) && isValidPosDeviceClaim(h, w, w.id)
      ),
    delete: (h, _w, b) => any(() => h.isOwner(), async () => (await h.isAdminOrAbove()) && isString(getOr(b, "posLink", null))),
  },

  branches: {
    read: (h) => h.isAnyAdmin(),
    create: (h) => h.isAdminOrAbove(),
    update: (h) => h.isAdminOrAbove(),
    delete: (h) => h.isAdminOrAbove(),
  },

  registers: {
    read: (h) => h.isAnyAdmin(),
    create: async (h, _w, a) => (await h.isAdminOrAbove()) && isString(a.branchId),
    update: (h, w, a, b) =>
      any(
        async () =>
          (await h.isAdminOrAbove()) && a.branchId === b.branchId && (!has(b, "number") || getOr(a, "number", null) === b.number),
        () => isValidRegisterLockChange(h, w)
      ),
    delete: (h) => h.isAdminOrAbove(),
  },

  branchStock: {
    read: (h) => h.isAnyAdmin(),
    create: async (h, w, a) =>
      (await h.isEditorOrAbove()) &&
      isString(a.branchId) &&
      isString(a.productId) &&
      w.id === `${a.branchId}__${a.productId}` &&
      isMap(a.stockByCell),
    update: (h, w) => h.signedIn() && isValidBranchStockWrite(h, w),
    delete: (h) => h.isEditorOrAbove(),
  },

  products: {
    read: (h, _c, d) => any(() => d.status === "active", () => h.isAnyAdmin()),
    create: (h) => h.isEditorOrAbove(),
    update: (h, w) => any(() => h.isEditorOrAbove(), () => isValidStockDecrement(h, w)),
    delete: (h) => h.isEditorOrAbove(),
  },

  categories: publicRead_editorWrite,
  siteContent: publicRead_editorWrite,

  settings: {
    read: () => true,
    create: (h) => h.isAdminOrAbove(),
    update: (h) => h.isAdminOrAbove(),
    delete: (h) => h.isAdminOrAbove(),
  },

  reviews: {
    read: (h, _c, d) => any(() => h.isAnyAdmin(), () => d.status === "approved"),
    create: (h, _w, a) =>
      any(
        () => h.isEditorOrAbove(),
        () =>
          h.identified() &&
          a.status === "pending" &&
          isInt(a.rating) &&
          a.rating >= 1 &&
          a.rating <= 5 &&
          isString(a.body) &&
          a.body.length > 0 &&
          a.body.length <= 2000 &&
          isString(a.author) &&
          a.author.length > 0 &&
          a.author.length <= 100 &&
          isString(a.productId) &&
          isString(a.productName) &&
          hasOnly(keys(a), ["productId", "productName", "author", "rating", "title", "body", "status", "createdAt", "updatedAt"])
      ),
    update: (h) => h.isEditorOrAbove(),
    delete: (h) => h.isEditorOrAbove(),
  },

  media: {
    read: (h) => h.isAnyAdmin(),
    create: (h) => h.isEditorOrAbove(),
    update: (h) => h.isEditorOrAbove(),
    delete: (h) => h.isEditorOrAbove(),
  },

  discounts: {
    read: (h, _c, d) => any(() => h.isAnyAdmin(), () => d.active === true),
    create: (h) => h.isEditorOrAbove(),
    update: (h, w, a, b) =>
      any(
        () => h.isEditorOrAbove(),
        () =>
          h.signedIn() &&
          b.active === true &&
          hasOnly(affectedKeys(w.after, w.before), ["usageCount", "updatedAt"]) &&
          a.usageCount === b.usageCount + 1
      ),
    delete: (h) => h.isEditorOrAbove(),
  },

  deliveryZones: {
    read: (h, _c, d) => any(() => h.isAnyAdmin(), () => d.active === true),
    create: (h) => h.isEditorOrAbove(),
    update: (h) => h.isEditorOrAbove(),
    // No delete: zones are deactivated, never removed.
  },

  orders: {
    read: (h, _c, d) =>
      any(
        () => h.withRole(["owner", "admin", "editor"]),
        async () =>
          (await h.withRole(["cashier"])) &&
          (inList(getOr(d, "source", ""), ["web", "manual"]) || inList(getOr(d, "branchId", ""), await h.myBranchIds())),
        () => h.signedIn() && d.customerId === h.uid()
      ),
    create: (h, w) =>
      any(
        async () => (await h.isCashierOrAbove()) && orderActorUidFieldsValid(h, w) && isValidStaffOrderBranch(h, w),
        () => isValidCheckoutOrder(h, w)
      ),
    update: (h, w) =>
      any(
        async () => (await h.isAdminOrAbove()) && isValidNonDeliveryUpdate(w) && orderActorUidFieldsValid(h, w),
        async () => (await h.isBranchNoteEditorOrAbove()) && isValidCashierBranchNoteUpdate(w) && orderActorUidFieldsValid(h, w)
      ),
    delete: (h) => h.isAdminOrAbove(),
  },

  returns: {
    read: (h) => h.isCashierOrAbove(),
    create: async (h, _w, a) =>
      (await h.isCashierOrAbove()) &&
      a.status === "quarantine" &&
      a.disposition === null &&
      a.restocked === false &&
      isInt(a.qty) &&
      a.qty > 0 &&
      nonEmpty(a.orderId) &&
      nonEmpty(a.productId) &&
      nonEmpty(a.variantId) &&
      nonEmpty(a.size) &&
      inList(a.reason, RETURN_REASONS) &&
      inList((await h.doc(`orders/${a.orderId}`)).status, ["shipped", "delivered", "completed"]) &&
      (await returnCounterMatchesIntake(h, a)) &&
      (!has(a, "processedByUid") || a.processedByUid === h.uid()),
    update: async (h, _w, a, b) =>
      (await h.isAdminOrAbove()) &&
      b.status !== "resolved" &&
      a.orderId === b.orderId &&
      a.productId === b.productId &&
      a.variantId === b.variantId &&
      a.size === b.size &&
      a.qty === b.qty &&
      (a.restocked === b.restocked || (b.restocked === false && a.restocked === true)) &&
      (!has(a, "resolvedByUid") || a.resolvedByUid === h.uid()),
    delete: (h) => h.isAdminOrAbove(),
  },

  returnCounters: (() => {
    const write = async (h: H, w: WriteCtx, a: Doc) => {
      const b = w.before ? (strict(w.before) as Doc) : null;
      return (
        (await h.isCashierOrAbove()) &&
        nonEmpty(a.orderId) &&
        nonEmpty(a.productId) &&
        nonEmpty(a.variantId) &&
        nonEmpty(a.size) &&
        w.id === returnCounterId(a.orderId, a.productId, a.variantId, a.size) &&
        isInt(a.returnedQty) &&
        a.returnedQty > (b ? b.returnedQty : 0) &&
        a.returnedQty <= orderLineQtyForReturn((await h.doc(`orders/${a.orderId}`)).lines, a.productId, a.variantId, a.size) &&
        (b == null || (a.orderId === b.orderId && a.productId === b.productId && a.variantId === b.variantId && a.size === b.size))
      );
    };
    return { read: (h: H) => h.isAnyAdmin(), create: write, update: write };
  })(),

  stockMovements: {
    read: (h) => h.isAnyAdmin(),
    create: (h, _w, a) => {
      const actorOk = () => !has(a, "actorUid") || a.actorUid === h.uid();
      return any(
        async () => (await h.isEditorOrAbove()) && actorOk(),
        () =>
          h.signedIn() &&
          a.reason === "sale" &&
          inList(a.source, ["web", "pos"]) &&
          nonEmpty(a.productId) &&
          nonEmpty(a.variantId) &&
          nonEmpty(a.size) &&
          isInt(a.qtyBefore) &&
          isInt(a.qtyChange) &&
          a.qtyChange < 0 &&
          isInt(a.qtyAfter) &&
          actorOk()
      );
    },
  },

  registerSessions: {
    read: (h) => h.isAnyAdmin(),
    create: async (h, w, a) => {
      if (
        !(
          (await h.isCashierOrAbove()) &&
          a.cashierId === h.uid() &&
          a.status === "open" &&
          a.salesCount === 0 &&
          a.cashTotal === 0 &&
          a.cardTotal === 0 &&
          a.discountTotal === 0 &&
          a.grossTotal === 0 &&
          getOr(a, "cashOutTotal", 0) === 0
        )
      ) {
        return false;
      }
      if (has(a, "operatorId") && !(await isValidShiftOperator(h, a.operatorId, a.branchId))) return false;
      if (!(isString(a.branchId) && (await h.canSellAtBranch(a.branchId)) && isString(a.registerId))) return false;
      const r = await h.docAfter(`registers/${a.registerId}`);
      return r.branchId === a.branchId && r.active === true && r.openSessionId === w.id;
    },
    update: async (h, _w, a, b) =>
      (await any(async () => (await h.isCashierOrAbove()) && b.cashierId === h.uid(), () => h.isAdminOrAbove())) &&
      ["cashierId", "cashierName", "branchId", "registerId", "operatorId"].every((f) => eq(getOr(a, f, null), getOr(b, f, null))) &&
      (!has(a, "closedByUid") || a.closedByUid === h.uid()),
    delete: (h) => h.isAdminOrAbove(),
  },

  cashMovements: {
    read: (h) => h.isAnyAdmin(),
    create: async (h, w, a) =>
      (await h.isCashierOrAbove()) &&
      hasOnly(keys(a), ["sessionId", "branchId", "registerId", "type", "amount", "reason", "actorUid", "actorName", "createdAt"]) &&
      a.type === "withdrawal" &&
      isNumber(a.amount) &&
      a.amount > 0 &&
      a.actorUid === h.uid() &&
      isString(a.actorName) &&
      isString(getOr(a, "reason", "")) &&
      size(getOr(a, "reason", "")) <= 200 &&
      eq(a.createdAt, timestamp(w.now)) &&
      isString(a.sessionId) &&
      isValidCashWithdrawal(h, w),
  },

  customers: {
    read: (h, c) => any(() => h.isAnyAdmin(), () => h.signedIn() && h.uid() === c.id),
    create: (h, w, a) =>
      any(
        () => h.isAdminOrAbove(),
        () =>
          h.identified() &&
          h.uid() === w.id &&
          hasOnly(keys(a), ["uid", "authProvider", "photoURL", "name", "email", "phone", "ordersCount", "totalSpent", "createdAt", "updatedAt"]) &&
          a.ordersCount === 0 &&
          a.totalSpent === 0
      ),
    update: (h, w) => {
      const self = () => h.identified() && h.uid() === w.id;
      return any(
        () => self() && hasOnly(affectedKeys(w.after, w.before), ["name", "phone", "photoURL", "updatedAt"]),
        async () => self() && isValidOrderStatsIncrement(h, w),
        () => self() && isValidAddressesUpdate(w),
        () => h.isAdminOrAbove()
      );
    },
    delete: (h) => h.isAdminOrAbove(),
  },

  notifications: {
    read: (h) => h.isAnyAdmin(),
    create: (h, _w, a) =>
      any(
        () => h.isAdminOrAbove(),
        () =>
          h.signedIn() &&
          a.kind === "low_stock" &&
          a.read === false &&
          isString(a.title) &&
          isString(a.body) &&
          hasOnly(keys(a), ["kind", "title", "body", "link", "read", "createdAt", "updatedAt"])
      ),
    update: (h) => h.isAdminOrAbove(),
    delete: (h) => h.isAdminOrAbove(),
  },

  activityLogs: {
    read: (h) => h.isAdminOrAbove(),
    create: async (h, _w, a) => (await h.isAnyAdmin()) && a.actorUid === h.uid(),
  },

  presence: (() => {
    const write = (_h: H, _w: WriteCtx, a: Doc) => hasOnly(keys(a), ["lastSeen", "expiresAt"]) && isTimestamp(a.lastSeen) && isTimestamp(a.expiresAt);
    return { read: (h: H) => h.isAnyAdmin(), create: write, update: write, delete: (h: H) => h.isAnyAdmin() };
  })(),

  analyticsDaily: (() => {
    const write = (_h: H, _w: WriteCtx, a: Doc) =>
      hasOnly(keys(a), ["date", "pageviews", "visits"]) && isString(a.date) && optCounter(a, "pageviews") && optCounter(a, "visits");
    return { read: (h: H) => h.isAnyAdmin(), create: write, update: write };
  })(),

  productStats: (() => {
    const write = (_h: H, _w: WriteCtx, a: Doc) => hasOnly(keys(a), ["views", "quickAdds"]) && optCounter(a, "views") && optCounter(a, "quickAdds");
    return { read: (h: H) => h.isAnyAdmin(), create: write, update: write };
  })(),

  categoryStats: (() => {
    const write = (_h: H, _w: WriteCtx, a: Doc) => hasOnly(keys(a), ["views"]) && isCounterInt(a.views);
    return { read: (h: H) => h.isAnyAdmin(), create: write, update: write };
  })(),

  productViewsDaily: (() => {
    const write = (_h: H, _w: WriteCtx, a: Doc) =>
      hasOnly(keys(a), ["date", "productId", "views", "quickAdds"]) &&
      isString(a.date) &&
      isString(a.productId) &&
      optCounter(a, "views") &&
      optCounter(a, "quickAdds");
    return { read: (h: H) => h.isAnyAdmin(), create: write, update: write };
  })(),

  categoryViewsDaily: (() => {
    const write = (_h: H, _w: WriteCtx, a: Doc) =>
      hasOnly(keys(a), ["date", "category", "views"]) && isString(a.date) && isString(a.category) && isCounterInt(a.views);
    return { read: (h: H) => h.isAnyAdmin(), create: write, update: write };
  })(),

  newsletterSubscribers: {
    read: (h) => h.isAnyAdmin(),
    create: (_h, _w, a) => hasOnly(keys(a), ["email", "createdAt"]) && isString(a.email) && a.email.length > 0 && a.email.length < 200,
    update: (h) => h.isAdminOrAbove(),
    delete: (h) => h.isAdminOrAbove(),
  },
};

// Any rule that throws (a missing field, a get() of a missing document, a
// type error) denies, exactly like an evaluation error in Firestore rules.
async function evaluate(fn: () => boolean | Promise<boolean>): Promise<boolean> {
  try {
    return (await fn()) === true;
  } catch (e) {
    if (e instanceof RuleError || e instanceof TypeError) return false;
    throw e;
  }
}

export const storeRules: Rules = {
  read(c) {
    const r = COLLECTIONS[c.collection];
    const fn = r && (c.kind === "get" ? r.get ?? r.read : r.list ?? r.read);
    if (!fn) return Promise.resolve(false);
    return evaluate(() => fn(helpers(c), c, strict(c.data) as Doc));
  },
  write(w) {
    const r = COLLECTIONS[w.collection];
    const fn = r?.[w.op];
    if (!fn) return Promise.resolve(false);
    const h = helpers(w);
    return evaluate(() => {
      if (w.op === "delete") return (fn as NonNullable<CollectionRules["delete"]>)(h, w, strict(w.before ?? {}) as Doc);
      if (w.op === "create") return (fn as NonNullable<CollectionRules["create"]>)(h, w, strict(w.after!) as Doc);
      return (fn as NonNullable<CollectionRules["update"]>)(h, w, strict(w.after!) as Doc, strict(w.before!) as Doc);
    });
  },
};
