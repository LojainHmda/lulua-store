import { doc, runTransaction, serverTimestamp } from "firebase/firestore";
import type { Actor } from "../admin/actor";
import { checkBulkStatusEligibility } from "../admin/orderBulkStatus";
import type { AdminOrder, OrderStatus } from "../admin/types";
import { db } from "./config";

export class BulkStatusUpdateError extends Error {
  reasonKey?: string;
  constructor(message: string, reasonKey?: string) {
    super(message);
    this.reasonKey = reasonKey;
  }
}

// One order, one transaction -- re-reads the order's CURRENT status from the
// server immediately before writing, the same reason cancelOrderAndRestoreStock()
// (orderCancellation.ts) re-reads status inside its own transaction instead
// of trusting whatever the caller already had in hand. OrderList.tsx's
// `orders` array is only as fresh as its onSnapshot listener: checking
// eligibility against that cached value and then writing with a bare
// updateDoc leaves a real (if narrow) race -- another admin could cancel
// this exact order, via the dedicated cancellation flow, in the window
// between this admin building their bulk selection and clicking Confirm.
// Without a fresh in-transaction re-check, that race can silently move a
// just-cancelled order to some other status, leaving its already-restored
// stock never re-decremented (the unit becomes sellable twice). Wrapping
// the read + eligibility check + write in one transaction closes that
// window exactly as tightly as the cancellation flow it must never race
// against.
export async function updateOrderStatusIfEligible(orderId: string, targetStatus: OrderStatus, actor: Actor): Promise<void> {
  const orderRef = doc(db, "orders", orderId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(orderRef);
    if (!snap.exists()) throw new BulkStatusUpdateError("This order no longer exists.");
    const order = snap.data() as AdminOrder;
    const check = checkBulkStatusEligibility(order, targetStatus);
    if (!check.eligible) {
      throw new BulkStatusUpdateError(`Order status could not be updated (${check.reasonKey}).`, check.reasonKey);
    }
    tx.update(orderRef, {
      status: targetStatus,
      statusUpdatedByUid: actor.uid,
      statusUpdatedByEmail: actor.email,
      statusUpdatedByName: actor.displayName || actor.email,
      statusUpdatedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  });
}
