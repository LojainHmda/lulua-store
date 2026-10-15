import { describe, expect, it } from "vitest";
import { lineBranchStockNoteTexts, returnLineKey } from "../../src/admin/returnsHelpers";

function noteEntry(note: string) {
  return { note, updatedByUid: "u1", updatedByEmail: "a@b.com", updatedByName: "A", updatedAt: null };
}

function line(productId: string, variantId = "v1", size = "M") {
  return { productId, variantId, size, qty: 1, name: productId, color: "black", price: 10 };
}

describe("returnLineKey", () => {
  it("joins productId/variantId/size with :: so two lines never collide", () => {
    expect(returnLineKey("p1", "v1", "M")).toBe("p1::v1::M");
    expect(returnLineKey("p1", "v1", "M")).not.toBe(returnLineKey("p1", "v2", "M"));
  });
});

describe("lineBranchStockNoteTexts", () => {
  it("Test 1 — no notes: returns an empty array for an order with no lineBranchStockNotes at all", () => {
    const order = { lines: [line("jacket"), line("dress"), line("skirt")], lineBranchStockNotes: undefined };
    expect(lineBranchStockNoteTexts(order)).toEqual([]);
  });

  it("returns an empty array for an order with an empty map", () => {
    const order = { lines: [line("jacket")], lineBranchStockNotes: {} };
    expect(lineBranchStockNoteTexts(order)).toEqual([]);
  });

  it("Test 2 — one note: returns exactly that line's text (Case 2 from the OLD system)", () => {
    const order = {
      lines: [line("jacket"), line("dress"), line("skirt")],
      lineBranchStockNotes: { [returnLineKey("dress", "v1", "M")]: noteEntry("تحت") },
    };
    expect(lineBranchStockNoteTexts(order)).toEqual(["تحت"]);
  });

  it("Test 3 — two notes, in product-line order (not object-insertion order)", () => {
    const order = {
      lines: [line("jacket"), line("dress"), line("skirt")],
      lineBranchStockNotes: {
        // Deliberately inserted OUT of line order, to prove the result
        // follows `lines`, not Object.values()'s own key order.
        [returnLineKey("skirt", "v1", "M")]: noteEntry("لون أسود"),
        [returnLineKey("jacket", "v1", "M")]: noteEntry("تحت"),
      },
    };
    expect(lineBranchStockNoteTexts(order)).toEqual(["تحت", "لون أسود"]);
  });

  it("Test 4 — three notes, full example from the spec", () => {
    const order = {
      lines: [line("jacket"), line("dress"), line("skirt")],
      lineBranchStockNotes: {
        [returnLineKey("jacket", "v1", "M")]: noteEntry("تحت"),
        [returnLineKey("dress", "v1", "M")]: noteEntry("لون أسود"),
        [returnLineKey("skirt", "v1", "M")]: noteEntry("تأكد من المقاس"),
      },
    };
    expect(lineBranchStockNoteTexts(order)).toEqual(["تحت", "لون أسود", "تأكد من المقاس"]);
    expect(lineBranchStockNoteTexts(order).join(" / ")).toBe("تحت / لون أسود / تأكد من المقاس");
  });

  it("Test 5 — line order is authoritative even when lineBranchStockNotes' own key order disagrees", () => {
    const order = {
      lines: [line("skirt"), line("jacket"), line("dress")], // display order: skirt, jacket, dress
      lineBranchStockNotes: {
        [returnLineKey("jacket", "v1", "M")]: noteEntry("A"),
        [returnLineKey("dress", "v1", "M")]: noteEntry("B"),
        [returnLineKey("skirt", "v1", "M")]: noteEntry("C"),
      },
    };
    expect(lineBranchStockNoteTexts(order)).toEqual(["C", "A", "B"]);
  });

  it("Test 6 — clearing one line's note removes exactly that entry, keeping the others in order", () => {
    const lines = [line("jacket"), line("dress"), line("skirt")];
    const before = {
      lines,
      lineBranchStockNotes: {
        [returnLineKey("jacket", "v1", "M")]: noteEntry("تحت"),
        [returnLineKey("dress", "v1", "M")]: noteEntry("لون أسود"),
        [returnLineKey("skirt", "v1", "M")]: noteEntry("تأكد من المقاس"),
      },
    };
    expect(lineBranchStockNoteTexts(before).join(" / ")).toBe("تحت / لون أسود / تأكد من المقاس");

    // Simulates commitLineNote() deleting the "dress" key outright when its text is cleared.
    const { [returnLineKey("dress", "v1", "M")]: _removed, ...remaining } = before.lineBranchStockNotes;
    const after = { lines, lineBranchStockNotes: remaining };
    expect(lineBranchStockNoteTexts(after).join(" / ")).toBe("تحت / تأكد من المقاس");
  });

  it("never returns a value for a note that is empty/whitespace (the write path deletes these, but stay defensive)", () => {
    const order = { lines: [line("jacket")], lineBranchStockNotes: { [returnLineKey("jacket", "v1", "M")]: noteEntry("   ") } };
    expect(lineBranchStockNoteTexts(order)).toEqual([]);
  });

  it("associates each note with its own product line even when two lines share a productId but differ by variant/size", () => {
    const order = {
      lines: [line("shirt", "black", "S"), line("shirt", "black", "M")],
      lineBranchStockNotes: {
        [returnLineKey("shirt", "black", "S")]: noteEntry("small note"),
        [returnLineKey("shirt", "black", "M")]: noteEntry("medium note"),
      },
    };
    expect(lineBranchStockNoteTexts(order)).toEqual(["small note", "medium note"]);
  });

  it("does not mutate the input order or its map", () => {
    const map = { [returnLineKey("jacket", "v1", "M")]: noteEntry("تحت") };
    const order = { lines: [line("jacket")], lineBranchStockNotes: map };
    lineBranchStockNoteTexts(order);
    expect(order.lineBranchStockNotes).toBe(map);
    expect(map[returnLineKey("jacket", "v1", "M")].note).toBe("تحت");
  });
});
