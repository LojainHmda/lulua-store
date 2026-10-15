import { describe, expect, it } from "vitest";
import {
  applyClientLedgerFilters,
  buildLedgerQueryConstraints,
  findPageCursor,
  resolveActorDisplay,
  stockMovementDeltaTone,
} from "../../src/admin/stockMovements";
import type { StockMovement } from "../../src/admin/types";

function movement(overrides: Partial<StockMovement> = {}): StockMovement {
  return {
    id: "m1",
    productId: "p1",
    productName: "Silk Robe",
    variantId: "black",
    colorName: "Black",
    size: "M",
    qtyBefore: 5,
    qtyChange: -2,
    qtyAfter: 3,
    reason: "sale",
    source: "web",
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("stockMovementDeltaTone", () => {
  it("is success for a positive change (stock arriving)", () => {
    expect(stockMovementDeltaTone(5)).toBe("success");
  });

  it("is danger for a negative change (stock leaving)", () => {
    expect(stockMovementDeltaTone(-3)).toBe("danger");
  });
});

describe("resolveActorDisplay", () => {
  it("returns webCheckout for a web sale with no actor fields", () => {
    expect(resolveActorDisplay({ source: "web" })).toEqual({ kind: "webCheckout" });
  });

  it("never fabricates the web-checkout label for a non-web reason with no actor", () => {
    expect(resolveActorDisplay({ source: "admin" })).toEqual({ kind: "unknown" });
  });

  it("prefers actorName when both actorName and actorEmail are present", () => {
    expect(resolveActorDisplay({ source: "admin", actorName: "Sara", actorEmail: "sara@sisley.ps" })).toEqual({
      kind: "named",
      name: "Sara",
    });
  });

  it("falls back to actorEmail when actorName is absent", () => {
    expect(resolveActorDisplay({ source: "pos", actorEmail: "cashier@sisley.ps" })).toEqual({
      kind: "named",
      name: "cashier@sisley.ps",
    });
  });

  it("prefers a named actor over the web-checkout label even if source is web (helper's own precedence, though a real web sale never sets an actor)", () => {
    expect(resolveActorDisplay({ source: "web", actorName: "Sara" })).toEqual({ kind: "named", name: "Sara" });
  });
});

describe("buildLedgerQueryConstraints", () => {
  it("defaults to orderBy(createdAt desc) + orderBy(documentId desc) + limit, with no where clauses", () => {
    const constraints = buildLedgerQueryConstraints({});
    expect(constraints.map((c) => c.type)).toEqual(["orderBy", "orderBy", "limit"]);
  });

  it("adds a single where(productId ==) ahead of both orderBy clauses for the indexed product-history view", () => {
    const constraints = buildLedgerQueryConstraints({ productId: "p1" });
    expect(constraints.map((c) => c.type)).toEqual(["where", "orderBy", "orderBy", "limit"]);
  });

  it("adds one startAfter (carrying both createdAt and the document id) when a page cursor is supplied", () => {
    const constraints = buildLedgerQueryConstraints({}, { cursor: { createdAt: "some-cursor", id: "doc1" } });
    expect(constraints.map((c) => c.type)).toEqual(["orderBy", "orderBy", "startAfter", "limit"]);
  });

  it("adds one where clause per side of a date range, on the same createdAt-sorted, documentId-tiebroken query", () => {
    const constraints = buildLedgerQueryConstraints({ dateFrom: "2026-01-01", dateTo: "2026-01-31" });
    expect(constraints.map((c) => c.type)).toEqual(["where", "where", "orderBy", "orderBy", "limit"]);
  });

  it("combines productId + date range + cursor into a single well-formed query", () => {
    const constraints = buildLedgerQueryConstraints(
      { productId: "p1", dateFrom: "2026-01-01" },
      { cursor: { createdAt: "c", id: "doc1" } }
    );
    expect(constraints.map((c) => c.type)).toEqual(["where", "where", "orderBy", "orderBy", "startAfter", "limit"]);
  });

  it("short-circuits to a lone where() for an orderId-scoped lookup, ignoring every other filter/cursor/limit/tiebreaker", () => {
    const constraints = buildLedgerQueryConstraints(
      { orderId: "ord-1", productId: "p1", dateFrom: "2026-01-01", dateTo: "2026-01-31" },
      { cursor: { createdAt: "c", id: "doc1" }, pageSize: 5 }
    );
    expect(constraints.map((c) => c.type)).toEqual(["where"]);
  });
});

describe("applyClientLedgerFilters", () => {
  const rows: StockMovement[] = [
    movement({ id: "a", colorName: "Black", size: "M", reason: "sale", source: "web" }),
    movement({ id: "b", colorName: "Red", size: "S", reason: "manual_adjustment", source: "admin", actorName: "Sara", actorEmail: "sara@sisley.ps" }),
    movement({ id: "c", colorName: "Black", size: "L", reason: "return_restock", source: "admin", actorEmail: "omar@sisley.ps" }),
  ];

  it("returns every row when no filters are set", () => {
    expect(applyClientLedgerFilters(rows, {})).toHaveLength(3);
  });

  it("filters by exact color", () => {
    expect(applyClientLedgerFilters(rows, { colorName: "Black" }).map((r) => r.id)).toEqual(["a", "c"]);
  });

  it("filters by exact size", () => {
    expect(applyClientLedgerFilters(rows, { size: "S" }).map((r) => r.id)).toEqual(["b"]);
  });

  it("filters by reason", () => {
    expect(applyClientLedgerFilters(rows, { reason: "return_restock" }).map((r) => r.id)).toEqual(["c"]);
  });

  it("filters by source", () => {
    expect(applyClientLedgerFilters(rows, { source: "web" }).map((r) => r.id)).toEqual(["a"]);
  });

  it("matches actor by a case-insensitive substring of either actorName or actorEmail, and excludes rows with no actor at all", () => {
    expect(applyClientLedgerFilters(rows, { actor: "sara" }).map((r) => r.id)).toEqual(["b"]);
    expect(applyClientLedgerFilters(rows, { actor: "OMAR@SISLEY" }).map((r) => r.id)).toEqual(["c"]);
  });

  it("combines multiple filters with AND semantics", () => {
    expect(applyClientLedgerFilters(rows, { colorName: "Black", reason: "return_restock" }).map((r) => r.id)).toEqual(["c"]);
  });
});

describe("findPageCursor", () => {
  it("returns the last row's (createdAt, id) pair when it is already resolved", () => {
    const rows = [movement({ id: "a", createdAt: "t1" }), movement({ id: "b", createdAt: "t2" })];
    expect(findPageCursor(rows)).toEqual({ createdAt: "t2", id: "b" });
  });

  it("skips a trailing row whose createdAt has not resolved yet (a serverTimestamp() read back immediately after its own write)", () => {
    const rows = [movement({ id: "a", createdAt: "t1" }), movement({ id: "b", createdAt: null })];
    expect(findPageCursor(rows)).toEqual({ createdAt: "t1", id: "a" });
  });

  it("returns undefined for an empty page", () => {
    expect(findPageCursor([])).toBeUndefined();
  });

  it("returns undefined when every row on the page is still unresolved", () => {
    const rows = [movement({ id: "a", createdAt: null }), movement({ id: "b", createdAt: undefined })];
    expect(findPageCursor(rows)).toBeUndefined();
  });

  // The actual bug being fixed: multiple docs written inside the same
  // Firestore transaction share the exact same createdAt (one server
  // commit timestamp per transaction). The old cursor (createdAt alone)
  // would point at the shared timestamp and Firestore's startAfter() would
  // then exclude EVERY document at that timestamp, not just the ones
  // already shown — silently dropping siblings still on this page. Because
  // the cursor now also carries the specific document's id, "Load more"
  // resumes after that exact document instead of after the whole
  // timestamp group. See stock-movements-pagination.test.ts for the
  // corresponding live-emulator proof against real tied documents.
  it("identifies the specific last document by id even when several rows share an identical createdAt", () => {
    const tiedTimestamp = "2026-01-01T00:00:00Z";
    const rows = [
      movement({ id: "z-first-in-page", createdAt: tiedTimestamp }),
      movement({ id: "y-middle-of-tie", createdAt: tiedTimestamp }),
      movement({ id: "x-last-in-page", createdAt: tiedTimestamp }),
    ];
    expect(findPageCursor(rows)).toEqual({ createdAt: tiedTimestamp, id: "x-last-in-page" });
  });
});
