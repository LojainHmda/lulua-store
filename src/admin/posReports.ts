import type { AdminOrder, PosReturn, RegisterSession } from "./types";
import { toInputDate } from "./posDateRange";

// POS Reports (Admin → Point of Sale → Reports): the same figures at every
// level of Branch → Till → Day → Shift. One aggregator groups sales,
// returns and shifts by a key, so each level adds up exactly to the one
// above it.
//  - sales: by where/when they were rung up (cancelled left out);
//  - refunds: by where/when the money went back (the receiving till);
//  - cash count: by the shift (its own expected/counted/difference).

export interface ReportRow {
  key: string;
  salesCount: number;
  items: number;
  sales: number;
  discount: number;
  cash: number;
  card: number;
  refundCount: number;
  refunds: number;
  net: number;
  avg: number;
  shifts: number;
  openShifts: number;
  expected: number;
  counted: number;
  variance: number;
}

export type ReportLevel = "branch" | "register" | "day" | "shift";

const r2 = (n: number) => Math.round(n * 100) / 100;

function ms(v: unknown): number | null {
  const ts = v as { toMillis?: () => number; toDate?: () => Date } | undefined;
  if (ts?.toMillis) return ts.toMillis();
  if (ts?.toDate) return ts.toDate().getTime();
  return null;
}

export const dayKey = (v: unknown) => {
  const t = ms(v);
  return t === null ? "" : toInputDate(new Date(t));
};

export function emptyRow(key: string): ReportRow {
  return { key, salesCount: 0, items: 0, sales: 0, discount: 0, cash: 0, card: 0, refundCount: 0, refunds: 0, net: 0, avg: 0, shifts: 0, openShifts: 0, expected: 0, counted: 0, variance: 0 };
}

export const orderKey: Record<ReportLevel, (o: AdminOrder) => string> = {
  branch: (o) => o.branchId ?? "",
  register: (o) => o.registerId ?? "",
  day: (o) => dayKey(o.createdAt),
  shift: (o) => o.registerSessionId ?? "",
};
export const returnKey: Record<ReportLevel, (r: PosReturn) => string> = {
  branch: (r) => r.branchId,
  register: (r) => r.registerId,
  day: (r) => dayKey(r.createdAt),
  shift: (r) => r.sessionId,
};
export const sessionKey: Record<ReportLevel, (s: RegisterSession) => string> = {
  branch: (s) => s.branchId ?? "",
  register: (s) => s.registerId ?? "",
  day: (s) => dayKey(s.openedAt),
  shift: (s) => s.id,
};

export function aggregate(level: ReportLevel, orders: AdminOrder[], returns: PosReturn[], sessions: RegisterSession[]): ReportRow[] {
  const m = new Map<string, ReportRow>();
  const row = (k: string) => {
    let r = m.get(k);
    if (!r) m.set(k, (r = emptyRow(k)));
    return r;
  };
  for (const o of orders) {
    if (o.status === "cancelled") continue;
    const r = row(orderKey[level](o));
    r.salesCount += 1;
    r.items += o.lines.reduce((n, l) => n + l.qty, 0);
    r.sales += o.total;
    r.discount += o.discount ?? 0;
    r.cash += o.cashAmount ?? 0;
    r.card += o.cardAmount ?? 0;
  }
  for (const x of returns) {
    const r = row(returnKey[level](x));
    r.refundCount += 1;
    r.refunds += x.refundTotal;
  }
  for (const s of sessions) {
    const r = row(sessionKey[level](s));
    r.shifts += 1;
    const expected = s.expectedCash ?? s.startingCash + s.cashTotal - (s.cashOutTotal ?? 0) - (s.cashRefundTotal ?? 0);
    r.expected += expected;
    if (s.status !== "closed") r.openShifts += 1;
    else if (typeof s.countedCash === "number") {
      r.counted += s.countedCash;
      r.variance += s.variance ?? s.countedCash - expected;
    }
  }
  return [...m.values()].map((r) => ({
    ...r,
    sales: r2(r.sales),
    discount: r2(r.discount),
    cash: r2(r.cash),
    card: r2(r.card),
    refunds: r2(r.refunds),
    net: r2(r.sales - r.refunds),
    avg: r.salesCount ? r2(r.sales / r.salesCount) : 0,
    expected: r2(r.expected),
    counted: r2(r.counted),
    variance: r2(r.variance),
  }));
}

export function total(rows: ReportRow[]): ReportRow {
  const t = emptyRow("total");
  for (const r of rows) {
    for (const k of Object.keys(t) as (keyof ReportRow)[]) if (k !== "key" && k !== "avg") (t[k] as number) += r[k] as number;
  }
  for (const k of ["sales", "discount", "cash", "card", "refunds", "net", "expected", "counted", "variance"] as const) t[k] = r2(t[k]);
  t.avg = t.salesCount ? r2(t.sales / t.salesCount) : 0;
  return t;
}

// CSV with a header row; quotes every text cell.
export function toCsv(header: string[], rows: (string | number)[][]): string {
  const cell = (v: string | number) => (typeof v === "number" ? String(v) : `"${v.replace(/"/g, '""')}"`);
  return "﻿" + [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
}
