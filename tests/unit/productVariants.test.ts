import { describe, expect, it } from "vitest";
import {
  countUnknownStock,
  emptyVariant,
  exceedsCheckoutSafeLimit,
  hasUnknownStock,
  joinProductFields,
  newVariantId,
  normalizeProduct,
  resizeVariantStock,
  shouldDisplayNewStockCellAsBlank,
  splitProductFields,
  stockCellKey,
  toStockByCell,
  totalStock,
  unionSizes,
} from "../../src/admin/productVariants";
import type { AdminColorVariant, AdminProduct } from "../../src/admin/types";

// colorvariants-map-migration-plan-2026-09-22: this file's own module
// comment documents the three raw Firestore shapes joinProductFields()
// must keep working across (new flat, old array, legacy pre-colorVariants)
// — these tests are the losslessness/correctness proof for that converter,
// the single chokepoint the whole migration's "keep the app layer
// array-shaped" guarantee rests on.

describe("joinProductFields: NEW flat shape (colorVariants metadata map + stockByCell)", () => {
  it("joins metadata and stock back into the familiar nested array, sorted by order", () => {
    const raw = {
      colorVariants: {
        b: { colorName: "Blue", colorHex: "#00f", order: 1 },
        a: { colorName: "Amber", colorHex: "#fa0", order: 0 },
      },
      stockByCell: {
        "a::S": { qty: 5 },
        "a::M": { qty: null, qtyUnknown: true },
        "b::S": { qty: 0 },
      },
    };
    const result = joinProductFields(raw);
    expect(result.map((v) => v.id)).toEqual(["a", "b"]); // sorted by order, not object key order
    expect(result[0]).toMatchObject({ id: "a", colorName: "Amber", colorHex: "#fa0", order: 0 });
    expect(result[0].sizeStock).toEqual(
      expect.arrayContaining([
        { size: "S", qty: 5, qtyUnknown: undefined },
        { size: "M", qty: null, qtyUnknown: true },
      ])
    );
    expect(result[1]).toMatchObject({ id: "b", colorName: "Blue", order: 1 });
    expect(result[1].sizeStock).toEqual([{ size: "S", qty: 0, qtyUnknown: undefined }]);
  });

  it("preserves every metadata field (colorNameAr, imageId, imageUrl, gallery)", () => {
    const raw = {
      colorVariants: {
        v1: { colorName: "Red", colorNameAr: "أحمر", colorHex: "#f00", imageId: "img1", imageUrl: "https://x/1.jpg", gallery: ["https://x/1.jpg", "https://x/2.jpg"], order: 0 },
      },
      stockByCell: { "v1::S": { qty: 3 } },
    };
    const [v] = joinProductFields(raw);
    expect(v).toMatchObject({
      colorNameAr: "أحمر",
      imageId: "img1",
      imageUrl: "https://x/1.jpg",
      gallery: ["https://x/1.jpg", "https://x/2.jpg"],
    });
  });

  it("a variant with no stock cells at all still appears, with an empty sizeStock", () => {
    const raw = { colorVariants: { v1: { colorName: "Red", colorHex: "#f00", order: 0 } }, stockByCell: {} };
    const [v] = joinProductFields(raw);
    expect(v.sizeStock).toEqual([]);
  });

  it("falls back to object key order (then id) when `order` is missing on some/all variants", () => {
    const raw = { colorVariants: { z: { colorName: "Z", colorHex: "#000" }, a: { colorName: "A", colorHex: "#111" } }, stockByCell: {} };
    const result = joinProductFields(raw);
    // Object.entries order for string keys is insertion order (z, then a) --
    // both get a derived order of 0 and 1 respectively via the `i` fallback,
    // NOT re-sorted alphabetically by id.
    expect(result.map((v) => v.id)).toEqual(["z", "a"]);
  });

  it("a size label carrying a hidden RTL mark round-trips byte-for-byte as the map key suffix", () => {
    const rtlSize = "‏M";
    const raw = { colorVariants: { v1: { colorName: "X", colorHex: "#000", order: 0 } }, stockByCell: { [`v1::${rtlSize}`]: { qty: 4 } } };
    const [v] = joinProductFields(raw);
    expect(v.sizeStock).toEqual([{ size: rtlSize, qty: 4, qtyUnknown: undefined }]);
  });
});

describe("joinProductFields: OLD array shape (pre-migration, today's live shape)", () => {
  it("passes an already-array-shaped document through unchanged, assigning `order` from array position", () => {
    const raw = {
      colorVariants: [
        { id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 5 }] },
        { id: "white", colorName: "White", colorHex: "#fff", sizeStock: [{ size: "S", qty: 2 }] },
      ],
    };
    const result = joinProductFields(raw);
    expect(result).toEqual([
      { id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 5 }], order: 0 },
      { id: "white", colorName: "White", colorHex: "#fff", sizeStock: [{ size: "S", qty: 2 }], order: 1 },
    ]);
  });

  it("respects an already-present `order` field over array position (a doc saved after this feature existed)", () => {
    const raw = {
      colorVariants: [
        { id: "black", colorName: "Black", colorHex: "#000", sizeStock: [], order: 5 },
        { id: "white", colorName: "White", colorHex: "#fff", sizeStock: [], order: 1 },
      ],
    };
    // joinProductFields for the array branch preserves array position as
    // the RETURNED order (matches today's behavior exactly — the array
    // branch is a pass-through, not a re-sort); only the flat branch
    // actively sorts by `order`. This documents that intentional
    // asymmetry rather than assuming it.
    const result = joinProductFields(raw);
    expect(result.map((v) => v.id)).toEqual(["black", "white"]);
    expect(result.map((v) => v.order)).toEqual([5, 1]);
  });
});

describe("joinProductFields: LEGACY shape (pre-colorVariants documents)", () => {
  it("folds top-level colorName/colorHex/stock into a single 'default' variant", () => {
    const raw = { colorName: "Only Color", colorHex: "#123456", stock: [{ size: "M", qty: 7 }] };
    const result = joinProductFields(raw);
    expect(result).toEqual([{ id: "default", colorName: "Only Color", colorNameAr: undefined, colorHex: "#123456", imageId: undefined, imageUrl: undefined, gallery: undefined, order: 0, sizeStock: [{ size: "M", qty: 7 }] }]);
  });

  it("an empty colorVariants array also falls through to the legacy fold (matches the original normalizeProduct's exact behavior)", () => {
    const raw = { colorVariants: [], colorName: "X", colorHex: "#000", sizes: ["S"] };
    const result = joinProductFields(raw);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("default");
  });

  it("no colorVariants and no legacy stock array falls back to zeroed sizes from `sizes`", () => {
    const raw = { sizes: ["S", "M"] };
    const result = joinProductFields(raw);
    expect(result[0].sizeStock).toEqual([{ size: "S", qty: 0 }, { size: "M", qty: 0 }]);
  });
});

describe("splitProductFields / toStockByCell: the write-side mirror", () => {
  const variants: AdminColorVariant[] = [
    { id: "a", colorName: "Amber", colorNameAr: "كهرماني", colorHex: "#fa0", imageUrl: "https://x/a.jpg", gallery: ["https://x/a.jpg"], order: 0, sizeStock: [{ size: "S", qty: 5 }, { size: "M", qty: null, qtyUnknown: true }] },
    { id: "b", colorName: "Blue", colorHex: "#00f", order: 1, sizeStock: [{ size: "S", qty: 0 }] },
  ];

  it("splits metadata and stock into the two flat Firestore fields", () => {
    const { colorVariants, stockByCell } = splitProductFields(variants);
    expect(colorVariants).toEqual({
      a: { colorName: "Amber", colorNameAr: "كهرماني", colorHex: "#fa0", imageId: undefined, imageUrl: "https://x/a.jpg", gallery: ["https://x/a.jpg"], order: 0 },
      b: { colorName: "Blue", colorNameAr: undefined, colorHex: "#00f", imageId: undefined, imageUrl: undefined, gallery: undefined, order: 1 },
    });
    expect(stockByCell).toEqual({
      "a::S": { qty: 5, qtyUnknown: undefined },
      "a::M": { qty: null, qtyUnknown: true },
      "b::S": { qty: 0, qtyUnknown: undefined },
    });
  });

  it("toStockByCell alone produces just the stock half (used by every stock-only writer)", () => {
    expect(toStockByCell(variants)).toEqual(splitProductFields(variants).stockByCell);
  });

  it("never silently drops the null/qtyUnknown distinction — a never-confirmed cell round-trips as null, not 0", () => {
    const { stockByCell } = splitProductFields(variants);
    expect(stockByCell["a::M"].qty).toBeNull();
    expect(stockByCell["a::M"].qtyUnknown).toBe(true);
  });
});

describe("Lossless round-trip: join(split(x)) preserves every color, size, qty (incl. null), and metadata field", () => {
  const cases: { name: string; variants: AdminColorVariant[] }[] = [
    {
      name: "simple single variant",
      variants: [{ id: "v1", colorName: "Red", colorHex: "#f00", order: 0, sizeStock: [{ size: "S", qty: 3 }] }],
    },
    {
      name: "multiple colors, multiple sizes, mixed null/zero/positive qty",
      variants: [
        { id: "v1", colorName: "Red", colorNameAr: "أحمر", colorHex: "#f00", imageUrl: "https://x/1.jpg", gallery: ["https://x/1.jpg", "https://x/2.jpg"], order: 0, sizeStock: [{ size: "S", qty: 0 }, { size: "M", qty: null, qtyUnknown: true }, { size: "L", qty: 12 }] },
        { id: "v2", colorName: "Blue", colorHex: "#00f", imageId: "img2", order: 1, sizeStock: [{ size: "S", qty: 5 }] },
        { id: "v3", colorName: "Green", colorHex: "#0f0", order: 2, sizeStock: [] },
      ],
    },
    {
      name: "a size label with a hidden RTL mark",
      variants: [{ id: "v1", colorName: "X", colorHex: "#000", order: 0, sizeStock: [{ size: "‏M", qty: 1 }] }],
    },
    {
      name: "the real product-732 shape (18 colors, 40 total slots)",
      variants: Array.from({ length: 18 }, (_, i) => ({
        id: `v${i}`,
        colorName: `Color${i}`,
        colorHex: "#112233",
        order: i,
        sizeStock: Array.from({ length: i === 17 ? 6 : 2 }, (_, s) => ({ size: `SZ${s}`, qty: 10 - s })),
      })),
    },
  ];

  for (const { name, variants } of cases) {
    it(`round-trips losslessly: ${name}`, () => {
      const { colorVariants, stockByCell } = splitProductFields(variants);
      const rejoined = joinProductFields({ colorVariants, stockByCell });
      // Compare order-independent-ly at the top (join sorts by order, which
      // matches the input's own order here) but require every field,
      // including every stock cell, to be byte-identical.
      expect(rejoined).toEqual(variants);
    });
  }
});

describe("normalizeProduct: now backed by joinProductFields, same external behavior", () => {
  it("still returns AdminProduct with colorVariants populated for a flat-shaped raw doc", () => {
    const raw = {
      id: "p1",
      colorVariants: { v1: { colorName: "Red", colorHex: "#f00", order: 0 } },
      stockByCell: { "v1::S": { qty: 3 } },
    } as unknown as AdminProduct;
    const result = normalizeProduct(raw);
    expect(result.colorVariants).toEqual([{ id: "v1", colorName: "Red", colorNameAr: undefined, colorHex: "#f00", imageId: undefined, imageUrl: undefined, gallery: undefined, order: 0, sizeStock: [{ size: "S", qty: 3, qtyUnknown: undefined }] }]);
  });

  it("still folds a legacy raw doc the same way it always has", () => {
    const raw = { id: "p1", colorName: "Only", colorHex: "#123", stock: [{ size: "S", qty: 1 }] } as unknown as AdminProduct;
    expect(normalizeProduct(raw).colorVariants[0].id).toBe("default");
  });
});

describe("newVariantId: collision-safe id generation (required once colorVariants is a Firestore map)", () => {
  it("never returns an id already present in existingIds, even under forced collisions", () => {
    const originalRandom = Math.random;
    let call = 0;
    // Force the first 3 attempts to collide with an already-used id, then
    // succeed on the 4th — proves the retry loop actually retries rather
    // than trusting the first candidate.
    Math.random = () => {
      call++;
      return call <= 3 ? 0.123456 : 0.987654;
    };
    try {
      const existing = [`red-${(0.123456).toString(36).slice(2, 7)}`];
      const id = newVariantId("Red", existing);
      expect(existing).not.toContain(id);
    } finally {
      Math.random = originalRandom;
    }
  });

  it("returns a base-prefixed id when given a real color name, empty when blank", () => {
    expect(newVariantId("Navy Blue")).toMatch(/^navy-blue-/);
    expect(newVariantId("")).not.toMatch(/^-/);
  });
});

describe("emptyVariant: collision-safe and order-aware", () => {
  it("assigns the requested order and a collision-free id", () => {
    const v = emptyVariant(["S", "M"], ["existing-1"], 3);
    expect(v.order).toBe(3);
    expect(v.id).not.toBe("existing-1");
    expect(v.sizeStock).toEqual([{ size: "S", qty: 0 }, { size: "M", qty: 0 }]);
  });
});

// Admin product-form "One Size" support (see the One-Size admin-creation
// audit report): ProductForm.tsx's ALL_SIZES now includes "One Size"
// alongside XS/S/M/L/XL, but every function it actually calls to build and
// save a product (emptyVariant, splitProductFields/toStockByCell,
// joinProductFields) was already fully generic over size strings -- no
// function here needed to change. These tests prove "One Size" flows
// through that existing generic handling exactly like any other size
// string, with no special-casing required or added.
describe("\"One Size\" flows through the generic size/variant handling exactly like any other size", () => {
  it("emptyVariant seeds a confirmed 0 for \"One Size\" the same way it does for any other size", () => {
    const v = emptyVariant(["One Size"]);
    expect(v.sizeStock).toEqual([{ size: "One Size", qty: 0 }]);
  });

  it("emptyVariant treats \"One Size\" as just one more entry when mixed with ordinary sizes", () => {
    const v = emptyVariant(["XS", "S", "One Size"]);
    expect(v.sizeStock).toEqual([{ size: "XS", qty: 0 }, { size: "S", qty: 0 }, { size: "One Size", qty: 0 }]);
  });

  it("splitProductFields/toStockByCell key a \"One Size\" stock cell the same way as any other size (variantId::size)", () => {
    const variants: AdminColorVariant[] = [
      { id: "brown", colorName: "Brown", colorHex: "#5b4636", order: 0, sizeStock: [{ size: "One Size", qty: 4 }] },
    ];
    const { stockByCell } = splitProductFields(variants);
    expect(stockByCell["brown::One Size"]).toEqual({ qty: 4, qtyUnknown: undefined });
  });

  it("round-trips a \"One Size\" product losslessly through join(split(x)), same as every other size case", () => {
    const variants: AdminColorVariant[] = [
      { id: "brown", colorName: "Brown", colorHex: "#5b4636", order: 0, sizeStock: [{ size: "One Size", qty: 4 }] },
      { id: "black", colorName: "Black", colorHex: "#000000", order: 1, sizeStock: [{ size: "One Size", qty: 0 }] },
    ];
    const { colorVariants, stockByCell } = splitProductFields(variants);
    const rejoined = joinProductFields({ colorVariants, stockByCell });
    expect(rejoined).toEqual(variants);
  });

  it("resizeVariantStock preserves an existing \"One Size\" entry and seeds a fresh one identically to any other size", () => {
    const withStock: AdminColorVariant = { id: "v1", colorName: "X", colorHex: "#000", order: 0, sizeStock: [{ size: "One Size", qty: 7 }] };
    expect(resizeVariantStock(withStock, ["One Size"])).toEqual([{ size: "One Size", qty: 7 }]);
    const withoutStock: AdminColorVariant = { id: "v2", colorName: "Y", colorHex: "#111", order: 0, sizeStock: [] };
    expect(resizeVariantStock(withoutStock, ["One Size"])).toEqual([{ size: "One Size", qty: 0 }]);
  });
});

describe("exceedsCheckoutSafeLimit: retired (colorvariants-map-migration-plan-2026-09-22)", () => {
  it("always returns false now, regardless of color/size count", () => {
    const many = { colorVariants: Array.from({ length: 20 }, () => ({ sizeStock: Array.from({ length: 10 }, () => ({})) })) };
    expect(exceedsCheckoutSafeLimit(many)).toBe(false);
    expect(exceedsCheckoutSafeLimit({ colorVariants: [] })).toBe(false);
  });
});

// Numeric-input UX fix (see the audit/implementation report): these prove
// the three-state stock contract survives the new "new variant shows blank
// instead of a literal 0" display behavior -- written BEFORE the
// ProductForm.tsx/Inventory.tsx input migration itself, per the explicit
// requirement to test this first.
describe("shouldDisplayNewStockCellAsBlank: display-only override, never changes what's saved", () => {
  const initial = new Set([stockCellKey("v1", "S")]); // v1::S existed when the product loaded; nothing else did
  const touched = new Set([stockCellKey("v2", "M")]); // the admin has explicitly edited v2::M this session

  it("empty/unknown (qty: null) is never affected by this helper -- it already displays blank on its own", () => {
    expect(shouldDisplayNewStockCellAsBlank(null, "v1", "S", initial, touched)).toBe(false);
    expect(shouldDisplayNewStockCellAsBlank(null, "brandNewVariant", "M", initial, touched)).toBe(false);
  });

  it("confirmed 0 remains displayed as 0 for a cell that already existed when the product loaded", () => {
    expect(shouldDisplayNewStockCellAsBlank(0, "v1", "S", initial, touched)).toBe(false);
  });

  it("confirmed 0 remains displayed as 0 once the admin has explicitly touched that cell this session, even for a brand-new variant", () => {
    expect(shouldDisplayNewStockCellAsBlank(0, "v2", "M", initial, touched)).toBe(false);
  });

  it("a brand-new, never-touched cell whose value is still the seeded 0 displays blank", () => {
    expect(shouldDisplayNewStockCellAsBlank(0, "v2", "L", initial, touched)).toBe(true);
  });

  it("positive quantities are never overridden, new variant or not", () => {
    expect(shouldDisplayNewStockCellAsBlank(5, "v2", "L", initial, touched)).toBe(false);
    expect(shouldDisplayNewStockCellAsBlank(5, "v1", "S", initial, touched)).toBe(false);
  });

  it("does not mutate the sets it's given", () => {
    const before = { initial: new Set(initial), touched: new Set(touched) };
    shouldDisplayNewStockCellAsBlank(0, "v2", "L", initial, touched);
    expect(initial).toEqual(before.initial);
    expect(touched).toEqual(before.touched);
  });
});

describe("Numeric-input UX fix: total stock / low-stock / ledger inputs are unaffected by the display-only change", () => {
  // emptyVariant() itself is UNCHANGED (still seeds a real, confirmed qty:
  // 0, never null) -- this is what keeps resolveSellability's out_of_stock
  // logic, totalStock(), and the stock ledger all working exactly as they
  // did before the input UX fix, since none of them are told anything
  // different about a freshly-added variant than they were before.
  it("emptyVariant still seeds confirmed 0, not null -- totalStock/sellability logic sees a real out-of-stock variant, unchanged", () => {
    const v = emptyVariant(["S", "M"]);
    expect(v.sizeStock).toEqual([{ size: "S", qty: 0 }, { size: "M", qty: 0 }]);
    const product = { colorVariants: [v] } as AdminProduct;
    expect(totalStock(product)).toBe(0);
    expect(hasUnknownStock(product)).toBe(false); // still confirmed-0, not "unconfirmed" -- resolveSellability's out_of_stock branch still fires for an untouched new variant, exactly as before
  });

  it("splitProductFields/toStockByCell (the stock ledger's own input) still round-trip a freshly-added confirmed-0 cell as 0, not null", () => {
    const v = emptyVariant(["S"]);
    const { stockByCell } = splitProductFields([v]);
    expect(stockByCell[`${v.id}::S`].qty).toBe(0);
  });
});

describe("existing aggregation helpers: unaffected by the schema change (still operate on the in-memory array)", () => {
  const product = { colorVariants: [{ id: "v1", sizeStock: [{ size: "S", qty: 5 }, { size: "M", qty: null }] }, { id: "v2", sizeStock: [{ size: "S", qty: 3 }] }] } as AdminProduct;

  it("totalStock sums only known quantities", () => {
    expect(totalStock(product)).toBe(8);
  });
  it("hasUnknownStock/countUnknownStock detect the one null cell", () => {
    expect(hasUnknownStock(product)).toBe(true);
    expect(countUnknownStock(product)).toBe(1);
  });
  it("unionSizes/resizeVariantStock still work per-variant", () => {
    expect(unionSizes(product.colorVariants)).toEqual(["S", "M"]);
    expect(resizeVariantStock(product.colorVariants[1], ["S", "M"])).toEqual([{ size: "S", qty: 3 }, { size: "M", qty: 0 }]);
  });
});
