import { doc, runTransaction, serverTimestamp } from "firebase/firestore";
import type { Actor } from "../admin/actor";
import { logActivity } from "../admin/logActivity";
import { normalizeProduct, stockCellKey, toStockByCell } from "../admin/productVariants";
import { ONLINE_LOCATION, receiptAllocations, type ReceiptLineDraft } from "../admin/stockReceipt";
import type { AdminProduct, Branch, BranchStockDoc } from "../admin/types";
import { branchStockId } from "./branchStock";
import { db } from "./config";

export type StockReceiptErrorCode = "duplicate" | "productMissing" | "cellMissing" | "unconfirmed" | "branchInactive" | "invalid";

export class StockReceiptError extends Error {
  readonly code: StockReceiptErrorCode;
  constructor(message: string, code: StockReceiptErrorCode) {
    super(message);
    this.code = code;
  }
}

export interface StockReceiptInput {
  receiptId: string;
  product: { id: string; name: string };
  lines: ReceiptLineDraft[];
  locationIds: string[];
  reference?: string;
  note?: string;
}

// Adds received stock to the online store and/or branches in ONE
// transaction: either every location and every movement is written, or
// nothing is. Mirrors the other stock writers (saveBranchStock,
// ProductForm, placeOrder): fresh reads inside the transaction, quantities
// re-derived from those reads (never from what the screen showed), and one
// stockMovements row per changed cell.
//
// Duplicate protection: the movement ids are derived from receiptId
// (`<receiptId>__<n>`), and the first one is read before writing. A second
// submit of the same receipt (double click, retry after a timeout that
// actually committed, a second tab) finds it and stops with "duplicate"
// instead of adding the stock twice.
export async function receiveStock(input: StockReceiptInput, actor: Actor): Promise<{ movements: number; units: number }> {
  const allocations = receiptAllocations(input.lines, input.locationIds);
  if (allocations.length === 0) throw new StockReceiptError("Nothing to add.", "invalid");

  const productRef = doc(db, "products", input.product.id);
  const branchIds = [...new Set(allocations.map((a) => a.locationId).filter((id) => id !== ONLINE_LOCATION))];
  const branchStockRefs = branchIds.map((id) => doc(db, "branchStock", branchStockId(id, input.product.id)));
  const branchRefs = branchIds.map((id) => doc(db, "branches", id));
  const movementRef = (n: number) => doc(db, "stockMovements", `${input.receiptId}__${n}`);
  const reference = input.reference?.trim() || undefined;
  const note = input.note?.trim() || undefined;

  await runTransaction(db, async (tx) => {
    if ((await tx.get(movementRef(0))).exists()) {
      throw new StockReceiptError("This stock was already added (same receipt).", "duplicate");
    }
    const productSnap = await tx.get(productRef);
    const branchSnaps = await Promise.all(branchRefs.map((r) => tx.get(r)));
    const stockSnaps = await Promise.all(branchStockRefs.map((r) => tx.get(r)));
    if (!productSnap.exists()) throw new StockReceiptError("This product no longer exists.", "productMissing");

    branchSnaps.forEach((snap) => {
      const b = snap.exists() ? (snap.data() as Branch) : null;
      if (!b || !b.active) throw new StockReceiptError(`Branch ${b?.name ?? snap.id} is missing or inactive.`, "branchInactive");
    });

    const product = normalizeProduct({ id: productSnap.id, ...productSnap.data() } as AdminProduct);
    // Every allocated color/size must still exist on the product.
    for (const a of allocations) {
      const variant = product.colorVariants.find((v) => v.id === a.variantId);
      if (!variant || !variant.sizeStock.some((s) => s.size === a.size)) {
        throw new StockReceiptError(`${a.colorName} / ${a.size} no longer exists on this product.`, "cellMissing");
      }
    }

    const movements: Record<string, unknown>[] = [];
    const base = {
      productId: product.id,
      productName: product.name,
      reason: "stock_received",
      source: "admin",
      actorUid: actor.uid,
      actorEmail: actor.email,
      actorName: actor.displayName || actor.email,
      receiptId: input.receiptId,
      reference,
      note,
    };

    // Online store: the product document's own stock.
    const online = allocations.filter((a) => a.locationId === ONLINE_LOCATION);
    if (online.length > 0) {
      const nextVariants = product.colorVariants.map((v) => ({
        ...v,
        sizeStock: v.sizeStock.map((s) => {
          const add = online.filter((a) => a.variantId === v.id && a.size === s.size).reduce((sum, a) => sum + a.qty, 0);
          if (!add) return s;
          // Never turn an unconfirmed count into a made-up number.
          if (s.qty === null) {
            throw new StockReceiptError(`Online stock for ${v.colorName} / ${s.size} was never confirmed — set it in the product form first.`, "unconfirmed");
          }
          movements.push({ ...base, variantId: v.id, colorName: v.colorName, size: s.size, qtyBefore: s.qty, qtyChange: add, qtyAfter: s.qty + add });
          return { ...s, qty: s.qty + add, qtyUnknown: undefined };
        }),
      }));
      tx.update(productRef, { stockByCell: toStockByCell(nextVariants), updatedAt: serverTimestamp() });
    }

    // Each branch: its branchStock doc (created on first stock).
    branchIds.forEach((branchId, i) => {
      const snap = stockSnaps[i];
      const current = (snap.exists() ? (snap.get("stockByCell") as BranchStockDoc["stockByCell"]) : undefined) ?? {};
      const next = { ...current };
      for (const a of allocations.filter((x) => x.locationId === branchId)) {
        const key = stockCellKey(a.variantId, a.size);
        const before = typeof next[key]?.qty === "number" ? (next[key].qty as number) : 0;
        next[key] = { qty: before + a.qty };
        movements.push({ ...base, variantId: a.variantId, colorName: a.colorName, size: a.size, qtyBefore: before, qtyChange: a.qty, qtyAfter: before + a.qty, branchId });
      }
      if (snap.exists()) tx.update(branchStockRefs[i], { stockByCell: next, updatedAt: serverTimestamp() });
      else tx.set(branchStockRefs[i], { branchId, productId: product.id, stockByCell: next, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    });

    movements.forEach((m, n) => tx.set(movementRef(n), { ...m, createdAt: serverTimestamp() }));
  });

  const units = allocations.reduce((s, a) => s + a.qty, 0);
  await logActivity(actor, "stock.received", input.product.name, `${units} units · ${input.receiptId}${reference ? ` · ${reference}` : ""}`);
  return { movements: allocations.length, units };
}
