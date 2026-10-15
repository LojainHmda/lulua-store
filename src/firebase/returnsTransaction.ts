import { collection, doc, runTransaction, serverTimestamp } from "firebase/firestore";
import type { Actor } from "../admin/actor";
import { normalizeProduct, stockCellKey, toStockByCell } from "../admin/productVariants";
import { logActivity } from "../admin/logActivity";
import { computeStockDeltas } from "../admin/stockMovements";
import type { AdminOrder, AdminProduct, AdminReturn, BranchStockDoc, ReturnReason } from "../admin/types";
import { branchStockId } from "./branchStock";
import { db } from "./config";
import { returnsApi } from "./collections";

export class ReturnResolutionError extends Error {}
export class ReturnIntakeError extends Error {}

// Matches returnCounterId() in firestore.rules exactly — the rule computes
// the same path independently from the return document's own fields, so
// this string shape can't drift between client and rule without both
// sides breaking loudly (a wrong path here just reads a fresh, empty
// counter and gets rejected by returnCounterMatchesIntake()).
function returnCounterId(orderId: string, productId: string, variantId: string, size: string): string {
  return `${orderId}::${productId}::${variantId}::${size}`;
}

export interface CreateReturnInput {
  orderId: string;
  orderNumber: string;
  customerId?: string;
  customerName: string;
  customerEmail: string;
  productId: string;
  productName: string;
  variantId: string;
  colorName: string;
  size: string;
  sku?: string;
  qty: number;
  reason: ReturnReason;
  reasonNote?: string;
}

// Intake never touches product stock (the unit was already decremented at
// the original sale and simply isn't re-added until an explicit resolution
// — see the module doc on resolveReturn below). It IS a transaction,
// though: alongside the returns/{id} document itself, it also bumps a
// returnCounters/{orderId::productId::variantId::size} running total,
// which firestore.rules independently caps at the line's originally-sold
// qty (orderLineQtyForReturn(), read straight off the order) and ties back
// to this exact return via getAfter() (returnCounterMatchesIntake()). That
// makes "total returned <= qty originally sold" a server-enforced
// invariant, not just the client-side hint alreadyReturnedQtyForLine()
// still provides for the UI's max-qty stepper — see the long comment on
// returnCounters/{id} in firestore.rules for why a counter document (not a
// live SUM query, which Firestore transactions can't run) is what makes
// this race-free under concurrent submission.
export async function createReturn(input: CreateReturnInput, actor: Actor): Promise<string> {
  const counterRef = doc(db, "returnCounters", returnCounterId(input.orderId, input.productId, input.variantId, input.size));
  const orderRef = doc(db, "orders", input.orderId);
  const returnRef = doc(collection(db, "returns"));

  await runTransaction(db, async (tx) => {
    const [counterSnap, orderSnap] = [await tx.get(counterRef), await tx.get(orderRef)];
    if (!orderSnap.exists()) throw new ReturnIntakeError("This order no longer exists.");

    const order = orderSnap.data() as AdminOrder;
    const originalQty = order.lines
      .filter((l) => l.productId === input.productId && l.variantId === input.variantId && l.size === input.size)
      .reduce((sum, l) => sum + l.qty, 0);
    const before = counterSnap.exists() ? ((counterSnap.data().returnedQty as number) ?? 0) : 0;
    const after = before + input.qty;
    if (after > originalQty) {
      const remaining = Math.max(0, originalQty - before);
      throw new ReturnIntakeError(
        remaining > 0
          ? `Only ${remaining} unit(s) of this line are still eligible for return (already returned: ${before} of ${originalQty}).`
          : `This entire line has already been returned (${before} of ${originalQty}).`
      );
    }

    tx.set(counterRef, {
      orderId: input.orderId,
      productId: input.productId,
      variantId: input.variantId,
      size: input.size,
      returnedQty: after,
      updatedAt: serverTimestamp(),
    });

    tx.set(returnRef, {
      ...input,
      status: "quarantine",
      disposition: null,
      restocked: false,
      processedBy: actor.email,
      processedByName: actor.displayName || actor.email,
      processedByUid: actor.uid,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  });

  const target = `${input.productName} — ${input.colorName}/${input.size} (order #${input.orderNumber})`;
  await logActivity(actor, "return.logged", target, `Qty ${input.qty}, reason: ${input.reason}${input.reasonNote ? ` — ${input.reasonNote}` : ""}`);
  return returnRef.id;
}

// Only ever called with disposition "good" or "damaged" — "needs_repair" is
// handled by markNeedsRepair() below, since it never touches product stock.
// A "good" disposition is the ONLY place in the entire app, other than an
// admin directly editing Inventory/ProductForm, that increases
// product.colorVariants.sizeStock.qty — it is deliberately a separate,
// standalone transaction from placeOrder()/updateOrderLines(), so the
// checkout hot path's Firestore-rules expression budget is never touched by
// this feature at all.
export async function resolveReturn(
  returnId: string,
  disposition: "good" | "damaged",
  actor: Actor,
  inspectionNotes?: string
): Promise<void> {
  const returnRef = doc(db, "returns", returnId);
  const willRestock = disposition === "good";

  const result = await runTransaction(db, async (tx) => {
    const returnSnap = await tx.get(returnRef);
    if (!returnSnap.exists()) throw new ReturnResolutionError("This return record no longer exists.");
    const ret = returnSnap.data() as AdminReturn;
    if (ret.status === "resolved") throw new ReturnResolutionError("This return has already been resolved.");

    let restockedQtyNote = "";
    if (willRestock) {
      const productRef = doc(db, "products", ret.productId);
      const productSnap = await tx.get(productRef);
      if (!productSnap.exists()) {
        throw new ReturnResolutionError(`${ret.productName} no longer exists — cannot restock this return. Resolve it as Damaged/Unsellable instead, or fix the product record first.`);
      }
      const product = normalizeProduct({ id: productSnap.id, ...productSnap.data() } as AdminProduct);
      // Multi-branch: an item sold at a branch POS goes back into THAT
      // branch's stock, not the online stock on the product document.
      const orderSnap = await tx.get(doc(db, "orders", ret.orderId));
      const saleBranchId = orderSnap.exists() ? (orderSnap.get("branchId") as string | undefined) : undefined;
      const branchRef = saleBranchId ? doc(db, "branchStock", branchStockId(saleBranchId, ret.productId)) : null;
      const branchSnap = branchRef ? await tx.get(branchRef) : null;
      const variant = product.colorVariants.find((v) => v.id === ret.variantId);
      if (!variant) {
        throw new ReturnResolutionError(`${ret.productName}: the "${ret.colorName}" color no longer exists on this product — cannot restock automatically. Resolve it as Damaged/Unsellable, or re-add that color first.`);
      }
      const stockEntry = variant.sizeStock.find((s) => s.size === ret.size);
      if (!stockEntry) {
        throw new ReturnResolutionError(`${ret.productName} (${variant.colorName}): size "${ret.size}" no longer exists on this product — cannot restock automatically. Resolve it as Damaged/Unsellable, or re-add that size first.`);
      }

      if (branchRef) {
        const cells = ((branchSnap?.exists() ? branchSnap.get("stockByCell") : undefined) ?? {}) as BranchStockDoc["stockByCell"];
        const key = stockCellKey(ret.variantId, ret.size);
        const before = typeof cells[key]?.qty === "number" ? (cells[key].qty as number) : 0;
        const after = before + ret.qty;
        const nextCells = { ...cells, [key]: { ...cells[key], qty: after } };
        if (branchSnap?.exists()) {
          tx.update(branchRef, { stockByCell: nextCells, updatedAt: serverTimestamp() });
        } else {
          tx.set(branchRef, { branchId: saleBranchId, productId: ret.productId, stockByCell: nextCells, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
        }
        tx.set(doc(collection(db, "stockMovements")), {
          productId: ret.productId,
          productName: ret.productName,
          variantId: ret.variantId,
          colorName: variant.colorName,
          size: ret.size,
          qtyBefore: before,
          qtyChange: ret.qty,
          qtyAfter: after,
          reason: "return_restock",
          source: "admin",
          actorUid: actor.uid,
          actorEmail: actor.email,
          actorName: actor.displayName || actor.email,
          orderId: ret.orderId,
          orderNumber: ret.orderNumber,
          returnId,
          branchId: saleBranchId,
          createdAt: serverTimestamp(),
        });
      } else {
        // A null (never-confirmed) count is still floored at 0 here — the
        // returned unit is a known physical item in hand right now, so "at
        // least N exist" is always a safe statement even if the rest of that
        // slot's count is otherwise unconfirmed. Matches totalStock()'s
        // "known quantities are always a safe floor" philosophy.
        const before = stockEntry.qty ?? 0;
        const after = before + ret.qty;
        if (stockEntry.qty === null) {
          restockedQtyNote = ` (stock for this size was previously unconfirmed — set to ${after}; verify the real count)`;
        }

        const newColorVariants = product.colorVariants.map((v) =>
          v.id !== variant.id
            ? v
            : { ...v, sizeStock: v.sizeStock.map((s) => (s.size !== ret.size ? s : { ...s, qty: after })) }
        );
        // Restocking only ever changes a quantity, never a color's metadata —
        // written as `stockByCell` alone, same reasoning as
        // adminOrderEdit.ts's identical comment.
        tx.update(productRef, { stockByCell: toStockByCell(newColorVariants), updatedAt: serverTimestamp() });

        // Only ever reached for disposition "good" (willRestock) — a
        // "damaged" resolution never touches stock and so never produces a
        // movement, by construction (this whole block is skipped entirely).
        for (const delta of computeStockDeltas(product.colorVariants, newColorVariants)) {
          tx.set(doc(collection(db, "stockMovements")), {
            productId: ret.productId,
            productName: ret.productName,
            variantId: delta.variantId,
            colorName: delta.colorName,
            size: delta.size,
            qtyBefore: delta.qtyBefore,
            qtyChange: delta.qtyChange,
            qtyAfter: delta.qtyAfter,
            reason: "return_restock",
            source: "admin",
            actorUid: actor.uid,
            actorEmail: actor.email,
            actorName: actor.displayName || actor.email,
            orderId: ret.orderId,
            orderNumber: ret.orderNumber,
            returnId,
            createdAt: serverTimestamp(),
          });
        }
      }
    }

    tx.update(returnRef, {
      status: "resolved",
      disposition,
      restocked: willRestock,
      inspectionNotes: inspectionNotes ?? ret.inspectionNotes ?? "",
      resolvedBy: actor.email,
      resolvedByName: actor.displayName || actor.email,
      resolvedByUid: actor.uid,
      resolvedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    return { ret, restockedQtyNote };
  });

  const { ret, restockedQtyNote } = result;
  const target = `${ret.productName} — ${ret.colorName}/${ret.size} (order #${ret.orderNumber})`;
  await logActivity(
    actor,
    willRestock ? "return.resolvedGood" : "return.resolvedDamaged",
    target,
    willRestock ? `Qty ${ret.qty} returned to available stock${restockedQtyNote}` : `Qty ${ret.qty} permanently excluded from sellable stock`
  );
}

// No product read/write at all — a repair holding state never touches
// stock, so this is a plain document update, not a transaction.
export async function markNeedsRepair(returnId: string, actor: Actor, inspectionNotes?: string): Promise<void> {
  const returns = await returnsApi.get(returnId);
  if (!returns) throw new ReturnResolutionError("This return record no longer exists.");
  if (returns.status === "resolved") throw new ReturnResolutionError("This return has already been resolved.");

  await returnsApi.update(returnId, {
    status: "needs_repair",
    disposition: null,
    inspectionNotes: inspectionNotes ?? returns.inspectionNotes ?? "",
  });

  const target = `${returns.productName} — ${returns.colorName}/${returns.size} (order #${returns.orderNumber})`;
  await logActivity(actor, "return.needsRepair", target, `Qty ${returns.qty} stays excluded from sellable stock pending repair`);
}
