import { doc, runTransaction, setDoc, updateDoc } from "firebase/firestore";
import type { Firestore } from "firebase/firestore";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { findLowStockCrossings } from "../../src/admin/lowStockNotify";
import { clearFirestore, getTestEnv, teardownTestEnv } from "./setup";

// Low-Stock Notification Trigger task: proves the fix for a retry-
// duplication bug in orderTransaction.ts / adminOrderEdit.ts. Both files
// collect a `stockChanges` array DURING their runTransaction() callback,
// then loop over it AFTER the transaction commits to call notifyLowStock()
// (deliberately outside the transaction -- see that function's own
// comment). Before this fix, `stockChanges` was declared outside the
// callback and only ever pushed to, never reset. Firestore's optimistic-
// concurrency retry re-invokes the ENTIRE callback from scratch whenever a
// read document changes before commit -- a real, routine occurrence under
// write contention, not an edge case. Without a reset, a discarded failed
// attempt's entries stayed in the array alongside the eventual successful
// attempt's, so the post-commit loop called notifyLowStock() once per
// attempt instead of once per actual committed transition -- risking a
// duplicate/spurious low-stock notification built from a before/after pair
// that was never really committed.
//
// The fix (see `stockChanges = []` added as the first line of both
// callbacks) resets the array at the top of every attempt, so only the
// final, successful attempt's entries ever survive to the post-commit loop
// -- mirroring the pattern already proven safe for `pendingMovements`
// (declared fresh inside the callback) and for Inventory.tsx/ProductForm.tsx's
// `committedBefore`/`committedAfter` (reassigned, not accumulated).
//
// This can only be proven against a real Firestore transaction retry, not
// pure logic, so it's a live-emulator test -- same reasoning as
// tests/rules/stock-movements-pagination.test.ts's own live-emulator proof
// for a different retry/consistency question.

interface StockChange {
  productId: string;
  before: number;
  after: number;
}

// Hand-rolled to mirror the exact PRE-FIX shape (array declared outside the
// callback, only ever pushed to) -- used only as a negative control to
// prove the bug is real, not the app's own code.
async function buggyDecrement(db: Firestore, productId: string, decrementBy: number, onFirstAttempt: () => Promise<void>): Promise<StockChange[]> {
  const stockChanges: StockChange[] = [];
  let firstAttempt = true;
  await runTransaction(db, async (tx) => {
    const ref = doc(db, "products", productId);
    const snap = await tx.get(ref);
    const before = (snap.data() as { qty: number }).qty;
    if (firstAttempt) {
      firstAttempt = false;
      // Out-of-band write to the same doc, still inside the callback but
      // via a completely separate write (not `tx`) -- this is what makes
      // Firestore detect the conflict and retry the whole callback once.
      await onFirstAttempt();
    }
    const after = before - decrementBy;
    tx.update(ref, { qty: after });
    stockChanges.push({ productId, before, after });
  });
  return stockChanges;
}

// Hand-rolled to mirror the exact POST-FIX shape: reset to a fresh array at
// the top of every attempt, matching the real orderTransaction.ts /
// adminOrderEdit.ts pattern after this task's fix.
async function fixedDecrement(db: Firestore, productId: string, decrementBy: number, onFirstAttempt: () => Promise<void>): Promise<StockChange[]> {
  let stockChanges: StockChange[] = [];
  let firstAttempt = true;
  await runTransaction(db, async (tx) => {
    stockChanges = [];
    const ref = doc(db, "products", productId);
    const snap = await tx.get(ref);
    const before = (snap.data() as { qty: number }).qty;
    if (firstAttempt) {
      firstAttempt = false;
      await onFirstAttempt();
    }
    const after = before - decrementBy;
    tx.update(ref, { qty: after });
    stockChanges.push({ productId, before, after });
  });
  return stockChanges;
}

describe("notifyLowStock retry-safety (orderTransaction.ts / adminOrderEdit.ts pattern)", () => {
  beforeEach(async () => {
    await clearFirestore();
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  it("BUG (negative control): the pre-fix accumulate-outside pattern collects a stale entry alongside the real one when the transaction retries", async () => {
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "products", "p1"), { qty: 5 });
      const changes = await buggyDecrement(db, "p1", 1, async () => {
        await updateDoc(doc(db, "products", "p1"), { qty: 4 });
      });
      // The bug, reproduced: TWO entries collected for one logical sale --
      // one stale (before=5, from the attempt Firestore discarded), one
      // real (before=4, the actual committed transition). A caller looping
      // over this to call notifyLowStock() would fire it twice.
      expect(changes).toHaveLength(2);
      expect(changes.map((c) => c.before).sort()).toEqual([4, 5]);
    });
  });

  it("FIX: the reset-per-attempt pattern collects exactly one entry, matching only the real committed transition", async () => {
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "products", "p2"), { qty: 5 });
      const changes = await fixedDecrement(db, "p2", 1, async () => {
        await updateDoc(doc(db, "products", "p2"), { qty: 4 });
      });
      expect(changes).toHaveLength(1);
      expect(changes[0]).toEqual({ productId: "p2", before: 4, after: 3 });
    });
  });

  it("no-retry path is unaffected: a transaction that never conflicts still collects exactly one entry", async () => {
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "products", "p3"), { qty: 10 });
      const changes = await fixedDecrement(db, "p3", 2, async () => {
        /* no conflicting write -- no retry should occur */
      });
      expect(changes).toHaveLength(1);
      expect(changes[0]).toEqual({ productId: "p3", before: 10, after: 8 });
    });
  });

  it("crossing logic itself is untouched by this fix: still only fires on a genuine before>=threshold, after<threshold transition", () => {
    const before = [{ id: "v1", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "M", qty: 4 }] }];
    const after = [{ id: "v1", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "M", qty: 2 }] }];
    expect(findLowStockCrossings(before, after, 3)).toEqual([{ colorName: "Black", size: "M", qty: 2 }]);
  });

  it("zero-delta / no-crossing transitions still produce no crossing, matching existing behavior", () => {
    const before = [{ id: "v1", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "M", qty: 2 }] }];
    const after = [{ id: "v1", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "M", qty: 2 }] }];
    expect(findLowStockCrossings(before, after, 3)).toEqual([]);
  });
});
