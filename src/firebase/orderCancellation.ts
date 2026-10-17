import { collection, doc, runTransaction, serverTimestamp } from "../db/firestore";
import type { Actor } from "../admin/actor";
import { logActivity } from "../admin/logActivity";
import { notifyLowStock } from "../admin/lowStockNotify";
import { normalizeProduct, toStockByCell } from "../admin/productVariants";
import {
  aggregateCancellationRestoreQty,
  computeCancellationStockUpdates,
  computeStockDeltas,
  OrderCancellationError,
} from "../admin/stockMovements";
import type { AdminColorVariant, AdminOrder, AdminProduct } from "../admin/types";
import { db } from "./config";

export { OrderCancellationError };

// Cancels a still-unshipped order and gives back exactly the stock its
// CURRENT lines say is outstanding -- deliberately a standalone transaction,
// not a call into updateOrderLines() with an empty array. That function's
// "at least one item" guard and its shipping-recalculation logic are both
// specifically about editing a still-active order, not about ending one;
// bending it to also mean "and cancel" would mix two distinct intents into
// one function. This one instead reuses updateOrderLines()'s exact delta
// philosophy: an order's `lines`, for as long as status is pending/
// processing, IS the authoritative record of what's currently held out of
// sellable stock (kept in sync by placeOrder()/updateOrderLines() at every
// prior edit) -- so "cancel" is simply "release all of it, then stop".
//
// The aggregation/validation/new-colorVariants math lives in
// src/admin/stockMovements.ts (aggregateCancellationRestoreQty(),
// computeCancellationStockUpdates()) as pure, unit-testable functions --
// this function is just the thin Firestore transaction around them, same
// split as every other stock writer already uses for computeStockDeltas().
//
// Shipped/delivered/completed/refunded orders are never eligible here (see
// the status guard below) -- goods that already left the building can only
// come back through the Returns Shelf's quarantine->inspect flow, which
// this function never touches.
export async function cancelOrderAndRestoreStock(orderId: string, actor: Actor): Promise<void> {
  const orderRef = doc(db, "orders", orderId);

  // Reset on every transaction attempt, including retries -- identical
  // reasoning to orderTransaction.ts/adminOrderEdit.ts: Firestore replays
  // this whole callback from scratch on a write-conflict retry, and this
  // array is read from OUTSIDE the callback after commit (for the
  // low-stock check below), so it must never hold a discarded attempt's
  // stale entries alongside the real, committed one's.
  let stockChanges: { product: { id: string; name: string }; before: AdminColorVariant[]; after: AdminColorVariant[] }[] = [];
  let orderNumber = "";

  await runTransaction(db, async (tx) => {
    stockChanges = [];
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists()) throw new OrderCancellationError("Order not found.");
    const order = orderSnap.data() as AdminOrder;
    orderNumber = order.orderNumber;

    // The only guard that matters for idempotency: re-checked against a
    // FRESH read inside this transaction, never whatever the UI had cached
    // when the admin clicked. Once this succeeds and commits, status is no
    // longer pending/processing/ready, so a second call -- a double-click, a
    // retried request, a second browser tab, a race with another admin --
    // fails right here instead of restoring stock twice. Exactly mirrors
    // resolveReturn()'s `if (ret.status === "resolved") throw`.
    // "ready" (Phase 3) is included here alongside pending/processing: stock
    // was never touched by preparation, so an order that's fully prepared
    // but hasn't shipped yet is exactly as cancellable as one still being
    // prepared -- excluding it would leave a real order stuck with no way to
    // cancel or return it (RETURNABLE_ORDER_STATUSES correctly excludes
    // "ready" too, since nothing has shipped).
    if (order.status !== "pending" && order.status !== "processing" && order.status !== "ready") {
      throw new OrderCancellationError("Only pending, processing, or ready orders can be cancelled this way.");
    }

    // A branch POS sale came out of that branch's stock (branchStock), but
    // this restores to the product's ONLINE stock — so it must never run for
    // one. POS sales are created "completed" and normally never get here;
    // this stops it if one is moved back to an open status by hand. Items
    // from a branch sale go back through Returns, which restocks the branch.
    if (order.branchId) {
      throw new OrderCancellationError("This is a branch (POS) sale — cancelling here would put the stock back online instead of at the branch. Use Returns to restock that branch.");
    }

    const restoreEntries = aggregateCancellationRestoreQty(order.lines);

    // An empty manual/off-site order (created via OrderList.tsx's "New
    // Order" and never given a line item) has nothing to restore -- a
    // correct no-op, not an error.
    if (restoreEntries.length === 0) {
      tx.update(orderRef, {
        status: "cancelled",
        cancelledByUid: actor.uid,
        cancelledByEmail: actor.email,
        cancelledByName: actor.displayName || actor.email,
        cancelledAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      return;
    }

    const distinctProductIds = [...new Set(restoreEntries.map((e) => e.productId))];
    const productRefs = distinctProductIds.map((id) => doc(db, "products", id));
    const productSnaps = await Promise.all(productRefs.map((ref) => tx.get(ref)));

    const productById = new Map<string, AdminProduct>();
    productSnaps.forEach((snap, i) => {
      if (!snap.exists()) {
        throw new OrderCancellationError("One of the products in this order no longer exists — cannot safely restore stock. Resolve the discrepancy manually via Inventory before cancelling.");
      }
      productById.set(distinctProductIds[i], normalizeProduct({ id: snap.id, ...snap.data() } as AdminProduct));
    });

    // Throws before anything is queued if any line can't be safely resolved
    // (color/size removed, or stock never confirmed) -- see the function's
    // own doc comment for why that ordering matters.
    const updates = computeCancellationStockUpdates(restoreEntries, productById);

    for (const u of updates) {
      // Restoration only ever changes quantities, never a color's metadata —
      // written as `stockByCell` alone, same reasoning as
      // adminOrderEdit.ts's identical comment.
      tx.update(doc(db, "products", u.productId), { stockByCell: toStockByCell(u.after), updatedAt: serverTimestamp() });
      stockChanges.push({ product: { id: u.productId, name: u.productName }, before: u.before, after: u.after });
      for (const delta of computeStockDeltas(u.before, u.after)) {
        tx.set(doc(collection(db, "stockMovements")), {
          productId: u.productId,
          productName: u.productName,
          variantId: delta.variantId,
          colorName: delta.colorName,
          size: delta.size,
          qtyBefore: delta.qtyBefore,
          qtyChange: delta.qtyChange,
          qtyAfter: delta.qtyAfter,
          reason: "order_cancelled",
          source: "admin",
          actorUid: actor.uid,
          actorEmail: actor.email,
          actorName: actor.displayName || actor.email,
          orderId,
          orderNumber: order.orderNumber,
          createdAt: serverTimestamp(),
        });
      }
    }

    tx.update(orderRef, {
      status: "cancelled",
      cancelledByUid: actor.uid,
      cancelledByEmail: actor.email,
      cancelledByName: actor.displayName || actor.email,
      cancelledAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  });

  await logActivity(actor, "order.cancelled", `#${orderNumber}`);

  // Fire-and-forget, after the cancellation has already committed
  // successfully -- same pattern as every other stock writer. This only
  // ever INCREASES stock, so findLowStockCrossings()'s strictly-downward
  // condition (before >= threshold, after < threshold) can never fire here;
  // calling it anyway keeps this call site consistent with the other four
  // rather than special-casing "this one never needs it".
  for (const change of stockChanges) {
    void notifyLowStock(change.product, change.before, change.after);
  }
}
