import { describe, expect, it } from "vitest";
import { aggregate, toCsv, total } from "../../src/admin/posReports";
import type { AdminOrder, PosReturn, RegisterSession } from "../../src/admin/types";

const at = (day: number, h: number) => {
  const d = new Date(2026, 9, day, h);
  return { toMillis: () => d.getTime(), toDate: () => d };
};
const sale = (o: Partial<AdminOrder>) =>
  ({ status: "completed", lines: [{ qty: 1 }], total: 100, cashAmount: 100, cardAmount: 0, branchId: "b1", registerId: "r1", registerSessionId: "s1", createdAt: at(18, 10), ...o }) as AdminOrder;
const ret = (o: Partial<PosReturn>) => ({ branchId: "b1", registerId: "r1", sessionId: "s1", refundTotal: 30, createdAt: at(18, 12), ...o }) as PosReturn;
const sess = (o: Partial<RegisterSession>) =>
  ({ id: "s1", branchId: "b1", registerId: "r1", status: "closed", startingCash: 100, cashTotal: 100, cashRefundTotal: 30, countedCash: 165, expectedCash: 170, variance: -5, openedAt: at(18, 9), ...o }) as RegisterSession;

const orders = [
  sale({}),
  sale({ total: 50, cashAmount: 0, cardAmount: 50, discount: 5 }),
  sale({ registerId: "r2", registerSessionId: "s2", total: 200, cashAmount: 200 }),
  sale({ branchId: "b2", registerId: "r9", registerSessionId: "s9", createdAt: at(19, 11) }),
  sale({ status: "cancelled", total: 999 }),
];
const returns = [ret({}), ret({ branchId: "b2", registerId: "r9", sessionId: "s9", refundTotal: 10, createdAt: at(19, 12) })];
const sessions = [sess({}), sess({ id: "s2", registerId: "r2", status: "open", countedCash: undefined, variance: undefined }), sess({ id: "s9", branchId: "b2", registerId: "r9", openedAt: at(19, 9), variance: 2, countedCash: 172 })];

describe("POS reports", () => {
  it("each level adds up to the same total", () => {
    const levels = (["branch", "register", "day", "shift"] as const).map((l) => total(aggregate(l, orders, returns, sessions)));
    for (const t of levels) expect(t).toMatchObject({ salesCount: 4, sales: 450, refunds: 40, net: 410, discount: 5, cash: 400, card: 50, shifts: 3, openShifts: 1, variance: -3 });
  });

  it("groups by branch, till, day and shift", () => {
    const byBranch = aggregate("branch", orders, returns, sessions);
    expect(byBranch.find((r) => r.key === "b1")).toMatchObject({ salesCount: 3, sales: 350, refunds: 30, net: 320, avg: 116.67, shifts: 2, openShifts: 1, variance: -5 });
    expect(byBranch.find((r) => r.key === "b2")).toMatchObject({ salesCount: 1, net: 90, variance: 2 });
    const byDay = aggregate("day", orders, returns, sessions);
    expect(byDay.map((r) => [r.key, r.net]).sort()).toEqual([
      ["2026-10-18", 320],
      ["2026-10-19", 90],
    ]);
    const byShift = aggregate("shift", orders, returns, sessions);
    expect(byShift.find((r) => r.key === "s1")).toMatchObject({ salesCount: 2, sales: 150, refunds: 30, counted: 165, expected: 170 });
    expect(byShift.find((r) => r.key === "s2")).toMatchObject({ openShifts: 1, counted: 0, variance: 0 });
  });

  it("CSV quotes text and keeps numbers plain", () => {
    expect(toCsv(["Till", "Net"], [['POS "1"', 12.5]])).toBe('﻿"Till","Net"\r\n"POS ""1""",12.5');
  });
});
