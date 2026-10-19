import { describe, expect, it } from "vitest";
import { buildDayFigures, dayBounds, figuresDiffer, snapshotId } from "../../src/admin/daySnapshot";
import type { AdminOrder, BranchStockDoc, PosReturn, RegisterSession } from "../../src/admin/types";

const at = (h: number, m = 0) => {
  const d = new Date("2026-10-19T00:00:00");
  d.setHours(h, m);
  return { toMillis: () => d.getTime(), toDate: () => d };
};

const sale = (o: Partial<AdminOrder>): AdminOrder =>
  ({
    id: Math.random().toString(36).slice(2),
    orderNumber: "SIS-1",
    source: "pos",
    status: "completed",
    lines: [{ productId: "dress", variantId: "w", size: "S", qty: 1, name: "Dress", color: "White", price: 100 }],
    subtotal: 100,
    shipping: 0,
    total: 100,
    cashAmount: 100,
    cardAmount: 0,
    registerId: "r1",
    registerName: "POS-01",
    cashierUid: "c1",
    cashierName: "Rana",
    createdAt: at(10),
    ...o,
  }) as AdminOrder;

const session = (o: Partial<RegisterSession>): RegisterSession =>
  ({
    id: "s1",
    cashierId: "c1",
    cashierName: "Rana",
    registerId: "r1",
    registerName: "POS-01",
    startingCash: 200,
    status: "closed",
    salesCount: 0,
    cashTotal: 0,
    cardTotal: 0,
    discountTotal: 0,
    grossTotal: 0,
    openedAt: at(9),
    closedAt: at(18),
    ...o,
  }) as RegisterSession;

describe("end-of-day figures", () => {
  it("adds up sales, refunds, payments, drawer, tills, cashiers, products and hours", () => {
    const orders = [
      sale({ total: 90, subtotal: 100, discount: 10, manualDiscount: 10, discountSource: "manual", cashAmount: 90 }),
      sale({
        lines: [{ productId: "scarf", variantId: "w", size: "One", qty: 3, name: "Scarf", color: "White", price: 50 }],
        subtotal: 150,
        total: 150,
        cashAmount: 0,
        cardAmount: 150,
        registerId: "r2",
        registerName: "POS-02",
        cashierUid: "c2",
        cashierName: "Lina",
        createdAt: at(14, 30),
        offline: true,
      }),
      sale({ status: "cancelled", total: 999 }),
    ];
    const returns = [{ id: "x", registerId: "r1", registerName: "POS-01", cashierUid: "c1", cashierName: "Rana", refundTotal: 40, cashRefund: 40, cardRefund: 0, itemCount: 1 } as PosReturn];
    const sessions = [
      session({ id: "s1", salesCount: 1, grossTotal: 90, cashTotal: 90, cashRefundTotal: 40, refundTotal: 40, cashOutTotal: 20, countedCash: 225, expectedCash: 230, variance: -5 }),
      session({ id: "s2", registerId: "r2", registerName: "POS-02", cashierName: "Lina", status: "open", startingCash: 100, salesCount: 1, grossTotal: 150, cardTotal: 150, openedAt: at(12), closedAt: undefined }),
    ];
    const stock = [{ id: "b1__d", branchId: "b1", productId: "d", stockByCell: { "w::S": { qty: 4 }, "w::M": { qty: 0 }, "w::L": { qty: -2 }, "w::XL": { qty: null } } } as BranchStockDoc];
    const f = buildDayFigures({ orders, returns, sessions, stock });

    expect(f).toMatchObject({
      salesCount: 2,
      cancelledCount: 1,
      offlineCount: 1,
      itemsSold: 4,
      subtotal: 250,
      discountTotal: 10,
      manualDiscount: 10,
      salesTotal: 240,
      cashSales: 90,
      cardSales: 150,
      avgSale: 120,
      refundCount: 1,
      refundTotal: 40,
      cashRefunds: 40,
      netTotal: 200,
    });
    // Drawer: shifts' own figures; only the counted shift is in counted/variance.
    expect(f.drawer).toEqual({ startingCash: 300, cashSales: 90, cashRefunds: 40, withdrawals: 20, expected: 330, counted: 225, variance: -5, uncounted: 1 });
    expect(f.shifts.map((s) => [s.registerName, s.open, s.expectedCash])).toEqual([
      ["POS-01", false, 230],
      ["POS-02", true, 100],
    ]);
    expect(f.registers).toEqual([
      { registerId: "r1", name: "POS-01", salesCount: 1, salesTotal: 90, refundTotal: 40, netTotal: 50 },
      { registerId: "r2", name: "POS-02", salesCount: 1, salesTotal: 150, refundTotal: 0, netTotal: 150 },
    ]);
    expect(f.cashiers.map((c) => [c.name, c.salesTotal, c.refundTotal])).toEqual([
      ["Lina", 150, 0],
      ["Rana", 90, 40],
    ]);
    expect(f.topProducts[0]).toMatchObject({ productId: "scarf", qty: 3, total: 150 });
    expect(f.hours[10]).toBe(90);
    expect(f.hours[14]).toBe(150);
    expect(f.stock).toEqual({ units: 4, cells: 3, outOfStock: 1, negative: 1 });
  });

  it("an empty day is all zeros; figuresDiffer spots a late sale", () => {
    const empty = buildDayFigures({ orders: [], returns: [], sessions: [] });
    expect(empty).toMatchObject({ salesCount: 0, salesTotal: 0, netTotal: 0, avgSale: 0, stock: null });
    expect(figuresDiffer(empty, buildDayFigures({ orders: [], returns: [], sessions: [] }))).toBe(false);
    expect(figuresDiffer(empty, buildDayFigures({ orders: [sale({})], returns: [], sessions: [] }))).toBe(true);
  });

  it("day bounds and ids", () => {
    const { start, end } = dayBounds("2026-10-19");
    expect(end.getTime() - start.getTime()).toBeGreaterThanOrEqual(23 * 3600_000);
    expect(start.getDate()).toBe(19);
    expect(snapshotId("b1", "2026-10-19")).toBe("b1__2026-10-19");
  });
});
