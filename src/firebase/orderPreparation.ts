import { doc, runTransaction, serverTimestamp } from "../db/firestore";
import type { Actor } from "../admin/actor";
import {
  allLinesPrepared,
  deriveStatusAfterPreparationChange,
  setLinePrepared,
  setLinePreparedMeta,
  type PreparedLineMeta,
  type PreparedLines,
} from "../admin/orderPreparation";
import type { AdminOrder, OrderLine, OrderStatus } from "../admin/types";
import { db } from "./config";

export class OrderPreparationError extends Error {}

export interface SetLinePreparedResult {
  previousStatus: OrderStatus;
  newStatus: OrderStatus;
  preparedLines: PreparedLines;
  preparedLineMeta: PreparedLineMeta;
}

// One order, one transaction -- re-reads preparedLines/status fresh right
// before writing (same reasoning as cancelOrderAndRestoreStock() and
// updateOrderStatusIfEligible()), so two employees confirming different
// lines on the same order at nearly the same moment can never clobber each
// other's write or leave status out of sync with the real preparedLines map.
// Only ever touches preparedLines/preparedLineMeta and status (plus the
// status-attribution fields when status actually changes as a result) --
// never lines/subtotal/shipping/total/stock, so this can't interact with
// checkout, POS, returns, cancellation, or item editing at all, and stays
// stock-neutral exactly as before.
export async function setOrderLinePrepared(
  orderId: string,
  line: Pick<OrderLine, "productId" | "variantId" | "size">,
  prepared: boolean,
  actor: Actor
): Promise<SetLinePreparedResult> {
  const orderRef = doc(db, "orders", orderId);
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(orderRef);
    if (!snap.exists()) throw new OrderPreparationError("Order not found.");
    const order = snap.data() as AdminOrder;

    const now = serverTimestamp();
    const nextPreparedLines = setLinePrepared(order.preparedLines, line, prepared);
    const nextPreparedLineMeta = setLinePreparedMeta(order.preparedLineMeta, line, prepared, actor, now);
    const nextStatus = deriveStatusAfterPreparationChange(order.status, allLinesPrepared(order.lines, nextPreparedLines));

    // A per-line confirm/reset only stamps order-level status attribution
    // when it actually CAUSED a status change (e.g. the last line just got
    // confirmed and the order automatically became "ready") -- an
    // individual line toggle that doesn't move the order's overall status
    // must never overwrite "who last changed the status" with the name of
    // someone who merely touched one line.
    const statusChanged = nextStatus !== order.status;
    tx.update(orderRef, {
      preparedLines: nextPreparedLines,
      preparedLineMeta: nextPreparedLineMeta,
      status: nextStatus,
      ...(statusChanged
        ? { statusUpdatedByUid: actor.uid, statusUpdatedByEmail: actor.email, statusUpdatedByName: actor.displayName || actor.email, statusUpdatedAt: now }
        : {}),
      updatedAt: now,
    });

    return { previousStatus: order.status, newStatus: nextStatus, preparedLines: nextPreparedLines, preparedLineMeta: nextPreparedLineMeta };
  });
}
