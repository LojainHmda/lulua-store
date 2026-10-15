import { describe, expect, it } from "vitest";
import {
  allLinesPrepared,
  deriveStatusAfterPreparationChange,
  isLinePrepared,
  reconcilePreparedLinesAfterEdit,
  setLinePrepared,
  setLinePreparedMeta,
  type PreparedLines,
} from "../../src/admin/orderPreparation";
import type { OrderLine } from "../../src/admin/types";

const ACTOR_A = { uid: "uid-a", email: "a@example.com", displayName: "Employee A" };
const ACTOR_B = { uid: "uid-b", email: "b@example.com", displayName: "Employee B" };

function line(overrides: Partial<OrderLine> = {}): OrderLine {
  return {
    productId: "p1",
    variantId: "v1",
    name: "Essential Dress",
    qty: 1,
    price: 100,
    size: "M",
    color: "Black",
    ...overrides,
  };
}

describe("isLinePrepared / allLinesPrepared", () => {
  it("(1) a pending order with no preparedLines field starts with every line unconfirmed", () => {
    const lines = [line(), line({ productId: "p2" })];
    expect(isLinePrepared(undefined, lines[0])).toBe(false);
    expect(isLinePrepared(undefined, lines[1])).toBe(false);
    expect(allLinesPrepared(lines, undefined)).toBe(false);
  });

  it("(10) a historical order without a preparedLines field is valid and reads as fully unconfirmed, not an error", () => {
    const lines = [line()];
    expect(() => allLinesPrepared(lines, undefined)).not.toThrow();
    expect(allLinesPrepared(lines, undefined)).toBe(false);
  });

  it("an order with zero lines is never treated as fully prepared (vacuous truth guard)", () => {
    expect(allLinesPrepared([], undefined)).toBe(false);
    expect(allLinesPrepared([], {})).toBe(false);
  });

  it("(3) confirming one line only affects that line's own state, not sibling lines", () => {
    const a = line({ productId: "p1" });
    const b = line({ productId: "p2" });
    const preparedLines = setLinePrepared(undefined, a, true);
    expect(isLinePrepared(preparedLines, a)).toBe(true);
    expect(isLinePrepared(preparedLines, b)).toBe(false);
    expect(allLinesPrepared([a, b], preparedLines)).toBe(false);
  });

  it("(6) all lines confirmed is detected correctly", () => {
    const a = line({ productId: "p1" });
    const b = line({ productId: "p2" });
    let preparedLines: PreparedLines = setLinePrepared(undefined, a, true);
    preparedLines = setLinePrepared(preparedLines, b, true);
    expect(allLinesPrepared([a, b], preparedLines)).toBe(true);
  });

  it("(4) resetting a confirmed line removes its confirmed state entirely (not just flips a flag to false)", () => {
    const a = line({ productId: "p1" });
    let preparedLines = setLinePrepared(undefined, a, true);
    expect(isLinePrepared(preparedLines, a)).toBe(true);
    preparedLines = setLinePrepared(preparedLines, a, false);
    expect(isLinePrepared(preparedLines, a)).toBe(false);
    expect(preparedLines).toEqual({});
  });

  it("(13) two distinct lines that happen to share the same product/variant/size key are treated as one preparation unit -- confirming one confirms both", () => {
    const a = line({ productId: "p1" });
    const b = line({ productId: "p1" }); // identical identity
    const preparedLines = setLinePrepared(undefined, a, true);
    expect(isLinePrepared(preparedLines, b)).toBe(true);
  });
});

describe("setLinePreparedMeta (Phase A: per-line who/when attribution)", () => {
  it("records the confirming employee's uid/email/name and the given timestamp when a line is confirmed", () => {
    const a = line({ productId: "p1" });
    const meta = setLinePreparedMeta(undefined, a, true, ACTOR_A, "t1");
    const key = Object.keys(meta)[0];
    expect(meta[key]).toEqual({ prepared: true, byUid: "uid-a", byEmail: "a@example.com", byName: "Employee A", at: "t1" });
  });

  it("falls back to email when displayName is blank, matching every other actor field's convention", () => {
    const a = line({ productId: "p1" });
    const meta = setLinePreparedMeta(undefined, a, true, { uid: "uid-a", email: "a@example.com", displayName: "" }, "t1");
    const key = Object.keys(meta)[0];
    expect(meta[key].byName).toBe("a@example.com");
  });

  it("a different employee can later confirm/reset the SAME line and the metadata reflects only the most recent actor", () => {
    const a = line({ productId: "p1" });
    let meta = setLinePreparedMeta(undefined, a, true, ACTOR_A, "t1");
    meta = setLinePreparedMeta(meta, a, false, ACTOR_B, "t2");
    const key = Object.keys(meta)[0];
    expect(meta[key]).toEqual({ prepared: false, byUid: "uid-b", byEmail: "b@example.com", byName: "Employee B", at: "t2" });
  });

  it("a reset OVERWRITES the entry with prepared:false rather than deleting it -- unlike preparedLines, 'who last touched this line' survives a reset", () => {
    const a = line({ productId: "p1" });
    let meta = setLinePreparedMeta(undefined, a, true, ACTOR_A, "t1");
    meta = setLinePreparedMeta(meta, a, false, ACTOR_A, "t2");
    const key = Object.keys(meta)[0];
    expect(meta[key]).toBeDefined();
    expect(meta[key].prepared).toBe(false);
  });

  it("touching one line's metadata never affects a sibling line's metadata", () => {
    const a = line({ productId: "p1" });
    const b = line({ productId: "p2" });
    let meta = setLinePreparedMeta(undefined, a, true, ACTOR_A, "t1");
    meta = setLinePreparedMeta(meta, b, true, ACTOR_B, "t2");
    expect(Object.keys(meta)).toHaveLength(2);
    const keyA = Object.keys(setLinePrepared(undefined, a, true))[0];
    const keyB = Object.keys(setLinePrepared(undefined, b, true))[0];
    expect(meta[keyA].byUid).toBe("uid-a");
    expect(meta[keyB].byUid).toBe("uid-b");
  });

  it("is purely additive metadata -- preparedLines/isLinePrepared() alone still decide confirmation, independent of preparedLineMeta entirely", () => {
    const a = line({ productId: "p1" });
    // preparedLineMeta says "prepared: true" but the real preparedLines map
    // (built independently below) says otherwise -- confirmation status
    // must be decided ONLY by preparedLines, never by peeking at the
    // metadata map, exactly as this module's own doc comment requires.
    const meta = setLinePreparedMeta(undefined, a, true, ACTOR_A, "t1");
    void meta;
    const preparedLines = setLinePrepared(undefined, a, false);
    expect(isLinePrepared(preparedLines, a)).toBe(false);
  });

  it("an order with no preparedLineMeta field at all (every historical order) produces a fresh map with no migration/throw", () => {
    const a = line();
    expect(() => setLinePreparedMeta(undefined, a, true, ACTOR_A, "t1")).not.toThrow();
  });
});

describe("deriveStatusAfterPreparationChange", () => {
  it("(2) a pending order becomes 'processing' the moment any preparation action happens, even if nothing is confirmed yet", () => {
    expect(deriveStatusAfterPreparationChange("pending", false)).toBe("processing");
  });

  it("(5) staying incomplete keeps a processing order in 'processing'", () => {
    expect(deriveStatusAfterPreparationChange("processing", false)).toBe("processing");
  });

  it("(6) completing every line moves the order to 'ready'", () => {
    expect(deriveStatusAfterPreparationChange("processing", true)).toBe("ready");
  });

  it("(7) resetting one line on an already-'ready' order drops it back to 'processing'", () => {
    expect(deriveStatusAfterPreparationChange("ready", false)).toBe("processing");
  });

  it("(8) reconfirming the final missing line returns a 'processing' order to 'ready'", () => {
    expect(deriveStatusAfterPreparationChange("processing", true)).toBe("ready");
  });

  it("a single-line order can go straight from pending to 'ready' in one confirmation", () => {
    expect(deriveStatusAfterPreparationChange("pending", true)).toBe("ready");
  });

  it("never touches status for a shipped/delivered/completed/cancelled/refunded order, regardless of allConfirmed", () => {
    for (const status of ["shipped", "delivered", "completed", "cancelled", "refunded"] as const) {
      expect(deriveStatusAfterPreparationChange(status, true)).toBe(status);
      expect(deriveStatusAfterPreparationChange(status, false)).toBe(status);
    }
  });
});

describe("reconcilePreparedLinesAfterEdit", () => {
  it("keeps a confirmed line's state when its identity and quantity are unchanged by the edit", () => {
    const a = line({ productId: "p1", qty: 2 });
    const preparedLines = setLinePrepared(undefined, a, true);
    const reconciled = reconcilePreparedLinesAfterEdit(preparedLines, [a], [a]);
    expect(isLinePrepared(reconciled, a)).toBe(true);
  });

  it("clears a confirmed line's state when its quantity changes -- the old confirmation no longer represents the full requested qty", () => {
    const before = line({ productId: "p1", qty: 2 });
    const after = line({ productId: "p1", qty: 3 });
    const preparedLines = setLinePrepared(undefined, before, true);
    const reconciled = reconcilePreparedLinesAfterEdit(preparedLines, [before], [after]);
    expect(isLinePrepared(reconciled, after)).toBe(false);
  });

  it("a brand-new line added during the edit starts unconfirmed", () => {
    const existing = line({ productId: "p1" });
    const added = line({ productId: "p2" });
    const preparedLines = setLinePrepared(undefined, existing, true);
    const reconciled = reconcilePreparedLinesAfterEdit(preparedLines, [existing], [existing, added]);
    expect(isLinePrepared(reconciled, existing)).toBe(true);
    expect(isLinePrepared(reconciled, added)).toBe(false);
  });

  it("(13) a removed line's stale confirmation does not linger for an unrelated line", () => {
    const removed = line({ productId: "p1" });
    const remaining = line({ productId: "p2" });
    let preparedLines = setLinePrepared(undefined, removed, true);
    preparedLines = setLinePrepared(preparedLines, remaining, true);
    const reconciled = reconcilePreparedLinesAfterEdit(preparedLines, [removed, remaining], [remaining]);
    expect(reconciled).toEqual({ [Object.keys(setLinePrepared(undefined, remaining, true))[0]]: true });
    expect(isLinePrepared(reconciled, remaining)).toBe(true);
  });

  it("an edit on an order with no preparedLines field at all produces no confirmed lines (never throws)", () => {
    const a = line();
    expect(() => reconcilePreparedLinesAfterEdit(undefined, [a], [a])).not.toThrow();
    expect(reconcilePreparedLinesAfterEdit(undefined, [a], [a])).toEqual({});
  });
});
