import { describe, expect, it } from "vitest";
import {
  classifyCustomerIdentifier,
  matchOrdersByNumberFragment,
  phoneQueryVariants,
  resolveOrderByFragment,
  resolveProductByQuery,
} from "../../src/admin/assistant/entityResolution";
import type { AdminProduct } from "../../src/admin/types";

describe("matchOrdersByNumberFragment / resolveOrderByFragment", () => {
  const orders = [
    { id: "o1", orderNumber: "SIS-MT1FREUU" },
    { id: "o2", orderNumber: "SIS-6556AB" },
    { id: "o3", orderNumber: "SIS-6556CD" },
  ];

  it("matches a real, unique order number fragment", () => {
    const resolved = resolveOrderByFragment(orders, "MT1FREUU");
    expect(resolved.kind).toBe("resolved");
    if (resolved.kind === "resolved") expect(resolved.value.id).toBe("o1");
  });

  it("is case-insensitive", () => {
    const resolved = resolveOrderByFragment(orders, "mt1freuu");
    expect(resolved.kind).toBe("resolved");
  });

  it("returns not_found for an unknown order number, never a guess", () => {
    expect(resolveOrderByFragment(orders, "9999999").kind).toBe("not_found");
  });

  it("returns ambiguous when a fragment matches more than one order", () => {
    const resolved = resolveOrderByFragment(orders, "6556");
    expect(resolved.kind).toBe("ambiguous");
    if (resolved.kind === "ambiguous") expect(resolved.candidates).toHaveLength(2);
  });

  it("refuses a too-short fragment (avoids over-broad accidental matches)", () => {
    expect(matchOrdersByNumberFragment(orders, "55")).toEqual([]);
  });
});

describe("classifyCustomerIdentifier", () => {
  it("recognizes an exact email", () => {
    expect(classifyCustomerIdentifier("sara@example.com")).toEqual({ kind: "email", value: "sara@example.com" });
  });

  it("normalizes email casing/whitespace", () => {
    expect(classifyCustomerIdentifier("  Sara@Example.com  ")).toEqual({ kind: "email", value: "sara@example.com" });
  });

  it("recognizes a phone number (7+ digits) when no email is present", () => {
    expect(classifyCustomerIdentifier("0501234567")).toEqual({ kind: "phone", value: "0501234567" });
  });

  it("recognizes a phone number embedded in a sentence", () => {
    expect(classifyCustomerIdentifier("customer 050-123-4567 orders")).toEqual({ kind: "phone", value: "0501234567" });
  });

  it("treats a bare name as insufficient -- never matches a customer by name alone", () => {
    expect(classifyCustomerIdentifier("Sara")).toEqual({ kind: "insufficient" });
    expect(classifyCustomerIdentifier("سارة")).toEqual({ kind: "insufficient" });
  });

  it("treats a short numeric fragment (fewer than 7 digits) as insufficient, not a phone", () => {
    expect(classifyCustomerIdentifier("12345")).toEqual({ kind: "insufficient" });
  });
});

describe("phoneQueryVariants", () => {
  it("includes the input digits themselves", () => {
    expect(phoneQueryVariants("0501234567")).toContain("0501234567");
  });

  it("includes the leading-zero-stripped variant for a local-format number", () => {
    expect(phoneQueryVariants("0501234567")).toContain("501234567");
  });

  it("includes a leading-zero-added variant for a number with no leading zero", () => {
    expect(phoneQueryVariants("501234567")).toContain("0501234567");
  });

  it("includes a 972-country-code-prefixed variant", () => {
    const variants = phoneQueryVariants("0501234567");
    expect(variants).toContain("972501234567");
  });

  it("never produces more than a small, bounded set of variants", () => {
    expect(phoneQueryVariants("0501234567").length).toBeLessThanOrEqual(4);
  });
});

function product(overrides: Partial<AdminProduct> = {}): AdminProduct {
  return {
    id: "p1",
    slug: "essential-black-dress",
    name: "Essential Black Dress",
    category: "dresses",
    price: 129.99,
    colorVariants: [],
    sizes: ["S", "M", "L"],
    rating: 0,
    reviewCount: 0,
    description: "",
    details: [],
    status: "active",
    ...overrides,
  };
}

describe("resolveProductByQuery", () => {
  it("resolves an exact product id", () => {
    const products = [product({ id: "p1" }), product({ id: "p2", slug: "other" })];
    const resolved = resolveProductByQuery(products, "p1");
    expect(resolved.kind).toBe("resolved");
    if (resolved.kind === "resolved") expect(resolved.value.id).toBe("p1");
  });

  it("resolves an exact slug/SKU via the existing barcode matching chain", () => {
    const products = [product({ id: "p1", slug: "essential-black-dress" })];
    const resolved = resolveProductByQuery(products, "essential-black-dress");
    expect(resolved.kind).toBe("resolved");
  });

  it("resolves a unique textual name match", () => {
    const products = [product({ id: "p1", name: "Essential Black Dress" }), product({ id: "p2", name: "Summer Sandals" })];
    const resolved = resolveProductByQuery(products, "black dress");
    expect(resolved.kind).toBe("resolved");
    if (resolved.kind === "resolved") expect(resolved.value.id).toBe("p1");
  });

  it("reports ambiguous when multiple products match the same text", () => {
    const products = [product({ id: "p1", name: "Black Dress A" }), product({ id: "p2", name: "Black Dress B" })];
    const resolved = resolveProductByQuery(products, "black dress");
    expect(resolved.kind).toBe("ambiguous");
    if (resolved.kind === "ambiguous") expect(resolved.candidates).toHaveLength(2);
  });

  it("returns not_found for a query matching no product, never a guess", () => {
    const products = [product({ id: "p1", name: "Essential Black Dress" })];
    expect(resolveProductByQuery(products, "nonexistent product xyz").kind).toBe("not_found");
  });

  it("matches via the Arabic name too", () => {
    const products = [product({ id: "p1", name: "Essential Black Dress", nameAr: "فستان أسود أساسي" })];
    const resolved = resolveProductByQuery(products, "فستان أسود");
    expect(resolved.kind).toBe("resolved");
  });
});
