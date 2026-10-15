import { phoneNumbersLikelyMatch } from "./nonDeliveryMatch";
import type { AdminOrder, AdminReturn, OrderStatus } from "./types";

// "Successful" means the customer actually received the goods and the sale
// stuck -- delivered or completed (a POS in-store sale is created directly
// as "completed", see orderTransaction.ts). Deliberately excludes
// shipped (still in transit, not yet confirmed received), and obviously
// excludes pending/processing/cancelled/refunded. This mirrors the Order
// Cancellation audit's own conclusion: a cancellation releases stock before
// anything shipped, so it was never a "successful" sale to begin with, and
// shouldn't quietly count as one.
export const SUCCESSFUL_ORDER_STATUSES: readonly OrderStatus[] = ["delivered", "completed"];

export interface CustomerHistorySummary {
  totalOrders: number;
  statusCounts: Partial<Record<OrderStatus, number>>;
  successfulCount: number;
  // Sum of order.total (not subtotal) across successful orders only -- see
  // the audit's own finding that customer.totalSpent sums subtotal and
  // never excludes cancelled/refunded orders, which is exactly why this
  // feature recomputes from live order data instead of reusing that field.
  successfulSpend: number;
  averageSuccessfulOrderValue: number | null;
  firstOrderAt: Date | null;
  lastOrderAt: Date | null;
  nonDeliveryFlaggedCount: number;
  // null means "not computed" (the guest path -- a guest's returns can
  // never be reliably linked, since a guest order carries no customerId for
  // AdminReturn.customerId to denormalize in the first place), NOT "known
  // zero returns". The UI must treat these two states differently.
  returnedOrderCount: number | null;
  // True as soon as at least one OTHER order exists for this customer --
  // `orders` passed in here is expected to already exclude the order
  // currently being viewed (see OrderDetail.tsx), so "repeat customer"
  // means "this is not their only order."
  isRepeatCustomer: boolean;
  cancelledCount: number;
  cancellationRatio: number | null;
}

function toDate(value: unknown): Date | null {
  if (!value) return null;
  const ts = value as { toDate?: () => Date };
  if (typeof ts.toDate === "function") {
    const d = ts.toDate();
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(value as string | number);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Pure -- no Firestore reads, no writes. Takes whatever orders/returns the
// caller already fetched (see OrderDetail.tsx) and derives every displayed
// figure fresh, rather than trusting the stored customer.ordersCount/
// totalSpent counters, which the audit confirmed never get corrected for a
// later cancellation, return, or refund.
export function summarizeCustomerHistory(orders: AdminOrder[], returns: AdminReturn[] | null): CustomerHistorySummary {
  const statusCounts: Partial<Record<OrderStatus, number>> = {};
  let successfulCount = 0;
  let successfulSpend = 0;
  let cancelledCount = 0;
  let nonDeliveryFlaggedCount = 0;
  let firstOrderAt: Date | null = null;
  let lastOrderAt: Date | null = null;

  for (const order of orders) {
    statusCounts[order.status] = (statusCounts[order.status] ?? 0) + 1;
    if (SUCCESSFUL_ORDER_STATUSES.includes(order.status)) {
      successfulCount += 1;
      successfulSpend += order.total;
    }
    if (order.status === "cancelled") cancelledCount += 1;
    if (order.nonDeliveryFlagged) nonDeliveryFlaggedCount += 1;

    const createdAt = toDate(order.createdAt);
    if (createdAt) {
      if (!firstOrderAt || createdAt < firstOrderAt) firstOrderAt = createdAt;
      if (!lastOrderAt || createdAt > lastOrderAt) lastOrderAt = createdAt;
    }
  }

  // Deduped by orderId -- a single order can have multiple return records
  // (separate line items returned separately), but this counts ORDERS that
  // had at least one return, matching every other count here being an
  // order count, not a line-item count.
  const returnedOrderCount = returns === null ? null : new Set(returns.map((r) => r.orderId)).size;

  return {
    totalOrders: orders.length,
    statusCounts,
    successfulCount,
    successfulSpend,
    averageSuccessfulOrderValue: successfulCount > 0 ? successfulSpend / successfulCount : null,
    firstOrderAt,
    lastOrderAt,
    nonDeliveryFlaggedCount,
    returnedOrderCount,
    isRepeatCustomer: orders.length >= 1,
    cancelledCount,
    cancellationRatio: orders.length > 0 ? cancelledCount / orders.length : null,
  };
}

function normalizeEmail(email: string | undefined | null): string {
  return (email ?? "").trim().toLowerCase();
}

export interface GuestOrderMatch {
  order: AdminOrder;
  matchedBy: "email" | "phone";
}

// Guest checkouts have no persistent identity (see the audit) -- this only
// ever produces a "possible match" list, never a confirmed one. `candidates`
// is expected to already be a narrow, pre-fetched set (an exact-string
// Firestore query on customerEmail and/or customerPhone -- see
// OrderDetail.tsx), NOT the whole orders collection; this function just
// does the final matching/labeling over that set, the same "narrow
// candidates in, pure comparison logic here" split nonDeliveryMatch.ts's
// own findNonDeliveryMatches() already uses.
//
// Email is compared as an exact, normalized (trimmed, lower-cased) match.
// Phone reuses phoneNumbersLikelyMatch() unchanged -- no new matching logic
// is introduced. Name is deliberately never consulted, even as a
// tie-breaker: nonDeliveryMatch.ts's own nonDeliveryNameMatches() exists
// precisely because a name alone is too weak a signal (common first names
// would false-positive), and no concrete tie-breaking scenario was specified
// here that would justify combining it in.
export function findGuestPossibleMatches(
  candidates: AdminOrder[],
  target: { email?: string; phone?: string },
  excludeOrderId: string
): GuestOrderMatch[] {
  const targetEmail = normalizeEmail(target.email);
  const matches: GuestOrderMatch[] = [];
  const seen = new Set<string>();

  for (const order of candidates) {
    if (order.id === excludeOrderId || seen.has(order.id)) continue;
    if (targetEmail && normalizeEmail(order.customerEmail) === targetEmail) {
      matches.push({ order, matchedBy: "email" });
      seen.add(order.id);
    } else if (phoneNumbersLikelyMatch(order.customerPhone, target.phone)) {
      matches.push({ order, matchedBy: "phone" });
      seen.add(order.id);
    }
  }

  return matches;
}
