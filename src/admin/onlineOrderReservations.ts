import { returnLineKey } from "./returnsHelpers";
import type { AdminOrder, OrderStatus } from "./types";

// Pure helper only — no Firestore access — mirroring the style of
// returnsHelpers.ts / orderStatusCounts.ts. Powers the read-only "is this
// exact product/variant/size already committed to an online order" check in
// ProductAvailabilityCheckModal.tsx (opened from OrderList.tsx's toolbar), so
// an employee physically in the store can check BEFORE selling a product to
// a walk-in customer whether the same physical unit is already needed by a
// still-open online order.
//
// NOT tied to AddOrderItemModal.tsx (adding a line to a specific existing
// order) or to POS (Terminal.tsx's checkout flow) -- an earlier version of
// this feature was incorrectly built inside AddOrderItemModal.tsx and was
// reverted; see ProductAvailabilityCheckModal.tsx and OrderList.tsx for the
// corrected integration point. This module's own status-set/arithmetic logic
// was unaffected by that relocation and needed no changes.
//
// ---------------------------------------------------------------------------
// WHICH STATUSES ACTUALLY "RESERVE" STOCK, AND WHY — this is the one fact the
// whole feature hinges on, and it is NOT what the request's own example
// assumes at face value. Traced end-to-end across orderTransaction.ts,
// orderCancellation.ts, adminOrderEdit.ts, and returnsTransaction.ts:
//
// 1. Stock (`stockByCell` / colorVariants[].sizeStock[].qty) is decremented
//    ONCE, atomically, the moment an order is CREATED (placeOrder(), for
//    both web checkout and POS — same function, same transaction that writes
//    the order doc) — never again at any later status transition. So by the
//    time any order exists in Firestore, its claimed quantity has ALREADY
//    been subtracted from the product's stock number, regardless of status.
// 2. The ONLY thing that gives stock back is an explicit action:
//    cancelOrderAndRestoreStock() (only for status pending/processing/ready
//    — orderCancellation.ts's own comment: "stock was never touched by
//    preparation, so a fully-prepared-but-unshipped order is exactly as
//    cancellable as one still being prepared"), or the fully separate
//    Returns Shelf flow (resolveReturn(..., "good"), keyed by a returns/{id}
//    document, with zero dependency on the order's own status field).
// 3. Consequence for "refunded": marking an order refunded — via the single-
//    order dropdown or the bulk-status flow — has ZERO automatic stock
//    effect (confirmed: neither write path touches the products collection
//    at all). A refunded order's stock is only ever given back if a return
//    was separately created AND resolved "good" — the status field alone
//    guarantees nothing. This directly contradicts a natural assumption that
//    "refunded" behaves like "cancelled"; it does not.
//
// Given (1)-(3), the meaningful question for THIS feature is not "has this
// order's stock been given back" (only cancellation reliably does that) —
// it's "is this order still drawing from the SAME undifferentiated physical
// pool a new in-store sale would also draw from, i.e. has its unit not yet
// physically left the store". That is true for exactly pending/processing/
// ready:
//   - pending/processing: the order exists and has decremented stock, but
//     nothing has been pulled from the shelf yet.
//   - ready: every line has been checked off the prep checklist, but ready
//     is a pure paperwork/checklist flag with NO additional stock effect
//     (setOrderLinePrepared() "never touches lines/subtotal/shipping/total/
//     stock... stays stock-neutral") — the unit is staged for shipping but,
//     per orderCancellation.ts's own reasoning, still physically as
//     recoverable/cancellable as a processing order.
// It is FALSE for shipped/delivered/completed: per returnsHelpers.ts's
// RETURNABLE_ORDER_STATUSES ("orders in these statuses have actually left
// the building"), those units are physically gone from the store's shelf
// already — their stock was subtracted once, permanently, with no ongoing
// competition against a NEW in-store sale for the same physical item.
//
// "refunded" is the one genuinely debatable case, and an EARLIER version of
// this comment overstated it — corrected here after adversarial review:
// there is NO code path that requires a refunded order to have shipped
// first. OrderDetail.tsx's single-order dropdown and orderBulkStatus.ts's
// checkBulkStatusEligibility() both let a pending/processing order move
// straight to "refunded" (only "cancelled" and "ready" are blocked
// targets) — the app's OWN unit tests exercise exactly this transition as
// expected/valid. So a refunded order's unit has NOT necessarily left the
// building, and its stock was NOT given back either (point 3 above) —
// "refunded" is excluded from this set on a different, narrower basis than
// shipped/delivered/completed: in the primary, intended use of that status
// (the order is being abandoned/voided, not fulfilled), there is no longer
// a competing claim on the unit, so treating it as non-reserving is the
// safe direction — the tradeoff is that "stock" then under-reports the true
// physical count by that order's quantity until someone notices and
// corrects it, rather than ever overselling.
// KNOWN LIMITATION: if "refunded" is ever used for a partial/goodwill
// refund on an order that is STILL being fulfilled (the physical unit
// genuinely still going out to that customer), this feature would wrongly
// treat that unit as free, because the order-status model has no way to
// distinguish "refunded and abandoned" from "refunded but still shipping" —
// both are just status: "refunded". This is a real, narrow, workflow-
// dependent gap, not something this feature can resolve without a schema
// change (explicitly out of scope for this task).
//
// This is a DELIBERATE, separately-named constant rather than a reuse of
// OrderDetail.tsx's own (unexported) PREPARABLE_STATUSES or
// orderCancellation.ts's restoration-eligibility guard, even though the
// value is currently identical to both — they answer related but distinct
// questions (what can staff still prepare / cancel) that could diverge from
// "does this still compete for shelf stock" in the future for unrelated
// reasons.
export const STOCK_RESERVING_ORDER_STATUSES: OrderStatus[] = ["pending", "processing", "ready"];

export interface OnlineOrderReservationEntry {
  orderId: string;
  orderNumber: string;
  customerName: string;
  status: OrderStatus;
  qty: number;
}

export interface ProductLineReservation {
  reservedQty: number;
  entries: OnlineOrderReservationEntry[];
}

// Sums exactly-matching product+variant+size lines (via returnLineKey — the
// same per-line identity key Branch Stock Notes and Returns already use, so
// this never invents a second notion of "which line is this") across every
// order in `orders` whose status reserves stock, excluding `excludeOrderId`
// (the order currently being edited in OrderDetail.tsx -- its own lines are
// not a competing "online order", they're the very order this add-item flow
// is adding to). Multiple lines for the same product/variant/size within one
// order are summed together, and multiple contributing orders are all
// reported individually rather than collapsed into a bare count.
//
// Defensive against legacy/malformed data: a line missing productId/
// variantId/size, or an order missing `lines` entirely, is skipped rather
// than thrown on.
export function reservationsForLine(
  orders: Pick<AdminOrder, "id" | "orderNumber" | "customerName" | "status" | "lines">[],
  line: { productId: string; variantId: string; size: string },
  excludeOrderId?: string
): ProductLineReservation {
  const key = returnLineKey(line.productId, line.variantId, line.size);
  const entries: OnlineOrderReservationEntry[] = [];

  for (const order of orders) {
    if (!order || order.id === excludeOrderId) continue;
    if (!STOCK_RESERVING_ORDER_STATUSES.includes(order.status)) continue;

    const qty = (order.lines ?? [])
      .filter((l) => l && l.productId && l.variantId && l.size && returnLineKey(l.productId, l.variantId, l.size) === key)
      .reduce((sum, l) => sum + (l.qty ?? 0), 0);

    if (qty > 0) {
      entries.push({ orderId: order.id, orderNumber: order.orderNumber, customerName: order.customerName, status: order.status, qty });
    }
  }

  return { reservedQty: entries.reduce((sum, e) => sum + e.qty, 0), entries };
}

export type StoreSaleAvailabilityTier = "safe" | "warning" | "block";

export interface StoreSaleAvailability {
  tier: StoreSaleAvailabilityTier;
  stock: number | null; // the exact same StockVariant.qty already used everywhere else (null = unconfirmed) -- no second stock model
  reserved: number;
  available: number | null; // == stock (see the correction note below); null only when stock itself is unconfirmed
}

// ---------------------------------------------------------------------------
// CORRECTED FORMULA (this replaces an earlier, wrong version of this
// function that computed `available = stock - reservedQty`). Caught and
// explained by a direct correction after this feature's first
// implementation, and re-verified against the same write paths cited in the
// STOCK_RESERVING_ORDER_STATUSES comment above:
//
// `stock` (StockVariant.qty, read live off the product) is the CURRENT
// value, and per this module's own point (1) above, placeOrder() already
// subtracted every reserving order's claimed quantity from it at the moment
// each of those orders was created. So `stock` does not need reservedQty
// subtracted from it a second time -- doing so double-counts the exact same
// commitment that has already been removed from the number:
//
//   Original physical stock 5, one online order for 1 unit ->
//   placeOrder() decrements: stock becomes 5 - 1 = 4.
//   reservedQty (this order's line, summed by reservationsForLine above) = 1.
//   The 1 committed unit is ALREADY excluded from the 4 -- all 4 remaining
//   units are genuinely free. availableForStoreSale = 4 (= stock), NOT
//   4 - 1 = 3.
//
// The three specs this was checked against:
//   stock=4, reserved=1 -> available=4 (not 3)
//   stock=0, reserved=1 -> available=0 (not -1) -- blocked, since nothing
//     of the original single unit remains at all
//   stock=3, reserved=2 -> available=3 (not 1)
//
// One direct consequence, stated plainly rather than glossed over: with
// `available === stock` always, the "block" tier can only ever fire when
// `stock` is 0 (or unconfirmed/null) -- exactly the same condition the
// pre-existing size-picker button already disables on
// (`disabled={s.qty === 0 || s.qty === null}` in AddOrderItemModal.tsx). So
// under this corrected, verified-accurate arithmetic, "block" never adds a
// NEW restriction beyond what already existed; it can only ever coincide
// with it. The feature's real, additive value is the "warning" tier and the
// order list underneath it: surfacing WHICH online order(s), for how much,
// are why the number is what it is -- still useful, safety-relevant context
// for staff -- not an independent new stock gate. See the implementation
// report for why this doesn't reduce the feature to nothing: the "reserved"
// figure is still exactly what the request asked to see per order, and
// `available` still needs computing correctly (as `stock`, not `stock -
// reserved`) so it's never a lie -- it just isn't a second, tighter ceiling
// than `stock` itself.
//
// This DOES still assume `stock` hasn't been overwritten by an out-of-band
// physical recount that re-counted an already-committed-but-not-yet-picked
// unit and didn't know to exclude it (Inventory.tsx / ProductForm.tsx allow
// a direct manual stock edit, independent of any order). If that happens,
// `stock` itself would be wrong before this function ever sees it, and no
// purely order-derived calculation can detect or correct that from the
// product/order documents alone -- a data-entry-accuracy question outside
// this feature's scope, not an arithmetic error in it.
// ---------------------------------------------------------------------------
//
// "safe": nothing is reserved (regardless of stock) -- an unrelated
// variant/size, or a product with zero online commitments, is always safe.
// "warning": something is reserved, but stock is still positive -- informs
// staff of the commitment without restricting anything beyond what stock
// already allows. "block": stock is exactly 0 (or unconfirmed) while a
// reservation exists -- coincides with, never adds to, the pre-existing
// disabled-button state.
export function classifyStoreSaleAvailability(stock: number | null, reservedQty: number): StoreSaleAvailability {
  if (reservedQty <= 0) {
    return { tier: "safe", stock, reserved: 0, available: stock };
  }
  if (stock === null) {
    return { tier: "block", stock, reserved: reservedQty, available: null };
  }
  return { tier: stock > 0 ? "warning" : "block", stock, reserved: reservedQty, available: stock };
}
