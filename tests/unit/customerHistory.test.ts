import { describe, expect, it } from "vitest";
import { findGuestPossibleMatches, summarizeCustomerHistory } from "../../src/admin/customerHistory";
import type { AdminOrder, AdminReturn } from "../../src/admin/types";

let seq = 0;
function order(overrides: Partial<AdminOrder> = {}): AdminOrder {
  seq += 1;
  return {
    id: `order-${seq}`,
    orderNumber: `SIS-${seq}`,
    customerName: "Test Customer",
    customerEmail: "test@example.com",
    lines: [{ productId: "p1", variantId: "v1", name: "Item", qty: 1, price: 100, size: "M", color: "Black" }],
    subtotal: 100,
    shipping: 0,
    total: 100,
    status: "pending",
    createdAt: { toDate: () => new Date("2026-01-01T00:00:00Z") },
    ...overrides,
  };
}

function ret(overrides: Partial<AdminReturn> = {}): AdminReturn {
  seq += 1;
  return {
    id: `return-${seq}`,
    orderId: "order-1",
    orderNumber: "SIS-1",
    customerName: "Test Customer",
    customerEmail: "test@example.com",
    productId: "p1",
    productName: "Item",
    variantId: "v1",
    colorName: "Black",
    size: "M",
    qty: 1,
    reason: "defective",
    status: "quarantine",
    disposition: null,
    processedBy: "admin@example.com",
    processedByName: "admin",
    restocked: false,
    ...overrides,
  };
}

describe("summarizeCustomerHistory", () => {
  it("1. a new customer with no previous orders returns an all-empty summary", () => {
    const summary = summarizeCustomerHistory([], null);
    expect(summary.totalOrders).toBe(0);
    expect(summary.successfulCount).toBe(0);
    expect(summary.successfulSpend).toBe(0);
    expect(summary.averageSuccessfulOrderValue).toBeNull();
    expect(summary.firstOrderAt).toBeNull();
    expect(summary.lastOrderAt).toBeNull();
    expect(summary.isRepeatCustomer).toBe(false);
    expect(summary.cancellationRatio).toBeNull();
    expect(summary.returnedOrderCount).toBeNull();
  });

  it("2. a customer with multiple successful orders counts and sums them correctly", () => {
    const orders = [
      order({ status: "delivered", total: 150 }),
      order({ status: "completed", total: 250 }),
      order({ status: "delivered", total: 100 }),
    ];
    const summary = summarizeCustomerHistory(orders, []);
    expect(summary.totalOrders).toBe(3);
    expect(summary.successfulCount).toBe(3);
    expect(summary.successfulSpend).toBe(500);
  });

  it("3. cancelled orders are counted separately and excluded from successful spend", () => {
    const orders = [order({ status: "cancelled", total: 999 }), order({ status: "delivered", total: 100 })];
    const summary = summarizeCustomerHistory(orders, []);
    expect(summary.cancelledCount).toBe(1);
    expect(summary.successfulCount).toBe(1);
    expect(summary.successfulSpend).toBe(100);
  });

  it("4. pending/processing orders count toward total but never toward successful", () => {
    const orders = [order({ status: "pending", total: 100 }), order({ status: "processing", total: 200 })];
    const summary = summarizeCustomerHistory(orders, []);
    expect(summary.totalOrders).toBe(2);
    expect(summary.successfulCount).toBe(0);
    expect(summary.successfulSpend).toBe(0);
    expect(summary.statusCounts.pending).toBe(1);
    expect(summary.statusCounts.processing).toBe(1);
  });

  it("5. non-delivery flagged orders are counted", () => {
    const orders = [order({ nonDeliveryFlagged: true }), order({ nonDeliveryFlagged: true }), order()];
    const summary = summarizeCustomerHistory(orders, []);
    expect(summary.nonDeliveryFlaggedCount).toBe(2);
  });

  it("6. returned order count dedupes multiple return records for the same order", () => {
    const orders = [order({ id: "order-1", status: "delivered" })];
    const returns = [ret({ orderId: "order-1" }), ret({ orderId: "order-1" }), ret({ orderId: "order-9" })];
    const summary = summarizeCustomerHistory(orders, returns);
    expect(summary.returnedOrderCount).toBe(2);
  });

  it("7. successful spend uses order.total, not subtotal (discount/shipping already applied)", () => {
    const orders = [order({ status: "completed", subtotal: 200, discount: 50, shipping: 20, total: 170 })];
    const summary = summarizeCustomerHistory(orders, []);
    expect(summary.successfulSpend).toBe(170);
  });

  it("8. average successful order value divides spend by successful count only", () => {
    const orders = [
      order({ status: "delivered", total: 100 }),
      order({ status: "completed", total: 300 }),
      order({ status: "cancelled", total: 9999 }),
    ];
    const summary = summarizeCustomerHistory(orders, []);
    expect(summary.averageSuccessfulOrderValue).toBe(200);
  });

  it("9. first/last order dates are derived correctly from mixed createdAt shapes", () => {
    const orders = [
      order({ createdAt: { toDate: () => new Date("2026-03-01T00:00:00Z") } }),
      order({ createdAt: { toDate: () => new Date("2026-01-15T00:00:00Z") } }),
      order({ createdAt: { toDate: () => new Date("2026-02-10T00:00:00Z") } }),
    ];
    const summary = summarizeCustomerHistory(orders, []);
    expect(summary.firstOrderAt?.toISOString()).toBe(new Date("2026-01-15T00:00:00Z").toISOString());
    expect(summary.lastOrderAt?.toISOString()).toBe(new Date("2026-03-01T00:00:00Z").toISOString());
  });

  it("10. repeat-customer detection: zero prior orders is not a repeat, one or more is", () => {
    expect(summarizeCustomerHistory([], null).isRepeatCustomer).toBe(false);
    expect(summarizeCustomerHistory([order()], null).isRepeatCustomer).toBe(true);
  });

  it("11. cancellation ratio is a simple fraction of total orders", () => {
    const orders = [order({ status: "cancelled" }), order({ status: "cancelled" }), order({ status: "delivered" }), order({ status: "pending" })];
    const summary = summarizeCustomerHistory(orders, []);
    expect(summary.cancellationRatio).toBe(0.5);
  });

  it("12. mixed order statuses produce a fully correct combined summary", () => {
    const orders = [
      order({ status: "pending", total: 100 }),
      order({ status: "processing", total: 100 }),
      order({ status: "shipped", total: 100 }),
      order({ status: "delivered", total: 200 }),
      order({ status: "completed", total: 300 }),
      order({ status: "cancelled", total: 400 }),
      order({ status: "refunded", total: 500 }),
    ];
    const summary = summarizeCustomerHistory(orders, []);
    expect(summary.totalOrders).toBe(7);
    expect(summary.successfulCount).toBe(2);
    expect(summary.successfulSpend).toBe(500);
    expect(summary.cancelledCount).toBe(1);
    expect(Object.values(summary.statusCounts).reduce((a, b) => a + (b ?? 0), 0)).toBe(7);
  });

  it("15. missing/incomplete order fields (no createdAt, no email/phone) don't break the calculation", () => {
    const sparse: AdminOrder = {
      id: "sparse-1",
      orderNumber: "SIS-SPARSE",
      customerName: "Sparse Customer",
      lines: [],
      subtotal: 0,
      shipping: 0,
      total: 0,
      status: "pending",
    };
    expect(() => summarizeCustomerHistory([sparse], null)).not.toThrow();
    const summary = summarizeCustomerHistory([sparse], null);
    expect(summary.totalOrders).toBe(1);
    expect(summary.firstOrderAt).toBeNull();
    expect(summary.lastOrderAt).toBeNull();
  });

  it("16. duplicate/unusual order line items never affect the calculation (only status/total/createdAt/nonDeliveryFlagged matter)", () => {
    const weirdLines = order({
      status: "delivered",
      total: 100,
      lines: [
        { productId: "p1", variantId: "v1", name: "Item", qty: 3, price: 10, size: "M", color: "Black" },
        { productId: "p1", variantId: "v1", name: "Item", qty: 3, price: 10, size: "M", color: "Black" },
      ],
    });
    const emptyLines = order({ status: "delivered", total: 50, lines: [] });
    const summary = summarizeCustomerHistory([weirdLines, emptyLines], []);
    expect(summary.totalOrders).toBe(2);
    expect(summary.successfulCount).toBe(2);
    expect(summary.successfulSpend).toBe(150);
  });

  it("is a pure function -- does not mutate its inputs", () => {
    const orders = [order({ status: "delivered" })];
    const returns = [ret()];
    const ordersSnapshot = JSON.stringify(orders);
    const returnsSnapshot = JSON.stringify(returns);
    summarizeCustomerHistory(orders, returns);
    expect(JSON.stringify(orders)).toBe(ordersSnapshot);
    expect(JSON.stringify(returns)).toBe(returnsSnapshot);
  });
});

describe("findGuestPossibleMatches", () => {
  it("13a. matches on exact normalized email (case/whitespace tolerant)", () => {
    const candidates = [order({ id: "g1", customerEmail: "  John@Example.com  " })];
    const matches = findGuestPossibleMatches(candidates, { email: "john@example.com" }, "current-order");
    expect(matches).toHaveLength(1);
    expect(matches[0].matchedBy).toBe("email");
    expect(matches[0].order.id).toBe("g1");
  });

  it("13b. matches on phone via the existing phoneNumbersLikelyMatch tolerance for format differences", () => {
    const candidates = [order({ id: "g2", customerEmail: "someone-else@example.com", customerPhone: "0501234567" })];
    const matches = findGuestPossibleMatches(candidates, { phone: "+972-50-123-4567" }, "current-order");
    expect(matches).toHaveLength(1);
    expect(matches[0].matchedBy).toBe("phone");
  });

  it("13c. no match when neither email nor phone correspond", () => {
    const candidates = [order({ id: "g3", customerEmail: "nobody@example.com", customerPhone: "0559999999" })];
    const matches = findGuestPossibleMatches(candidates, { email: "different@example.com", phone: "0501234567" }, "current-order");
    expect(matches).toHaveLength(0);
  });

  it("13d. email match takes priority over a coincidental non-match on phone", () => {
    const candidates = [order({ id: "g4", customerEmail: "match@example.com", customerPhone: "0000000000" })];
    const matches = findGuestPossibleMatches(candidates, { email: "match@example.com", phone: "9999999999" }, "current-order");
    expect(matches).toHaveLength(1);
    expect(matches[0].matchedBy).toBe("email");
  });

  it("14. never labels a match as confirmed identity -- matchedBy is always 'email' or 'phone', never a stronger claim, and name is never consulted", () => {
    // Same name, deliberately different (non-matching) email and phone --
    // a name-only similarity must never produce a match on its own.
    const candidates = [order({ id: "g5", customerName: "Ahmad Ali", customerEmail: "unrelated@example.com", customerPhone: "0512345678" })];
    const matches = findGuestPossibleMatches(candidates, { email: "someone@else.com", phone: "0598765432" }, "current-order");
    expect(matches).toHaveLength(0);
    // And structurally, the match shape never carries a "confirmed"/"verified" field.
    const realMatch = findGuestPossibleMatches(
      [order({ id: "g6", customerEmail: "a@b.com" })],
      { email: "a@b.com" },
      "current-order"
    )[0];
    expect(Object.keys(realMatch).sort()).toEqual(["matchedBy", "order"]);
    expect(["email", "phone"]).toContain(realMatch.matchedBy);
  });

  it("excludes the currently-viewed order from its own possible-match results", () => {
    const candidates = [order({ id: "current-order", customerEmail: "me@example.com" }), order({ id: "other", customerEmail: "me@example.com" })];
    const matches = findGuestPossibleMatches(candidates, { email: "me@example.com" }, "current-order");
    expect(matches.map((m) => m.order.id)).toEqual(["other"]);
  });

  it("deduplicates a candidate that would otherwise match by both email and phone", () => {
    const candidates = [order({ id: "g7", customerEmail: "dup@example.com", customerPhone: "0501234567" })];
    const matches = findGuestPossibleMatches(candidates, { email: "dup@example.com", phone: "0501234567" }, "current-order");
    expect(matches).toHaveLength(1);
  });

  it("16b. an empty candidate list never throws and returns no matches", () => {
    expect(() => findGuestPossibleMatches([], { email: "a@b.com", phone: "123" }, "x")).not.toThrow();
    expect(findGuestPossibleMatches([], { email: "a@b.com", phone: "123" }, "x")).toEqual([]);
  });
});
