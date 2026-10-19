import { collection, doc, getDoc, getDocs, limit, orderBy, query, runTransaction, serverTimestamp, Timestamp, where } from "../db/firestore";
import type { Firestore } from "../db/firestore";
import { subtreeSlugs } from "../data/categoryTree";
import { normalizeProduct, stockCellKey } from "../admin/productVariants";
import {
  cardRefundable,
  isWithinReturnWindow,
  MAX_RETURN_LINES,
  POS_RETURN_POLICY_DEFAULTS,
  posReturnLineKey,
  refundForUnits,
  saleLineRemaining,
  refundMethodFor,
  returnCounterId,
  round2,
  saleLineNets,
} from "../admin/posReturns";
import type {
  AdminCategory,
  AdminOrder,
  AdminProduct,
  BranchStockDoc,
  PosReturn,
  PosReturnLine,
  PosReturnPolicyDoc,
  RegisterSession,
  ReturnReason,
} from "../admin/types";

// In-store returns (refunds) at a POS register. Every function takes the
// Firestore instance explicitly (the app passes firebase/config's `db`), so
// the rules tests can run the real transaction against the real rules.
//
// One return = one transaction: the return record, the sale's per-line
// "already returned" counters and refund totals, the receiving branch's
// stock (+ one ledger row per restocked line) and the shift's refund totals
// all commit together or not at all. services/api/src/rules re-checks the
// money and stock figures against each other server-side.

export type PosReturnErrorCode =
  | "duplicateLine"
  | "noLines"
  | "tooManyLines"
  | "badQty"
  | "sessionClosed"
  | "notYourSession"
  | "saleNotFound"
  | "notPosSale"
  | "saleCancelled"
  | "windowExpired"
  | "lineNotOnSale"
  | "overReturn"
  | "notReturnable"
  | "noReceiptDisabled"
  | "productMissing"
  | "cannotRestock"
  | "amountChanged"
  | "cardTooHigh"
  | "badSplit"
  | "drawerShort";

export class PosReturnError extends Error {
  readonly code: PosReturnErrorCode;
  readonly params: Record<string, string | number>;
  constructor(code: PosReturnErrorCode, params: Record<string, string | number> = {}, message?: string) {
    super(message ?? code);
    this.code = code;
    this.params = params;
  }
}

export interface ReturnPolicy {
  policy: PosReturnPolicyDoc;
  // Category slugs (whole sub-trees of the configured categories) whose
  // products can't be returned.
  nonReturnableSlugs: Set<string>;
}

export async function loadReturnPolicy(fs: Firestore): Promise<ReturnPolicy> {
  const snap = await getDoc(doc(fs, "settings", "posReturns"));
  const policy = { ...POS_RETURN_POLICY_DEFAULTS, ...(snap.exists() ? (snap.data() as Partial<PosReturnPolicyDoc>) : {}) };
  const nonReturnableSlugs = new Set<string>();
  if (policy.nonReturnableCategoryIds.length > 0) {
    const cats = (await getDocs(collection(fs, "categories"))).docs.map((d) => ({ id: d.id, ...d.data() }) as AdminCategory);
    for (const id of policy.nonReturnableCategoryIds) for (const slug of subtreeSlugs(cats, id)) nonReturnableSlugs.add(slug);
  }
  return { policy, nonReturnableSlugs };
}

// Every product, not just sellable ones: an item that is archived, out of
// stock or otherwise unsellable today can still come back. Only used to
// resolve scans/searches on the Returns screen -- never to sell.
export async function listReturnLookupProducts(fs: Firestore): Promise<AdminProduct[]> {
  const snap = await getDocs(collection(fs, "products"));
  return snap.docs.map((d) => normalizeProduct({ id: d.id, ...d.data() } as AdminProduct));
}

function toOrder(id: string, data: Record<string, unknown>): AdminOrder {
  return { id, ...data } as AdminOrder;
}

export function tsDate(v: unknown): Date | null {
  const ts = v as { toDate?: () => Date } | undefined;
  return ts?.toDate ? ts.toDate() : null;
}

// The sale a receipt belongs to (receipt number typed or scanned). Any
// branch: a cashier may take back a sale made at another branch.
export async function findSaleByNumber(fs: Firestore, saleNumber: string): Promise<AdminOrder | null> {
  const snap = await getDocs(query(collection(fs, "orders"), where("orderNumber", "==", saleNumber.trim().toUpperCase()), limit(1)));
  const d = snap.docs[0];
  return d ? toOrder(d.id, d.data()) : null;
}

// Every branch's POS sales since `since` that can still be returned (not
// cancelled, not already returned in full), newest first. The Returns
// screen lists only the products on these, and finds an item's sale here.
export async function listReturnableSales(fs: Firestore, since: Date): Promise<AdminOrder[]> {
  const snap = await getDocs(
    query(collection(fs, "orders"), where("source", "==", "pos"), where("createdAt", ">=", Timestamp.fromDate(since)), orderBy("createdAt", "desc"), limit(2000))
  );
  const orders = snap.docs.map((d) => toOrder(d.id, d.data())).filter((o) => o.status !== "cancelled" && o.refundStatus !== "full");
  // Sales returned from before returnedByLine existed: read their counters.
  await Promise.all(
    orders
      .filter((o) => (o.returnCount ?? 0) > 0 && !o.returnedByLine)
      .map(async (o) => {
        o.returnedByLine = Object.fromEntries(await loadReturnedQty(fs, o));
      })
  );
  return orders.filter((o) => o.lines.some((l) => saleLineRemaining(o, l) > 0));
}

// Units of each line of a sale already returned (in store or through the
// online returns flow -- both use the same counters).
export async function loadReturnedQty(fs: Firestore, order: AdminOrder): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  await Promise.all(
    order.lines.map(async (l) => {
      const snap = await getDoc(doc(fs, "returnCounters", returnCounterId(order.id, l.productId, l.variantId, l.size)));
      out.set(posReturnLineKey(l.productId, l.variantId, l.size), snap.exists() ? ((snap.get("returnedQty") as number) ?? 0) : 0);
    })
  );
  return out;
}

export async function listReturnsForSale(fs: Firestore, orderId: string): Promise<PosReturn[]> {
  const snap = await getDocs(query(collection(fs, "posReturns"), where("orderId", "==", orderId)));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as PosReturn).sort((a, b) => (tsDate(a.createdAt)?.getTime() ?? 0) - (tsDate(b.createdAt)?.getTime() ?? 0));
}

export interface PosReturnRequestLine {
  productId: string;
  variantId: string;
  size: string;
  qty: number;
  restock: boolean;
}

export interface PosReturnRequest {
  // Chosen once per return on the screen and reused on every retry, so a
  // repeated submit (double click, retry after a timeout that actually went
  // through) finds the first one instead of refunding twice.
  returnId: string;
  returnNumber: string;
  sessionId: string;
  // Set = a return against that sale; absent = no receipt.
  orderId?: string;
  lines: PosReturnRequestLine[];
  // The card leg of the refund; the rest is paid in cash.
  cardRefund: number;
  // The total the cashier confirmed. If the amounts worked out here differ
  // (the sale changed meanwhile), nothing is written.
  expectedRefundTotal: number;
  reason: ReturnReason;
  note?: string;
}

export interface PosReturnResult {
  record: PosReturn;
  // true = this return was already recorded by an earlier attempt.
  alreadyProcessed: boolean;
}

export async function processPosReturn(fs: Firestore, req: PosReturnRequest, actor: { uid: string }, returnPolicy: ReturnPolicy): Promise<PosReturnResult> {
  const { policy, nonReturnableSlugs } = returnPolicy;
  const lines = req.lines.filter((l) => l.qty > 0);
  if (lines.length === 0) throw new PosReturnError("noLines");
  if (lines.length > MAX_RETURN_LINES) throw new PosReturnError("tooManyLines", { max: MAX_RETURN_LINES });
  const keys = lines.map((l) => posReturnLineKey(l.productId, l.variantId, l.size));
  if (new Set(keys).size !== keys.length) throw new PosReturnError("duplicateLine");
  if (lines.some((l) => !Number.isInteger(l.qty) || l.qty <= 0)) throw new PosReturnError("badQty");
  if (!(req.cardRefund >= 0)) throw new PosReturnError("badSplit");

  const returnRef = doc(fs, "posReturns", req.returnId);
  const sessionRef = doc(fs, "registerSessions", req.sessionId);
  const orderRef = req.orderId ? doc(fs, "orders", req.orderId) : null;
  const productIds = [...new Set(lines.map((l) => l.productId))];

  return runTransaction(fs, async (tx) => {
    const existing = await tx.get(returnRef);
    if (existing.exists()) {
      return { record: { id: existing.id, ...existing.data() } as PosReturn, alreadyProcessed: true };
    }
    const sessionSnap = await tx.get(sessionRef);
    if (!sessionSnap.exists()) throw new PosReturnError("sessionClosed");
    const session = { id: sessionSnap.id, ...sessionSnap.data() } as RegisterSession;
    if (session.status !== "open" || !session.branchId || !session.registerId) throw new PosReturnError("sessionClosed");
    if (session.cashierId !== actor.uid) throw new PosReturnError("notYourSession");
    const branchId = session.branchId;

    const orderSnap = orderRef ? await tx.get(orderRef) : null;
    let order: AdminOrder | null = null;
    if (orderRef) {
      if (!orderSnap?.exists()) throw new PosReturnError("saleNotFound");
      order = toOrder(orderSnap.id, orderSnap.data());
      if (order.source !== "pos") throw new PosReturnError("notPosSale");
      if (order.status === "cancelled") throw new PosReturnError("saleCancelled");
      if (!isWithinReturnWindow(tsDate(order.createdAt), policy.windowDays)) throw new PosReturnError("windowExpired", { days: policy.windowDays });
    } else if (!policy.allowNoReceipt) {
      throw new PosReturnError("noReceiptDisabled");
    }

    // Every line of the sale, not just the returned ones: needed to tell a
    // partial return from a full one.
    const counterRefs = order ? order.lines.map((l) => doc(fs, "returnCounters", returnCounterId(order!.id, l.productId, l.variantId, l.size))) : [];
    const counterSnaps = await Promise.all(counterRefs.map((r) => tx.get(r)));
    const returnedBefore = new Map<string, number>();
    order?.lines.forEach((l, i) => {
      const s = counterSnaps[i];
      returnedBefore.set(posReturnLineKey(l.productId, l.variantId, l.size), s.exists() ? ((s.get("returnedQty") as number) ?? 0) : 0);
    });

    const productSnaps = await Promise.all(productIds.map((id) => tx.get(doc(fs, "products", id))));
    const productById = new Map<string, AdminProduct>();
    productSnaps.forEach((s) => {
      if (s.exists()) productById.set(s.id, normalizeProduct({ id: s.id, ...s.data() } as AdminProduct));
    });

    const restockProductIds = [...new Set(lines.filter((l) => l.restock).map((l) => l.productId))];
    const stockRefs = restockProductIds.map((id) => doc(fs, "branchStock", `${branchId}__${id}`));
    const stockSnaps = await Promise.all(stockRefs.map((r) => tx.get(r)));

    const nets = order ? saleLineNets(order) : [];
    const outLines: PosReturnLine[] = lines.map((l) => {
      const product = productById.get(l.productId);
      const variant = product?.colorVariants.find((v) => v.id === l.variantId);
      const cellExists = !!variant?.sizeStock.some((s) => s.size === l.size);
      if (product && nonReturnableSlugs.has(product.category)) throw new PosReturnError("notReturnable", { name: product.name });
      if (l.restock && !cellExists) throw new PosReturnError("cannotRestock", { name: product?.name ?? l.productId });

      if (order) {
        const i = order.lines.findIndex((x) => x.productId === l.productId && x.variantId === l.variantId && x.size === l.size);
        if (i < 0) throw new PosReturnError("lineNotOnSale");
        const sold = order.lines[i];
        const before = returnedBefore.get(posReturnLineKey(l.productId, l.variantId, l.size)) ?? 0;
        if (before + l.qty > sold.qty) throw new PosReturnError("overReturn", { name: sold.name, left: Math.max(0, sold.qty - before) });
        return {
          productId: l.productId,
          variantId: l.variantId,
          size: l.size,
          name: sold.name,
          color: sold.color,
          qty: l.qty,
          unitPrice: sold.price,
          refund: refundForUnits(nets[i], sold.qty, before, l.qty),
          restock: l.restock,
        };
      }
      if (!product || !variant || !cellExists) throw new PosReturnError("productMissing");
      return {
        productId: l.productId,
        variantId: l.variantId,
        size: l.size,
        name: product.name,
        color: variant.colorName,
        qty: l.qty,
        unitPrice: product.price,
        refund: round2(product.price * l.qty),
        restock: l.restock,
      };
    });

    const refundTotal = round2(outLines.reduce((s, l) => s + l.refund, 0));
    if (Math.abs(refundTotal - req.expectedRefundTotal) > 0.005) throw new PosReturnError("amountChanged", { total: refundTotal });
    const cardRefund = round2(req.cardRefund);
    const cashRefund = round2(refundTotal - cardRefund);
    if (cashRefund < 0) throw new PosReturnError("badSplit");
    if (cardRefund > cardRefundable(order) + 0.005) throw new PosReturnError("cardTooHigh", { max: cardRefundable(order) });
    const drawer = round2(session.startingCash + session.cashTotal - (session.cashOutTotal ?? 0) - (session.cashRefundTotal ?? 0));
    if (cashRefund > drawer + 0.005) throw new PosReturnError("drawerShort", { cash: drawer });

    const itemCount = outLines.reduce((s, l) => s + l.qty, 0);
    const record: Omit<PosReturn, "id" | "createdAt"> = {
      returnNumber: req.returnNumber,
      kind: order ? "receipt" : "no_receipt",
      ...(order
        ? {
            orderId: order.id,
            orderNumber: order.orderNumber,
            ...(order.branchId ? { saleBranchId: order.branchId } : {}),
            ...(order.branchName ? { saleBranchName: order.branchName } : {}),
            ...(order.registerName ? { saleRegisterName: order.registerName } : {}),
            ...(order.createdAt ? { saleCreatedAt: order.createdAt } : {}),
          }
        : {}),
      branchId,
      ...(session.branchName ? { branchName: session.branchName } : {}),
      ...(session.branchCode ? { branchCode: session.branchCode } : {}),
      registerId: session.registerId,
      ...(session.registerName ? { registerName: session.registerName } : {}),
      sessionId: session.id,
      cashierUid: actor.uid,
      cashierName: session.cashierName,
      ...(session.operatorId ? { operatorId: session.operatorId } : {}),
      lines: outLines,
      itemCount,
      refundTotal,
      refundMethod: refundMethodFor(cashRefund, cardRefund),
      cashRefund,
      cardRefund,
      reason: req.reason,
      ...(req.note?.trim() ? { note: req.note.trim().slice(0, 300) } : {}),
    };
    tx.set(returnRef, { ...record, createdAt: serverTimestamp() });

    if (order && orderRef) {
      let soldUnits = 0;
      let returnedUnits = 0;
      // Units returned so far per line (the counters' values after this
      // return) -- kept on the sale so lists can tell which items are left.
      const returnedByLine: Record<string, number> = {};
      order.lines.forEach((l, i) => {
        const key = posReturnLineKey(l.productId, l.variantId, l.size);
        const before = returnedBefore.get(key) ?? 0;
        const now = outLines.find((x) => posReturnLineKey(x.productId, x.variantId, x.size) === key)?.qty ?? 0;
        soldUnits += l.qty;
        returnedUnits += before + now;
        returnedByLine[key] = before + now;
        if (now > 0) {
          tx.set(counterRefs[i], { orderId: order!.id, productId: l.productId, variantId: l.variantId, size: l.size, returnedQty: before + now, updatedAt: serverTimestamp() });
        }
      });
      tx.update(orderRef, {
        refundedTotal: round2((order.refundedTotal ?? 0) + refundTotal),
        refundedCash: round2((order.refundedCash ?? 0) + cashRefund),
        refundedCard: round2((order.refundedCard ?? 0) + cardRefund),
        returnedQty: (order.returnedQty ?? 0) + itemCount,
        returnedByLine,
        returnCount: (order.returnCount ?? 0) + 1,
        refundStatus: returnedUnits >= soldUnits ? "full" : "partial",
        lastReturnId: req.returnId,
        updatedAt: serverTimestamp(),
      });
    }

    let movementNo = 0;
    restockProductIds.forEach((productId, i) => {
      const snap = stockSnaps[i];
      const current = ((snap.exists() ? snap.get("stockByCell") : undefined) ?? {}) as BranchStockDoc["stockByCell"];
      const next = { ...current };
      for (const l of outLines.filter((x) => x.restock && x.productId === productId)) {
        const key = stockCellKey(l.variantId, l.size);
        const before = typeof next[key]?.qty === "number" ? (next[key].qty as number) : 0;
        next[key] = { ...next[key], qty: before + l.qty };
        tx.set(doc(fs, "stockMovements", `${req.returnId}__${movementNo++}`), {
          productId,
          productName: l.name,
          variantId: l.variantId,
          colorName: l.color,
          size: l.size,
          qtyBefore: before,
          qtyChange: l.qty,
          qtyAfter: before + l.qty,
          reason: "return_restock",
          source: "pos",
          actorUid: actor.uid,
          actorName: session.cashierName,
          ...(order ? { orderId: order.id, orderNumber: order.orderNumber } : {}),
          returnId: req.returnId,
          branchId,
          registerId: session.registerId,
          ...(session.registerName ? { registerName: session.registerName } : {}),
          createdAt: serverTimestamp(),
        });
      }
      if (snap.exists()) tx.update(stockRefs[i], { stockByCell: next, lastReturnId: req.returnId, updatedAt: serverTimestamp() });
      else tx.set(stockRefs[i], { branchId, productId, stockByCell: next, lastReturnId: req.returnId, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    });

    tx.update(sessionRef, {
      refundCount: (session.refundCount ?? 0) + 1,
      refundTotal: round2((session.refundTotal ?? 0) + refundTotal),
      cashRefundTotal: round2((session.cashRefundTotal ?? 0) + cashRefund),
      cardRefundTotal: round2((session.cardRefundTotal ?? 0) + cardRefund),
      updatedAt: serverTimestamp(),
    });

    return { record: { id: req.returnId, ...record, createdAt: Timestamp.now() } as PosReturn, alreadyProcessed: false };
  });
}
