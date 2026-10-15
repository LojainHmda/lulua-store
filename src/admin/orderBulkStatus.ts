import type { AdminOrder, OrderStatus } from "./types";

// Every status the single-order OrderDetail.tsx dropdown can set EXCEPT
// "cancelled" -- that one only ever appears there as a non-actionable
// display value for an order that's already cancelled (see STATUSES.filter
// in OrderDetail.tsx), never as something the dropdown lets you move INTO.
// Bulk status update mirrors that exactly: cancellation must always go
// through cancelOrderAndRestoreStock() so its stock-restoration transaction
// can never be bypassed by a bare status write, bulk or otherwise.
export const BULK_ORDER_STATUSES: OrderStatus[] = ["pending", "processing", "shipped", "delivered", "completed", "refunded"];

export interface BulkStatusEligibility {
  eligible: boolean;
  reasonKey?: string;
}

// Pure precondition check, called once per selected order before it's
// written. Returns a translation KEY rather than an already-translated
// message (unlike checkoutValidation.ts's validateCheckoutFields) because
// the caller needs the raw key both to translate for display AND to key a
// per-order failure list -- the caller applies t() itself.
//
// Deliberately MORE restrictive here than OrderDetail.tsx's single-order
// dropdown for one specific case: that dropdown's own filter condition
// (`s !== "cancelled" || order.status === "cancelled"`) actually leaves an
// already-cancelled order's status freely reassignable to anything else
// (pending, shipped, ...) with no dedicated "reopen" handling -- silently
// moving it out of "cancelled" would leave its previously-restored stock
// never re-decremented, effectively giving away inventory. That's a narrow
// edge case for a single accidental click; multiplied across a bulk
// selection it's a real risk, so bulk status update refuses to touch any
// order that is CURRENTLY cancelled at all, regardless of target status.
// This only tightens the existing behavior -- see the required-behavior /
// safety sections of the bulk-status-update spec (never allow "cancelled"
// through this action; never bypass cancelOrderAndRestoreStock()).
export function checkBulkStatusEligibility(order: Pick<AdminOrder, "status">, targetStatus: OrderStatus): BulkStatusEligibility {
  if (targetStatus === "cancelled") {
    // Never reachable through the bulk UI's own status picker (it only ever
    // offers BULK_ORDER_STATUSES) -- kept as a defense-in-depth guard, same
    // reasoning as updateStatus()'s identical check in OrderDetail.tsx.
    return { eligible: false, reasonKey: "admin.orders.bulk.reasonTargetCancelled" };
  }
  if (targetStatus === "ready") {
    // "Ready" (تم التجهيز) is derived automatically from the per-line
    // preparation checklist (see orderPreparation.ts) -- never a status a
    // human picks, bulk or otherwise. Same defense-in-depth reasoning as the
    // "cancelled" guard above; BULK_ORDER_STATUSES already excludes it too.
    return { eligible: false, reasonKey: "admin.orders.bulk.reasonTargetReady" };
  }
  if (order.status === "cancelled") {
    return { eligible: false, reasonKey: "admin.orders.bulk.reasonSourceCancelled" };
  }
  return { eligible: true };
}

export interface BulkStatusOutcome {
  orderId: string;
  orderNumber: string;
  ok: boolean;
  reasonKey?: string;
  errorMessage?: string;
}

// Summarizes a settled batch into the exact counts the UI/toast/activity
// log all need -- pure, so the "N updated, M failed" wording logic is
// unit-testable without touching Firestore.
export function summarizeBulkStatusOutcomes(outcomes: BulkStatusOutcome[]): { succeeded: number; failed: number; total: number } {
  const succeeded = outcomes.filter((o) => o.ok).length;
  return { succeeded, failed: outcomes.length - succeeded, total: outcomes.length };
}
