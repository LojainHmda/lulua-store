import { describe, expect, it } from "vitest";
import { getAvailableSizesForProduct } from "../../src/data/variants";
import type { ColorVariant, Product } from "../../src/types";

// getAvailableSizesForProduct is the product-card hover feature's only new
// piece of logic (see the product-card size-display report) — everything
// else it's built from (isSizeAvailable / getAvailableSizesFor) is
// pre-existing and unchanged. These tests focus on the one new behavior:
// aggregating "available in at least one color" across every variant.

function variant(id: string, sizeStock: ColorVariant["sizeStock"]): ColorVariant {
  return { id, colorName: id, colorHex: "#000000", sizeStock };
}

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: "p1",
    slug: "p1",
    name: "Test Product",
    price: 100,
    colorVariants: [],
    sizes: [],
    rating: 4.5,
    reviewCount: 0,
    description: "",
    details: [],
    category: "dresses",
    ...overrides,
  };
}

describe("getAvailableSizesForProduct: aggregates across ALL color variants", () => {
  it("unions sizes across colors per the spec example (Red: S,M / Black: M,L / White: XS,L)", () => {
    const p = product({
      sizes: ["XS", "S", "M", "L"],
      colorVariants: [
        variant("red", [{ size: "S", qty: 5 }, { size: "M", qty: 5 }]),
        variant("black", [{ size: "M", qty: 5 }, { size: "L", qty: 5 }]),
        variant("white", [{ size: "XS", qty: 5 }, { size: "L", qty: 5 }]),
      ],
    });
    expect(getAvailableSizesForProduct(p)).toEqual(["XS", "S", "M", "L"]);
  });

  it("a size with 0 in one color but stock in another still displays (M: red=0, black=3)", () => {
    const p = product({
      sizes: ["S", "M"],
      colorVariants: [
        variant("red", [{ size: "S", qty: 2 }, { size: "M", qty: 0 }]),
        variant("black", [{ size: "M", qty: 3 }]),
      ],
    });
    expect(getAvailableSizesForProduct(p)).toEqual(["S", "M"]);
  });

  it("a size that is 0 or null in EVERY color is excluded", () => {
    const p = product({
      sizes: ["S", "M", "L"],
      colorVariants: [
        variant("red", [{ size: "S", qty: 2 }, { size: "M", qty: 0 }, { size: "L", qty: null }]),
        variant("black", [{ size: "S", qty: 0 }, { size: "M", qty: 0 }, { size: "L", qty: null }]),
      ],
    });
    expect(getAvailableSizesForProduct(p)).toEqual(["S"]);
  });

  it("deduplicates -- each size appears at most once even when available in every color", () => {
    const p = product({
      sizes: ["S", "M"],
      colorVariants: [
        variant("red", [{ size: "S", qty: 5 }, { size: "M", qty: 5 }]),
        variant("black", [{ size: "S", qty: 5 }, { size: "M", qty: 5 }]),
        variant("white", [{ size: "S", qty: 5 }, { size: "M", qty: 5 }]),
      ],
    });
    const result = getAvailableSizesForProduct(p);
    expect(result).toEqual(["S", "M"]);
    expect(new Set(result).size).toBe(result.length);
  });

  it("preserves product.sizes' declared order, never alphabetically re-sorts", () => {
    const p = product({
      sizes: ["L", "XS", "M", "S"], // deliberately not alphabetical
      colorVariants: [variant("only", [{ size: "L", qty: 1 }, { size: "XS", qty: 1 }, { size: "M", qty: 1 }, { size: "S", qty: 1 }])],
    });
    expect(getAvailableSizesForProduct(p)).toEqual(["L", "XS", "M", "S"]);
  });

  it("returns an empty array (never throws, never renders a placeholder) when no size has stock anywhere", () => {
    const p = product({
      sizes: ["S", "M"],
      colorVariants: [variant("red", [{ size: "S", qty: 0 }, { size: "M", qty: null }])],
    });
    expect(getAvailableSizesForProduct(p)).toEqual([]);
  });

  it("returns an empty array for a product with no color variants at all", () => {
    const p = product({ sizes: ["S", "M"], colorVariants: [] });
    expect(getAvailableSizesForProduct(p)).toEqual([]);
  });

  it("returns an empty array for a product with no declared sizes at all", () => {
    const p = product({ sizes: [], colorVariants: [variant("red", [{ size: "S", qty: 5 }])] });
    expect(getAvailableSizesForProduct(p)).toEqual([]);
  });

  it("a size declared on the product but structurally missing from a variant's own sizeStock is treated as unavailable for that variant (not a crash)", () => {
    const p = product({
      sizes: ["S", "M", "L"],
      colorVariants: [
        variant("red", [{ size: "S", qty: 5 }]), // no M/L entries at all
        variant("black", [{ size: "L", qty: 2 }]),
      ],
    });
    expect(getAvailableSizesForProduct(p)).toEqual(["S", "L"]);
  });
});
