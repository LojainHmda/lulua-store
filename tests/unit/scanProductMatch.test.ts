import { describe, expect, it } from "vitest";
import { matchProductFromScan } from "../../src/admin/scanProductMatch";
import type { AdminProduct } from "../../src/admin/types";

function product(overrides: Partial<AdminProduct> = {}): AdminProduct {
  return {
    id: "p1",
    slug: "summer-dress",
    name: "Summer Dress",
    category: "dresses",
    price: 129.99,
    colorVariants: [],
    sizes: [],
    rating: 0,
    reviewCount: 0,
    description: "",
    details: [],
    status: "active",
    ...overrides,
  };
}

describe("matchProductFromScan: barcode (SKU) matching", () => {
  it("matches a product by exact SKU", () => {
    const products = [product({ id: "p1", sku: "8901030702" })];
    expect(matchProductFromScan(products, "8901030702")?.id).toBe("p1");
  });

  it("does not match on a partial/substring SKU (exact only, no fuzzy matching)", () => {
    const products = [product({ sku: "8901030702" })];
    expect(matchProductFromScan(products, "030702")).toBeNull();
    expect(matchProductFromScan(products, "89010307")).toBeNull();
  });

  it("returns null for a product with no SKU set (fails gracefully, not a crash)", () => {
    const products = [product({ sku: undefined })];
    expect(matchProductFromScan(products, "8901030702")).toBeNull();
  });

  it("never matches a scan against an empty-string sku", () => {
    const products = [product({ sku: "" })];
    expect(matchProductFromScan(products, "")).toBeNull();
  });

  it("returns null when nothing matches at all (unknown scan)", () => {
    const products = [product({ sku: "8901030702" }), product({ id: "p2", slug: "other" })];
    expect(matchProductFromScan(products, "not-a-real-code")).toBeNull();
  });
});

describe("matchProductFromScan: QR (slug/URL) matching", () => {
  it("matches a product by a bare slug", () => {
    const products = [product({ slug: "summer-dress" })];
    expect(matchProductFromScan(products, "summer-dress")?.id).toBe("p1");
  });

  it("matches a product from a full storefront URL encoded in a QR label", () => {
    const products = [product({ slug: "summer-dress" })];
    const scanned = "https://sisley.example.com/product/summer-dress";
    expect(matchProductFromScan(products, scanned)?.id).toBe("p1");
  });

  it("does not match a URL for an unrelated path shape", () => {
    const products = [product({ slug: "summer-dress" })];
    expect(matchProductFromScan(products, "https://sisley.example.com/categories/dresses")).toBeNull();
  });

  it("slug match wins over a SKU match when both could apply", () => {
    // Contrived, but locks in the documented precedence (slug checked first).
    const products = [product({ id: "bySlug", slug: "ABC123" }), product({ id: "bySku", slug: "different-slug", sku: "ABC123" })];
    expect(matchProductFromScan(products, "ABC123")?.id).toBe("bySlug");
  });
});

describe("matchProductFromScan: derived barcode identity (productBarcodeValue)", () => {
  it("a product with no sku is matched by scanning its slug as raw barcode text (not just as a URL/QR)", () => {
    const products = [product({ id: "p1", slug: "formal-wool-vest", sku: undefined })];
    expect(matchProductFromScan(products, "formal-wool-vest")?.id).toBe("p1");
  });

  it("a product with a manual sku is matched by its sku, not its slug", () => {
    const products = [product({ id: "p1", slug: "formal-wool-vest", sku: "NEW-CODE-1" })];
    expect(matchProductFromScan(products, "NEW-CODE-1")?.id).toBe("p1");
    // Slug still resolves too — QR labels always encode the slug-based
    // storefront URL regardless of whether a manual sku is also set.
    expect(matchProductFromScan(products, "formal-wool-vest")?.id).toBe("p1");
  });

  it("clearing a product's sku changes what raw text matches it, with no stored state", () => {
    const withSku = product({ id: "p1", slug: "formal-wool-vest", sku: "OLD-CODE" });
    expect(matchProductFromScan([withSku], "OLD-CODE")?.id).toBe("p1");

    const cleared = { ...withSku, sku: undefined };
    expect(matchProductFromScan([cleared], "OLD-CODE")).toBeNull();
    expect(matchProductFromScan([cleared], "formal-wool-vest")?.id).toBe("p1");
  });
});

describe("matchProductFromScan: recovered legacy barcode shape (2026-09-24 import)", () => {
  it("matches a real imported 6-digit numeric legacy barcode", () => {
    const products = [product({ id: "1001", slug: "some-product", sku: "101404" })];
    expect(matchProductFromScan(products, "101404")?.id).toBe("1001");
  });

  it("treats sku matching as an exact string comparison, never a numeric one -- a leading zero is never lost or ignored", () => {
    // No product in the completed import actually has a leading-zero sku
    // today (verified live: all 532 are plain 6-digit numeric strings), but
    // the matcher must still be provably safe for one, since a real garment
    // barcode could have one. matchProductFromScan/productBarcodeValue never
    // call Number()/parseInt() anywhere -- comparison is always `=== `on the
    // raw string, so "0101404" and "101404" are two different values, exactly
    // like two different real barcodes would be.
    const products = [product({ id: "a", slug: "product-a", sku: "0101404" }), product({ id: "b", slug: "product-b", sku: "101404" })];
    expect(matchProductFromScan(products, "0101404")?.id).toBe("a");
    expect(matchProductFromScan(products, "101404")?.id).toBe("b");
  });
});

describe("matchProductFromScan: multiple products", () => {
  it("picks the correct product among several candidates", () => {
    const products = [
      product({ id: "a", slug: "a-product", sku: "SKU-A" }),
      product({ id: "b", slug: "b-product", sku: "SKU-B" }),
      product({ id: "c", slug: "c-product", sku: "SKU-C" }),
    ];
    expect(matchProductFromScan(products, "SKU-B")?.id).toBe("b");
    expect(matchProductFromScan(products, "c-product")?.id).toBe("c");
  });

  it("returns null against an empty product list", () => {
    expect(matchProductFromScan([], "anything")).toBeNull();
  });
});
