import type { AdminOrder, BranchStockDoc, PosReturn, RegisterSession } from "./types";

// End-of-day snapshot of one branch (Feature 9): everything the branch did
// on one calendar day, worked out from the day's POS sales, returns and
// shifts. Shown live on Admin → Branches → End of day, and frozen into
// branchDaySnapshots/{branchId}__{yyyy-mm-dd} when an admin closes the day.
//
// What counts on the day:
//  - sales: POS sales of this branch created that day (offline sales count
//    on the day they were made at the till), cancelled ones left out;
//  - refunds: returns taken in at this branch that day (where the money went
//    back), whatever day the sale was;
//  - the cash drawer: the shifts opened that day (a shift's own running
//    totals, so one that runs past midnight is counted once, on its day).

export interface DayShift {
  id: string;
  registerId: string;
  registerName: string;
  cashierName: string;
  openedAt: number | null;
  closedAt: number | null;
  open: boolean;
  salesCount: number;
  grossTotal: number;
  cashTotal: number;
  cardTotal: number;
  refundTotal: number;
  cashRefundTotal: number;
  cashOutTotal: number;
  startingCash: number;
  expectedCash: number;
  countedCash: number | null;
  variance: number | null;
}

export interface DayFigures {
  salesCount: number;
  itemsSold: number;
  subtotal: number;
  discountTotal: number;
  promoDiscount: number;
  manualDiscount: number;
  salesTotal: number;
  cashSales: number;
  cardSales: number;
  avgSale: number;
  cancelledCount: number;
  offlineCount: number;
  refundCount: number;
  itemsReturned: number;
  refundTotal: number;
  cashRefunds: number;
  cardRefunds: number;
  netTotal: number;
  drawer: { startingCash: number; cashSales: number; cashRefunds: number; withdrawals: number; expected: number; counted: number; variance: number; uncounted: number };
  shifts: DayShift[];
  registers: { registerId: string; name: string; salesCount: number; salesTotal: number; refundTotal: number; netTotal: number }[];
  cashiers: { id: string; name: string; salesCount: number; salesTotal: number; discountTotal: number; refundTotal: number }[];
  topProducts: { productId: string; name: string; qty: number; total: number }[];
  // Sales total per hour of the day (0-23).
  hours: number[];
  // Branch stock when the figures were worked out (only meaningful for the
  // day it was taken -- a frozen snapshot keeps the close-of-day count).
  stock: { units: number; cells: number; outOfStock: number; negative: number } | null;
}

export interface BranchDaySnapshot {
  id: string;
  branchId: string;
  branchName: string;
  branchCode?: string;
  date: string;
  figures: DayFigures;
  closedByUid: string;
  closedByName: string;
  closedAt?: unknown;
  version: number;
  note?: string;
}

export const snapshotId = (branchId: string, date: string) => `${branchId}__${date}`;

export function dayBounds(date: string): { start: Date; end: Date } {
  const start = new Date(`${date}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

function ms(v: unknown): number | null {
  const ts = v as { toMillis?: () => number; toDate?: () => Date } | undefined;
  if (ts?.toMillis) return ts.toMillis();
  if (ts?.toDate) return ts.toDate().getTime();
  return null;
}

export function buildDayFigures(input: {
  orders: AdminOrder[];
  returns: PosReturn[];
  sessions: RegisterSession[];
  stock?: BranchStockDoc[] | null;
}): DayFigures {
  const sales = input.orders.filter((o) => o.status !== "cancelled");
  const sum = <T,>(xs: T[], f: (x: T) => number) => r2(xs.reduce((s, x) => s + (f(x) || 0), 0));

  const salesTotal = sum(sales, (o) => o.total);
  const refundTotal = sum(input.returns, (r) => r.refundTotal);
  const cashRefunds = sum(input.returns, (r) => r.cashRefund);

  const shifts: DayShift[] = input.sessions
    .map((s) => {
      const expected = r2(s.startingCash + s.cashTotal - (s.cashOutTotal ?? 0) - (s.cashRefundTotal ?? 0));
      const counted = s.status === "closed" && typeof s.countedCash === "number" ? s.countedCash : null;
      return {
        id: s.id,
        registerId: s.registerId ?? "",
        registerName: s.registerName ?? "—",
        cashierName: s.cashierName,
        openedAt: ms(s.openedAt),
        closedAt: ms(s.closedAt),
        open: s.status !== "closed",
        salesCount: s.salesCount,
        grossTotal: s.grossTotal,
        cashTotal: s.cashTotal,
        cardTotal: s.cardTotal,
        refundTotal: s.refundTotal ?? 0,
        cashRefundTotal: s.cashRefundTotal ?? 0,
        cashOutTotal: s.cashOutTotal ?? 0,
        startingCash: s.startingCash,
        expectedCash: s.expectedCash ?? expected,
        countedCash: counted,
        variance: counted === null ? null : r2(s.variance ?? counted - (s.expectedCash ?? expected)),
      };
    })
    .sort((a, b) => (a.openedAt ?? 0) - (b.openedAt ?? 0));
  const closed = shifts.filter((s) => s.countedCash !== null);

  const regMap = new Map<string, DayFigures["registers"][number]>();
  const reg = (id: string, name: string) => regMap.get(id) ?? { registerId: id, name, salesCount: 0, salesTotal: 0, refundTotal: 0, netTotal: 0 };
  sales.forEach((o) => {
    const e = reg(o.registerId ?? "", o.registerName ?? "—");
    e.salesCount += 1;
    e.salesTotal = r2(e.salesTotal + o.total);
    regMap.set(e.registerId, e);
  });
  input.returns.forEach((r) => {
    const e = reg(r.registerId, r.registerName ?? "—");
    e.refundTotal = r2(e.refundTotal + r.refundTotal);
    regMap.set(e.registerId, e);
  });
  const registers = [...regMap.values()].map((e) => ({ ...e, netTotal: r2(e.salesTotal - e.refundTotal) })).sort((a, b) => a.name.localeCompare(b.name));

  const cashMap = new Map<string, DayFigures["cashiers"][number]>();
  const who = (id: string, name: string) => cashMap.get(id) ?? { id, name, salesCount: 0, salesTotal: 0, discountTotal: 0, refundTotal: 0 };
  sales.forEach((o) => {
    const id = o.operatorId ?? o.cashierUid ?? "";
    const e = who(id, o.cashierName ?? id);
    e.salesCount += 1;
    e.salesTotal = r2(e.salesTotal + o.total);
    e.discountTotal = r2(e.discountTotal + (o.discount ?? 0));
    cashMap.set(id, e);
  });
  input.returns.forEach((r) => {
    const id = r.operatorId ?? r.cashierUid;
    const e = who(id, r.cashierName);
    e.refundTotal = r2(e.refundTotal + r.refundTotal);
    cashMap.set(id, e);
  });
  const cashiers = [...cashMap.values()].sort((a, b) => b.salesTotal - a.salesTotal);

  const prod = new Map<string, DayFigures["topProducts"][number]>();
  sales.forEach((o) =>
    o.lines.forEach((l) => {
      const e = prod.get(l.productId) ?? { productId: l.productId, name: l.name, qty: 0, total: 0 };
      e.qty += l.qty;
      e.total = r2(e.total + l.price * l.qty - ((l as { promoDiscount?: number }).promoDiscount ?? 0));
      prod.set(l.productId, e);
    })
  );
  const topProducts = [...prod.values()].sort((a, b) => b.qty - a.qty || b.total - a.total).slice(0, 10);

  const hours = Array.from({ length: 24 }, () => 0);
  sales.forEach((o) => {
    const t = ms(o.createdAt);
    if (t !== null) hours[new Date(t).getHours()] = r2(hours[new Date(t).getHours()] + o.total);
  });

  let stock: DayFigures["stock"] = null;
  if (input.stock) {
    stock = { units: 0, cells: 0, outOfStock: 0, negative: 0 };
    for (const d of input.stock)
      for (const c of Object.values(d.stockByCell ?? {})) {
        if (c.qty === null || c.qty === undefined) continue;
        stock.cells += 1;
        if (c.qty > 0) stock.units += c.qty;
        else if (c.qty === 0) stock.outOfStock += 1;
        else stock.negative += 1;
      }
  }

  return {
    salesCount: sales.length,
    itemsSold: sales.reduce((n, o) => n + o.lines.reduce((m, l) => m + l.qty, 0), 0),
    subtotal: sum(sales, (o) => o.subtotal),
    discountTotal: sum(sales, (o) => o.discount ?? 0),
    promoDiscount: sum(sales, (o) => o.promoDiscount ?? 0),
    manualDiscount: sum(sales, (o) => o.manualDiscount ?? (o.discountSource === "manual" ? (o.discount ?? 0) : 0)),
    salesTotal,
    cashSales: sum(sales, (o) => o.cashAmount ?? 0),
    cardSales: sum(sales, (o) => o.cardAmount ?? 0),
    avgSale: sales.length ? r2(salesTotal / sales.length) : 0,
    cancelledCount: input.orders.length - sales.length,
    offlineCount: sales.filter((o) => o.offline).length,
    refundCount: input.returns.length,
    itemsReturned: input.returns.reduce((n, r) => n + r.itemCount, 0),
    refundTotal,
    cashRefunds,
    cardRefunds: sum(input.returns, (r) => r.cardRefund),
    netTotal: r2(salesTotal - refundTotal),
    drawer: {
      startingCash: sum(shifts, (s) => s.startingCash),
      cashSales: sum(shifts, (s) => s.cashTotal),
      cashRefunds: sum(shifts, (s) => s.cashRefundTotal),
      withdrawals: sum(shifts, (s) => s.cashOutTotal),
      expected: sum(shifts, (s) => s.expectedCash),
      counted: sum(closed, (s) => s.countedCash ?? 0),
      variance: sum(closed, (s) => s.variance ?? 0),
      uncounted: shifts.length - closed.length,
    },
    shifts,
    registers,
    cashiers,
    topProducts,
    hours,
    stock,
  };
}

// The headline figures an admin compares between a closed day and what the
// data says now (a late offline sale or a forced close changes them).
export function figuresDiffer(a: DayFigures, b: DayFigures): boolean {
  return (
    a.salesCount !== b.salesCount ||
    a.salesTotal !== b.salesTotal ||
    a.refundCount !== b.refundCount ||
    a.refundTotal !== b.refundTotal ||
    a.drawer.counted !== b.drawer.counted ||
    a.shifts.length !== b.shifts.length
  );
}
