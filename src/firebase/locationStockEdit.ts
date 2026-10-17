import { collection, doc, runTransaction, serverTimestamp } from "../db/firestore";
import type { Actor } from "../admin/actor";
import { logActivity } from "../admin/logActivity";
import { ONLINE_LOCATION } from "../admin/locationStock";
import { normalizeProduct, stockCellKey, toStockByCell } from "../admin/productVariants";
import type { AdminProduct, BranchStockDoc, StockAdjustmentReason } from "../admin/types";
import { branchStockId } from "./branchStock";
import { db } from "./config";

export class LocationStockEditError extends Error {
  readonly code: "conflict" | "productMissing" | "cellMissing";
  constructor(message: string, code: "conflict" | "productMissing" | "cellMissing") {
    super(message);
    this.code = code;
  }
}

export interface LocationStockEdit {
  variantId: string;
  colorName: string;
  size: string;
  // The count the admin saw when they opened the editor (null = online
  // count never confirmed). If the stored count differs at save time —
  // e.g. a POS sale happened meanwhile — the save is refused rather than
  // silently overwriting that sale.
  expected: number | null;
  qty: number;
}

// Sets new counts for some color/sizes at ONE location — the online store
// (the product doc's stockByCell) or a branch (its branchStock doc) — in a
// single transaction, with one "manual_adjustment" stockMovements row per
// changed cell. All or nothing.
export async function saveLocationStock(
  product: { id: string; name: string },
  locationId: string,
  edits: LocationStockEdit[],
  reason: { code: StockAdjustmentReason; note?: string },
  actor: Actor
): Promise<void> {
  const note = reason.note?.trim() || undefined;
  const changed = edits.filter((e) => e.qty !== e.expected);
  if (changed.length === 0) return;

  const isOnline = locationId === ONLINE_LOCATION;
  const productRef = doc(db, "products", product.id);
  const branchRef = isOnline ? null : doc(db, "branchStock", branchStockId(locationId, product.id));

  await runTransaction(db, async (tx) => {
    const movements: Record<string, unknown>[] = [];
    const movement = (e: LocationStockEdit, before: number) => ({
      productId: product.id,
      productName: product.name,
      variantId: e.variantId,
      colorName: e.colorName,
      size: e.size,
      qtyBefore: before,
      qtyChange: e.qty - before,
      qtyAfter: e.qty,
      reason: "manual_adjustment",
      adjustmentReason: reason.code,
      note,
      source: "admin",
      actorUid: actor.uid,
      actorEmail: actor.email,
      actorName: actor.displayName || actor.email,
      branchId: isOnline ? undefined : locationId,
      createdAt: serverTimestamp(),
    });
    const conflict = () => {
      throw new LocationStockEditError("The stock changed while you were editing (for example a sale). Reopen the editor to see the latest numbers.", "conflict");
    };

    if (isOnline) {
      const snap = await tx.get(productRef);
      if (!snap.exists()) throw new LocationStockEditError("This product no longer exists.", "productMissing");
      const p = normalizeProduct({ id: snap.id, ...snap.data() } as AdminProduct);
      for (const e of changed) {
        const cell = p.colorVariants.find((v) => v.id === e.variantId)?.sizeStock.find((s) => s.size === e.size);
        if (!cell) throw new LocationStockEditError(`${e.colorName} / ${e.size} no longer exists on this product.`, "cellMissing");
        if ((cell.qty ?? null) !== e.expected) conflict();
      }
      const next = p.colorVariants.map((v) => ({
        ...v,
        sizeStock: v.sizeStock.map((s) => {
          const e = changed.find((x) => x.variantId === v.id && x.size === s.size);
          if (!e) return s;
          // computeStockDeltas' convention: an unconfirmed (null) count is 0 for the ledger.
          movements.push(movement(e, s.qty ?? 0));
          return { size: s.size, qty: e.qty };
        }),
      }));
      tx.update(productRef, { stockByCell: toStockByCell(next), updatedAt: serverTimestamp() });
    } else {
      const snap = await tx.get(branchRef!);
      const current = (snap.exists() ? (snap.get("stockByCell") as BranchStockDoc["stockByCell"]) : undefined) ?? {};
      const next = { ...current };
      for (const e of changed) {
        const key = stockCellKey(e.variantId, e.size);
        // Absent cell = 0 at this branch (see branchCellQty).
        const before = typeof current[key]?.qty === "number" ? (current[key].qty as number) : 0;
        if (before !== e.expected) conflict();
        next[key] = { qty: e.qty };
        movements.push(movement(e, before));
      }
      if (snap.exists()) tx.update(branchRef!, { stockByCell: next, updatedAt: serverTimestamp() });
      else tx.set(branchRef!, { branchId: locationId, productId: product.id, stockByCell: next, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    }

    for (const m of movements) tx.set(doc(collection(db, "stockMovements")), m);
  });

  await logActivity(actor, "inventory.stockUpdated", product.name, `${reason.code}${note ? ` — ${note}` : ""}`);
}
