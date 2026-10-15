import { describe, expect, it } from "vitest";
import { BULK_ORDER_STATUSES, checkBulkStatusEligibility, summarizeBulkStatusOutcomes, type BulkStatusOutcome } from "../../src/admin/orderBulkStatus";
import type { OrderStatus } from "../../src/admin/types";

const ALL_STATUSES: OrderStatus[] = ["pending", "processing", "ready", "shipped", "delivered", "completed", "cancelled", "refunded"];

describe("BULK_ORDER_STATUSES", () => {
  it("never includes cancelled -- cancellation must always go through cancelOrderAndRestoreStock()", () => {
    expect(BULK_ORDER_STATUSES).not.toContain("cancelled");
  });

  it("never includes ready -- it's derived automatically from the preparation checklist, never a manual target (Phase 3)", () => {
    expect(BULK_ORDER_STATUSES).not.toContain("ready");
  });

  it("includes every other real order status, and nothing else", () => {
    const expected = ALL_STATUSES.filter((s) => s !== "cancelled" && s !== "ready");
    expect([...BULK_ORDER_STATUSES].sort()).toEqual([...expected].sort());
  });
});

describe("checkBulkStatusEligibility", () => {
  it("allows a normal (non-cancelled) order to move to any bulk-eligible status", () => {
    for (const target of BULK_ORDER_STATUSES) {
      expect(checkBulkStatusEligibility({ status: "pending" }, target)).toEqual({ eligible: true });
    }
  });

  it("rejects cancelled as a target, even defensively, for every source status", () => {
    for (const source of ALL_STATUSES) {
      const result = checkBulkStatusEligibility({ status: source }, "cancelled");
      expect(result.eligible).toBe(false);
      expect(result.reasonKey).toBe("admin.orders.bulk.reasonTargetCancelled");
    }
  });

  it("rejects ready as a target, even defensively, for every source status (Phase 3 -- preparation, not a human, decides this transition)", () => {
    for (const source of ALL_STATUSES) {
      const result = checkBulkStatusEligibility({ status: source }, "ready");
      expect(result.eligible).toBe(false);
      expect(result.reasonKey).toBe("admin.orders.bulk.reasonTargetReady");
    }
  });

  it("rejects any order that is currently cancelled as a source, regardless of the requested target", () => {
    for (const target of BULK_ORDER_STATUSES) {
      const result = checkBulkStatusEligibility({ status: "cancelled" }, target);
      expect(result.eligible).toBe(false);
      expect(result.reasonKey).toBe("admin.orders.bulk.reasonSourceCancelled");
    }
  });

  it("the source-cancelled check applies even though targetStatus is otherwise valid -- this is deliberately stricter than OrderDetail.tsx's single-order dropdown", () => {
    expect(checkBulkStatusEligibility({ status: "cancelled" }, "pending")).toEqual({
      eligible: false,
      reasonKey: "admin.orders.bulk.reasonSourceCancelled",
    });
  });

  it("target-cancelled is checked ahead of source-cancelled when both would independently fail (reason is well-defined, not ambiguous)", () => {
    const result = checkBulkStatusEligibility({ status: "cancelled" }, "cancelled");
    expect(result.eligible).toBe(false);
    expect(result.reasonKey).toBe("admin.orders.bulk.reasonTargetCancelled");
  });
});

describe("summarizeBulkStatusOutcomes", () => {
  function outcome(ok: boolean): BulkStatusOutcome {
    return { orderId: Math.random().toString(36), orderNumber: "SIS-TEST", ok };
  }

  it("counts an all-success batch correctly", () => {
    expect(summarizeBulkStatusOutcomes([outcome(true), outcome(true), outcome(true)])).toEqual({ succeeded: 3, failed: 0, total: 3 });
  });

  it("counts an all-failure batch correctly", () => {
    expect(summarizeBulkStatusOutcomes([outcome(false), outcome(false)])).toEqual({ succeeded: 0, failed: 2, total: 2 });
  });

  it("counts a mixed batch correctly (the '7 updated, 2 failed' case)", () => {
    const outcomes = [...Array(7).fill(null).map(() => outcome(true)), ...Array(2).fill(null).map(() => outcome(false))];
    expect(summarizeBulkStatusOutcomes(outcomes)).toEqual({ succeeded: 7, failed: 2, total: 9 });
  });

  it("handles an empty batch without dividing by zero or throwing", () => {
    expect(summarizeBulkStatusOutcomes([])).toEqual({ succeeded: 0, failed: 0, total: 0 });
  });
});
