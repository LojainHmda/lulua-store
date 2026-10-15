import type { AdminOrder, OrderStatus } from "./types";

// Pure helper only — no Firestore access — mirroring the style of
// orderBulkStatus.ts / returnsHelpers.ts. The one live subscription this
// powers lives in ../hooks/usePendingOrdersCount.ts.

// Canonical statuses counted by the "الطلبات" nav badge (AdminLayout.tsx):
// orders still somewhere in the preparation workflow, not yet handed off.
//
// This is an interpretive mapping, not a literal one, and is documented
// here deliberately rather than left implicit:
//   - The requested "جاري التحضير" matches OrderStatus "processing" exactly
//     (admin.orderStatus.processing = "جاري التحضير 📥").
//   - The requested "جاري التجهيز" does NOT appear verbatim as any status's
//     Arabic label. The only two statuses whose Arabic label shares its
//     "التجهيز" root are "pending" ("بانتظار التجهيز 📥") and "ready" ("تم
//     التجهيز ✅") -- and "ready" is explicitly on the do-not-count list, so
//     by elimination "pending" is the intended match.
//   - This also matches how the rest of the codebase already treats these
//     two statuses as one phase: OrderDetail.tsx's `isEditable` and its
//     "still pending/processing" checks, and PREPARABLE_STATUSES minus
//     "ready", all group pending+processing together as "not yet finalized"
//     -- the same "still being prepared" phase the badge is meant to count.
// "ready" (تم التجهيز), "shipped", "delivered", "cancelled", "refunded", and
// "completed" are deliberately excluded, exactly per the do-not-count list.
export const PENDING_ORDER_STATUSES: OrderStatus[] = ["pending", "processing"];

export function isPendingOrderStatus(status: OrderStatus): boolean {
  return PENDING_ORDER_STATUSES.includes(status);
}

// Pure count over whatever order list a caller already has in hand. Takes
// only `status` so it's trivial to test without constructing full AdminOrder
// fixtures, and so it can be reused equally against a live Firestore-backed
// list or an in-memory one.
export function countPendingOrders(orders: Pick<AdminOrder, "status">[]): number {
  return orders.filter((o) => isPendingOrderStatus(o.status)).length;
}

// Every canonical OrderStatus (src/admin/types.ts), in the same order the
// single-order status dropdown (OrderDetail.tsx's STATUSES) and the bulk
// picker (orderBulkStatus.ts's BULK_ORDER_STATUSES) already present them:
// the shipping/preparation workflow in order, then "completed" -- the POS
// in-store terminal state -- last, since it sits outside that workflow.
// This is the canonical list the Orders-page status cards (OrderStatusCards)
// render one card per entry of, so a status can never be silently missing
// or duplicated from that grid.
export const ALL_ORDER_STATUSES: OrderStatus[] = ["pending", "processing", "ready", "shipped", "delivered", "cancelled", "refunded", "completed"];

// Live per-status breakdown for the Orders page's status-summary cards.
// Every canonical status is always present in the result (defaulting to 0)
// even if no order currently has it -- callers must not need to guess which
// keys exist. Pure and Firestore-free, same shape as countPendingOrders():
// fed by whatever order list a caller already has (see OrderList.tsx, which
// passes its own already-subscribed `orders` state -- this function never
// opens a subscription of its own, so it adds zero new Firestore reads).
export function countOrdersByStatus(orders: Pick<AdminOrder, "status">[]): Record<OrderStatus, number> {
  const counts = Object.fromEntries(ALL_ORDER_STATUSES.map((s) => [s, 0])) as Record<OrderStatus, number>;
  for (const o of orders) {
    counts[o.status]++;
  }
  return counts;
}
