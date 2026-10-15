import { describe, expect, it } from "vitest";
import {
  UNSELLABLE_REASON_PRIORITY,
  filterSellable,
  isSellable,
  resolveSellability,
  unsellableReasonDetail,
  unsellableReasonLabelKey,
  type SellabilityInput,
  type UnsellableReasonCode,
} from "../../src/data/sellability";
import { translations } from "../../src/i18n/translations";

// Builds a product from a compact description: each inner array is one color
// variant, each number (or null) is the quantity of one size slot. Declared
// sizes are S, M, L, ... up to the widest variant.
function product(variants: (number | null)[][], overrides: Partial<SellabilityInput> = {}): SellabilityInput {
  const labels = ["S", "M", "L", "XL", "XXL", "3XL"];
  const width = Math.max(0, ...variants.map((v) => v.length));
  return {
    sizes: labels.slice(0, width),
    colorVariants: variants.map((qtys) => ({ sizeStock: qtys.map((qty, i) => ({ size: labels[i], qty })) })),
    ...overrides,
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

describe("resolveSellability: sellable products stay visible", () => {
  it("a product with stock in every size is sellable", () => {
    const r = resolveSellability(product([[3, 2, 1]]));
    expect(r.sellable).toBe(true);
    expect(r.primaryReason).toBeNull();
    expect(r.reasons).toEqual([]);
    expect(r.keptVisibleBecause).toBeNull();
  });

  it("a product with stock in only one size of one color is sellable", () => {
    expect(isSellable(product([[0, 0, 0], [0, 1, 0]]))).toBe(true);
  });

  it("a storefront-shaped product (no status field at all) is treated as active", () => {
    expect("status" in product([[1]])).toBe(false);
    expect(isSellable(product([[1]]))).toBe(true);
  });

  it("an explicitly active product is sellable", () => {
    expect(isSellable(product([[1]], { status: "active" }))).toBe(true);
  });

  it("does not hide a product just because it looks unusual (price/images/description are never sellability rules)", () => {
    const odd = { ...product([[2]]), price: 0, imageUrl: undefined, description: "" };
    expect(isSellable(odd)).toBe(true);
  });
});

describe("resolveSellability: out-of-stock products are excluded", () => {
  it("every size confirmed at 0 is out of stock", () => {
    const r = resolveSellability(product([[0, 0, 0]]));
    expect(r.sellable).toBe(false);
    expect(r.primaryReason).toEqual({ code: "out_of_stock" });
  });

  it("every color of a multi-color product at 0 is out of stock", () => {
    const r = resolveSellability(product([[0, 0], [0, 0], [0, 0]]));
    expect(r.primaryReason?.code).toBe("out_of_stock");
  });

  it("a negative quantity (data anomaly) is never treated as available stock", () => {
    expect(resolveSellability(product([[-1, 0]])).primaryReason?.code).toBe("out_of_stock");
  });

  it("becomes sellable again by itself when stock returns (visibility is derived, not stored)", () => {
    const soldOut = product([[0, 0]]);
    expect(isSellable(soldOut)).toBe(false);
    const restocked = { ...soldOut, colorVariants: [{ sizeStock: [{ size: "S", qty: 0 }, { size: "M", qty: 4 }] }] };
    expect(isSellable(restocked)).toBe(true);
  });
});

describe("resolveSellability: explicitly unavailable products are excluded", () => {
  it("an archived product is excluded even with plenty of stock", () => {
    const r = resolveSellability(product([[10, 10]], { status: "archived" }));
    expect(r.sellable).toBe(false);
    expect(r.primaryReason).toEqual({ code: "inactive", status: "archived" });
  });

  it("a draft product is excluded", () => {
    expect(resolveSellability(product([[5]], { status: "draft" })).primaryReason).toEqual({ code: "inactive", status: "draft" });
  });

  it("any status other than active is excluded rather than guessed at", () => {
    expect(isSellable(product([[5]], { status: "weird" }))).toBe(false);
  });

  it("returns to sellable when the status goes back to active", () => {
    expect(isSellable(product([[5]], { status: "active" }))).toBe(true);
  });
});

describe("resolveSellability: existing problem states", () => {
  it("a product with no colors has incomplete data", () => {
    const r = resolveSellability(product([], { sizes: ["S"] }));
    expect(r.primaryReason).toEqual({ code: "incomplete_data", missing: "colors" });
  });

  it("a product whose colors have no size slots at all has incomplete data (not 'out of stock')", () => {
    const r = resolveSellability({ sizes: ["S"], colorVariants: [{ sizeStock: [] }] });
    expect(r.primaryReason).toEqual({ code: "incomplete_data", missing: "sizes" });
    expect(r.reasons.some((x) => x.code === "out_of_stock")).toBe(false);
  });

  // colorvariants-map-migration-plan-2026-09-22: exceedsCheckoutSafeLimit()
  // (and therefore the "checkout_unsafe"/"خلل في المنتج" reason) is
  // retired — it always returns false now. The old array-based Firestore
  // Rules validated a checkout by re-diffing a product's ENTIRE
  // colorVariants array, so cost scaled with the product's TOTAL color/size
  // count; the approved flat `stockByCell` schema validates a checkout in
  // cost proportional to what THAT checkout actually claims (bounded by the
  // existing, unchanged 8-line cap), independent of catalog size — proven
  // in migration/colorvariants-map-migration-plan-2026-09-22/spike2/
  // SPIKE-REPORT-2.md, including the real worst-case 18-color/40-slot
  // product with a full 8-line multi-color claim. These tests now confirm
  // the retirement itself: a product this large is genuinely sellable.
  it("many colors with stock is sellable — the old checkout-safe-limit cliff no longer applies", () => {
    const r = resolveSellability(product([[1], [1], [1], [1], [1]]));
    expect(r.sellable).toBe(true);
    expect(r.primaryReason).toBeNull();
  });

  it("many colors x many sizes is still sellable (no size-slot ceiling either)", () => {
    expect(isSellable(product([[1, 1, 1], [1, 1, 1], [1, 1, 1]]))).toBe(true);
    expect(isSellable(product([[1, 1, 1, 1], [1, 1, 1], [1, 1, 1]]))).toBe(true);
  });
});

describe("resolveSellability: ambiguous products are kept visible, never silently hidden", () => {
  it("stock that was never counted (all null) is kept visible", () => {
    const r = resolveSellability(product([[null, null]]));
    expect(r.sellable).toBe(true);
    expect(r.keptVisibleBecause).toBe("stock_unconfirmed");
  });

  it("zeros mixed with unknowns and nothing confirmed is still kept visible", () => {
    const r = resolveSellability(product([[0, null]]));
    expect(r.sellable).toBe(true);
    expect(r.keptVisibleBecause).toBe("stock_unconfirmed");
  });

  it("unknown stock alongside confirmed stock is simply sellable (nothing ambiguous)", () => {
    const r = resolveSellability(product([[null, 4]]));
    expect(r.sellable).toBe(true);
    expect(r.keptVisibleBecause).toBeNull();
  });

  it("real stock that exists only in sizes the product does not declare is kept visible", () => {
    const r = resolveSellability({ sizes: ["S"], colorVariants: [{ sizeStock: [{ size: "S", qty: 0 }, { size: "XL", qty: 7 }] }] });
    expect(r.sellable).toBe(true);
    expect(r.keptVisibleBecause).toBe("stock_outside_declared_sizes");
  });

  it("a malformed quantity (undefined) is treated as unconfirmed, not as zero", () => {
    const malformed = { sizes: ["S"], colorVariants: [{ sizeStock: [{ size: "S" } as unknown as { size: string; qty: number | null }] }] };
    expect(isSellable(malformed)).toBe(true);
  });

  it("an unconfirmed-stock product that is ALSO archived is still hidden (the explicit decision wins)", () => {
    const r = resolveSellability(product([[null]], { status: "archived" }));
    expect(r.sellable).toBe(false);
    expect(r.keptVisibleBecause).toBeNull();
  });
});

describe("resolveSellability: one deterministic primary reason", () => {
  it("lists reasons in the documented priority order", () => {
    expect(UNSELLABLE_REASON_PRIORITY).toEqual(["inactive", "incomplete_data", "checkout_unsafe", "out_of_stock"]);
  });

  it("archived + out of stock -> primary is 'inactive', both preserved", () => {
    const r = resolveSellability(product([[0], [0], [0], [0], [0]], { status: "archived" }));
    expect(r.primaryReason?.code).toBe("inactive");
    expect(r.reasons.map((x) => x.code)).toEqual(["inactive", "out_of_stock"]);
  });

  it("many colors, all confirmed at zero, is still 'out of stock' (not the retired checkout_unsafe)", () => {
    const r = resolveSellability(product([[0], [0], [0], [0], [0]]));
    expect(r.primaryReason?.code).toBe("out_of_stock");
    expect(r.reasons.map((x) => x.code)).toEqual(["out_of_stock"]);
  });

  it("incomplete data outranks a product defect and stock", () => {
    const r = resolveSellability({ sizes: [], colorVariants: [] });
    expect(r.primaryReason?.code).toBe("incomplete_data");
  });

  it("always gives the same answer for the same input", () => {
    const p = product([[0], [0], [0], [0], [0]], { status: "draft" });
    expect(resolveSellability(p)).toEqual(resolveSellability(p));
  });
});

describe("filterSellable", () => {
  const inStock = product([[3]]);
  const soldOut = product([[0]]);
  const archived = product([[3]], { status: "archived" });
  // Many colors, in stock — genuinely sellable since exceedsCheckoutSafeLimit
  // was retired (colorvariants-map-migration-plan-2026-09-22); kept here to
  // confirm filterSellable doesn't hide it for having "too many" colors.
  const manyColorsInStock = product([[1], [1], [1], [1], [1]]);
  const unconfirmed = product([[null]]);

  it("keeps sellable and ambiguous products, drops the rest, preserving order and identity", () => {
    const result = filterSellable([inStock, soldOut, archived, manyColorsInStock, unconfirmed]);
    expect(result).toEqual([inStock, manyColorsInStock, unconfirmed]);
    expect(result[0]).toBe(inStock);
    expect(result[1]).toBe(manyColorsInStock);
    expect(result[2]).toBe(unconfirmed);
  });

  it("returns an empty list when nothing is sellable (never falls back to showing everything)", () => {
    expect(filterSellable([soldOut, archived])).toEqual([]);
  });

  it("returns a new array and never mutates the input list or the products in it", () => {
    const input = deepFreeze([product([[3]]), product([[0]]), product([[3]], { status: "draft" }), product([[null, 0]])]);
    const snapshot = JSON.parse(JSON.stringify(input));
    const result = filterSellable(input);
    expect(result).not.toBe(input);
    expect(JSON.parse(JSON.stringify(input))).toEqual(snapshot);
    input.forEach((p) => resolveSellability(p)); // frozen input would throw on any write
  });
});

function lookup(lang: "en" | "ar", key: string): unknown {
  return key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], translations[lang]);
}

describe("reason labels", () => {
  const codes: UnsellableReasonCode[] = ["inactive", "incomplete_data", "checkout_unsafe", "out_of_stock"];

  it("uses the exact Arabic business labels", () => {
    const ar = (code: UnsellableReasonCode) => lookup("ar", unsellableReasonLabelKey(code));
    expect(ar("out_of_stock")).toBe("نفدت الكمية");
    expect(ar("inactive")).toBe("غير متاح للبيع");
    expect(ar("incomplete_data")).toBe("بيانات المنتج غير مكتملة");
    expect(ar("checkout_unsafe")).toBe("خلل في المنتج");
  });

  it("has a non-empty label in both languages for every reason code", () => {
    for (const code of codes) {
      for (const lang of ["en", "ar"] as const) {
        const label = lookup(lang, unsellableReasonLabelKey(code));
        expect(typeof label === "string" && label.length > 0, `${lang} label for ${code}`).toBe(true);
      }
    }
  });

  it("has an explanatory detail line in both languages for every reason (no vague technical text)", () => {
    const reasons = [
      { code: "inactive", status: "archived" },
      { code: "inactive", status: "draft" },
      { code: "inactive", status: "weird" },
      { code: "incomplete_data", missing: "colors" },
      { code: "incomplete_data", missing: "sizes" },
      { code: "checkout_unsafe", colorCount: 6, sizeSlots: 8 },
      { code: "out_of_stock" },
    ] as const;
    for (const reason of reasons) {
      const { key } = unsellableReasonDetail(reason);
      for (const lang of ["en", "ar"] as const) {
        const text = lookup(lang, key);
        expect(typeof text === "string" && text.length > 10, `${lang} detail for ${key}`).toBe(true);
      }
    }
  });

  it("the product-defect detail reports the actual color and size counts", () => {
    const { key, params } = unsellableReasonDetail({ code: "checkout_unsafe", colorCount: 6, sizeSlots: 8 });
    expect(params).toEqual({ colors: 6, slots: 8 });
    for (const lang of ["en", "ar"] as const) {
      const text = lookup(lang, key) as string;
      expect(text).toContain("{colors}");
      expect(text).toContain("{slots}");
    }
  });

  it("archived and draft explain themselves differently", () => {
    expect(unsellableReasonDetail({ code: "inactive", status: "archived" }).key).not.toBe(unsellableReasonDetail({ code: "inactive", status: "draft" }).key);
  });
});
