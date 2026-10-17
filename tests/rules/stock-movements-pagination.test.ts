import { collection, doc, getDocs, limit, orderBy, query, setDoc, startAfter, Timestamp } from "../../src/db/firestore";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildLedgerQueryConstraints, findPageCursor } from "../../src/admin/stockMovements";
import type { StockMovement } from "../../src/admin/types";
import { clearFirestore, getTestEnv, teardownTestEnv } from "./setup";

// Issue B fix (pre-deployment audit): the Stock Ledger's "Load more"
// cursor used to be createdAt alone. Every write inside a single Firestore
// transaction commits with the SAME server timestamp, so a multi-line
// checkout, a multi-cell inventory save, or a multi-line order edit
// routinely produces several stockMovements docs sharing an identical
// createdAt -- not a rare tie, the normal case whenever one write touches
// more than one (product, variant, size) cell. A createdAt-only
// startAfter() cursor excludes EVERY document at that exact timestamp on
// the next page, not just the ones already shown, silently dropping
// same-transaction siblings that happened to fall after a page boundary.
//
// This is a live-emulator proof (not just a pure-function shape test --
// see stockLedgerHelpers.test.ts for those) because the actual claim is
// about real Firestore cursor semantics, which only the emulator can
// authoritatively confirm. Mirrors the existing project convention of
// reaching for tests/rules/ (a real Firestore, not just security rules)
// whenever a claim depends on genuine Firestore behavior -- see
// stock-movements-transactions.test.ts's own precedent.

function movementDoc(createdAt: Timestamp): Record<string, unknown> {
  return {
    productId: "prod1",
    productName: "Test Dress",
    variantId: "black",
    colorName: "Black",
    size: "M",
    qtyBefore: 10,
    qtyChange: -1,
    qtyAfter: 9,
    reason: "manual_adjustment",
    source: "admin",
    actorEmail: "admin1@example.com",
    actorName: "admin1",
    createdAt,
  };
}

describe("stock ledger pagination cursor (Issue B fix)", () => {
  beforeEach(async () => {
    await clearFirestore();
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  it("does not drop same-createdAt siblings across a 50-row page boundary, unlike a createdAt-only cursor", async () => {
    const env = await getTestEnv();
    const base = Timestamp.fromMillis(1_700_000_000_000);

    // 48 documents with distinct, strictly-descending createdAt values --
    // an ordinary feed of separate events.
    const distinctIds: string[] = [];
    // 4 more documents sharing ONE identical createdAt, older than all 48
    // above -- simulating 4 stockMovements rows written inside a single
    // multi-line transaction, which is exactly how a real tie arises.
    const tiedTimestamp = Timestamp.fromMillis(base.toMillis() - 48_000);
    const tiedIds: string[] = [];

    await env.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore();
      for (let i = 0; i < 48; i++) {
        const ref = doc(collection(fs, "stockMovements"));
        distinctIds.push(ref.id);
        await setDoc(ref, movementDoc(Timestamp.fromMillis(base.toMillis() - i * 1000)));
      }
      for (let i = 0; i < 4; i++) {
        const ref = doc(collection(fs, "stockMovements"));
        tiedIds.push(ref.id);
        await setDoc(ref, movementDoc(tiedTimestamp));
      }
    });

    const allIds = new Set([...distinctIds, ...tiedIds]);
    expect(allIds.size).toBe(52);

    await env.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore();

      // --- Fixed behavior: the real, currently-shipped
      // buildLedgerQueryConstraints()/findPageCursor(), exactly as
      // StockLedger.tsx calls them. ---
      const page1Constraints = buildLedgerQueryConstraints({}, { pageSize: 50 });
      const page1Snap = await getDocs(query(collection(fs, "stockMovements"), ...page1Constraints));
      const page1Rows = page1Snap.docs.map((d) => ({ id: d.id, ...d.data() }) as StockMovement);
      expect(page1Rows).toHaveLength(50);

      const cursor = findPageCursor(page1Rows);
      expect(cursor).toBeDefined();

      const page2Constraints = buildLedgerQueryConstraints({}, { cursor, pageSize: 50 });
      const page2Snap = await getDocs(query(collection(fs, "stockMovements"), ...page2Constraints));
      const page2Rows = page2Snap.docs.map((d) => ({ id: d.id, ...d.data() }) as StockMovement);

      const combinedIds = new Set([...page1Rows.map((r) => r.id), ...page2Rows.map((r) => r.id)]);
      expect(combinedIds.size).toBe(52);
      expect([...combinedIds].sort()).toEqual([...allIds].sort());
      // Every tied-timestamp sibling is present exactly once across the
      // two pages combined -- none dropped, none duplicated.
      for (const id of tiedIds) {
        expect(combinedIds.has(id)).toBe(true);
      }

      // --- Negative control: reproduces the pre-fix bug on the SAME
      // seeded data, proving this test would actually have caught it. A
      // single-field cursor (createdAt alone, no documentId tiebreaker) is
      // exactly what buildLedgerQueryConstraints() produced before this
      // fix -- startAfter() with only one value excludes every document
      // whose createdAt equals that value, not just the ones already
      // shown on page 1. ---
      const oldPage1Snap = await getDocs(query(collection(fs, "stockMovements"), orderBy("createdAt", "desc"), limit(50)));
      const oldPage1Rows = oldPage1Snap.docs.map((d) => ({ id: d.id, ...d.data() }) as StockMovement);
      expect(oldPage1Rows).toHaveLength(50);
      const oldCursorValue = oldPage1Rows[oldPage1Rows.length - 1].createdAt;

      const oldPage2Snap = await getDocs(
        query(collection(fs, "stockMovements"), orderBy("createdAt", "desc"), startAfter(oldCursorValue), limit(50))
      );
      const oldPage2Rows = oldPage2Snap.docs.map((d) => ({ id: d.id, ...d.data() }) as StockMovement);

      const oldCombinedIds = new Set([...oldPage1Rows.map((r) => r.id), ...oldPage2Rows.map((r) => r.id)]);
      expect(oldCombinedIds.size).toBeLessThan(52);
    });
  });
});
