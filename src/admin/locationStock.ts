import type { StockMovement } from "./types";

// Per-location stock breakdown for one product, derived entirely from the
// existing data: the product doc's stockByCell (online/website stock), the
// branchStock docs (one per branch), and the stockMovements ledger, where a
// movement's `branchId` says which branch it changed (absent = online).
// Pure logic only — ProductStockByLocation.tsx does the reads.

// Location id used for the website's own stock (movements without branchId).
export const ONLINE_LOCATION = "online";

export type LedgerMovement = Pick<
  StockMovement,
  "id" | "variantId" | "colorName" | "size" | "qtyBefore" | "qtyChange" | "qtyAfter" | "reason" | "source" | "actorName" | "actorEmail" | "orderId" | "orderNumber" | "returnId" | "branchId" | "registerName" | "receiptId" | "reference" | "note" | "adjustmentReason"
> & { at: number }; // createdAt in ms (0 while a just-written serverTimestamp is still pending)

export type MovementBucket = "opening" | "added" | "removed" | "sold" | "returned";

export function movementLocation(m: Pick<StockMovement, "branchId">): string {
  return m.branchId || ONLINE_LOCATION;
}

// Which column of the breakdown a movement counts toward.
//  - opening:  "initial_stock" (product created with stock), or the very
//              first stock a location ever received for a color/size — a
//              branch is stocked through a manual count from 0, which is its
//              opening stock rather than a later addition.
//  - sold:     sales, net of order edits and cancellations (a cancelled or
//              reduced order gives its units back, so they were never sold).
//  - returned: returned items put back on the shelf.
//  - added / removed: every other manual count change, by direction.
export function classifyMovement(m: Pick<StockMovement, "reason" | "qtyBefore" | "qtyChange">, isFirstForCell: boolean): MovementBucket {
  switch (m.reason) {
    case "initial_stock":
      return "opening";
    case "sale":
    case "order_edit":
    case "order_cancelled":
      return "sold";
    case "return_restock":
      return "returned";
    case "manual_adjustment":
    case "stock_received":
    default:
      if (isFirstForCell && m.qtyBefore === 0 && m.qtyChange > 0) return "opening";
      return m.qtyChange > 0 ? "added" : "removed";
  }
}

export interface LocationStockSummary {
  locationId: string;
  // Opening stock recorded in the ledger (see classifyMovement()).
  opening: number;
  // Stock the location already held before its history starts (e.g. stock
  // that predates the ledger). current - ledger net change; 0 normally.
  // Negative means the ledger and the stored count disagree.
  untracked: number;
  added: number;
  removed: number; // positive number of units taken out by manual counts
  sold: number; // net units sold
  returned: number;
  current: number;
  movementCount: number;
  lastMovementAt: number | null;
}

// current = (opening + untracked) + added - removed - sold + returned,
// always, by construction — `untracked` absorbs anything the ledger can't
// explain so the numbers on screen always add up to the real stored count.
export function summarizeLocationStock(movements: LedgerMovement[], currentByLocation: Map<string, number>): Map<string, LocationStockSummary> {
  const sorted = [...movements].sort((a, b) => a.at - b.at);
  const out = new Map<string, LocationStockSummary>();
  const ensure = (locationId: string) => {
    let s = out.get(locationId);
    if (!s) {
      s = { locationId, opening: 0, untracked: 0, added: 0, removed: 0, sold: 0, returned: 0, current: currentByLocation.get(locationId) ?? 0, movementCount: 0, lastMovementAt: null };
      out.set(locationId, s);
    }
    return s;
  };
  for (const id of currentByLocation.keys()) ensure(id);

  const seenCells = new Set<string>();
  const net = new Map<string, number>();
  for (const m of sorted) {
    const loc = movementLocation(m);
    const s = ensure(loc);
    const cell = `${loc}::${m.variantId}::${m.size}`;
    const bucket = classifyMovement(m, !seenCells.has(cell));
    seenCells.add(cell);
    if (bucket === "opening") s.opening += m.qtyChange;
    else if (bucket === "added") s.added += m.qtyChange;
    else if (bucket === "removed") s.removed += -m.qtyChange;
    else if (bucket === "sold") s.sold += -m.qtyChange;
    else s.returned += m.qtyChange;
    net.set(loc, (net.get(loc) ?? 0) + m.qtyChange);
    s.movementCount++;
    if (m.at) s.lastMovementAt = Math.max(s.lastMovementAt ?? 0, m.at);
  }
  for (const s of out.values()) s.untracked = s.current - (net.get(s.locationId) ?? 0);
  return out;
}
