import { describe, expect, it } from "vitest";
import { productBarcodeValue } from "../../src/admin/productBarcode";

describe("productBarcodeValue", () => {
  it("uses the manual sku when present", () => {
    expect(productBarcodeValue({ sku: "8901030702", slug: "summer-dress" })).toBe("8901030702");
  });

  it("trims a manual sku before using it", () => {
    expect(productBarcodeValue({ sku: "  8901030702  ", slug: "summer-dress" })).toBe("8901030702");
  });

  it("falls back to the slug when sku is undefined", () => {
    expect(productBarcodeValue({ sku: undefined, slug: "summer-dress" })).toBe("summer-dress");
  });

  it("falls back to the slug when sku is an empty string", () => {
    expect(productBarcodeValue({ sku: "", slug: "summer-dress" })).toBe("summer-dress");
  });

  it("falls back to the slug when sku is only whitespace", () => {
    expect(productBarcodeValue({ sku: "   ", slug: "summer-dress" })).toBe("summer-dress");
  });

  it("is a pure derivation — the same input always yields the same output, nothing stored", () => {
    const product = { sku: undefined, slug: "formal-wool-vest" };
    expect(productBarcodeValue(product)).toBe(productBarcodeValue(product));
  });
});
