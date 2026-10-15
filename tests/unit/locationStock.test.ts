import { describe, expect, it } from "vitest";
import { classifyMovement, ONLINE_LOCATION, summarizeLocationStock, type LedgerMovement } from "../../src/admin/locationStock";

let seq = 0;
function mv(p: Partial<LedgerMovement> & Pick<LedgerMovement, "reason" | "qtyBefore" | "qtyAfter">): LedgerMovement {
  seq++;
  return { id: `m${seq}`, variantId: "black-p1", colorName: "Black", size: "M", source: "admin", at: seq * 1000, qtyChange: p.qtyAfter - p.qtyBefore, ...p };
}

describe("classifyMovement", () => {
  it("treats a location's first stock-in from 0 as opening, later ones as added", () => {
    expect(classifyMovement({ reason: "manual_adjustment", qtyBefore: 0, qtyChange: 10 }, true)).toBe("opening");
    expect(classifyMovement({ reason: "manual_adjustment", qtyBefore: 4, qtyChange: 6 }, false)).toBe("added");
    expect(classifyMovement({ reason: "manual_adjustment", qtyBefore: 0, qtyChange: 5 }, false)).toBe("added");
    expect(classifyMovement({ reason: "manual_adjustment", qtyBefore: 5, qtyChange: -2 }, true)).toBe("removed");
  });
  it("nets order edits and cancellations into sold", () => {
    expect(classifyMovement({ reason: "order_cancelled", qtyBefore: 3, qtyChange: 2 }, false)).toBe("sold");
    expect(classifyMovement({ reason: "order_edit", qtyBefore: 3, qtyChange: -1 }, false)).toBe("sold");
  });
});

describe("summarizeLocationStock", () => {
  it("keeps each branch separate and reconciles to the stored count", () => {
    const movements = [
      mv({ reason: "initial_stock", qtyBefore: 0, qtyAfter: 12 }), // online
      mv({ reason: "manual_adjustment", qtyBefore: 0, qtyAfter: 10, branchId: "A" }),
      mv({ reason: "manual_adjustment", qtyBefore: 0, qtyAfter: 7, branchId: "B" }),
      mv({ reason: "sale", source: "pos", qtyBefore: 10, qtyAfter: 8, branchId: "A", orderNumber: "1001" }),
      mv({ reason: "sale", source: "web", qtyBefore: 12, qtyAfter: 11 }),
      mv({ reason: "manual_adjustment", qtyBefore: 8, qtyAfter: 13, branchId: "A" }),
      mv({ reason: "return_restock", qtyBefore: 13, qtyAfter: 14, branchId: "A" }),
    ];
    const current = new Map([[ONLINE_LOCATION, 11], ["A", 14], ["B", 7]]);
    const s = summarizeLocationStock(movements, current);

    expect(s.get("A")).toMatchObject({ opening: 10, added: 5, sold: 2, returned: 1, removed: 0, current: 14, untracked: 0, movementCount: 4 });
    expect(s.get("B")).toMatchObject({ opening: 7, sold: 0, current: 7, untracked: 0 });
    expect(s.get(ONLINE_LOCATION)).toMatchObject({ opening: 12, sold: 1, current: 11, untracked: 0 });
    for (const x of s.values()) {
      expect(x.opening + x.untracked + x.added - x.removed - x.sold + x.returned).toBe(x.current);
    }
  });

  it("reports stock that predates the ledger as untracked instead of hiding it", () => {
    const s = summarizeLocationStock([mv({ reason: "sale", qtyBefore: 20, qtyAfter: 18 })], new Map([[ONLINE_LOCATION, 18]]));
    expect(s.get(ONLINE_LOCATION)).toMatchObject({ opening: 0, untracked: 20, sold: 2, current: 18 });
  });

  it("includes locations with stock but no history", () => {
    const s = summarizeLocationStock([], new Map([["C", 4]]));
    expect(s.get("C")).toMatchObject({ untracked: 4, current: 4, movementCount: 0 });
  });
});
