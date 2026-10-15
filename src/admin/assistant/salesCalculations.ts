// Canonical V1 sales definition for the Assistant. Pure functions only --
// no Firestore reads (see operations.ts for the bounded fetch that feeds
// these). Deliberately its OWN definition, not a reuse of
// customer.totalSpent/ordersCount (never corrected for cancellation/return,
// see customerHistory.ts's own comment), Dashboard.tsx's revenue calc
// (correct-ish but capped at the 500 most recent orders with no date
// bound), Reports.tsx's (excludes cancelled but NOT refunded -- an
// unnoticed inconsistency), or POS RegisterSession.grossTotal (shift
// reconciliation only). See the discovery audit's §4 for the full
// comparison. This is intentionally close to Dashboard.tsx's definition
// (the more correct of the two existing store-wide ones), made explicit
// and documented as the one the assistant always uses and always states.
import type { AdminOrder, OrderStatus } from "../types";

// Sales = every order except these two -- a cancellation released its
// stock/never shipped, and a refund means the money came back. Everything
// else (pending/processing/ready/shipped/delivered/completed) counts,
// deliberately including orders that haven't shipped yet: "what were
// today's sales" means "what did we book today", not "what have we
// definitely delivered" (see confirmedSalesTotals below for that narrower
// question).
export const SALES_EXCLUDED_STATUSES: readonly OrderStatus[] = ["cancelled", "refunded"];

export function isIncludedInSales(order: Pick<AdminOrder, "status">): boolean {
  return !SALES_EXCLUDED_STATUSES.includes(order.status);
}

// Mirrors customerHistory.ts's own SUCCESSFUL_ORDER_STATUSES exactly --
// re-declared here (not imported) only because importing a customer-scoped
// module's constant into a store-wide sales module would be a strange
// dependency direction; the VALUE is identical on purpose, not a
// coincidence, and must be kept in sync with customerHistory.ts if that
// ever changes.
export const CONFIRMED_SALES_STATUSES: readonly OrderStatus[] = ["delivered", "completed"];

export function isConfirmedSale(order: Pick<AdminOrder, "status">): boolean {
  return CONFIRMED_SALES_STATUSES.includes(order.status);
}

export interface SalesTotals {
  totalSales: number;
  orderCount: number;
  /** null, never NaN or 0, when orderCount is 0 -- see the explicit "never divide by zero" requirement. */
  averageOrderValue: number | null;
}

function computeTotals(includedOrders: AdminOrder[]): SalesTotals {
  const totalSales = includedOrders.reduce((sum, o) => sum + o.total, 0);
  const orderCount = includedOrders.length;
  return { totalSales, orderCount, averageOrderValue: orderCount > 0 ? totalSales / orderCount : null };
}

// `orders` is expected to already be the bounded, date-range-filtered set
// fetched by operations.ts -- this function does no further date
// filtering, only the status inclusion rule. `order.total` already nets
// discount and includes shipping (subtotal - discount + shipping, verified
// identical across orderTransaction.ts/adminOrderEdit.ts/Terminal.tsx), so
// there is no separate "should shipping/discount be included" decision to
// make here.
export function computeSalesTotals(orders: AdminOrder[]): SalesTotals {
  return computeTotals(orders.filter(isIncludedInSales));
}

// The narrower, "definitely happened" figure -- delivered/completed only.
// Never substituted for computeSalesTotals(); only ever shown as an
// explicitly separate, explicitly labeled secondary figure (see
// answerFormatter.ts).
export function computeConfirmedSalesTotals(orders: AdminOrder[]): SalesTotals {
  return computeTotals(orders.filter(isConfirmedSale));
}

export function countByStatus(orders: AdminOrder[], status: OrderStatus): number {
  return orders.filter((o) => o.status === status).length;
}

export interface StatusBreakdown {
  pending: number;
  processing: number;
  ready: number;
  shipped: number;
  delivered: number;
  cancelled: number;
  refunded: number;
  completed: number;
}

export function computeStatusBreakdown(orders: AdminOrder[]): StatusBreakdown {
  return {
    pending: countByStatus(orders, "pending"),
    processing: countByStatus(orders, "processing"),
    ready: countByStatus(orders, "ready"),
    shipped: countByStatus(orders, "shipped"),
    delivered: countByStatus(orders, "delivered"),
    cancelled: countByStatus(orders, "cancelled"),
    refunded: countByStatus(orders, "refunded"),
    completed: countByStatus(orders, "completed"),
  };
}

export interface ComparisonResult {
  a: SalesTotals;
  b: SalesTotals;
  /** a.totalSales - b.totalSales -- a plain arithmetic fact, never framed as "better"/"worse". */
  salesDifference: number;
  /** null when b.totalSales is 0 -- never divide by zero. */
  salesPercentChange: number | null;
  orderCountDifference: number;
}

export function compareSales(ordersA: AdminOrder[], ordersB: AdminOrder[]): ComparisonResult {
  const a = computeSalesTotals(ordersA);
  const b = computeSalesTotals(ordersB);
  return {
    a,
    b,
    salesDifference: a.totalSales - b.totalSales,
    salesPercentChange: b.totalSales !== 0 ? (a.totalSales - b.totalSales) / b.totalSales : null,
    orderCountDifference: a.orderCount - b.orderCount,
  };
}

export function totalUnitsSold(orders: AdminOrder[]): number {
  return orders.filter(isIncludedInSales).reduce((sum, o) => sum + o.lines.reduce((s, l) => s + l.qty, 0), 0);
}
