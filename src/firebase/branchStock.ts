import { collection, doc, onSnapshot, query, runTransaction, serverTimestamp, where } from "firebase/firestore";
import type { Actor } from "../admin/actor";
import { stockCellKey } from "../admin/productVariants";
import type { AdminProduct, BranchStockDoc } from "../admin/types";
import { db } from "./config";

// Deterministic id so a branch/product pair can be read directly inside a
// transaction (no query needed) -- placeOrder() relies on this.
export function branchStockId(branchId: string, productId: string): string {
  return `${branchId}__${productId}`;
}

// A cell absent from the branch document means this branch never received
// that color/size: 0, not "unknown".
export function branchCellQty(stock: BranchStockDoc | undefined, variantId: string, size: string): number {
  const qty = stock?.stockByCell?.[stockCellKey(variantId, size)]?.qty;
  return typeof qty === "number" ? qty : 0;
}

export function branchTotalQty(stock: BranchStockDoc | undefined): number {
  if (!stock) return 0;
  return Object.values(stock.stockByCell ?? {}).reduce((sum, c) => sum + (typeof c.qty === "number" && c.qty > 0 ? c.qty : 0), 0);
}

// The product as this branch sees it: same colors/sizes/prices, but every
// size's qty replaced by the branch's own count. Lets the existing POS
// picker, sellability rule and stock checks run unchanged against branch
// stock instead of the online stock on the product document.
export function withBranchStock(product: AdminProduct, stock: BranchStockDoc | undefined): AdminProduct {
  return {
    ...product,
    colorVariants: product.colorVariants.map((v) => ({
      ...v,
      sizeStock: v.sizeStock.map((s) => ({ size: s.size, qty: branchCellQty(stock, v.id, s.size) })),
    })),
  };
}

function toDoc(id: string, data: Record<string, unknown>): BranchStockDoc {
  return { id, ...(data as Omit<BranchStockDoc, "id">) };
}

// productId -> that product's stock doc at one branch.
export function subscribeBranchStock(branchId: string, onData: (byProduct: Map<string, BranchStockDoc>) => void): () => void {
  return onSnapshot(
    query(collection(db, "branchStock"), where("branchId", "==", branchId)),
    (snap) => onData(new Map(snap.docs.map((d) => [d.get("productId") as string, toDoc(d.id, d.data())]))),
    (error) => {
      console.error("[branchStock] subscribe error:", error);
      onData(new Map());
    }
  );
}

// Every branch's stock doc for one product -- the POS "other branches"
// availability view.
export function subscribeProductBranchStock(productId: string, onData: (docs: BranchStockDoc[]) => void): () => void {
  return onSnapshot(
    query(collection(db, "branchStock"), where("productId", "==", productId)),
    (snap) => onData(snap.docs.map((d) => toDoc(d.id, d.data()))),
    (error) => {
      console.error("[branchStock] product subscribe error:", error);
      onData([]);
    }
  );
}

export interface BranchStockEdit {
  variantId: string;
  colorName: string;
  size: string;
  qty: number;
}

export class BranchTransferError extends Error {}

// Moves units of one color/size from one branch to another, atomically: both
// branch documents change together, with a "branch_transfer" ledger row on
// each side. Refuses to move more than the source branch holds right now.
export async function transferBranchStock(
  fromBranchId: string,
  toBranchId: string,
  product: { id: string; name: string },
  cell: { variantId: string; colorName: string; size: string },
  qty: number,
  actor: Actor
): Promise<void> {
  if (fromBranchId === toBranchId || !(qty > 0)) throw new BranchTransferError("Invalid transfer.");
  const key = stockCellKey(cell.variantId, cell.size);
  const fromRef = doc(db, "branchStock", branchStockId(fromBranchId, product.id));
  const toRef = doc(db, "branchStock", branchStockId(toBranchId, product.id));
  await runTransaction(db, async (tx) => {
    const [fromSnap, toSnap] = await Promise.all([tx.get(fromRef), tx.get(toRef)]);
    const fromCells = ((fromSnap.exists() ? fromSnap.get("stockByCell") : undefined) ?? {}) as BranchStockDoc["stockByCell"];
    const toCells = ((toSnap.exists() ? toSnap.get("stockByCell") : undefined) ?? {}) as BranchStockDoc["stockByCell"];
    const fromBefore = typeof fromCells[key]?.qty === "number" ? (fromCells[key].qty as number) : 0;
    const toBefore = typeof toCells[key]?.qty === "number" ? (toCells[key].qty as number) : 0;
    if (qty > fromBefore) throw new BranchTransferError(`Only ${fromBefore} available.`);
    tx.update(fromRef, { stockByCell: { ...fromCells, [key]: { qty: fromBefore - qty } }, updatedAt: serverTimestamp() });
    if (toSnap.exists()) tx.update(toRef, { stockByCell: { ...toCells, [key]: { qty: toBefore + qty } }, updatedAt: serverTimestamp() });
    else tx.set(toRef, { branchId: toBranchId, productId: product.id, stockByCell: { [key]: { qty } }, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    const base = {
      productId: product.id,
      productName: product.name,
      variantId: cell.variantId,
      colorName: cell.colorName,
      size: cell.size,
      reason: "branch_transfer",
      source: "admin",
      actorUid: actor.uid,
      actorEmail: actor.email,
      actorName: actor.displayName || actor.email,
      createdAt: serverTimestamp(),
    };
    tx.set(doc(collection(db, "stockMovements")), { ...base, branchId: fromBranchId, qtyBefore: fromBefore, qtyChange: -qty, qtyAfter: fromBefore - qty, transferToBranchId: toBranchId });
    tx.set(doc(collection(db, "stockMovements")), { ...base, branchId: toBranchId, qtyBefore: toBefore, qtyChange: qty, qtyAfter: toBefore + qty, transferFromBranchId: fromBranchId });
  });
}

// Admin/editor manual count for one branch: sets the given cells and writes
// one stockMovements row per changed cell (tagged with branchId), atomically
// -- the same ledger guarantee Inventory.tsx gives online stock.
export async function saveBranchStock(branchId: string, product: { id: string; name: string }, edits: BranchStockEdit[], actor: Actor): Promise<void> {
  const ref = doc(db, "branchStock", branchStockId(branchId, product.id));
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const current = (snap.exists() ? (snap.get("stockByCell") as BranchStockDoc["stockByCell"]) : undefined) ?? {};
    const next = { ...current };
    const changed: (BranchStockEdit & { before: number })[] = [];
    for (const e of edits) {
      const key = stockCellKey(e.variantId, e.size);
      const before = typeof current[key]?.qty === "number" ? (current[key].qty as number) : 0;
      if (before === e.qty && key in current) continue;
      next[key] = { qty: e.qty };
      if (before !== e.qty) changed.push({ ...e, before });
    }
    if (snap.exists()) {
      tx.update(ref, { stockByCell: next, updatedAt: serverTimestamp() });
    } else {
      tx.set(ref, { branchId, productId: product.id, stockByCell: next, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    }
    for (const c of changed) {
      tx.set(doc(collection(db, "stockMovements")), {
        productId: product.id,
        productName: product.name,
        variantId: c.variantId,
        colorName: c.colorName,
        size: c.size,
        qtyBefore: c.before,
        qtyChange: c.qty - c.before,
        qtyAfter: c.qty,
        reason: "manual_adjustment",
        source: "admin",
        actorUid: actor.uid,
        actorEmail: actor.email,
        actorName: actor.displayName || actor.email,
        branchId,
        createdAt: serverTimestamp(),
      });
    }
  });
}
