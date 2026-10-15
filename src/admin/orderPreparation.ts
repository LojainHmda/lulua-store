import type { Actor } from "./actor";
import { returnLineKey } from "./returnsHelpers";
import type { OrderLine, OrderStatus } from "./types";

// Pure helpers only — no Firestore access — mirroring the style of
// returnsHelpers.ts/productVariants.ts. The one write path lives in
// firebase/orderPreparation.ts.

export type PreparedLines = Record<string, boolean>;

// Reuses returnsHelpers.ts's own key shape (productId::variantId::size) --
// there is no reason for preparation tracking and returns tracking to
// identify "which line" two different ways.
function lineKey(line: Pick<OrderLine, "productId" | "variantId" | "size">): string {
  return returnLineKey(line.productId, line.variantId, line.size);
}

// Missing entirely (undefined map, or key never set) reads as unconfirmed --
// this is what makes every historical order predating this feature valid
// with zero migration: it simply has no preparedLines at all, and every one
// of its lines is unconfirmed by default.
export function isLinePrepared(preparedLines: PreparedLines | undefined, line: Pick<OrderLine, "productId" | "variantId" | "size">): boolean {
  return preparedLines?.[lineKey(line)] === true;
}

// An order with zero lines is never "ready" -- there is nothing to have
// prepared, and treating vacuous truth as "all confirmed" would let a
// line-less manual/off-site order (see OrderList.tsx's "New Order") skip
// straight to a prepared state it never earned.
export function allLinesPrepared(lines: OrderLine[], preparedLines: PreparedLines | undefined): boolean {
  if (lines.length === 0) return false;
  return lines.every((l) => isLinePrepared(preparedLines, l));
}

export function setLinePrepared(
  preparedLines: PreparedLines | undefined,
  line: Pick<OrderLine, "productId" | "variantId" | "size">,
  prepared: boolean
): PreparedLines {
  const next = { ...(preparedLines ?? {}) };
  const key = lineKey(line);
  if (prepared) next[key] = true;
  else delete next[key];
  return next;
}

// Phase A: per-line "who/when" metadata, additive alongside preparedLines
// above -- never the source of truth for whether a line counts as
// confirmed (preparedLines/isLinePrepared() alone still decide that; see
// this module's own doc comment). Kept as a strictly separate map (not
// merged into preparedLines' own boolean values) specifically so
// preparedLines' existing shape/behavior/tests are untouched and every
// historical order without preparedLineMeta continues to work with zero
// migration -- a line simply has no metadata, never an error state. Unlike
// setLinePrepared (which deletes a key on reset), a reset here OVERWRITES
// the entry with prepared:false rather than deleting it, so "who last
// touched this line" is preserved even after a reset -- that is the whole
// point of this map's existence.
export type PreparedLineMeta = Record<string, { prepared: boolean; byUid: string; byEmail: string; byName: string; at: unknown }>;

export function setLinePreparedMeta(
  meta: PreparedLineMeta | undefined,
  line: Pick<OrderLine, "productId" | "variantId" | "size">,
  prepared: boolean,
  actor: Actor,
  at: unknown
): PreparedLineMeta {
  const next = { ...(meta ?? {}) };
  next[lineKey(line)] = { prepared, byUid: actor.uid, byEmail: actor.email, byName: actor.displayName || actor.email, at };
  return next;
}

// The only statuses preparation is ever allowed to move an order into or
// out of automatically. Touching status for anything else (shipped/
// delivered/completed/cancelled/refunded) would silently resurrect or
// rewrite a lifecycle stage preparation has no business changing -- see
// deriveStatusAfterPreparationChange below.
export const PREPARATION_MANAGED_STATUSES: OrderStatus[] = ["pending", "processing", "ready"];

// Whenever a line's confirmed/unconfirmed state changes, this is the ONLY
// place that decides the resulting order status -- called by both the
// per-line toggle (firebase/orderPreparation.ts) and, after an item-list
// edit reconciles stale confirmations, OrderDetail.tsx's saveLines(). If the
// order isn't currently in a preparation-managed status (already shipped,
// cancelled, etc.), preparation must never touch status at all.
export function deriveStatusAfterPreparationChange(currentStatus: OrderStatus, allConfirmed: boolean): OrderStatus {
  if (!PREPARATION_MANAGED_STATUSES.includes(currentStatus)) return currentStatus;
  return allConfirmed ? "ready" : "processing";
}

// Reconciles preparedLines after an item-list edit (add/remove/qty change)
// commits via updateOrderLines() -- that transaction knows nothing about
// preparedLines and never touches it, so without this a line's stale
// confirmation would silently survive a quantity change, no longer
// representing "the complete requested quantity" it was confirmed against.
// A line is kept confirmed only when the same (productId, variantId, size)
// identity survives the edit with an UNCHANGED qty; anything else (a new
// line, a removed line, a changed qty) starts/stays unconfirmed.
export function reconcilePreparedLinesAfterEdit(preparedLines: PreparedLines | undefined, oldLines: OrderLine[], newLines: OrderLine[]): PreparedLines {
  const oldQtyByKey = new Map(oldLines.map((l) => [lineKey(l), l.qty]));
  const next: PreparedLines = {};
  for (const l of newLines) {
    const key = lineKey(l);
    if (preparedLines?.[key] === true && oldQtyByKey.get(key) === l.qty) next[key] = true;
  }
  return next;
}
