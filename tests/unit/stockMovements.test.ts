import { describe, expect, it } from "vitest";
import {
  aggregateCancellationRestoreQty,
  computeCancellationStockUpdates,
  computeStockDeltas,
  OrderCancellationError,
} from "../../src/admin/stockMovements";
import type { AdminColorVariant, AdminProduct, OrderLine } from "../../src/admin/types";

function variant(overrides: Partial<AdminColorVariant> = {}): AdminColorVariant {
  return {
    id: "black",
    colorName: "Black",
    colorHex: "#000000",
    sizeStock: [{ size: "S", qty: 5 }, { size: "M", qty: 3 }],
    ...overrides,
  };
}

describe("computeStockDeltas", () => {
  it("returns one entry for a size cell whose quantity decreased", () => {
    const before = [variant()];
    const after = [variant({ sizeStock: [{ size: "S", qty: 3 }, { size: "M", qty: 3 }] })];
    expect(computeStockDeltas(before, after)).toEqual([
      { variantId: "black", colorName: "Black", size: "S", qtyBefore: 5, qtyAfter: 3, qtyChange: -2 },
    ]);
  });

  it("returns one entry for a size cell whose quantity increased", () => {
    const before = [variant()];
    const after = [variant({ sizeStock: [{ size: "S", qty: 5 }, { size: "M", qty: 8 }] })];
    expect(computeStockDeltas(before, after)).toEqual([
      { variantId: "black", colorName: "Black", size: "M", qtyBefore: 3, qtyAfter: 8, qtyChange: 5 },
    ]);
  });

  it("ignores every cell whose quantity did not change", () => {
    const before = [variant()];
    const after = [variant()];
    expect(computeStockDeltas(before, after)).toEqual([]);
  });

  it("does not create a phantom movement for an unrelated edit (color rename, image change)", () => {
    const before = [variant()];
    const after = [variant({ colorName: "Jet Black", imageUrl: "https://example.com/new.jpg" })];
    expect(computeStockDeltas(before, after)).toEqual([]);
  });

  it("floors a null (never-confirmed) qty to 0 on the before side", () => {
    const before = [variant({ sizeStock: [{ size: "S", qty: null }] })];
    const after = [variant({ sizeStock: [{ size: "S", qty: 4 }] })];
    expect(computeStockDeltas(before, after)).toEqual([
      { variantId: "black", colorName: "Black", size: "S", qtyBefore: 0, qtyAfter: 4, qtyChange: 4 },
    ]);
  });

  it("floors a null (never-confirmed) qty to 0 on the after side", () => {
    const before = [variant({ sizeStock: [{ size: "S", qty: 4 }] })];
    const after = [variant({ sizeStock: [{ size: "S", qty: null }] })];
    expect(computeStockDeltas(before, after)).toEqual([
      { variantId: "black", colorName: "Black", size: "S", qtyBefore: 4, qtyAfter: 0, qtyChange: -4 },
    ]);
  });

  it("does not report a change when an unconfirmed (null) slot is merely confirmed as zero", () => {
    const before = [variant({ sizeStock: [{ size: "S", qty: null }] })];
    const after = [variant({ sizeStock: [{ size: "S", qty: 0 }] })];
    expect(computeStockDeltas(before, after)).toEqual([]);
  });

  it("treats a brand-new size on an existing color as a baseline change from 0", () => {
    const before = [variant({ sizeStock: [{ size: "S", qty: 5 }] })];
    const after = [variant({ sizeStock: [{ size: "S", qty: 5 }, { size: "L", qty: 2 }] })];
    expect(computeStockDeltas(before, after)).toEqual([
      { variantId: "black", colorName: "Black", size: "L", qtyBefore: 0, qtyAfter: 2, qtyChange: 2 },
    ]);
  });

  it("treats a brand-new color variant as a baseline change from 0 for each of its sizes", () => {
    const before: AdminColorVariant[] = [];
    const after = [variant()];
    expect(computeStockDeltas(before, after)).toEqual([
      { variantId: "black", colorName: "Black", size: "S", qtyBefore: 0, qtyAfter: 5, qtyChange: 5 },
      { variantId: "black", colorName: "Black", size: "M", qtyBefore: 0, qtyAfter: 3, qtyChange: 3 },
    ]);
  });

  it("produces no entry for a color/size removed outright (not just zeroed)", () => {
    const before = [variant(), variant({ id: "red", colorName: "Red", sizeStock: [{ size: "S", qty: 2 }] })];
    const after = [variant()];
    expect(computeStockDeltas(before, after)).toEqual([]);
  });

  it("handles multiple touched cells across multiple variants in one call", () => {
    const before = [
      variant(),
      variant({ id: "red", colorName: "Red", sizeStock: [{ size: "S", qty: 2 }] }),
    ];
    const after = [
      variant({ sizeStock: [{ size: "S", qty: 4 }, { size: "M", qty: 3 }] }),
      variant({ id: "red", colorName: "Red", sizeStock: [{ size: "S", qty: 0 }] }),
    ];
    expect(computeStockDeltas(before, after)).toEqual([
      { variantId: "black", colorName: "Black", size: "S", qtyBefore: 5, qtyAfter: 4, qtyChange: -1 },
      { variantId: "red", colorName: "Red", size: "S", qtyBefore: 2, qtyAfter: 0, qtyChange: -2 },
    ]);
  });

  it("is a pure function — same input always yields the same output, nothing mutated", () => {
    const before = [variant()];
    const after = [variant({ sizeStock: [{ size: "S", qty: 1 }, { size: "M", qty: 3 }] })];
    const beforeSnapshot = JSON.stringify(before);
    const afterSnapshot = JSON.stringify(after);
    const r1 = computeStockDeltas(before, after);
    const r2 = computeStockDeltas(before, after);
    expect(r1).toEqual(r2);
    expect(JSON.stringify(before)).toBe(beforeSnapshot);
    expect(JSON.stringify(after)).toBe(afterSnapshot);
  });
});

function line(overrides: Partial<OrderLine> = {}): OrderLine {
  return {
    productId: "prod1",
    variantId: "black",
    name: "Test Dress",
    qty: 1,
    price: 100,
    size: "M",
    color: "Black",
    ...overrides,
  };
}

describe("aggregateCancellationRestoreQty", () => {
  it("returns one entry per distinct (productId, variantId, size)", () => {
    const result = aggregateCancellationRestoreQty([line(), line({ productId: "prod2", size: "L" })]);
    expect(result).toEqual([
      { productId: "prod1", variantId: "black", size: "M", qty: 1 },
      { productId: "prod2", variantId: "black", size: "L", qty: 1 },
    ]);
  });

  it("combines duplicate (productId, variantId, size) lines into one summed entry", () => {
    const result = aggregateCancellationRestoreQty([line({ qty: 2 }), line({ qty: 3 })]);
    expect(result).toEqual([{ productId: "prod1", variantId: "black", size: "M", qty: 5 }]);
  });

  it("keeps different variants of the same product separate", () => {
    const result = aggregateCancellationRestoreQty([line({ variantId: "black" }), line({ variantId: "red" })]);
    expect(result).toEqual([
      { productId: "prod1", variantId: "black", size: "M", qty: 1 },
      { productId: "prod1", variantId: "red", size: "M", qty: 1 },
    ]);
  });

  it("keeps different sizes of the same product/variant separate", () => {
    const result = aggregateCancellationRestoreQty([line({ size: "S" }), line({ size: "M" })]);
    expect(result).toEqual([
      { productId: "prod1", variantId: "black", size: "S", qty: 1 },
      { productId: "prod1", variantId: "black", size: "M", qty: 1 },
    ]);
  });

  it("returns an empty array for an empty order (no lines)", () => {
    expect(aggregateCancellationRestoreQty([])).toEqual([]);
  });

  it("does not mutate the input lines", () => {
    const lines = [line(), line()];
    const snapshot = JSON.stringify(lines);
    aggregateCancellationRestoreQty(lines);
    expect(JSON.stringify(lines)).toBe(snapshot);
  });
});

function product(overrides: Partial<AdminProduct> = {}): AdminProduct {
  return {
    id: "prod1",
    name: "Test Dress",
    slug: "test-dress",
    price: 100,
    status: "active",
    colorVariants: [variant()],
    ...overrides,
  } as AdminProduct;
}

describe("computeCancellationStockUpdates", () => {
  it("restores the exact quantity to the matching variant/size", () => {
    const entries = aggregateCancellationRestoreQty([line({ variantId: "black", size: "S", qty: 2 })]);
    const productById = new Map([["prod1", product()]]);
    const updates = computeCancellationStockUpdates(entries, productById);
    expect(updates).toEqual([
      {
        productId: "prod1",
        productName: "Test Dress",
        before: [variant()],
        after: [variant({ sizeStock: [{ size: "S", qty: 7 }, { size: "M", qty: 3 }] })],
      },
    ]);
  });

  it("restores correctly across multiple products in one call", () => {
    const entries = aggregateCancellationRestoreQty([
      line({ productId: "prod1", variantId: "black", size: "S", qty: 1 }),
      line({ productId: "prod2", variantId: "red", size: "L", qty: 4 }),
    ]);
    const productById = new Map([
      ["prod1", product()],
      ["prod2", product({ id: "prod2", name: "Other Product", colorVariants: [variant({ id: "red", colorName: "Red", sizeStock: [{ size: "L", qty: 1 }] })] })],
    ]);
    const updates = computeCancellationStockUpdates(entries, productById);
    expect(updates.find((u) => u.productId === "prod1")?.after).toEqual([variant({ sizeStock: [{ size: "S", qty: 6 }, { size: "M", qty: 3 }] })]);
    expect(updates.find((u) => u.productId === "prod2")?.after).toEqual([variant({ id: "red", colorName: "Red", sizeStock: [{ size: "L", qty: 5 }] })]);
  });

  it("restores correctly across multiple variants and multiple sizes of the same product", () => {
    const entries = aggregateCancellationRestoreQty([
      line({ variantId: "black", size: "S", qty: 1 }),
      line({ variantId: "black", size: "M", qty: 2 }),
      line({ variantId: "red", size: "S", qty: 1 }),
    ]);
    const productById = new Map([
      [
        "prod1",
        product({
          colorVariants: [variant(), variant({ id: "red", colorName: "Red", sizeStock: [{ size: "S", qty: 0 }] })],
        }),
      ],
    ]);
    const updates = computeCancellationStockUpdates(entries, productById);
    expect(updates).toEqual([
      {
        productId: "prod1",
        productName: "Test Dress",
        before: [variant(), variant({ id: "red", colorName: "Red", sizeStock: [{ size: "S", qty: 0 }] })],
        after: [
          variant({ sizeStock: [{ size: "S", qty: 6 }, { size: "M", qty: 5 }] }),
          variant({ id: "red", colorName: "Red", sizeStock: [{ size: "S", qty: 1 }] }),
        ],
      },
    ]);
  });

  it("combined with aggregateCancellationRestoreQty, restores the full amount for duplicate lines", () => {
    const entries = aggregateCancellationRestoreQty([line({ size: "S", qty: 2 }), line({ size: "S", qty: 3 })]);
    const productById = new Map([["prod1", product()]]);
    const updates = computeCancellationStockUpdates(entries, productById);
    expect(updates[0].after).toEqual([variant({ sizeStock: [{ size: "S", qty: 10 }, { size: "M", qty: 3 }] })]);
  });

  it("leaves an untouched product/cell completely unchanged", () => {
    const entries = aggregateCancellationRestoreQty([line({ size: "S", qty: 1 })]);
    const productById = new Map([["prod1", product()]]);
    const updates = computeCancellationStockUpdates(entries, productById);
    expect(updates[0].after[0].sizeStock.find((s) => s.size === "M")).toEqual({ size: "M", qty: 3 });
  });

  it("throws and computes nothing when a referenced product is missing from the map", () => {
    const entries = aggregateCancellationRestoreQty([line({ productId: "prod-deleted" })]);
    const productById = new Map([["prod1", product()]]);
    expect(() => computeCancellationStockUpdates(entries, productById)).toThrow(OrderCancellationError);
  });

  it("throws when the line's color variant no longer exists on the product", () => {
    const entries = aggregateCancellationRestoreQty([line({ variantId: "gold" })]);
    const productById = new Map([["prod1", product()]]);
    expect(() => computeCancellationStockUpdates(entries, productById)).toThrow(OrderCancellationError);
  });

  it("throws when the line's size no longer exists on the variant", () => {
    const entries = aggregateCancellationRestoreQty([line({ size: "XXL" })]);
    const productById = new Map([["prod1", product()]]);
    expect(() => computeCancellationStockUpdates(entries, productById)).toThrow(OrderCancellationError);
  });

  it("throws when the size's stock was never confirmed (qty: null) rather than silently restoring", () => {
    const entries = aggregateCancellationRestoreQty([line({ size: "S" })]);
    const productById = new Map([["prod1", product({ colorVariants: [variant({ sizeStock: [{ size: "S", qty: null }] })] })]]);
    expect(() => computeCancellationStockUpdates(entries, productById)).toThrow(OrderCancellationError);
  });

  it("does not silently apply a partial restoration when one of several lines is unsafe", () => {
    // prod1/black/S is perfectly valid; prod1/black/XXL does not exist.
    // The whole call must throw -- neither line should be reflected in any
    // returned update.
    const entries = aggregateCancellationRestoreQty([line({ size: "S", qty: 1 }), line({ size: "XXL", qty: 1 })]);
    const productById = new Map([["prod1", product()]]);
    expect(() => computeCancellationStockUpdates(entries, productById)).toThrow(OrderCancellationError);
  });

  it("returns an empty array when given no restore entries", () => {
    const productById = new Map([["prod1", product()]]);
    expect(computeCancellationStockUpdates([], productById)).toEqual([]);
  });

  it("does not mutate its inputs", () => {
    const entries = aggregateCancellationRestoreQty([line({ size: "S", qty: 1 })]);
    const p = product();
    const productSnapshot = JSON.stringify(p);
    computeCancellationStockUpdates(entries, new Map([["prod1", p]]));
    expect(JSON.stringify(p)).toBe(productSnapshot);
  });
});
