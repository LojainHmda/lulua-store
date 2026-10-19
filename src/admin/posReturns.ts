import type { AdminOrder, PosRefundMethod, PosReturnPolicyDoc } from "./types";

// Pure helpers for in-store returns (no database access) -- the one place
// refund amounts, the return window and the refund split are computed, used
// by the POS Returns screen, the return transaction (firebase/posReturn.ts)
// and the unit tests. The security rules (services/api/src/rules) re-check
// the money caps independently.

export const POS_RETURN_POLICY_DEFAULTS: PosReturnPolicyDoc = {
  windowDays: 14,
  allowNoReceipt: false,
  nonReturnableCategoryIds: [],
};

// A return without a receipt is capped like a sale; a receipt return can
// never have more lines than the sale it reverses.
export const MAX_RETURN_LINES = 8;

// How far back the Returns screen looks for sales when the policy has no
// return period (the rules allow cashiers exactly this far back).
export const SEARCH_DAYS_WITHOUT_WINDOW = 90;

// The window of sales the Returns screen loads: the return period, or
// SEARCH_DAYS_WITHOUT_WINDOW when there is none.
export function returnSearchSince(windowDays: number, now = Date.now()): Date {
  return new Date(now - (windowDays > 0 ? windowDays : SEARCH_DAYS_WITHOUT_WINDOW) * DAY_MS);
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const round2 = (n: number) => Math.round(n * 100) / 100;

// Same id shape as returnCounters/{id} in the rules: the running "units
// already returned" for one line of one sale, shared with the online
// returns flow so a unit can never be returned twice through either.
export function returnCounterId(orderId: string, productId: string, variantId: string, size: string): string {
  return `${orderId}::${productId}::${variantId}::${size}`;
}

export function posReturnLineKey(productId: string, variantId: string, size: string): string {
  return `${productId}::${variantId}::${size}`;
}

// Units of one line of a sale that can still be returned.
export function saleLineRemaining(
  order: Pick<AdminOrder, "returnedByLine">,
  line: { productId: string; variantId: string; size: string; qty: number }
): number {
  return Math.max(0, line.qty - (order.returnedByLine?.[posReturnLineKey(line.productId, line.variantId, line.size)] ?? 0));
}

// POS sale numbers ("SIS-…", printed on the receipt and in its barcode).
export function isSaleNumber(code: string): boolean {
  return /^SIS-[A-Z0-9]+$/i.test(code.trim());
}

export function newReturnNumber(now = Date.now()): string {
  return `RET-${now.toString(36).toUpperCase()}`;
}

// What each line of a sale actually cost the customer: its price x qty minus
// its share of the sale's discount (shared in proportion to line value). The
// last line takes the rounding remainder, so the nets always add up to
// exactly the sale total -- a sale returned in full refunds exactly what was
// paid, never a cent more or less.
//
// A line's own promotion discount (OrderLine.promoDiscount) stays on that
// line; only the sale-wide part (a whole-sale promotion, a manual discount)
// is shared out.
export function saleLineNets(order: Pick<AdminOrder, "lines" | "subtotal" | "discount" | "total" | "shipping">): number[] {
  const goods = round2(order.total - (order.shipping ?? 0));
  const base = order.lines.map((l) => round2(l.price * l.qty - (l.promoDiscount ?? 0)));
  const baseTotal = base.reduce((s, g) => s + g, 0);
  const discount = Math.max(0, round2(baseTotal - goods));
  if (order.lines.length === 0) return [];
  const nets = base.map((g) => (baseTotal > 0 ? round2(g - (discount * g) / baseTotal) : 0));
  const others = nets.slice(0, -1).reduce((s, n) => s + n, 0);
  nets[nets.length - 1] = round2(goods - others);
  return nets;
}

// Refund for returning `qty` more units of a line whose net value is
// `lineNet` over `soldQty` units, `alreadyReturned` of which came back
// before. Computed as a difference of running totals, so returning a line
// one unit at a time adds up to exactly the line's net value.
export function refundForUnits(lineNet: number, soldQty: number, alreadyReturned: number, qty: number): number {
  if (soldQty <= 0 || qty <= 0) return 0;
  const upTo = (n: number) => round2((lineNet * Math.min(n, soldQty)) / soldQty);
  return round2(upTo(alreadyReturned + qty) - upTo(alreadyReturned));
}

// The last moment a sale can still be returned; null = no limit.
export function returnDeadline(saleDate: Date, windowDays: number): Date | null {
  if (!(windowDays > 0)) return null;
  return new Date(saleDate.getTime() + windowDays * DAY_MS);
}

export function isWithinReturnWindow(saleDate: Date | null, windowDays: number, now = new Date()): boolean {
  const deadline = saleDate ? returnDeadline(saleDate, windowDays) : null;
  return !deadline || now.getTime() <= deadline.getTime();
}

// Card can only be refunded up to what was paid by card on the sale and not
// yet refunded to card. Cash is not capped by the sale (the store may pay a
// card sale back in cash); it is capped by the drawer instead.
export function cardRefundable(order: Pick<AdminOrder, "cardAmount" | "refundedCard"> | null): number {
  if (!order) return Infinity;
  return Math.max(0, round2((order.cardAmount ?? 0) - (order.refundedCard ?? 0)));
}

// The refund split the screen starts from: back the way the sale was paid
// (split sales in the same cash/card proportion), never more to card than
// is still refundable there. A return without a sale defaults to cash.
export function defaultRefundSplit(
  order: Pick<AdminOrder, "paymentMethod" | "cardAmount" | "total" | "refundedCard"> | null,
  refundTotal: number
): { method: PosRefundMethod; card: number } {
  if (!order || refundTotal <= 0) return { method: "cash", card: 0 };
  const maxCard = cardRefundable(order);
  let card = 0;
  if (order.paymentMethod === "card") card = refundTotal;
  else if (order.paymentMethod === "split" && order.total > 0) card = round2((refundTotal * (order.cardAmount ?? 0)) / order.total);
  card = round2(Math.min(card, maxCard, refundTotal));
  return { method: refundMethodFor(round2(refundTotal - card), card), card };
}

export function refundMethodFor(cash: number, card: number): PosRefundMethod {
  if (card > 0 && cash > 0) return "split";
  return card > 0 ? "card" : "cash";
}
