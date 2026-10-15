import { describe, expect, it } from "vitest";
import { filterLowStock, filterOutOfStock, isRecognizedZoneName, resolveSingleCustomerId } from "../../src/admin/assistant/operations";
import type { AdminProduct } from "../../src/admin/types";

function product(overrides: Partial<AdminProduct> = {}): AdminProduct {
  return {
    id: "p1",
    slug: "essential-black-dress",
    name: "Essential Black Dress",
    category: "dresses",
    price: 129.99,
    colorVariants: [{ id: "v1", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "M", qty: 5 }] }],
    sizes: ["M"],
    rating: 0,
    reviewCount: 0,
    description: "",
    details: [],
    status: "active",
    ...overrides,
  };
}

describe("resolveSingleCustomerId", () => {
  it("returns the shared customerId when every order has the same one (verified profile)", () => {
    expect(resolveSingleCustomerId([{ customerId: "c1" }, { customerId: "c1" }])).toBe("c1");
  });

  it("returns null when orders have no customerId at all (pure guest checkouts)", () => {
    expect(resolveSingleCustomerId([{ customerId: undefined }, { customerId: undefined }])).toBeNull();
  });

  it("returns null when orders belong to two DIFFERENT customerIds -- never picks one arbitrarily", () => {
    expect(resolveSingleCustomerId([{ customerId: "c1" }, { customerId: "c2" }])).toBeNull();
  });

  it("treats a mix of one real customerId plus guest orders (no customerId) sharing the same email/phone as that one verified identity", () => {
    expect(resolveSingleCustomerId([{ customerId: "c1" }, { customerId: undefined }])).toBe("c1");
  });
});

describe("isRecognizedZoneName", () => {
  const zones = [
    { name: "Nablus", nameAr: "نابلس" },
    { name: "Hebron", nameAr: "الخليل" },
  ];

  it("recognizes a real zone by its English name, case-insensitively", () => {
    expect(isRecognizedZoneName(zones, "nablus")).toBe(true);
  });

  it("recognizes a real zone by its Arabic name", () => {
    expect(isRecognizedZoneName(zones, "نابلس")).toBe(true);
  });

  it("returns false for a name that matches no real zone -- never guessed as real", () => {
    expect(isRecognizedZoneName(zones, "Atlantis")).toBe(false);
  });

  it("returns false for an empty fragment", () => {
    expect(isRecognizedZoneName(zones, "")).toBe(false);
  });
});

describe("filterOutOfStock", () => {
  it("includes an active product whose total known stock is exactly zero", () => {
    const p = product({ colorVariants: [{ id: "v1", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "M", qty: 0 }] }] });
    expect(filterOutOfStock([p])).toHaveLength(1);
  });

  it("excludes a product with stock remaining", () => {
    expect(filterOutOfStock([product()])).toHaveLength(0);
  });

  it("excludes a product with any unknown (null) qty slot -- never treats null as zero", () => {
    const p = product({ colorVariants: [{ id: "v1", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "M", qty: null }] }] });
    expect(filterOutOfStock([p])).toHaveLength(0);
  });

  it("excludes a non-active (draft/archived) product even at zero stock", () => {
    const p = product({ status: "archived", colorVariants: [{ id: "v1", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "M", qty: 0 }] }] });
    expect(filterOutOfStock([p])).toHaveLength(0);
  });
});

describe("filterLowStock", () => {
  it("includes an active product at or below the threshold, above zero", () => {
    const p = product({ colorVariants: [{ id: "v1", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "M", qty: 3 }] }] });
    expect(filterLowStock([p], 3)).toHaveLength(1);
  });

  it("excludes a product already at zero stock -- that is out_of_stock's job, not low_stock's", () => {
    const p = product({ colorVariants: [{ id: "v1", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "M", qty: 0 }] }] });
    expect(filterLowStock([p], 3)).toHaveLength(0);
  });

  it("excludes a product comfortably above the threshold", () => {
    const p = product({ colorVariants: [{ id: "v1", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "M", qty: 50 }] }] });
    expect(filterLowStock([p], 3)).toHaveLength(0);
  });

  it("excludes a product with any unknown (null) qty slot -- never guesses it's low", () => {
    const p = product({ colorVariants: [{ id: "v1", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "M", qty: null }] }] });
    expect(filterLowStock([p], 3)).toHaveLength(0);
  });

  it("respects a custom configured threshold rather than a hardcoded 3", () => {
    const p = product({ colorVariants: [{ id: "v1", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "M", qty: 8 }] }] });
    expect(filterLowStock([p], 3)).toHaveLength(0);
    expect(filterLowStock([p], 10)).toHaveLength(1);
  });
});
