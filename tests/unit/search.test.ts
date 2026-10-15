import { describe, expect, it } from "vitest";
import { buildCategoryLookup, buildProductLookup } from "../../src/components/admin/orderSearch";
import {
  buildCustomerEntries,
  buildOrderEntries,
  buildProductEntries,
  matchAndRank,
  type SearchEntry,
} from "../../src/admin/search/buildIndex";
import { ORDER_CUSTOMER_SEARCH_ROLES, PRODUCT_SEARCH_ROLES } from "../../src/admin/search/useGlobalSearch";
import type { AdminCustomer, AdminOrder, AdminProduct } from "../../src/admin/types";
import type { AdminRole } from "../../src/admin/types";

// Mirrors real translation behavior closely enough for these tests:
// returns the raw key by default, except for the one key whose {n}
// placeholder substitution is actually under test.
function t(key: string): string {
  if (key === "admin.search.ordersCount") return "{n} orders";
  return key;
}

function product(overrides: Partial<AdminProduct> = {}): AdminProduct {
  return {
    id: "p1",
    slug: "test-dress",
    name: "Summer Dress",
    nameAr: "فستان صيفي",
    category: "dresses",
    price: 129.99,
    colorVariants: [{ id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "M", qty: 5 }] }],
    sizes: ["M"],
    rating: 0,
    reviewCount: 0,
    description: "",
    details: [],
    status: "active",
    ...overrides,
  };
}

function order(overrides: Partial<AdminOrder> = {}): AdminOrder {
  return {
    id: "o1",
    orderNumber: "SIS-ABC123",
    customerName: "Maria Khoury",
    customerEmail: "maria@example.com",
    customerPhone: "+972-50-123-4567",
    lines: [],
    subtotal: 100,
    shipping: 0,
    total: 100,
    status: "pending",
    ...overrides,
  };
}

function customer(overrides: Partial<AdminCustomer> = {}): AdminCustomer {
  return {
    id: "c1",
    name: "Layla Ahmad",
    email: "layla@example.com",
    phone: "0501234567",
    ordersCount: 2,
    totalSpent: 200,
    ...overrides,
  };
}

const emptyLookups = { products: buildProductLookup([]), categories: buildCategoryLookup([]) };

describe("search: Arabic/English text normalization (via product name matching)", () => {
  it("matches an Arabic name including tashkeel/diacritics differences", () => {
    const p = product({ nameAr: "فُسْتَان صَيْفِي" });
    const entries = buildProductEntries([p], buildCategoryLookup([]), "ar", t);
    const result = matchAndRank(entries, "فستان صيفي", 10);
    expect(result.items).toHaveLength(1);
  });

  it("matches regardless of case for English text", () => {
    const entries = buildProductEntries([product({ name: "Summer Dress" })], buildCategoryLookup([]), "en", t);
    expect(matchAndRank(entries, "SUMMER", 10).items).toHaveLength(1);
    expect(matchAndRank(entries, "summer", 10).items).toHaveLength(1);
  });

  it("ignores punctuation/dash differences", () => {
    const entries = buildOrderEntries([order({ orderNumber: "SIS-ABC123" })], emptyLookups.products, emptyLookups.categories, t);
    expect(matchAndRank(entries, "sis abc123", 10).items).toHaveLength(1);
    expect(matchAndRank(entries, "SIS-ABC123", 10).items).toHaveLength(1);
  });

  it("matches on partial/prefix text", () => {
    const entries = buildProductEntries([product({ name: "Summer Dress" })], buildCategoryLookup([]), "en", t);
    expect(matchAndRank(entries, "Sum", 10).items).toHaveLength(1);
  });

  it("ranks an all-tokens-present match above a match with only some tokens present, and excludes a query where nothing matches at all", () => {
    const entries = buildProductEntries([product({ name: "Summer Dress", category: "dresses" })], buildCategoryLookup([]), "en", t);
    const all = matchAndRank(entries, "summer dress", 10);
    const partial = matchAndRank(entries, "summer parachute", 10); // "summer" matches, "parachute" doesn't
    const none = matchAndRank(entries, "parachute submarine", 10); // neither word matches anything
    expect(all.items).toHaveLength(1);
    expect(partial.items).toHaveLength(1); // still surfaced (weaker tier), not dropped entirely
    expect(none.items).toHaveLength(0);
  });
});

describe("search: SKU/barcode — exact and prefix only, never fuzzy", () => {
  it("ranks an exact SKU match above a name substring match", () => {
    const entries = buildProductEntries(
      [product({ id: "p1", name: "Blue Jeans", sku: "8901030702" }), product({ id: "p2", name: "8901030702 Special Edition" })],
      buildCategoryLookup([]),
      "en",
      t
    );
    const result = matchAndRank(entries, "8901030702", 10);
    expect(result.items[0].id).toBe("product:p1"); // exact SKU beats a name that merely contains the digits
  });

  it("matches a SKU prefix", () => {
    const entries = buildProductEntries([product({ sku: "8901030702" })], buildCategoryLookup([]), "en", t);
    expect(matchAndRank(entries, "89010307", 10).items).toHaveLength(1);
  });

  it("does NOT fuzzy/substring-match a SKU from the middle", () => {
    const entries = buildProductEntries([product({ sku: "8901030702" })], buildCategoryLookup([]), "en", t);
    // "030702" is a real substring of the SKU but not a prefix — must not match via the SKU at all.
    const result = matchAndRank(entries, "030702", 10);
    expect(result.items).toHaveLength(0);
  });
});

describe("search: order number — exact/prefix priority, partial preserved", () => {
  it("ranks an exact order-number match above a customer-name match", () => {
    const entries = buildOrderEntries(
      [order({ id: "o1", orderNumber: "SIS-ABC123", customerName: "Someone Else" }), order({ id: "o2", orderNumber: "SIS-XYZ999", customerName: "SIS-ABC123 Fan Club" })],
      emptyLookups.products,
      emptyLookups.categories,
      t
    );
    const result = matchAndRank(entries, "SIS-ABC123", 10);
    expect(result.items[0].id).toBe("order:o1");
  });

  it("still matches an order number as a partial/substring token (existing orderSearch.ts behavior preserved)", () => {
    const entries = buildOrderEntries([order({ orderNumber: "SIS-MTBP39X4" })], emptyLookups.products, emptyLookups.categories, t);
    expect(matchAndRank(entries, "mtbp39x4", 10).items).toHaveLength(1);
  });
});

describe("search: phone number normalization", () => {
  const phoneOrder = order({ customerPhone: "+972-50-123-4567" });

  it("matches across different formatting of the same number", () => {
    const entries = buildOrderEntries([phoneOrder], emptyLookups.products, emptyLookups.categories, t);
    expect(matchAndRank(entries, "+972-50-123-4567", 10).items).toHaveLength(1);
    expect(matchAndRank(entries, "050-123-4567", 10).items).toHaveLength(1);
    expect(matchAndRank(entries, "0501234567", 10).items).toHaveLength(1);
  });

  it("matches a customer by phone in a different format than stored", () => {
    const entries = buildCustomerEntries([customer({ phone: "0501234567" })], t);
    const result = matchAndRank(entries, "+972-50-123-4567", 10);
    expect(result.items).toHaveLength(1);
  });

  it("ranks a confident (long) phone match as an exact identifier, above a short/partial digit match elsewhere", () => {
    const entries = buildCustomerEntries(
      [customer({ id: "c1", name: "Target Customer", phone: "0501234567" }), customer({ id: "c2", name: "Customer 123", phone: "0559998888" })],
      t
    );
    const result = matchAndRank(entries, "0501234567", 10);
    expect(result.items[0].id).toBe("customer:c1");
  });

  it("does not give a too-short numeric query the strong phone-identifier tier", () => {
    // "exact" is literally named "05" (an exact title match, tier 5).
    // "other" only has "05" appearing inside their phone number, which is
    // below the phone-tier's own minimum digit count — if that were
    // incorrectly promoted to the identifier tier (6), it would outrank
    // "exact"; it must not.
    const entries = buildCustomerEntries(
      [customer({ id: "exact", name: "05", phone: "0559998888" }), customer({ id: "other", name: "Someone Else", phone: "0501234567" })],
      t
    );
    const result = matchAndRank(entries, "05", 10);
    expect(result.items[0].id).toBe("customer:exact");
  });

  it("does not treat a non-phone query with trailing digits as a phone search (regression)", () => {
    // Found via live QA: normalizePhoneDigits() strips everything down to
    // "123" for a query like this, which then false-positive matched any
    // customer/order whose phone happened to contain "123" anywhere.
    const entries = buildCustomerEntries([customer({ name: "Someone", phone: "0501234567" })], t);
    const result = matchAndRank(entries, "zzzzznonexistentqueryxyz123", 10);
    expect(result.items).toHaveLength(0);
  });

  it("still treats a query as phone-like when it's only digits plus common phone punctuation", () => {
    const entries = buildCustomerEntries([customer({ name: "Someone", phone: "0501234567" })], t);
    expect(matchAndRank(entries, "+972 (050) 123-4567", 10).items).toHaveLength(1);
  });
});

describe("search: ranking order end-to-end", () => {
  it("orders exact > prefix > all-tokens > partial-tokens", () => {
    const entries: SearchEntry[] = [
      { id: "partial", type: "product", title: "A", timestamp: 0, identifierMatches: [], titleMatches: [], phones: [], blob: "red shoes" },
      { id: "allTokens", type: "product", title: "B", timestamp: 0, identifierMatches: [], titleMatches: [], phones: [], blob: "red shirt medium" },
      { id: "prefix", type: "product", title: "Red Shirt Deluxe", timestamp: 0, identifierMatches: [], titleMatches: ["red shirt deluxe"], phones: [], blob: "red shirt deluxe" },
      { id: "exactTitle", type: "product", title: "Red Shirt", timestamp: 0, identifierMatches: [], titleMatches: ["red shirt"], phones: [], blob: "red shirt" },
      { id: "exactIdentifier", type: "product", title: "Unrelated", timestamp: 0, identifierMatches: ["red shirt"], titleMatches: [], phones: [], blob: "unrelated" },
    ];
    const result = matchAndRank(entries, "red shirt", 10);
    expect(result.items.map((e) => e.id)).toEqual(["exactIdentifier", "exactTitle", "prefix", "allTokens", "partial"]);
  });

  it("breaks ties within the same tier by recency (newer first)", () => {
    const entries: SearchEntry[] = [
      { id: "older", type: "order", title: "Order", timestamp: 1000, identifierMatches: [], titleMatches: [], phones: [], blob: "test order" },
      { id: "newer", type: "order", title: "Order", timestamp: 2000, identifierMatches: [], titleMatches: [], phones: [], blob: "test order" },
    ];
    const result = matchAndRank(entries, "test order", 10);
    expect(result.items.map((e) => e.id)).toEqual(["newer", "older"]);
  });

  it("caps results at the given limit but reports the true total", () => {
    const entries: SearchEntry[] = Array.from({ length: 8 }, (_, i) => ({
      id: `p${i}`,
      type: "product" as const,
      title: `Product ${i}`,
      timestamp: 0,
      identifierMatches: [],
      titleMatches: [],
      phones: [],
      blob: "widget",
    }));
    const result = matchAndRank(entries, "widget", 5);
    expect(result.items).toHaveLength(5);
    expect(result.total).toBe(8);
  });

  it("returns nothing for an empty query", () => {
    const entries = buildProductEntries([product()], buildCategoryLookup([]), "en", t);
    expect(matchAndRank(entries, "", 10).items).toHaveLength(0);
    expect(matchAndRank(entries, "   ", 10).items).toHaveLength(0);
  });
});

describe("search: customer result shows order info already on the doc (no extra reads)", () => {
  it("includes an orders-count amount label when the customer has past orders", () => {
    const entries = buildCustomerEntries([customer({ ordersCount: 3 })], t);
    expect(entries[0].amountLabel).toContain("3");
  });

  it("omits the amount label for a customer with no orders yet", () => {
    const entries = buildCustomerEntries([customer({ ordersCount: 0 })], t);
    expect(entries[0].amountLabel).toBeUndefined();
  });
});

describe("search permissions: which roles can search which entity types", () => {
  const ALL_ROLES: AdminRole[] = ["owner", "admin", "editor", "viewer", "cashier"];

  it("lets owner and admin search both products and orders/customers", () => {
    expect(PRODUCT_SEARCH_ROLES).toContain("owner");
    expect(PRODUCT_SEARCH_ROLES).toContain("admin");
    expect(ORDER_CUSTOMER_SEARCH_ROLES).toContain("owner");
    expect(ORDER_CUSTOMER_SEARCH_ROLES).toContain("admin");
  });

  it("lets editor search products but not orders/customers", () => {
    expect(PRODUCT_SEARCH_ROLES).toContain("editor");
    expect(ORDER_CUSTOMER_SEARCH_ROLES).not.toContain("editor");
  });

  it("excludes viewer from both order/customer search and product search (matches the exact route guards, not just the broader Firestore read rule)", () => {
    expect(PRODUCT_SEARCH_ROLES).not.toContain("viewer");
    expect(ORDER_CUSTOMER_SEARCH_ROLES).not.toContain("viewer");
  });

  it("includes cashier in the order/customer permission (matches isCashierOrAbove()), even though no UI currently invokes it for that role", () => {
    expect(ORDER_CUSTOMER_SEARCH_ROLES).toContain("cashier");
    expect(PRODUCT_SEARCH_ROLES).not.toContain("cashier");
  });

  it("never grants a role neither list explicitly names", () => {
    for (const role of ALL_ROLES) {
      const inProduct = PRODUCT_SEARCH_ROLES.includes(role);
      const inOrders = ORDER_CUSTOMER_SEARCH_ROLES.includes(role);
      if (role === "owner" || role === "admin") {
        expect(inProduct && inOrders).toBe(true);
      }
      if (role === "viewer") {
        expect(inProduct || inOrders).toBe(false);
      }
    }
  });
});
