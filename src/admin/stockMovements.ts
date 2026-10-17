import { documentId, limit, orderBy, startAfter, Timestamp, where, type QueryConstraint } from "../db/firestore";
import type { AdminColorVariant, AdminProduct, OrderLine, StockMovement, StockMovementReason, StockMovementSource } from "./types";

export interface StockDelta {
  variantId: string;
  colorName: string;
  size: string;
  qtyBefore: number;
  qtyAfter: number;
  qtyChange: number;
}

// Compares a product's colorVariants before/after a write and returns one
// entry for every (variant, size) cell whose quantity actually changed —
// everything else (a renamed color, a new image, an untouched size, a
// product edit that never touches quantity at all) is skipped, so no
// phantom zero-delta movement is ever produced. Each of the five real
// stock-changing call sites (orderTransaction.ts, adminOrderEdit.ts,
// returnsTransaction.ts, Inventory.tsx, ProductForm.tsx — see the Phase 0/1
// design report) already has its own before/after colorVariants pair in
// hand at no extra Firestore cost; this just extracts the raw per-cell
// deltas. The caller layers its own reason/source/order linkage on top,
// since only the caller knows *why* the change happened — mirrors exactly
// how lowStockNotify.ts's findLowStockCrossings() is used today.
//
// qty: null ("never confirmed") is floored to 0 on both sides — the same
// floor already used by resolveReturn() and totalStock() elsewhere in this
// codebase: a real physical unit is always at least the known count, never
// less. This means a slot going from null -> 0 (still unconfirmed, now
// explicitly zero) produces no entry (0 === 0, correctly not a real
// change), while null -> 5 produces a +5 entry (a genuine new baseline).
//
// A cell that exists in `before` but is entirely removed in `after` (a
// whole color or size deleted outright, not just zeroed) produces no
// entry — deliberately consistent with findLowStockCrossings()'s own
// before/after walk, which only ever iterates `after` variants too.
export function computeStockDeltas(before: AdminColorVariant[], after: AdminColorVariant[]): StockDelta[] {
  const deltas: StockDelta[] = [];
  for (const afterVariant of after) {
    const beforeVariant = before.find((v) => v.id === afterVariant.id);
    for (const afterStock of afterVariant.sizeStock) {
      const beforeStock = beforeVariant?.sizeStock.find((s) => s.size === afterStock.size);
      const qtyBefore = beforeStock?.qty ?? 0;
      const qtyAfter = afterStock.qty ?? 0;
      if (qtyBefore === qtyAfter) continue;
      deltas.push({
        variantId: afterVariant.id,
        colorName: afterVariant.colorName,
        size: afterStock.size,
        qtyBefore,
        qtyAfter,
        qtyChange: qtyAfter - qtyBefore,
      });
    }
  }
  return deltas;
}

// --- Order cancellation -> stock restoration --------------------------------
// Pure logic only, no Firestore reads -- the transaction (src/firebase/
// orderCancellation.ts) owns reading fresh order/product data and writing
// the result; this module owns the decisions worth testing without a live
// emulator, same split as computeStockDeltas() above.

export class OrderCancellationError extends Error {}

export interface CancellationRestoreEntry {
  productId: string;
  variantId: string;
  size: string;
  qty: number;
}

// Aggregates an order's lines by (productId, variantId, size) into the net
// quantity that should be released back to stock on cancellation. A
// duplicate (productId, variantId, size) appearing on more than one line
// restores as one combined quantity, never overwriting or double-counting —
// mirrors adminOrderEdit.ts's own delta map for the identical reason.
export function aggregateCancellationRestoreQty(lines: OrderLine[]): CancellationRestoreEntry[] {
  const byKey = new Map<string, CancellationRestoreEntry>();
  for (const l of lines) {
    const k = `${l.productId}::${l.variantId}::${l.size}`;
    const existing = byKey.get(k);
    if (existing) existing.qty += l.qty;
    else byKey.set(k, { productId: l.productId, variantId: l.variantId, size: l.size, qty: l.qty });
  }
  return [...byKey.values()];
}

export interface CancellationStockUpdate {
  productId: string;
  productName: string;
  before: AdminColorVariant[];
  after: AdminColorVariant[];
}

// Validates every aggregated restore entry against the live product data
// (its color still exists, its size still exists, its qty was actually
// confirmed) BEFORE computing any update — if any entry can't be safely
// resolved, this throws immediately and returns nothing, so the caller's
// transaction never queues a partial write. Mirrors resolveReturn()'s
// per-field existence checks, just validated across every line on the
// order up front instead of one return at a time.
export function computeCancellationStockUpdates(
  restoreEntries: CancellationRestoreEntry[],
  productById: Map<string, Pick<AdminProduct, "id" | "name" | "colorVariants">>
): CancellationStockUpdate[] {
  for (const entry of restoreEntries) {
    const product = productById.get(entry.productId);
    if (!product) {
      throw new OrderCancellationError("One of the products in this order no longer exists — cannot safely restore stock. Resolve the discrepancy manually via Inventory before cancelling.");
    }
    const variant = product.colorVariants.find((v) => v.id === entry.variantId);
    if (!variant) {
      throw new OrderCancellationError(`${product.name}: that color is no longer available — cannot safely restore stock for this order. Resolve it manually via Inventory before cancelling.`);
    }
    const stockEntry = variant.sizeStock.find((s) => s.size === entry.size);
    if (!stockEntry) {
      throw new OrderCancellationError(`${product.name} (${variant.colorName}): size "${entry.size}" is no longer available — cannot safely restore stock for this order. Resolve it manually via Inventory before cancelling.`);
    }
    if (stockEntry.qty === null) {
      throw new OrderCancellationError(`${product.name} (${variant.colorName}, ${entry.size}) has a stock count that was never confirmed — update its inventory before cancelling this order.`);
    }
  }

  const entryByKey = new Map<string, CancellationRestoreEntry>();
  for (const entry of restoreEntries) {
    entryByKey.set(`${entry.productId}::${entry.variantId}::${entry.size}`, entry);
  }

  const updates: CancellationStockUpdate[] = [];
  for (const product of productById.values()) {
    let touched = false;
    const newColorVariants: AdminColorVariant[] = product.colorVariants.map((variant) => ({
      ...variant,
      sizeStock: variant.sizeStock.map((s) => {
        const entry = entryByKey.get(`${product.id}::${variant.id}::${s.size}`);
        if (!entry) return s;
        touched = true;
        // Already proven non-null for every touched cell by the validation
        // pass above — the `?? 0` here is defensive parity with
        // resolveReturn()'s identical floor, not a real fallback this path
        // can actually hit.
        return { ...s, qty: (s.qty ?? 0) + entry.qty };
      }),
    }));
    if (touched) {
      updates.push({ productId: product.id, productName: product.name, before: product.colorVariants, after: newColorVariants });
    }
  }
  return updates;
}

// --- Phase 4: Stock Ledger admin UI helpers --------------------------------
// Pure logic only, no Firestore reads — the page (StockLedger.tsx) owns
// fetching and rendering; this module owns the decisions that are worth
// testing without a live emulator.

export const STOCK_MOVEMENT_REASON_LABEL_KEY: Record<StockMovementReason, string> = {
  sale: "admin.stockLedger.reason.sale",
  order_edit: "admin.stockLedger.reason.orderEdit",
  return_restock: "admin.stockLedger.reason.returnRestock",
  manual_adjustment: "admin.stockLedger.reason.manualAdjustment",
  initial_stock: "admin.stockLedger.reason.initialStock",
  order_cancelled: "admin.stockLedger.reason.orderCancelled",
  stock_received: "admin.stockLedger.reason.stockReceived",
  branch_transfer: "admin.stockLedger.reason.branchTransfer",
};

export const STOCK_MOVEMENT_SOURCE_LABEL_KEY: Record<StockMovementSource, string> = {
  web: "admin.stockLedger.source.web",
  pos: "admin.stockLedger.source.pos",
  admin: "admin.stockLedger.source.admin",
};

// A decrease reads as "danger" (stock leaving), an increase as "success"
// (stock arriving) — the project's existing semantic Badge tones, nothing
// new introduced. computeStockDeltas() never produces a zero-change entry,
// so there's deliberately no third case here.
export function stockMovementDeltaTone(qtyChange: number): "success" | "danger" {
  return qtyChange > 0 ? "success" : "danger";
}

// A web-checkout sale is placed by an arbitrary signed-in-or-anonymous
// shopper (see orderTransaction.ts) — no actor fields are ever written for
// that case, deliberately, rather than inventing a staff identity. This is
// the one and only case the UI should ever render a "Website checkout"
// label; every other reason always carries a real actorName/actorEmail.
// Never fabricates a name when fields are genuinely absent for any other
// reason — falls back to null, which the caller renders as an em dash.
export function resolveActorDisplay(movement: Pick<StockMovement, "source" | "actorName" | "actorEmail">): { kind: "webCheckout" } | { kind: "named"; name: string } | { kind: "unknown" } {
  if (movement.actorName || movement.actorEmail) {
    return { kind: "named", name: movement.actorName || movement.actorEmail! };
  }
  if (movement.source === "web") return { kind: "webCheckout" };
  return { kind: "unknown" };
}

export interface LedgerFilters {
  productId?: string;
  orderId?: string;
  dateFrom?: string; // yyyy-mm-dd, inclusive
  dateTo?: string; // yyyy-mm-dd, inclusive
}

// A page boundary is defined by BOTH values together, never createdAt
// alone — see the long comment on buildLedgerQueryConstraints below for
// why a single-field cursor is unsafe here specifically.
export interface LedgerPageCursor {
  createdAt: unknown;
  id: string;
}

// Server-side query shape only — the four filters that can genuinely be
// pushed to Firestore without a new composite index:
//   - no filters: orderBy(createdAt desc) + limit -- the always-free
//     single-field index every page starts from.
//   - productId: where(productId ==) + orderBy(createdAt desc) + limit --
//     exactly the existing (productId ASC, createdAt DESC) composite index
//     added in Phase 1, and nothing else.
//   - dateFrom/dateTo: range filters on createdAt, the SAME field the
//     query already sorts by -- Firestore covers "equality field(s) then a
//     single range/orderBy field" with one composite index, so this is
//     covered by the existing index too (with or without productId also
//     set), not a new one.
//   - orderId: a lone equality filter with no orderBy/limit at all -- an
//     order's lines are capped at MAX_CHECKOUT_LINES (8), so this always
//     returns a small, naturally-bounded result set and needs no index or
//     pagination. Deliberately short-circuits everything else below: an
//     order-scoped lookup is its own small, complete view, not a page of a
//     larger paginated feed.
// Every other filter (color, size, reason, source, actor) is NOT server-
// side — see applyClientLedgerFilters() below, applied only to whatever
// page is already loaded, per the approved design (avoiding speculative
// composite indexes for every possible filter combination).
//
// orderBy(documentId(), "desc") is added right after orderBy(createdAt,
// "desc") on every paginated path (everything except the orderId
// short-circuit, which never paginates at all). This is NOT a new index
// requirement: Firestore always appends __name__ as the final tiebreaker
// field to whatever index a query already uses, in the same direction as
// the last explicit orderBy -- both the automatic single-field index on
// createdAt and the existing (productId ASC, createdAt DESC) composite
// index already end with an implicit __name__ DESC. Making that tiebreak
// EXPLICIT in the query (rather than leaving it implicit) is what actually
// matters: multiple stockMovements docs written inside the same
// transaction share the exact same createdAt (every write in one Firestore
// transaction commits with one server timestamp) -- a real, common case
// here, not a rare one, since a multi-line checkout/order-edit/inventory
// save produces exactly this. A cursor built from createdAt alone
// (startAfter(createdAtValue)) excludes EVERY document with that exact
// timestamp on the next page, silently dropping same-transaction siblings
// that happened to fall after the page boundary. Cursoring on BOTH values
// (startAfter(createdAtValue, docId)) resumes exactly after that specific
// document instead, so ties are split correctly across pages instead of
// being dropped. See findPageCursor() below for how the pair is built, and
// tests/rules/stock-movements-pagination.test.ts for a live-emulator proof
// against real same-timestamp documents.
export function buildLedgerQueryConstraints(filters: LedgerFilters, opts: { cursor?: LedgerPageCursor; pageSize?: number } = {}): QueryConstraint[] {
  if (filters.orderId) {
    return [where("orderId", "==", filters.orderId)];
  }
  const constraints: QueryConstraint[] = [];
  if (filters.productId) constraints.push(where("productId", "==", filters.productId));
  if (filters.dateFrom) constraints.push(where("createdAt", ">=", Timestamp.fromDate(new Date(`${filters.dateFrom}T00:00:00`))));
  if (filters.dateTo) constraints.push(where("createdAt", "<=", Timestamp.fromDate(new Date(`${filters.dateTo}T23:59:59`))));
  constraints.push(orderBy("createdAt", "desc"));
  constraints.push(orderBy(documentId(), "desc"));
  if (opts.cursor) constraints.push(startAfter(opts.cursor.createdAt, opts.cursor.id));
  constraints.push(limit(opts.pageSize ?? 50));
  return constraints;
}

export interface ClientLedgerFilters {
  colorName?: string;
  size?: string;
  reason?: StockMovementReason;
  source?: StockMovementSource;
  actor?: string; // matches actorName or actorEmail, case-insensitive substring
}

// Applied to whatever window is currently loaded (the active page, or the
// full result set for an orderId-scoped lookup) — never the whole
// collection. An honest limitation, not a bug: "every manual_adjustment
// ever" isn't a cheap query today (see buildLedgerQueryConstraints' own
// comment) — these filters narrow what's already in hand instead.
export function applyClientLedgerFilters(rows: StockMovement[], filters: ClientLedgerFilters): StockMovement[] {
  const actorQuery = filters.actor?.trim().toLowerCase();
  return rows.filter((m) => {
    if (filters.colorName && m.colorName !== filters.colorName) return false;
    if (filters.size && m.size !== filters.size) return false;
    if (filters.reason && m.reason !== filters.reason) return false;
    if (filters.source && m.source !== filters.source) return false;
    if (actorQuery && !(m.actorName?.toLowerCase().includes(actorQuery) || m.actorEmail?.toLowerCase().includes(actorQuery))) return false;
    return true;
  });
}

// Picks the (createdAt, id) pair for the NEXT page's startAfter() from a
// just-loaded page -- both values together, never createdAt alone (see
// buildLedgerQueryConstraints' comment on why a single-field cursor can
// silently drop same-timestamp siblings). Walks backward past any trailing
// rows whose createdAt hasn't resolved yet -- a document read back
// immediately after its own serverTimestamp() write can briefly report
// null -- so "Load more" never breaks on that edge case. Returns undefined
// only if every row on the page is still unresolved (practically only
// possible on an empty page).
export function findPageCursor(rows: Pick<StockMovement, "id" | "createdAt">[]): LedgerPageCursor | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].createdAt != null) return { createdAt: rows[i].createdAt, id: rows[i].id };
  }
  return undefined;
}
