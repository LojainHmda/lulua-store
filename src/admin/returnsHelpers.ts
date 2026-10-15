import type { AdminOrder, AdminReturn, OrderStatus, ReturnDisposition, ReturnReason, ReturnStatus } from "./types";

// Pure helpers only — no Firestore access — mirroring the style of
// productVariants.ts. Every write path lives in firebase/returnsTransaction.ts.

// Orders in these statuses have actually left the building — only then is
// there a physical unit that could come back. Mirrors the Firestore rule's
// own order-status check on returns/{id} create; used client-side by every
// "Process Return" entry point (GlobalOrdersSidebarPanel, OrderDetail).
export const RETURNABLE_ORDER_STATUSES: OrderStatus[] = ["shipped", "delivered", "completed"];

export function returnLineKey(productId: string, variantId: string, size: string): string {
  return `${productId}::${variantId}::${size}`;
}

// Every non-empty Branch Stock Note text across an order's lines, in the
// SAME order those lines are displayed (order.lines), for a compact
// order-level summary on the main Orders page (OrderList.tsx) -- shown
// without opening the order. Read-only derivation over the existing
// order.lines + order.lineBranchStockNotes; this never creates, stores, or
// writes anything, and lineBranchStockNotes (keyed by returnLineKey) stays
// the sole place a note is actually associated with its specific product
// line. Deliberately walks `lines` and re-derives each one's own key rather
// than iterating lineBranchStockNotes' own object keys directly -- a plain
// object's key order isn't a reliable stand-in for product-line order, and
// doing it this way guarantees a note can never end up attributed to the
// wrong line in the summary.
export function lineBranchStockNoteTexts(order: Pick<AdminOrder, "lines" | "lineBranchStockNotes">): string[] {
  return order.lines
    .map((line) => order.lineBranchStockNotes?.[returnLineKey(line.productId, line.variantId, line.size)]?.note)
    .filter((note): note is string => !!note && note.trim() !== "");
}

// A unit counts against "already returned" for as long as it's on record as
// having physically come back, regardless of what happened to it since
// (quarantine, sent for repair, or already written off as damaged) — only
// resolved-good returns don't reduce what's still returnable, since those
// units are simply back in the normal sellable pool.
export function alreadyReturnedQtyForLine(
  returns: AdminReturn[],
  orderId: string,
  productId: string,
  variantId: string,
  size: string
): number {
  return returns
    .filter((r) => r.orderId === orderId && r.productId === productId && r.variantId === variantId && r.size === size)
    .reduce((sum, r) => sum + r.qty, 0);
}

export interface ReturnsAggregate {
  quarantineQty: number; // status: "quarantine" | "needs_repair" — not yet resolved, excluded from sellable stock
  damagedQty: number; // status: "resolved", disposition: "damaged" — permanently excluded
}

// Keyed by returnLineKey(productId, variantId, size) — powers the
// Available/Quarantine/Damaged display on the admin Inventory screen.
export function computeReturnsAggregates(returns: AdminReturn[]): Map<string, ReturnsAggregate> {
  const map = new Map<string, ReturnsAggregate>();
  for (const r of returns) {
    const key = returnLineKey(r.productId, r.variantId, r.size);
    const entry = map.get(key) ?? { quarantineQty: 0, damagedQty: 0 };
    if (r.status === "quarantine" || r.status === "needs_repair") {
      entry.quarantineQty += r.qty;
    } else if (r.status === "resolved" && r.disposition === "damaged") {
      entry.damagedQty += r.qty;
    }
    map.set(key, entry);
  }
  return map;
}

export const RETURN_REASON_LABEL_KEY: Record<ReturnReason, string> = {
  defective: "admin.returns.reason.defective",
  wrong_size: "admin.returns.reason.wrongSize",
  wrong_color: "admin.returns.reason.wrongColor",
  changed_mind: "admin.returns.reason.changedMind",
  fulfillment_error: "admin.returns.reason.fulfillmentError",
  shipping_error: "admin.returns.reason.shippingError",
  other: "admin.returns.reason.other",
};

export const RETURN_STATUS_LABEL_KEY: Record<ReturnStatus, string> = {
  quarantine: "admin.returns.status.quarantine",
  needs_repair: "admin.returns.status.needsRepair",
  resolved: "admin.returns.status.resolved",
};

export const RETURN_STATUS_TONE: Record<ReturnStatus, "neutral" | "success" | "warning" | "danger" | "info"> = {
  quarantine: "warning",
  needs_repair: "warning",
  resolved: "neutral", // disposition (good/damaged) carries the real meaning once resolved
};

export function returnDispositionLabelKey(disposition: ReturnDisposition): string | null {
  if (disposition === "good") return "admin.returns.disposition.good";
  if (disposition === "damaged") return "admin.returns.disposition.damaged";
  return null;
}

export function returnDispositionTone(disposition: ReturnDisposition): "success" | "danger" | "neutral" {
  if (disposition === "good") return "success";
  if (disposition === "damaged") return "danger";
  return "neutral";
}
