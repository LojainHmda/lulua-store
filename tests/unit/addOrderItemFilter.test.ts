import { describe, expect, it } from "vitest";
import { filterProductsForAddItem, productMatchesAddItemSearch } from "../../src/admin/addOrderItemFilter";

function product(overrides: Partial<{ name: string; nameAr?: string; category: string }> = {}) {
  return {
    name: "Blue Dress",
    nameAr: "فستان أزرق",
    category: "dresses",
    ...overrides,
  };
}

describe("productMatchesAddItemSearch", () => {
  it("matches an empty query unconditionally", () => {
    expect(productMatchesAddItemSearch(product(), "")).toBe(true);
    expect(productMatchesAddItemSearch(product(), "   ")).toBe(true);
  });

  it("matches by English name, case-insensitively (regression -- must not break existing search)", () => {
    expect(productMatchesAddItemSearch(product(), "blue")).toBe(true);
    expect(productMatchesAddItemSearch(product(), "DRESS")).toBe(true);
  });

  it("matches by Arabic name (regression)", () => {
    expect(productMatchesAddItemSearch(product(), "أزرق")).toBe(true);
  });

  it("does not match unrelated text", () => {
    expect(productMatchesAddItemSearch(product(), "shoes")).toBe(false);
  });

  it("does not throw when nameAr is absent", () => {
    expect(productMatchesAddItemSearch(product({ nameAr: undefined }), "blue")).toBe(true);
    expect(productMatchesAddItemSearch(product({ nameAr: undefined }), "أزرق")).toBe(false);
  });
});

describe("filterProductsForAddItem", () => {
  const dress1 = product({ name: "Blue Dress", category: "dresses" });
  const dress2 = product({ name: "Red Dress", category: "dresses" });
  const shoe1 = product({ name: "White Shoes", nameAr: "حذاء أبيض", category: "shoes" });
  const all = [dress1, dress2, shoe1];

  it("returns every product when no category and no search are set (unchanged original behavior)", () => {
    expect(filterProductsForAddItem(all, { search: "", categorySlug: null })).toEqual(all);
  });

  it("filters to only the selected category when no search is set", () => {
    expect(filterProductsForAddItem(all, { search: "", categorySlug: "dresses" })).toEqual([dress1, dress2]);
    expect(filterProductsForAddItem(all, { search: "", categorySlug: "shoes" })).toEqual([shoe1]);
  });

  it("selecting a category with zero matching products returns an empty list, not a fallback to all", () => {
    expect(filterProductsForAddItem(all, { search: "", categorySlug: "accessories" })).toEqual([]);
  });

  it("applies search across every category when categorySlug is null (global search, original behavior)", () => {
    expect(filterProductsForAddItem(all, { search: "dress", categorySlug: null })).toEqual([dress1, dress2]);
  });

  // The key new-behavior test: search scoped to the active category, mirroring
  // Shop.tsx's existing category-then-search order -- a query that would match
  // a product OUTSIDE the selected category must not surface it.
  it("scopes search to the selected category -- a match outside that category is excluded", () => {
    expect(filterProductsForAddItem(all, { search: "shoes", categorySlug: "dresses" })).toEqual([]);
    expect(filterProductsForAddItem(all, { search: "white", categorySlug: "shoes" })).toEqual([shoe1]);
  });

  it("search still matches within the selected category by Arabic name", () => {
    expect(filterProductsForAddItem(all, { search: "أبيض", categorySlug: "shoes" })).toEqual([shoe1]);
  });

  it("clearing back to categorySlug: null (the 'All' chip) restores the full, unscoped list", () => {
    const withCategory = filterProductsForAddItem(all, { search: "", categorySlug: "dresses" });
    expect(withCategory).toEqual([dress1, dress2]);
    const backToAll = filterProductsForAddItem(all, { search: "", categorySlug: null });
    expect(backToAll).toEqual(all);
  });

  it("does not mutate the input array", () => {
    const copy = [...all];
    filterProductsForAddItem(all, { search: "dress", categorySlug: "dresses" });
    expect(all).toEqual(copy);
  });
});
