import { describe, expect, it } from "vitest";
import {
  compareSales,
  computeConfirmedSalesTotals,
  computeSalesTotals,
  computeStatusBreakdown,
  countByStatus,
  isConfirmedSale,
  isIncludedInSales,
  totalUnitsSold,
} from "../../src/admin/assistant/salesCalculations";
import type { AdminOrder, OrderStatus } from "../../src/admin/types";

function order(overrides: Partial<AdminOrder> = {}): AdminOrder {
  return {
    id: Math.random().toString(36),
    orderNumber: "SIS-TEST",
    customerName: "Test Customer",
    lines: [{ productId: "p1", variantId: "v1", name: "Product", qty: 1, price: 100, size: "M", color: "Black" }],
    subtotal: 100,
    shipping: 0,
    total: 100,
    status: "pending",
    ...overrides,
  };
}

describe("isIncludedInSales / isConfirmedSale", () => {
  it("(pending/processing/ready/shipped/delivered/completed included) each counts toward sales", () => {
    const included: OrderStatus[] = ["pending", "processing", "ready", "shipped", "delivered", "completed"];
    for (const status of included) {
      expect(isIncludedInSales(order({ status }))).toBe(true);
    }
  });

  it("(cancelled excluded) does not count toward sales", () => {
    expect(isIncludedInSales(order({ status: "cancelled" }))).toBe(false);
  });

  it("(refunded excluded) does not count toward sales", () => {
    expect(isIncludedInSales(order({ status: "refunded" }))).toBe(false);
  });

  it("only delivered/completed count as confirmed sales", () => {
    expect(isConfirmedSale(order({ status: "delivered" }))).toBe(true);
    expect(isConfirmedSale(order({ status: "completed" }))).toBe(true);
    for (const status of ["pending", "processing", "ready", "shipped", "cancelled", "refunded"] as OrderStatus[]) {
      expect(isConfirmedSale(order({ status }))).toBe(false);
    }
  });
});

describe("computeSalesTotals", () => {
  it("sums order.total (already net of discount, already including shipping) across included statuses only", () => {
    const orders = [
      order({ status: "pending", total: 100 }),
      order({ status: "processing", total: 50 }),
      order({ status: "ready", total: 75 }),
      order({ status: "shipped", total: 200 }),
      order({ status: "delivered", total: 30 }),
      order({ status: "completed", total: 20 }),
      order({ status: "cancelled", total: 9999 }),
      order({ status: "refunded", total: 9999 }),
    ];
    const totals = computeSalesTotals(orders);
    expect(totals.totalSales).toBe(100 + 50 + 75 + 200 + 30 + 20);
    expect(totals.orderCount).toBe(6);
    expect(totals.averageOrderValue).toBeCloseTo((100 + 50 + 75 + 200 + 30 + 20) / 6);
  });

  it("returns 0/0/null for an empty order list -- never divides by zero", () => {
    const totals = computeSalesTotals([]);
    expect(totals.totalSales).toBe(0);
    expect(totals.orderCount).toBe(0);
    expect(totals.averageOrderValue).toBeNull();
  });

  it("returns null averageOrderValue (not NaN, not 0) when every order is excluded", () => {
    const totals = computeSalesTotals([order({ status: "cancelled" }), order({ status: "refunded" })]);
    expect(totals.orderCount).toBe(0);
    expect(totals.averageOrderValue).toBeNull();
  });

  it("a discounted order's total already reflects the discount -- summing total is correct without re-subtracting anything", () => {
    // subtotal 100, discount 20, shipping 10 -> total is already 90.
    const o = order({ subtotal: 100, discount: 20, shipping: 10, total: 90 });
    expect(computeSalesTotals([o]).totalSales).toBe(90);
  });

  it("shipping is included in the summed figure because it's already part of order.total", () => {
    const o = order({ subtotal: 100, shipping: 25, total: 125 });
    expect(computeSalesTotals([o]).totalSales).toBe(125);
  });
});

describe("computeConfirmedSalesTotals", () => {
  it("only sums delivered/completed orders, excluding everything else including shipped", () => {
    const orders = [
      order({ status: "shipped", total: 500 }),
      order({ status: "delivered", total: 40 }),
      order({ status: "completed", total: 60 }),
    ];
    const totals = computeConfirmedSalesTotals(orders);
    expect(totals.totalSales).toBe(100);
    expect(totals.orderCount).toBe(2);
  });
});

describe("countByStatus / computeStatusBreakdown", () => {
  it("counts each status independently, including zero counts", () => {
    const orders = [order({ status: "pending" }), order({ status: "pending" }), order({ status: "ready" })];
    expect(countByStatus(orders, "pending")).toBe(2);
    expect(countByStatus(orders, "ready")).toBe(1);
    expect(countByStatus(orders, "shipped")).toBe(0);
    const breakdown = computeStatusBreakdown(orders);
    expect(breakdown).toEqual({ pending: 2, processing: 0, ready: 1, shipped: 0, delivered: 0, cancelled: 0, refunded: 0, completed: 0 });
  });
});

describe("compareSales", () => {
  it("computes a plain arithmetic difference and percent change, never an evaluative label", () => {
    const a = [order({ status: "delivered", total: 150 })];
    const b = [order({ status: "delivered", total: 100 })];
    const cmp = compareSales(a, b);
    expect(cmp.salesDifference).toBe(50);
    expect(cmp.salesPercentChange).toBeCloseTo(0.5);
    expect(cmp.orderCountDifference).toBe(0);
    expect(Object.keys(cmp)).not.toContain("verdict");
  });

  it("returns null percent change when the baseline period has zero sales -- never divides by zero", () => {
    const a = [order({ status: "delivered", total: 150 })];
    const cmp = compareSales(a, []);
    expect(cmp.salesPercentChange).toBeNull();
    expect(cmp.salesDifference).toBe(150);
  });
});

describe("totalUnitsSold", () => {
  it("sums line quantities across included orders only", () => {
    const orders = [
      order({ status: "delivered", lines: [{ productId: "p1", variantId: "v1", name: "A", qty: 3, price: 10, size: "M", color: "Black" }] }),
      order({ status: "delivered", lines: [{ productId: "p2", variantId: "v2", name: "B", qty: 2, price: 5, size: "S", color: "White" }] }),
      order({ status: "cancelled", lines: [{ productId: "p3", variantId: "v3", name: "C", qty: 100, price: 1, size: "L", color: "Red" }] }),
    ];
    expect(totalUnitsSold(orders)).toBe(5);
  });

  it("sums multiple lines within a single order", () => {
    const o = order({
      status: "delivered",
      lines: [
        { productId: "p1", variantId: "v1", name: "A", qty: 2, price: 10, size: "M", color: "Black" },
        { productId: "p1", variantId: "v2", name: "A", qty: 1, price: 10, size: "L", color: "Black" },
      ],
    });
    expect(totalUnitsSold([o])).toBe(3);
  });

  it("returns 0 for an empty list", () => {
    expect(totalUnitsSold([])).toBe(0);
  });
});
