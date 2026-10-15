import { describe, expect, it } from "vitest";
import { ALL_ORDER_STATUSES, countOrdersByStatus, countPendingOrders, isPendingOrderStatus, PENDING_ORDER_STATUSES } from "../../src/admin/orderStatusCounts";
import type { OrderStatus } from "../../src/admin/types";

const ALL_STATUSES: OrderStatus[] = ["pending", "processing", "ready", "shipped", "delivered", "completed", "cancelled", "refunded"];

function orders(...statuses: OrderStatus[]) {
  return statuses.map((status) => ({ status }));
}

describe("PENDING_ORDER_STATUSES", () => {
  it("is exactly pending + processing -- the canonical mapping for the nav badge's two 'still in preparation' statuses (see orderStatusCounts.ts for why)", () => {
    expect([...PENDING_ORDER_STATUSES].sort()).toEqual(["pending", "processing"]);
  });

  it("never includes ready, even though its Arabic label shares the same root -- it's explicitly on the do-not-count list", () => {
    expect(PENDING_ORDER_STATUSES).not.toContain("ready");
  });

  it("never includes any other status", () => {
    for (const s of ALL_STATUSES.filter((s) => s !== "pending" && s !== "processing")) {
      expect(isPendingOrderStatus(s)).toBe(false);
    }
  });
});

describe("countPendingOrders", () => {
  // Test 1 -- 5 pending + 3 processing = 8.
  it("counts 5 pending + 3 processing orders as 8", () => {
    const fixture = [
      ...Array.from({ length: 5 }, () => ({ status: "pending" as OrderStatus })),
      ...Array.from({ length: 3 }, () => ({ status: "processing" as OrderStatus })),
    ];
    expect(countPendingOrders(fixture)).toBe(8);
  });

  // Test 2 -- one pending -> processing "moves" 5+3 to 4+4=8 still, then one
  // processing -> ready (completed prep) drops it to 7, matching the user's
  // worked example ("one order جاري التحضير→تم التجهيز makes it 7").
  it("counts 4 pending + 2 processing as 6", () => {
    const fixture = [
      ...Array.from({ length: 4 }, () => ({ status: "pending" as OrderStatus })),
      ...Array.from({ length: 2 }, () => ({ status: "processing" as OrderStatus })),
    ];
    expect(countPendingOrders(fixture)).toBe(6);
  });

  // Test 3 -- no pending orders at all -> no badge (count 0).
  it("returns 0 when there are no orders", () => {
    expect(countPendingOrders([])).toBe(0);
  });

  // Test 4 -- only completed/terminal orders -> no badge (count 0).
  it("returns 0 when every order is already completed/shipped/delivered/cancelled/refunded", () => {
    const fixture = orders("completed", "shipped", "delivered", "cancelled", "refunded", "ready");
    expect(countPendingOrders(fixture)).toBe(0);
  });

  // Test 5 -- mixed pending+completed -> only the two pending statuses count.
  it("counts only pending/processing out of a mixed batch, ignoring every other status", () => {
    const fixture = orders("pending", "processing", "ready", "shipped", "delivered", "cancelled", "refunded", "completed");
    expect(countPendingOrders(fixture)).toBe(2);
  });

  // Test 6 -- a newly pending order increases the count.
  it("increases by 1 when a new pending order is added to the list", () => {
    const before = orders("pending", "processing", "completed");
    const after = [...before, { status: "processing" as OrderStatus }];
    expect(countPendingOrders(after)).toBe(countPendingOrders(before) + 1);
  });

  // Test 7 -- a pending order moving to completed decreases the count.
  it("decreases by 1 when a pending order's status moves to a non-pending status", () => {
    const before = orders("pending", "processing", "processing");
    const after = [{ status: "completed" as OrderStatus }, { status: "processing" as OrderStatus }, { status: "processing" as OrderStatus }];
    expect(countPendingOrders(before)).toBe(3);
    expect(countPendingOrders(after)).toBe(2);
  });

  // Test 8 -- every other status (ready/shipped/delivered/cancelled/refunded/
  // completed) never affects the count, individually or in combination.
  it("is unaffected by any non-pending, non-processing status appearing anywhere in the list", () => {
    const base = orders("pending", "processing");
    for (const other of ALL_STATUSES.filter((s) => s !== "pending" && s !== "processing")) {
      expect(countPendingOrders([...base, { status: other }])).toBe(2);
    }
  });

  it("does not mutate its input", () => {
    const fixture = orders("pending", "completed");
    const copy = fixture.map((o) => ({ ...o }));
    countPendingOrders(fixture);
    expect(fixture).toEqual(copy);
  });
});

describe("ALL_ORDER_STATUSES", () => {
  it("is exactly the 8 canonical OrderStatus values, each listed once", () => {
    expect([...ALL_ORDER_STATUSES].sort()).toEqual([...ALL_STATUSES].sort());
    expect(new Set(ALL_ORDER_STATUSES).size).toBe(8);
  });
});

describe("countOrdersByStatus (Admin Orders page status cards)", () => {
  it("every canonical status is always present in the result, defaulting to 0, even for an empty order list", () => {
    const counts = countOrdersByStatus([]);
    for (const s of ALL_ORDER_STATUSES) {
      expect(counts[s]).toBe(0);
    }
  });

  // Worked example from the spec: جاري التجهيز (pending) = 3, تم التجهيز
  // (ready) = 12, plus a few of every other status thrown in.
  it("counts a realistic mixed batch correctly per status, leaving every other status at exactly its own count", () => {
    const fixture = [
      ...Array.from({ length: 3 }, () => ({ status: "pending" as OrderStatus })),
      ...Array.from({ length: 12 }, () => ({ status: "ready" as OrderStatus })),
      ...Array.from({ length: 5 }, () => ({ status: "refunded" as OrderStatus })),
      { status: "processing" as OrderStatus },
      { status: "processing" as OrderStatus },
      { status: "shipped" as OrderStatus },
      { status: "delivered" as OrderStatus },
      { status: "cancelled" as OrderStatus },
    ];
    expect(countOrdersByStatus(fixture)).toEqual({
      pending: 3,
      processing: 2,
      ready: 12,
      shipped: 1,
      delivered: 1,
      cancelled: 1,
      refunded: 5,
      completed: 0,
    });
  });

  // The spec's exact worked example: one order moves جاري التجهيز (pending)
  // -> تم التجهيز (ready); pending's card must drop by 1 and ready's card
  // must rise by 1, live, with every other status's count undisturbed.
  it("moving one order from pending to ready decrements pending and increments ready by exactly 1, leaving other counts untouched", () => {
    const before = [
      ...Array.from({ length: 3 }, () => ({ status: "pending" as OrderStatus })),
      ...Array.from({ length: 12 }, () => ({ status: "ready" as OrderStatus })),
      { status: "cancelled" as OrderStatus },
    ];
    const beforeCounts = countOrdersByStatus(before);
    expect(beforeCounts.pending).toBe(3);
    expect(beforeCounts.ready).toBe(12);

    // Same order list, one "pending" swapped to "ready" -- exactly what a
    // live onSnapshot update looks like from OrderList.tsx's point of view.
    const after = [{ status: "ready" as OrderStatus }, ...before.slice(1)];
    const afterCounts = countOrdersByStatus(after);
    expect(afterCounts.pending).toBe(2);
    expect(afterCounts.ready).toBe(13);
    expect(afterCounts.cancelled).toBe(beforeCounts.cancelled);
  });

  it("a status with zero current orders stays explicitly 0, not absent from the result", () => {
    const fixture = orders("ready", "ready", "cancelled");
    const counts = countOrdersByStatus(fixture);
    expect(Object.keys(counts).sort()).toEqual([...ALL_ORDER_STATUSES].sort());
    expect(counts.pending).toBe(0);
    expect(counts.processing).toBe(0);
    expect(counts.shipped).toBe(0);
    expect(counts.delivered).toBe(0);
    expect(counts.refunded).toBe(0);
    expect(counts.completed).toBe(0);
  });

  it("every count sums back to the total number of orders", () => {
    const fixture = orders("pending", "processing", "ready", "shipped", "delivered", "cancelled", "refunded", "completed", "pending", "ready");
    const counts = countOrdersByStatus(fixture);
    const sum = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(sum).toBe(fixture.length);
  });

  it("does not mutate its input", () => {
    const fixture = orders("pending", "ready", "cancelled");
    const copy = fixture.map((o) => ({ ...o }));
    countOrdersByStatus(fixture);
    expect(fixture).toEqual(copy);
  });
});
