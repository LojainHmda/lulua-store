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
import { applyPromotions, isPromotionLive, toPromotionDef } from "../shared/promotions.ts";
import { timestamp, tsToDate } from "../values.ts";

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
  // A document as plain data (no strict missing-field errors), or null.
  const raw = (path: string) => ctx.get(path);
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
    raw,
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

// `allowNegative`: a till's offline sale being sent -- the units already
// left with the customer, so the count may go below zero (flagged on the
// order for review). Never for a web checkout.
function cellDeltaForKeyOrInvalid(before: Doc, after: Doc, key: string, allowNegative = false): number {
  if (key === "__none__") return 0;
  return has(before, key) && has(after, key) && after[key].qty <= before[key].qty && (after[key].qty >= 0 || allowNegative)
    ? before[key].qty - after[key].qty
    : INVALID;
}

async function stockDecreaseMatchesClaimFlat(h: ReturnType<typeof helpers>, w: WriteCtx, productId: unknown) {
  const claim = await h.docAfter(`checkoutClaims/${h.uid()}`);
  const lines = claim.lines;
  const allowNegative = getOr(claim, "offline", false) === true && (await h.isCashierOrAbove());
  const before = effectiveStockByCellFlat(strict(w.before!) as Doc);
  const after = (strict(w.after!) as Doc).stockByCell;
  const claimed = claimedQtyForProduct(lines, productId);
  const ks = touchedCellKeysForProduct(lines, productId);
  return (
    claimed > 0 &&
    hasOnly(affectedKeys(after, before), ks) &&
    ks.reduce((s, k) => s + cellDeltaForKeyOrInvalid(before, after, k, allowNegative), 0) === claimed
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

// Must match POS_DISCOUNT_POLICY_DEFAULTS (src/admin/posDiscounts.ts).
const POS_DISCOUNT_DEFAULT_MAX_PERCENT = 10;

// A cashier's sale discount = automatic promotions + a manual part.
//  - Promotions: every promotion cited must exist and be live (active, in its
//    dates, for this branch), and the shared calculator, re-run here on the
//    claimed lines (the real prices), must give exactly the order's figures
//    -- per line, per promotion and in total.
//  - Manual: at most settings/posDiscounts.cashierMaxPercent of what's left
//    after promotions.
//  - total = subtotal - (promotions + manual).
async function isValidCashierDiscount(h: ReturnType<typeof helpers>, a: Doc, w: WriteCtx) {
  const d = getOr(a, "discount", 0);
  if (d === 0) return !has(a, "discountSource") && !has(a, "promotions") && getOr(a, "promoDiscount", 0) === 0;
  const promo = getOr(a, "promoDiscount", 0);
  // Sales from before promotions existed carry only discountSource "manual".
  const manual = getOr(a, "manualDiscount", getOr(a, "discountSource", "") === "manual" ? d : 0);
  if (!(isNumber(d) && d > 0 && isNumber(promo) && promo >= 0 && isNumber(manual) && manual >= 0 && near(d, promo + manual))) return false;
  const source = promo > 0 ? (manual > 0 ? "mixed" : "promotion") : "manual";
  if (getOr(a, "discountSource", "") !== source) return false;

  const claimLines = (await h.docAfter(`checkoutClaims/${h.uid()}`)).lines as any[];
  const sub = claimSubtotal(claimLines);
  if (!(near(a.subtotal, sub) && near(a.total, a.subtotal - d))) return false;

  if (promo > 0) {
    const cited = getOr(a, "promotions", []);
    if (!isList(cited) || cited.length === 0 || cited.length > 20) return false;
    // An offline sale is checked against the promotions of the moment it was
    // made (at most 7 days back, never in the future).
    let now = w.now.getTime();
    if (getOr(a, "offline", false) === true) {
      const at = tsToDate(getOr(a, "offlineCreatedAt", null) as never)?.getTime();
      if (!at || at > now + 5 * 60_000 || at < now - 7 * 24 * 3600_000) return false;
      now = at;
    }
    const defs = [];
    for (const c of cited as any[]) {
      const data = await h.raw(`promotions/${c.id}`);
      if (!data) return false;
      const def = toPromotionDef(String(c.id), data as Record<string, unknown>);
      if (!isPromotionLive(def, a.branchId, now)) return false;
      defs.push(def);
    }
    const lines = [];
    for (const l of firstLines(claimLines)) {
      const product = await h.raw(`products/${l.productId}`);
      lines.push({ key: `${l.productId}::${l.variantId}::${l.size}`, productId: l.productId, category: String((product as Doc | null)?.category ?? ""), price: l.price, qty: l.qty });
    }
    const res = applyPromotions(lines, defs, { branchId: a.branchId, now });
    if (!near(res.total, promo)) return false;
    for (const c of cited as any[]) {
      const hit = res.applied.find((x) => x.id === c.id);
      if (!hit || !near(c.amount, hit.amount)) return false;
    }
    for (const l of firstLines(a.lines)) {
      const want = res.lines[`${l.productId}::${l.variantId}::${l.size}`]?.discount ?? 0;
      if (!near(getOr(l, "promoDiscount", 0), want)) return false;
    }
  } else if (has(a, "promotions")) {
    return false;
  }

  if (manual > 0) {
    const s = (await h.exists("settings/posDiscounts")) ? await h.doc("settings/posDiscounts") : {};
    const pct = getOr(s, "cashierMaxPercent", POS_DISCOUNT_DEFAULT_MAX_PERCENT);
    if (!isNumber(pct) || pct <= 0) return false;
    if (manual > r2(((sub - promo) * Math.min(pct, 100)) / 100) + 0.005) return false;
  }
  return true;
}

async function isValidStaffOrderBranch(h: ReturnType<typeof helpers>, w: WriteCtx) {
  if ((await h.adminDoc()).role !== "cashier") return true;
  const a = strict(w.after!) as Doc;
  if (
    !(
      getOr(a, "source", "") === "pos" &&
      inList(getOr(a, "branchId", ""), await h.myBranchIds()) &&
      isString(getOr(a, "registerSessionId", null)) &&
      (await isValidCashierDiscount(h, a, w))
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

// --- POS returns (src/firebase/posReturn.ts) -------------------------------------
// One return commits, together: the posReturns/{id} record, the sale's
// returnCounters + refund totals (receipt returns), the receiving branch's
// branchStock (+ ledger rows) for restocked lines, and the shift's refund
// totals. Each side is checked against the return record created in the
// SAME commit (exists after, didn't exist before), so a cashier can only
// add stock / move refund totals by actually recording a return.

const DAY_MS = 24 * 60 * 60 * 1000;
const r2 = (n: number) => Math.round(n * 100) / 100;
const near = (a: unknown, b: number) => isNumber(a) && Math.abs(a - b) < 0.005;
const num = (d: Doc, f: string) => getOr(d, f, 0) as number;
const ORDER_REFUND_KEYS = ["refundedTotal", "refundedCash", "refundedCard", "returnedQty", "returnedByLine", "returnCount", "refundStatus", "lastReturnId", "updatedAt"];
const POS_RETURN_KEYS = [
  "returnNumber", "kind", "orderId", "orderNumber", "saleBranchId", "saleBranchName", "saleRegisterName", "saleCreatedAt",
  "branchId", "branchName", "branchCode", "registerId", "registerName", "sessionId", "cashierUid", "cashierName", "operatorId",
  "lines", "itemCount", "refundTotal", "refundMethod", "cashRefund", "cardRefund", "reason", "note", "createdAt",
];
// Must match POS_RETURN_POLICY_DEFAULTS (src/admin/posReturns.ts).
const POS_RETURN_POLICY_DEFAULTS = { windowDays: 14, allowNoReceipt: false };

const queryHasEq = (c: ReadCtx, field: string) => (c.query?.filters ?? []).some((f) => f.field === field && f.op === "==");
// Must match SEARCH_DAYS_WITHOUT_WINDOW (src/admin/posReturns.ts).
const RETURN_SEARCH_DAYS_WITHOUT_WINDOW = 90;

// The Returns screen lists every branch's still-returnable POS sales: a
// query bounded by createdAt >= (now - return period). Older sales, or an
// unbounded list, stay out of reach for cashiers.
async function isReturnableSalesQuery(h: ReturnType<typeof helpers>, c: ReadCtx) {
  const f = (c.query?.filters ?? []).find((x) => x.field === "createdAt" && (x.op === ">=" || x.op === ">"));
  const since = f ? tsToDate(f.value) : null;
  if (!since) return false;
  const { windowDays } = await posReturnPolicy(h);
  const days = windowDays > 0 ? windowDays : RETURN_SEARCH_DAYS_WITHOUT_WINDOW;
  // One day of slack for clock differences between the till and the server.
  return since.getTime() >= c.now.getTime() - (days + 1) * DAY_MS;
}

// The return being recorded in this very commit.
async function freshReturn(h: ReturnType<typeof helpers>, id: unknown): Promise<Doc> {
  if (!isString(id) || id.length === 0) throw new RuleError("no return id");
  if (await h.exists(`posReturns/${id}`)) throw new RuleError("return already recorded");
  return h.docAfter(`posReturns/${id}`);
}

const restockQty = (ret: Doc, productId: unknown, cell: string) =>
  (ret.lines as any[]).reduce(
    (s, l) => s + (l.restock === true && l.productId === productId && `${l.variantId}::${l.size}` === cell ? l.qty : 0),
    0
  );
const restockTotal = (ret: Doc, productId: unknown) =>
  (ret.lines as any[]).reduce((s, l) => s + (l.restock === true && l.productId === productId ? l.qty : 0), 0);

const cellQtyOf = (cells: any, key: string): number => {
  if (!has(cells, key)) return 0;
  const q = getOr(cells[key], "qty", 0);
  return isNumber(q) ? q : 0;
};

async function posReturnPolicy(h: ReturnType<typeof helpers>) {
  const s = (await h.exists("settings/posReturns")) ? await h.doc("settings/posReturns") : {};
  return {
    windowDays: getOr(s, "windowDays", POS_RETURN_POLICY_DEFAULTS.windowDays) as number,
    allowNoReceipt: getOr(s, "allowNoReceipt", POS_RETURN_POLICY_DEFAULTS.allowNoReceipt) === true,
  };
}

// branchStock create/update by a cashier: exactly the return's restocked
// units added to the receiving branch, nothing else.
async function isValidReturnRestock(h: ReturnType<typeof helpers>, w: WriteCtx) {
  const after = strict(w.after!) as Doc;
  const before = w.before ? (strict(w.before) as Doc) : null;
  const branchId = before ? before.branchId : after.branchId;
  const productId = before ? before.productId : after.productId;
  const ret = await freshReturn(h, after.lastReturnId);
  if (ret.branchId !== branchId || !(await h.canSellAtBranch(branchId))) return false;
  if (before) {
    if (!hasOnly(affectedKeys(w.after, w.before), ["stockByCell", "updatedAt", "lastReturnId"])) return false;
  } else if (
    !(
      isString(branchId) &&
      isString(productId) &&
      w.id === `${branchId}__${productId}` &&
      hasOnly(keys(after), ["branchId", "productId", "stockByCell", "lastReturnId", "createdAt", "updatedAt"])
    )
  ) {
    return false;
  }
  if (!isMap(after.stockByCell)) return false;
  const bc = before ? getOr(before, "stockByCell", {}) : {};
  const ac = after.stockByCell;
  const changed = affectedKeys(ac, bc);
  let added = 0;
  for (const k of changed) {
    const want = restockQty(ret, productId, k);
    if (!(want > 0 && has(ac, k) && cellQtyOf(ac, k) - cellQtyOf(bc, k) === want)) return false;
    added += want;
  }
  return added > 0 && added === restockTotal(ret, productId);
}

async function isValidPosReturn(h: ReturnType<typeof helpers>, w: WriteCtx, a: Doc) {
  const uid = h.uid();
  if (!(await h.isCashierOrAbove())) return false;
  if (!(hasOnly(keys(a), POS_RETURN_KEYS) && a.cashierUid === uid && inList(a.kind, ["receipt", "no_receipt"]))) return false;
  if (!(nonEmpty(a.returnNumber) && inList(a.reason, RETURN_REASONS) && eq(a.createdAt, timestamp(w.now)))) return false;
  if (!(isString(getOr(a, "note", "")) && size(getOr(a, "note", "")) <= 300)) return false;
  if (!(isList(a.lines) && a.lines.length > 0 && a.lines.length <= MAX_LINES)) return false;

  const lines = a.lines as any[];
  const seen = new Set<string>();
  let refundSum = 0;
  let units = 0;
  for (const l of lines) {
    const k = `${l.productId}::${l.variantId}::${l.size}`;
    if (seen.has(k)) return false;
    seen.add(k);
    if (!(nonEmpty(l.productId) && nonEmpty(l.variantId) && nonEmpty(l.size) && isInt(l.qty) && l.qty > 0)) return false;
    if (!(isNumber(l.unitPrice) && l.unitPrice >= 0 && isNumber(l.refund) && l.refund >= 0 && isBool(l.restock))) return false;
    if (l.refund > l.unitPrice * l.qty + 0.005) return false;
    refundSum += l.refund;
    units += l.qty;
  }
  const cash = a.cashRefund;
  const card = a.cardRefund;
  if (!(isNumber(cash) && cash >= 0 && isNumber(card) && card >= 0)) return false;
  if (!(near(a.refundTotal, r2(refundSum)) && near(cash + card, a.refundTotal) && a.itemCount === units)) return false;
  if (a.refundMethod !== (card > 0 && cash > 0 ? "split" : card > 0 ? "card" : "cash")) return false;

  // The shift paying the refund: the cashier's own open session at this branch.
  const s = await h.doc(`registerSessions/${a.sessionId}`);
  const sAfter = await h.docAfter(`registerSessions/${a.sessionId}`);
  if (!(s.status === "open" && s.cashierId === uid && getOr(s, "branchId", "") === a.branchId && getOr(s, "registerId", "") === a.registerId)) return false;
  if (!(await h.canSellAtBranch(a.branchId))) return false;
  const drawer = r2(num(s, "startingCash") + num(s, "cashTotal") - num(s, "cashOutTotal") - num(s, "cashRefundTotal"));
  if (cash > drawer + 0.005) return false;
  if (
    !(
      num(sAfter, "refundCount") === num(s, "refundCount") + 1 &&
      near(num(sAfter, "refundTotal"), num(s, "refundTotal") + a.refundTotal) &&
      near(num(sAfter, "cashRefundTotal"), num(s, "cashRefundTotal") + cash) &&
      near(num(sAfter, "cardRefundTotal"), num(s, "cardRefundTotal") + card)
    )
  ) {
    return false;
  }

  // Restocked units really landed in the receiving branch's stock.
  for (const l of lines.filter((x) => x.restock === true)) {
    const path = `branchStock/${a.branchId}__${l.productId}`;
    const key = `${l.variantId}::${l.size}`;
    const before = (await h.exists(path)) ? cellQtyOf(getOr(await h.doc(path), "stockByCell", {}), key) : 0;
    if (cellQtyOf(getOr(await h.docAfter(path), "stockByCell", {}), key) !== before + l.qty) return false;
  }

  const policy = await posReturnPolicy(h);
  if (a.kind === "no_receipt") {
    if (!policy.allowNoReceipt || has(a, "orderId")) return false;
    for (const l of lines) {
      const p = await h.doc(`products/${l.productId}`);
      if (!(l.unitPrice === p.price && near(l.refund, r2(p.price * l.qty)))) return false;
    }
    return true;
  }

  const o = await h.doc(`orders/${a.orderId}`);
  const oAfter = await h.docAfter(`orders/${a.orderId}`);
  if (!(getOr(o, "source", "") === "pos" && getOr(o, "status", "") !== "cancelled" && a.orderNumber === o.orderNumber)) return false;
  if (policy.windowDays > 0) {
    const sold = tsToDate(o.createdAt);
    if (!sold || w.now.getTime() > sold.getTime() + policy.windowDays * DAY_MS) return false;
  }
  if (
    !(
      oAfter.lastReturnId === w.id &&
      near(num(oAfter, "refundedTotal"), num(o, "refundedTotal") + a.refundTotal) &&
      num(oAfter, "refundedTotal") <= o.total + 0.005 &&
      near(num(oAfter, "refundedCash"), num(o, "refundedCash") + cash) &&
      near(num(oAfter, "refundedCard"), num(o, "refundedCard") + card) &&
      num(oAfter, "refundedCard") <= num(o, "cardAmount") + 0.005
    )
  ) {
    return false;
  }
  for (const l of lines) {
    if (!firstLines(o.lines).some((x) => x.productId === l.productId && x.variantId === l.variantId && x.size === l.size && x.price === l.unitPrice)) return false;
    const path = `returnCounters/${returnCounterId(a.orderId, l.productId, l.variantId, l.size)}`;
    const before = (await h.exists(path)) ? (await h.doc(path)).returnedQty : 0;
    if ((await h.docAfter(path)).returnedQty !== before + l.qty) return false;
    // The sale's per-line copy matches the counter.
    if (getOr(getOr(oAfter, "returnedByLine", {}), `${l.productId}::${l.variantId}::${l.size}`, -1) !== before + l.qty) return false;
  }
  return true;
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
    create: (h, w, a) =>
      any(
        async () =>
          (await h.isEditorOrAbove()) &&
          isString(a.branchId) &&
          isString(a.productId) &&
          w.id === `${a.branchId}__${a.productId}` &&
          isMap(a.stockByCell),
        async () => (await h.isCashierOrAbove()) && isValidReturnRestock(h, w)
      ),
    update: (h, w) => h.signedIn() && any(() => isValidBranchStockWrite(h, w), () => isValidReturnRestock(h, w)),
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
    // A cashier also reaches another branch's POS sale when taking it back:
    // by its id, by a query on its receipt number, or in the Returns
    // screen's list of sales still inside the return period -- never older
    // or unbounded lists of other branches' sales.
    get: (h, _c, d) =>
      any(
        () => h.withRole(["owner", "admin", "editor"]),
        async () =>
          (await h.withRole(["cashier"])) &&
          (keys(d).length === 0 || inList(getOr(d, "source", ""), ["web", "manual", "pos"]) || inList(getOr(d, "branchId", ""), await h.myBranchIds())),
        () => h.signedIn() && d.customerId === h.uid()
      ),
    list: (h, c, d) =>
      any(
        () => h.withRole(["owner", "admin", "editor"]),
        async () =>
          (await h.withRole(["cashier"])) &&
          (inList(getOr(d, "source", ""), ["web", "manual"]) ||
            inList(getOr(d, "branchId", ""), await h.myBranchIds()) ||
            (getOr(d, "source", "") === "pos" && (queryHasEq(c, "orderNumber") || (await isReturnableSalesQuery(h, c))))),
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
        async () => (await h.isBranchNoteEditorOrAbove()) && isValidCashierBranchNoteUpdate(w) && orderActorUidFieldsValid(h, w),
        // Marking an offline sale's stock shortage as reviewed (Admin → POS
        // Sales). Only these fields, so the sale's own actor fields
        // (cashierUid...) needn't match the admin.
        async () =>
          (await h.isAdminOrAbove()) &&
          getOr(strict(w.before!), "offline", false) === true &&
          hasOnly(affectedKeys(w.after, w.before), ["shortageReviewedAt", "shortageReviewedByName", "shortageReviewNote"]) &&
          eq((strict(w.after!) as Doc).shortageReviewedAt, timestamp(w.now)) &&
          size(getOr(strict(w.after!), "shortageReviewNote", "")) <= 500,
        // Refund totals of a POS sale, moved only together with the return
        // that justifies them (isValidPosReturn checks the figures).
        async () =>
          (await h.isCashierOrAbove()) &&
          hasOnly(affectedKeys(w.after, w.before), ORDER_REFUND_KEYS) &&
          (await freshReturn(h, (strict(w.after!) as Doc).lastReturnId)).orderId === w.id
      ),
    delete: (h) => h.isAdminOrAbove(),
  },

  // Automatic promotions: admins manage them, every till reads them.
  promotions: (() => {
    const valid = (a: Doc) =>
      isString(a.name) &&
      a.name.length > 0 &&
      a.name.length <= 80 &&
      isBool(a.active) &&
      inList(a.type, ["percent", "amount", "buy_x_get_y", "bundle"]) &&
      inList(a.scope, ["products", "categories", "sale"]) &&
      isNumber(a.value) &&
      a.value >= 0 &&
      (a.type !== "percent" || a.value <= 100) &&
      (a.scope !== "sale" || inList(a.type, ["percent", "amount"]));
    return {
      read: (h: H) => h.isAnyAdmin(),
      create: async (h: H, _w: WriteCtx, a: Doc) => (await h.isAdminOrAbove()) && valid(a),
      update: async (h: H, _w: WriteCtx, a: Doc) => (await h.isAdminOrAbove()) && valid(a),
      delete: (h: H) => h.isAdminOrAbove(),
    };
  })(),

  posReturns: {
    // By id (unguessable; also how a return checks it isn't a resubmit).
    get: (h) => h.withRole(["owner", "admin", "editor", "viewer", "cashier"]),
    list: (h, c, d) =>
      any(
        () => h.withRole(["owner", "admin", "editor", "viewer"]),
        async () =>
          (await h.withRole(["cashier"])) &&
          (inList(getOr(d, "branchId", ""), await h.myBranchIds()) ||
            inList(getOr(d, "saleBranchId", ""), await h.myBranchIds()) ||
            queryHasEq(c, "orderId"))
      ),
    create: (h, w, a) => isValidPosReturn(h, w, a),
    // Immutable: a return is corrected by another return, never edited.
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
        // Ledger row for a unit a POS return put back into branch stock.
        async () => {
          if (
            !(
              (await h.isCashierOrAbove()) &&
              a.reason === "return_restock" &&
              a.source === "pos" &&
              nonEmpty(a.productId) &&
              nonEmpty(a.variantId) &&
              nonEmpty(a.size) &&
              isInt(a.qtyBefore) &&
              isInt(a.qtyChange) &&
              a.qtyChange > 0 &&
              a.qtyAfter === a.qtyBefore + a.qtyChange &&
              actorOk()
            )
          ) {
            return false;
          }
          const ret = await freshReturn(h, a.returnId);
          return ret.branchId === a.branchId && ret.cashierUid === h.uid() && restockQty(ret, a.productId, `${a.variantId}::${a.size}`) === a.qtyChange;
        },
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

  // Sales put on hold at a till (src/firebase/heldSales.ts). A cashier holds
  // from their own open shift at their branch; any till of that branch may
  // take it back (held -> resumed) or drop it (held -> cancelled) -- once, so
  // two tills can never both carry on with it. Only those status changes.
  heldSales: (() => {
    const HELD_SALE_TTL_MS = 24 * 60 * 60 * 1000; // must match src/firebase/heldSales.ts
    const branchStaff = async (h: H, branchId: unknown) =>
      (await h.withRole(["owner", "admin", "editor", "viewer"])) || (await h.canSellAtBranch(branchId));
    return {
      read: (h: H, _c: ReadCtx, d: Doc) => branchStaff(h, getOr(d, "branchId", "")),
      create: async (h: H, w: WriteCtx, a: Doc) => {
        if (!(await h.isCashierOrAbove()) || !(await h.canSellAtBranch(a.branchId))) return false;
        if (!(a.status === "held" && a.cashierUid === h.uid() && isString(a.ref) && isList(a.lines) && a.lines.length > 0 && a.lines.length <= MAX_LINES)) return false;
        if (!eq(a.createdAt, timestamp(w.now))) return false;
        const s = await h.doc(`registerSessions/${a.sessionId}`);
        return s.status === "open" && s.cashierId === h.uid() && getOr(s, "branchId", "") === a.branchId;
      },
      update: async (h: H, w: WriteCtx, a: Doc, b: Doc) => {
        if (!(await h.isCashierOrAbove()) || !(await h.canSellAtBranch(b.branchId)) || b.status !== "held") return false;
        const changed = affectedKeys(w.after, w.before);
        if (a.status === "resumed") {
          const created = tsToDate(b.createdAt);
          return (
            hasOnly(changed, ["status", "resumedByUid", "resumedByName", "resumedSessionId", "resumedAt", "updatedAt"]) &&
            a.resumedByUid === h.uid() &&
            !!created &&
            w.now.getTime() - created.getTime() <= HELD_SALE_TTL_MS
          );
        }
        if (a.status === "cancelled") {
          return hasOnly(changed, ["status", "cancelledByUid", "cancelledByName", "cancelledAt", "updatedAt"]) && a.cancelledByUid === h.uid();
        }
        return false;
      },
      delete: (h: H) => h.isAdminOrAbove(),
    };
  })(),

  // Offline sales the server couldn't record as they were (shift closed, a
  // promotion changed meanwhile...): reported by the till so nothing is lost,
  // reviewed and marked resolved by owner/admin.
  posSyncIssues: {
    read: async (h, _c, d) => (await h.withRole(["owner", "admin", "editor", "viewer"])) || (await h.canSellAtBranch(getOr(d, "branchId", ""))),
    create: async (h, w, a) =>
      (await h.isCashierOrAbove()) &&
      (await h.canSellAtBranch(a.branchId)) &&
      a.status === "open" &&
      a.cashierUid === h.uid() &&
      isString(a.orderNumber) &&
      isString(a.reason) &&
      eq(a.reportedAt, timestamp(w.now)),
    update: async (h, w, a) =>
      (await h.isAdminOrAbove()) && hasOnly(affectedKeys(w.after, w.before), ["status", "resolvedByUid", "resolvedByName", "resolvedAt", "resolution"]) && a.resolvedByUid === h.uid(),
    delete: (h) => h.isAdminOrAbove(),
  },

  // End-of-day snapshots of a branch (Admin → Branches → End of day): one
  // per branch per day, id "<branchId>__<yyyy-mm-dd>". Owner/admin close the
  // day; closing it again replaces the figures as the next version.
  branchDaySnapshots: (() => {
    const valid = (h: H, w: WriteCtx, a: Doc) =>
      isString(a.branchId) &&
      isString(a.date) &&
      /^\d{4}-\d{2}-\d{2}$/.test(a.date) &&
      w.id === `${a.branchId}__${a.date}` &&
      isMap(a.figures) &&
      a.closedByUid === h.uid() &&
      isString(a.closedByName) &&
      eq(a.closedAt, timestamp(w.now)) &&
      isNumber(a.version) &&
      size(getOr(a, "note", "")) <= 500;
    return {
      read: (h: H) => h.isAdminOrAbove(),
      create: async (h: H, w: WriteCtx, a: Doc) => (await h.isAdminOrAbove()) && valid(h, w, a) && a.version === 1,
      update: async (h: H, w: WriteCtx, a: Doc) => {
        const before = strict(w.before!) as Doc;
        return (await h.isAdminOrAbove()) && valid(h, w, a) && a.branchId === before.branchId && a.date === before.date && a.version === (getOr(before, "version", 0) as number) + 1;
      },
      delete: (h: H) => h.isOwner(),
    };
  })(),

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
