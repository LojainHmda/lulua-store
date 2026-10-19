import { describe, expect, it } from "vitest";
import {
  cardRefundable,
  defaultRefundSplit,
  isSaleNumber,
  isWithinReturnWindow,
  refundForUnits,
  refundMethodFor,
  round2,
  saleLineNets,
} from "../../src/admin/posReturns";
import type { OrderLine } from "../../src/admin/types";

const line = (price: number, qty: number): OrderLine => ({ productId: "p", variantId: "v", size: "S", name: "x", color: "c", price, qty });

describe("saleLineNets", () => {
  it("is price x qty with no discount", () => {
    expect(saleLineNets({ lines: [line(100, 2), line(50, 1)], subtotal: 250, discount: 0, total: 250, shipping: 0 })).toEqual([200, 50]);
  });

  it("shares the discount by line value and always adds up to the total paid", () => {
    const order = { lines: [line(33.33, 1), line(33.33, 1), line(33.34, 1)], subtotal: 100, discount: 10, total: 90, shipping: 0 };
    const nets = saleLineNets(order);
    expect(round2(nets.reduce((s, n) => s + n, 0))).toBe(90);
    expect(nets[0]).toBe(30);
  });

  it("handles a fully discounted sale", () => {
    expect(saleLineNets({ lines: [line(10, 1), line(20, 1)], subtotal: 30, discount: 30, total: 0, shipping: 0 })).toEqual([0, 0]);
  });
});

describe("refundForUnits", () => {
  it("unit by unit adds up to the line's net exactly", () => {
    const net = 100; // 3 units, 33.33 each would lose a cent
    const parts = [0, 1, 2].map((r) => refundForUnits(net, 3, r, 1));
    expect(round2(parts.reduce((s, p) => s + p, 0))).toBe(100);
  });

  it("never refunds past what was sold", () => {
    expect(refundForUnits(100, 2, 2, 1)).toBe(0);
    expect(refundForUnits(100, 2, 1, 5)).toBe(50);
  });
});

describe("return window", () => {
  const sold = new Date("2026-10-01T10:00:00Z");
  it("0 days = no limit", () => {
    expect(isWithinReturnWindow(sold, 0, new Date("2030-01-01"))).toBe(true);
  });
  it("is open for exactly windowDays", () => {
    expect(isWithinReturnWindow(sold, 14, new Date("2026-10-15T10:00:00Z"))).toBe(true);
    expect(isWithinReturnWindow(sold, 14, new Date("2026-10-15T10:00:01Z"))).toBe(false);
  });
});

describe("refund split", () => {
  it("goes back the way the sale was paid", () => {
    expect(defaultRefundSplit({ paymentMethod: "cash", cardAmount: 0, total: 100 }, 40)).toEqual({ method: "cash", card: 0 });
    expect(defaultRefundSplit({ paymentMethod: "card", cardAmount: 100, total: 100 }, 40)).toEqual({ method: "card", card: 40 });
    expect(defaultRefundSplit({ paymentMethod: "split", cardAmount: 60, total: 100 }, 50)).toEqual({ method: "split", card: 30 });
  });

  it("never puts more on the card than is still refundable there", () => {
    expect(cardRefundable({ cardAmount: 100, refundedCard: 80 })).toBe(20);
    expect(defaultRefundSplit({ paymentMethod: "card", cardAmount: 100, total: 100, refundedCard: 80 }, 50)).toEqual({ method: "split", card: 20 });
  });

  it("a return without a sale refunds cash by default", () => {
    expect(defaultRefundSplit(null, 70)).toEqual({ method: "cash", card: 0 });
    expect(cardRefundable(null)).toBe(Infinity);
  });

  it("names the method from the amounts", () => {
    expect(refundMethodFor(10, 0)).toBe("cash");
    expect(refundMethodFor(0, 10)).toBe("card");
    expect(refundMethodFor(5, 5)).toBe("split");
    expect(refundMethodFor(0, 0)).toBe("cash");
  });
});

it("recognizes POS sale numbers", () => {
  expect(isSaleNumber("SIS-MG3K2A1")).toBe(true);
  expect(isSaleNumber(" sis-mg3k2a1 ")).toBe(true);
  expect(isSaleNumber("return-test-dress")).toBe(false);
});
