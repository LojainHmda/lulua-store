import { describe, expect, it } from "vitest";
import {
  aggregateByCategory,
  aggregateByColor,
  aggregateByProduct,
  aggregateBySize,
  aggregateByZone,
  filterOrdersByZoneFragment,
  topCategories,
  topColors,
  topProducts,
  topSizes,
  topZonesByOrders,
} from "../../src/admin/assistant/aggregations";
import type { AdminOrder, OrderLine } from "../../src/admin/types";

function line(overrides: Partial<OrderLine> = {}): OrderLine {
  return { productId: "p1", variantId: "v1", name: "Product 1", qty: 1, price: 100, size: "M", color: "Black", ...overrides };
}

function order(overrides: Partial<AdminOrder> = {}): AdminOrder {
  return {
    id: Math.random().toString(36),
    orderNumber: "SIS-TEST",
    customerName: "Test Customer",
    lines: [line()],
    subtotal: 100,
    shipping: 0,
    total: 100,
    status: "delivered",
    ...overrides,
  };
}

describe("aggregateByProduct / topProducts", () => {
  it("sums qty/revenue for the same product across multiple orders (duplicate product across orders)", () => {
    const orders = [
      order({ lines: [line({ productId: "p1", qty: 2, price: 50 })] }),
      order({ lines: [line({ productId: "p1", qty: 3, price: 50 })] }),
    ];
    const agg = aggregateByProduct(orders);
    expect(agg).toHaveLength(1);
    expect(agg[0]).toMatchObject({ productId: "p1", qty: 5, revenue: 250 });
  });

  it("sums multiple lines within a single order", () => {
    const o = order({ lines: [line({ productId: "p1", qty: 1 }), line({ productId: "p2", qty: 2 })] });
    const agg = aggregateByProduct([o]);
    expect(agg.find((a) => a.productId === "p1")?.qty).toBe(1);
    expect(agg.find((a) => a.productId === "p2")?.qty).toBe(2);
  });

  it("excludes cancelled and refunded orders from the aggregation", () => {
    const orders = [
      order({ status: "delivered", lines: [line({ productId: "p1", qty: 10 })] }),
      order({ status: "cancelled", lines: [line({ productId: "p1", qty: 1000 })] }),
      order({ status: "refunded", lines: [line({ productId: "p1", qty: 1000 })] }),
    ];
    expect(aggregateByProduct(orders).find((a) => a.productId === "p1")?.qty).toBe(10);
  });

  it("returns all tied products when asking for the single top product (topN=1) and there's a tie", () => {
    const orders = [order({ lines: [line({ productId: "p1", qty: 5 })] }), order({ lines: [line({ productId: "p2", qty: 5 })] })];
    const result = topProducts(orders, 1);
    expect(result.tiedForFirst).toBe(true);
    expect(result.items.map((i) => i.productId).sort()).toEqual(["p1", "p2"]);
  });

  it("returns a single winner (not flagged as tied) when there's a clear top product", () => {
    const orders = [order({ lines: [line({ productId: "p1", qty: 9 })] }), order({ lines: [line({ productId: "p2", qty: 1 })] })];
    const result = topProducts(orders, 1);
    expect(result.tiedForFirst).toBe(false);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].productId).toBe("p1");
  });

  it("returns the top N sorted by qty descending", () => {
    const orders = [
      order({ lines: [line({ productId: "p1", qty: 1 })] }),
      order({ lines: [line({ productId: "p2", qty: 5 })] }),
      order({ lines: [line({ productId: "p3", qty: 3 })] }),
    ];
    const result = topProducts(orders, 2);
    expect(result.items.map((i) => i.productId)).toEqual(["p2", "p3"]);
  });

  it("returns empty, not an error, for zero orders", () => {
    expect(topProducts([], 5).items).toEqual([]);
  });
});

describe("aggregateByCategory / topCategories", () => {
  it("joins productId -> category via the provided lookup map", () => {
    const orders = [order({ lines: [line({ productId: "p1", qty: 2 }), line({ productId: "p2", qty: 3 })] })];
    const productById = new Map([
      ["p1", { category: "dresses" }],
      ["p2", { category: "shoes" }],
    ]);
    const { items, unknownQty } = aggregateByCategory(orders, productById);
    expect(items.find((c) => c.category === "dresses")?.qty).toBe(2);
    expect(items.find((c) => c.category === "shoes")?.qty).toBe(3);
    expect(unknownQty).toBe(0);
  });

  it("tracks missing-product lines as unknownQty rather than silently assigning a category", () => {
    const orders = [order({ lines: [line({ productId: "deleted-product", qty: 7 })] })];
    const { items, unknownQty } = aggregateByCategory(orders, new Map());
    expect(items).toEqual([]);
    expect(unknownQty).toBe(7);
  });

  it("topCategories surfaces the unknownQty alongside the ranked result", () => {
    const orders = [order({ lines: [line({ productId: "p1", qty: 2 }), line({ productId: "missing", qty: 1 })] })];
    const { result, unknownQty } = topCategories(orders, new Map([["p1", { category: "dresses" }]]), 5);
    expect(result.items).toHaveLength(1);
    expect(unknownQty).toBe(1);
  });
});

describe("aggregateByColor / topColors", () => {
  it("aggregates directly from OrderLine.color -- no product join needed", () => {
    const orders = [order({ lines: [line({ color: "Black", qty: 2 }), line({ color: "White", qty: 1 })] })];
    const { items, unknownQty } = aggregateByColor(orders);
    expect(items.find((c) => c.color === "Black")?.qty).toBe(2);
    expect(items.find((c) => c.color === "White")?.qty).toBe(1);
    expect(unknownQty).toBe(0);
  });

  it("excludes a line with a missing/blank color from aggregation and counts it as unknown", () => {
    const orders = [order({ lines: [line({ color: "", qty: 4 })] })];
    const { items, unknownQty } = aggregateByColor(orders);
    expect(items).toEqual([]);
    expect(unknownQty).toBe(4);
  });

  it("never infers a color from the product name -- only uses the stored line.color verbatim", () => {
    const orders = [order({ lines: [line({ name: "Black Evening Dress", color: "Navy", qty: 1 })] })];
    const { items } = aggregateByColor(orders);
    expect(items).toEqual([{ color: "Navy", qty: 1 }]);
  });

  it("topColors ranks correctly", () => {
    const orders = [order({ lines: [line({ color: "Black", qty: 1 }), line({ color: "Red", qty: 9 })] })];
    const { result } = topColors(orders, 1);
    expect(result.items[0].color).toBe("Red");
  });
});

describe("aggregateBySize / topSizes", () => {
  it("preserves distinct size values exactly as stored, without normalizing", () => {
    const orders = [order({ lines: [line({ size: "M", qty: 2 }), line({ size: "42", qty: 1 })] })];
    const { items } = aggregateBySize(orders);
    expect(items.find((s) => s.size === "M")?.qty).toBe(2);
    expect(items.find((s) => s.size === "42")?.qty).toBe(1);
  });

  it("sums duplicate sizes across separate lines/orders", () => {
    const orders = [order({ lines: [line({ size: "M", qty: 2 })] }), order({ lines: [line({ size: "M", qty: 3 })] })];
    const { items } = aggregateBySize(orders);
    expect(items).toEqual([{ size: "M", qty: 5 }]);
  });

  it("tracks a missing size as unknown, not merged into any real size bucket", () => {
    const orders = [order({ lines: [line({ size: "", qty: 5 })] })];
    const { items, unknownQty } = aggregateBySize(orders);
    expect(items).toEqual([]);
    expect(unknownQty).toBe(5);
  });

  it("topSizes ranks correctly", () => {
    const orders = [order({ lines: [line({ size: "S", qty: 1 }), line({ size: "L", qty: 4 })] })];
    const { result } = topSizes(orders, 1);
    expect(result.items[0].size).toBe("L");
  });
});

describe("aggregateByZone / topZonesByOrders / filterOrdersByZoneFragment", () => {
  it("aggregates order count and sales per zone from the denormalized order fields", () => {
    const orders = [
      order({ deliveryZoneId: "nablus", deliveryZoneName: "Nablus", deliveryZoneNameAr: "نابلس", total: 100 }),
      order({ deliveryZoneId: "nablus", deliveryZoneName: "Nablus", deliveryZoneNameAr: "نابلس", total: 50 }),
      order({ deliveryZoneId: "hebron", deliveryZoneName: "Hebron", deliveryZoneNameAr: "الخليل", total: 200 }),
    ];
    const { items, unknownCount } = aggregateByZone(orders);
    const nablus = items.find((z) => z.zoneKey === "nablus")!;
    expect(nablus.orderCount).toBe(2);
    expect(nablus.sales).toBe(150);
    expect(unknownCount).toBe(0);
  });

  it("treats an order with no stored zone (POS/manual/historical) as unknown, never inferred", () => {
    const orders = [order({ deliveryZoneId: undefined, deliveryZoneName: undefined, source: "pos" })];
    const { items, unknownCount } = aggregateByZone(orders);
    expect(items).toEqual([]);
    expect(unknownCount).toBe(1);
  });

  it("excludes cancelled/refunded orders from zone aggregation", () => {
    const orders = [order({ status: "cancelled", deliveryZoneId: "nablus", deliveryZoneName: "Nablus", total: 999 })];
    const { items } = aggregateByZone(orders);
    expect(items).toEqual([]);
  });

  it("topZonesByOrders ranks zones by order count", () => {
    const orders = [
      order({ deliveryZoneId: "a", deliveryZoneName: "A" }),
      order({ deliveryZoneId: "b", deliveryZoneName: "B" }),
      order({ deliveryZoneId: "b", deliveryZoneName: "B" }),
    ];
    const { result } = topZonesByOrders(orders, 1);
    expect(result.items[0].zoneKey).toBe("b");
  });

  it("filterOrdersByZoneFragment matches the English name case/diacritic-insensitively", () => {
    const orders = [order({ deliveryZoneName: "Nablus" }), order({ deliveryZoneName: "Hebron" })];
    expect(filterOrdersByZoneFragment(orders, "nablus")).toHaveLength(1);
    expect(filterOrdersByZoneFragment(orders, "NABLUS")).toHaveLength(1);
  });

  it("filterOrdersByZoneFragment matches the Arabic name, diacritic/letter-shape insensitively", () => {
    const orders = [order({ deliveryZoneName: "Nablus", deliveryZoneNameAr: "نابلس" })];
    expect(filterOrdersByZoneFragment(orders, "نابلس")).toHaveLength(1);
  });

  it("filterOrdersByZoneFragment returns nothing for an unknown zone name, never a guess", () => {
    const orders = [order({ deliveryZoneName: "Nablus" })];
    expect(filterOrdersByZoneFragment(orders, "Atlantis")).toEqual([]);
  });
});
