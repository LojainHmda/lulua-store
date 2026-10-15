import { describe, expect, it } from "vitest";
import { setLineNote, type CartLine } from "../../src/context/CartContext";

function line(overrides: Partial<CartLine> = {}): CartLine {
  return {
    key: "p1-v1-M",
    productId: "p1",
    variantId: "v1",
    slug: "product-1",
    name: "Product 1",
    price: 100,
    color: "Black",
    size: "M",
    qty: 1,
    ...overrides,
  };
}

describe("setLineNote", () => {
  it("sets the note on the matching line only", () => {
    const lines = [line(), line({ key: "p2-v1-S", productId: "p2" })];
    const result = setLineNote(lines, "p1-v1-M", "Gift wrap please");
    expect(result.find((l) => l.key === "p1-v1-M")?.note).toBe("Gift wrap please");
  });

  it("does not affect a different line's note (two independent products)", () => {
    const lines = [line(), line({ key: "p2-v1-S", productId: "p2" })];
    const withFirstNote = setLineNote(lines, "p1-v1-M", "Note for product 1");
    const withBothNotes = setLineNote(withFirstNote, "p2-v1-S", "Note for product 2");
    expect(withBothNotes.find((l) => l.key === "p1-v1-M")?.note).toBe("Note for product 1");
    expect(withBothNotes.find((l) => l.key === "p2-v1-S")?.note).toBe("Note for product 2");
  });

  it("editing one product's note does not modify another product's note", () => {
    const lines = [line({ note: "Original note A" }), line({ key: "p2-v1-S", productId: "p2", note: "Original note B" })];
    const result = setLineNote(lines, "p1-v1-M", "Edited note A");
    expect(result.find((l) => l.key === "p1-v1-M")?.note).toBe("Edited note A");
    expect(result.find((l) => l.key === "p2-v1-S")?.note).toBe("Original note B");
  });

  it("handles setting an empty note (clearing it)", () => {
    const lines = [line({ note: "Something" })];
    const result = setLineNote(lines, "p1-v1-M", "");
    expect(result[0].note).toBe("");
  });

  it("leaves every other field on the line untouched", () => {
    const lines = [line({ qty: 3, price: 250 })];
    const result = setLineNote(lines, "p1-v1-M", "A note");
    expect(result[0]).toMatchObject({ qty: 3, price: 250, productId: "p1", variantId: "v1", size: "M", color: "Black" });
  });

  it("is a no-op (returns lines unchanged in content) when the key doesn't match any line", () => {
    const lines = [line()];
    const result = setLineNote(lines, "nonexistent-key", "A note");
    expect(result).toEqual(lines);
  });

  it("returns a new array without mutating the original", () => {
    const lines = [line()];
    const result = setLineNote(lines, "p1-v1-M", "A note");
    expect(result).not.toBe(lines);
    expect(lines[0].note).toBeUndefined();
  });
});
