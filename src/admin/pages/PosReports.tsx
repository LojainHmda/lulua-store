import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { orderBy, Timestamp, where } from "../../db/firestore";
import { useLanguage } from "../../context/LanguageContext";
import { localizedName } from "../../data/localize";
import { branchesApi, ordersApi, posReturnsApi, registersApi, registerSessionsApi } from "../../firebase/collections";
import { formatPrice } from "../../utils/currency";
import { AdminButton, AdminInput, Badge, Card, PageHeader, PageLoading } from "../components/ui";
import { POS_RANGES, rangeBounds, toInputDate, type PosRange } from "../posDateRange";
import { aggregate, dayKey, total, toCsv, type ReportLevel, type ReportRow } from "../posReports";
import type { AdminOrder, Branch, PosReturn, Register, RegisterSession } from "../types";

const FILTER_CONTROL = "!w-auto !py-1.5 min-w-[9rem]";

function tsDate(v: unknown): Date | null {
  const ts = v as { toDate?: () => Date } | undefined;
  return ts?.toDate ? ts.toDate() : null;
}

function Tile({ label, value, tone }: { label: string; value: string; tone?: "wine" | "olive" }) {
  return (
    <div className="rounded-xl border border-line bg-paper px-3 py-2.5">
      <p className="text-[11px] font-bold uppercase tracking-wide text-ink-faint">{label}</p>
      <p className={`mt-0.5 font-display text-lg font-bold ${tone === "wine" ? "text-wine" : tone === "olive" ? "text-olive" : "text-ink"}`}>{value}</p>
    </div>
  );
}

const money = (n: number) => formatPrice(n);
const signed = (n: number) => `${n > 0 ? "+" : ""}${formatPrice(n)}`;

// Admin → Point of Sale → Reports: drill down Branch → Till → Day → Shift →
// the shift's sales. Every level shows the same figures for the date range,
// and its rows add up to the level above. The path lives in the URL
// (?b=&r=&d=&s=), so the browser's back button and links work.
export default function PosReports() {
  const { t, lang } = useLanguage();
  const [params, setParams] = useSearchParams();
  const range = (POS_RANGES as string[]).includes(params.get("range") ?? "") ? (params.get("range") as PosRange) : "7d";
  const from = params.get("from") ?? toInputDate(new Date());
  const to = params.get("to") ?? toInputDate(new Date());
  const b = params.get("b") ?? "";
  const r = params.get("r") ?? "";
  const d = params.get("d") ?? "";
  const s = params.get("s") ?? "";
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) (v ? next.set(k, v) : next.delete(k));
    setParams(next);
  };

  const [branches, setBranches] = useState<Branch[]>([]);
  const [registers, setRegisters] = useState<Register[]>([]);
  const [orders, setOrders] = useState<AdminOrder[] | null>(null);
  const [returns, setReturns] = useState<PosReturn[] | null>(null);
  const [sessions, setSessions] = useState<RegisterSession[] | null>(null);
  // The opened shift's own sales/returns (whatever day they fell on).
  const [shiftOrders, setShiftOrders] = useState<AdminOrder[] | null>(null);
  const [shiftReturns, setShiftReturns] = useState<PosReturn[]>([]);

  useEffect(() => {
    branchesApi.list().then((x) => setBranches(x.sort((a, c) => a.name.localeCompare(c.name))));
    registersApi.list().then(setRegisters);
  }, []);

  const { start, end } = useMemo(() => rangeBounds(range, from, to), [range, from, to]);
  useEffect(() => {
    setOrders(null);
    setReturns(null);
    setSessions(null);
    const rangeOf = (f: string) => [where(f, ">=", Timestamp.fromDate(start)), where(f, "<", Timestamp.fromDate(end))];
    const u = [
      ordersApi.subscribe(setOrders, [where("source", "==", "pos"), ...rangeOf("createdAt"), orderBy("createdAt", "desc")]),
      posReturnsApi.subscribe(setReturns, [...rangeOf("createdAt")]),
      registerSessionsApi.subscribe(setSessions, [...rangeOf("openedAt")]),
    ];
    return () => u.forEach((f) => f());
  }, [start, end]);

  useEffect(() => {
    setShiftOrders(null);
    setShiftReturns([]);
    if (!s) return;
    const u1 = ordersApi.subscribe(setShiftOrders, [where("registerSessionId", "==", s)]);
    const u2 = posReturnsApi.subscribe(setShiftReturns, [where("sessionId", "==", s)]);
    return () => {
      u1();
      u2();
    };
  }, [s]);

  const level: ReportLevel | "sales" = s ? "sales" : d ? "shift" : r ? "day" : b ? "register" : "branch";

  // Narrow everything to the path chosen so far.
  const scoped = useMemo(() => {
    if (!orders || !returns || !sessions) return null;
    const inPath = (x: { branchId?: string; registerId?: string }, day: string) =>
      (!b || x.branchId === b) && (!r || x.registerId === r) && (!d || day === d);
    return {
      orders: orders.filter((o) => inPath(o, dayKey(o.createdAt))),
      returns: returns.filter((x) => inPath(x, dayKey(x.createdAt))),
      sessions: sessions.filter((x) => inPath(x, dayKey(x.openedAt))),
    };
  }, [orders, returns, sessions, b, r, d]);

  const branchLabel = (id: string) => {
    const x = branches.find((y) => y.id === id);
    return x ? `${x.code ? `${x.code} · ` : ""}${localizedName(x.name, x.nameAr, lang)}` : id || "—";
  };
  const registerLabel = (id: string) => registers.find((y) => y.id === id)?.name ?? sessions?.find((y) => y.registerId === id)?.registerName ?? (id || "—");
  const fmtDay = (k: string) => (k ? new Date(`${k}T00:00:00`).toLocaleDateString(lang === "ar" ? "ar" : "en-US", { weekday: "short", day: "numeric", month: "short" }) : "—");
  const fmtTime = (v: unknown) => tsDate(v)?.toLocaleTimeString(lang === "ar" ? "ar" : "en-US", { hour: "2-digit", minute: "2-digit" }) ?? "—";
  const shiftOf = (id: string) => sessions?.find((x) => x.id === id);
  const shiftLabel = (id: string) => {
    const x = shiftOf(id);
    return x ? `${x.cashierName} · ${fmtTime(x.openedAt)}–${x.status === "closed" ? fmtTime(x.closedAt) : t("admin.posReports.open")}` : t("admin.posReports.shiftFrom");
  };

  const rows = useMemo(() => {
    if (!scoped || level === "sales") return null;
    const list = aggregate(level, scoped.orders, scoped.returns, scoped.sessions);
    if (level === "day") return list.sort((a, c) => c.key.localeCompare(a.key));
    if (level === "shift") return list.sort((a, c) => (tsDate(shiftOf(a.key)?.openedAt)?.getTime() ?? 0) - (tsDate(shiftOf(c.key)?.openedAt)?.getTime() ?? 0));
    return list.sort((a, c) => c.net - a.net);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scoped, level]);

  const labelOf = (k: string) =>
    level === "branch" ? branchLabel(k) : level === "register" ? registerLabel(k) : level === "day" ? fmtDay(k) : shiftLabel(k);
  const drill = (k: string) => set(level === "branch" ? { b: k } : level === "register" ? { r: k } : level === "day" ? { d: k } : { s: k });

  // Figures for the tiles: the current level's total, or the shift itself.
  const shiftRow = useMemo(() => {
    if (!s || !shiftOrders) return null;
    const sess = shiftOf(s);
    return total(aggregate("shift", shiftOrders, shiftReturns, sess ? [sess] : []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s, shiftOrders, shiftReturns, sessions]);
  const sum: ReportRow | null = level === "sales" ? shiftRow : rows ? total(rows) : null;

  const crumbs: { label: string; patch: Record<string, string | null> }[] = [{ label: t("admin.posReports.allBranches"), patch: { b: null, r: null, d: null, s: null } }];
  if (b) crumbs.push({ label: branchLabel(b), patch: { r: null, d: null, s: null } });
  if (r) crumbs.push({ label: registerLabel(r), patch: { d: null, s: null } });
  if (d) crumbs.push({ label: fmtDay(d), patch: { s: null } });
  if (s) crumbs.push({ label: shiftLabel(s), patch: {} });

  const colName = { branch: t("admin.posReports.branch"), register: t("admin.posReports.till"), day: t("admin.posReports.day"), shift: t("admin.posReports.shift") };

  function exportCsv() {
    const header = [level === "sales" ? "#" : colName[level as ReportLevel], t("admin.posReports.salesCount"), t("admin.posReports.items"), t("admin.posReports.sales"), t("admin.posReports.discounts"), t("admin.posReports.refunds"), t("admin.posReports.net"), t("admin.posReports.cash"), t("admin.posReports.card"), t("admin.posReports.difference")];
    let body: (string | number)[][];
    if (level === "sales") {
      body = (shiftOrders ?? []).filter((o) => o.status !== "cancelled").map((o) => [o.orderNumber, 1, o.lines.reduce((n, l) => n + l.qty, 0), o.total, o.discount ?? 0, 0, o.total, o.cashAmount ?? 0, o.cardAmount ?? 0, 0]);
    } else {
      body = (rows ?? []).map((x) => [labelOf(x.key), x.salesCount, x.items, x.sales, x.discount, x.refunds, x.net, x.cash, x.card, x.variance]);
    }
    const blob = new Blob([toCsv(header, body)], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `pos-report-${crumbs.slice(1).map((c) => c.label).join("-").replace(/[^\w؀-ۿ-]+/g, "_") || "all"}-${toInputDate(start)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const loading = !scoped || (level === "sales" && !shiftOrders);
  const sess = s ? shiftOf(s) : undefined;

  return (
    <div>
      <PageHeader title={t("admin.nav.posReports")} description={t("admin.posReports.subtitle")} />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-line bg-paper p-0.5" role="radiogroup">
          {POS_RANGES.map((x) => (
            <button
              key={x}
              role="radio"
              aria-checked={range === x}
              onClick={() => set({ range: x, d: null, s: null })}
              className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-semibold ${range === x ? "bg-wine text-on-accent" : "text-ink-soft hover:text-ink"}`}
            >
              {t(`admin.posSales.range.${x}`)}
            </button>
          ))}
        </div>
        {range === "custom" && (
          <div className="flex items-center gap-1.5">
            <AdminInput type="date" value={from} max={to} onChange={(e) => set({ from: e.target.value })} className={FILTER_CONTROL} />
            <span className="text-ink-faint">→</span>
            <AdminInput type="date" value={to} min={from} onChange={(e) => set({ to: e.target.value })} className={FILTER_CONTROL} />
          </div>
        )}
        <div className="ms-auto">
          <AdminButton size="sm" icon="download" disabled={loading} onClick={exportCsv}>
            {t("admin.posReports.export")}
          </AdminButton>
        </div>
      </div>

      {/* Where we are; each step jumps back up. */}
      <nav className="mb-3 flex flex-wrap items-center gap-1 text-sm" aria-label={t("admin.posReports.path")}>
        {crumbs.map((c, i) => (
          <span key={i} className="flex items-center gap-1">
            {i > 0 && <span className="text-ink-faint rtl:-scale-x-100">›</span>}
            {i < crumbs.length - 1 ? (
              <button onClick={() => set(c.patch)} className="rounded-md px-1.5 py-0.5 font-semibold text-wine hover:bg-wine-light">
                {c.label}
              </button>
            ) : (
              <span className="rounded-md bg-cream-dim px-2 py-0.5 font-bold text-ink">{c.label}</span>
            )}
          </span>
        ))}
        {d && b && (
          <Link to={`/admin/branches/${b}/day?date=${d}`} className="ms-2 rounded-full border border-line px-2.5 py-0.5 text-xs font-semibold text-ink-soft hover:text-wine">
            {t("admin.posReports.endOfDay")}
          </Link>
        )}
      </nav>

      {loading || !sum ? (
        <PageLoading />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-9">
            <Tile label={t("admin.posReports.net")} value={money(sum.net)} tone="olive" />
            <Tile label={t("admin.posReports.sales")} value={money(sum.sales)} />
            <Tile label={t("admin.posReports.refunds")} value={sum.refunds ? `-${money(sum.refunds)}` : money(0)} tone="wine" />
            <Tile label={t("admin.posReports.discounts")} value={money(sum.discount)} />
            <Tile label={t("admin.posReports.salesCount")} value={String(sum.salesCount)} />
            <Tile label={t("admin.posReports.avg")} value={money(sum.avg)} />
            <Tile label={t("admin.posReports.cash")} value={money(sum.cash)} />
            <Tile label={t("admin.posReports.card")} value={money(sum.card)} />
            <Tile label={t("admin.posReports.difference")} value={sum.shifts > sum.openShifts ? signed(sum.variance) : "—"} tone={sum.variance < 0 ? "wine" : undefined} />
          </div>

          {level === "sales" ? (
            <>
              {sess && (
                <Card className="mt-4 flex flex-wrap gap-x-6 gap-y-1 px-4 py-3 text-sm">
                  <span>
                    <b>{t("admin.posReports.cashier")}:</b> {sess.cashierName}
                  </span>
                  <span>
                    <b>{t("admin.posReports.till")}:</b> {sess.registerName ?? "—"}
                  </span>
                  <span>
                    <b>{t("admin.posReports.hours")}:</b> {fmtTime(sess.openedAt)} – {sess.status === "closed" ? fmtTime(sess.closedAt) : <Badge tone="warning">{t("admin.posReports.open")}</Badge>}
                  </span>
                  <span>
                    <b>{t("admin.posReports.startingCash")}:</b> {money(sess.startingCash)}
                  </span>
                  <span>
                    <b>{t("admin.posReports.expected")}:</b> {money(sum.expected)}
                  </span>
                  <span>
                    <b>{t("admin.posReports.counted")}:</b> {sess.status === "closed" ? money(sum.counted) : "—"}
                  </span>
                </Card>
              )}
              <h2 className="mb-2 mt-5 font-display text-base font-bold text-ink">{t("admin.posReports.shiftSales")}</h2>
              <Card className="overflow-x-auto p-0">
                <table className="w-full text-sm">
                  <thead className="whitespace-nowrap bg-cream-dim text-xs uppercase text-ink-faint">
                    <tr>
                      <th className="px-3 py-2 text-start">{t("admin.posReports.time")}</th>
                      <th className="px-3 py-2 text-start">#</th>
                      <th className="px-3 py-2 text-end">{t("admin.posReports.items")}</th>
                      <th className="px-3 py-2 text-start">{t("admin.posReports.payment")}</th>
                      <th className="px-3 py-2 text-end">{t("admin.posReports.discounts")}</th>
                      <th className="px-3 py-2 text-end">{t("admin.posReports.total")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {(shiftOrders ?? [])
                      .slice()
                      .sort((x, y) => (tsDate(x.createdAt)?.getTime() ?? 0) - (tsDate(y.createdAt)?.getTime() ?? 0))
                      .map((o) => (
                        <tr key={o.id} className={o.status === "cancelled" ? "text-ink-faint line-through" : ""}>
                          <td className="px-3 py-2 text-ink-soft">{fmtTime(o.createdAt)}</td>
                          <td className="px-3 py-2 font-mono text-xs">
                            <Link to={`/admin/orders/${o.id}`} className="font-semibold text-wine hover:underline">
                              {o.orderNumber}
                            </Link>
                            {o.offline && <span className="ms-1.5 text-[10px] font-bold uppercase text-ink-faint">{t("admin.posReports.offline")}</span>}
                            {(o.refundedTotal ?? 0) > 0 && <span className="ms-1.5 text-[10px] font-bold uppercase text-wine">{t("admin.posReports.returned")}</span>}
                          </td>
                          <td className="px-3 py-2 text-end">{o.lines.reduce((n, l) => n + l.qty, 0)}</td>
                          <td className="px-3 py-2 text-ink-soft">{t(`pos.terminal.payment.${o.paymentMethod ?? "cash"}`)}</td>
                          <td className="px-3 py-2 text-end">{o.discount ? money(o.discount) : "—"}</td>
                          <td className="px-3 py-2 text-end font-semibold">{money(o.total)}</td>
                        </tr>
                      ))}
                    {(shiftOrders ?? []).length === 0 && (
                      <tr>
                        <td colSpan={6} className="px-3 py-5 text-center text-ink-faint">
                          {t("admin.posReports.noSales")}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </Card>
              {shiftReturns.length > 0 && (
                <>
                  <h2 className="mb-2 mt-5 font-display text-base font-bold text-ink">{t("admin.posReports.refunds")}</h2>
                  <Card className="divide-y divide-line p-0 text-sm">
                    {shiftReturns.map((x) => (
                      <div key={x.id} className="flex items-center justify-between px-4 py-2">
                        <span>
                          <span className="font-mono text-xs font-semibold text-wine">{x.returnNumber}</span>
                          <span className="ms-2 text-xs text-ink-faint">
                            {fmtTime(x.createdAt)} · {x.orderNumber ?? t("pos.returns.noReceiptShort")} · {x.itemCount} {t("admin.posReports.items").toLowerCase()}
                          </span>
                        </span>
                        <span className="font-semibold text-wine">-{money(x.refundTotal)}</span>
                      </div>
                    ))}
                  </Card>
                </>
              )}
            </>
          ) : (
            <Card className="mt-4 overflow-x-auto p-0">
              <table className="w-full text-sm">
                <thead className="whitespace-nowrap bg-cream-dim text-xs uppercase text-ink-faint">
                  <tr>
                    <th className="px-3 py-2 text-start">{colName[level]}</th>
                    <th className="px-3 py-2 text-end">{t("admin.posReports.salesCount")}</th>
                    <th className="px-3 py-2 text-end">{t("admin.posReports.items")}</th>
                    <th className="px-3 py-2 text-end">{t("admin.posReports.sales")}</th>
                    <th className="px-3 py-2 text-end">{t("admin.posReports.discounts")}</th>
                    <th className="px-3 py-2 text-end">{t("admin.posReports.refunds")}</th>
                    <th className="px-3 py-2 text-end">{t("admin.posReports.net")}</th>
                    <th className="px-3 py-2 text-end">{t("admin.posReports.cash")}</th>
                    <th className="px-3 py-2 text-end">{t("admin.posReports.card")}</th>
                    <th className="px-3 py-2 text-end">{t("admin.posReports.avg")}</th>
                    <th className="px-3 py-2 text-end">{level === "shift" ? t("admin.posReports.counted") : t("admin.posReports.shifts")}</th>
                    <th className="px-3 py-2 text-end">{t("admin.posReports.difference")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {rows!.length === 0 && (
                    <tr>
                      <td colSpan={12} className="px-3 py-6 text-center text-ink-faint">
                        {t("admin.posReports.noData")}
                      </td>
                    </tr>
                  )}
                  {rows!.map((x) => (
                    <tr key={x.key} onClick={() => drill(x.key)} className="cursor-pointer hover:bg-cream-dim/50">
                      <td className="px-3 py-2 font-semibold text-wine">
                        {labelOf(x.key)} <span className="text-ink-faint rtl:-scale-x-100">›</span>
                        {x.openShifts > 0 && (
                          <span className="ms-1.5">
                            <Badge tone="warning">{t("admin.posReports.open")}</Badge>
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-end">{x.salesCount}</td>
                      <td className="px-3 py-2 text-end">{x.items}</td>
                      <td className="px-3 py-2 text-end">{money(x.sales)}</td>
                      <td className="px-3 py-2 text-end">{x.discount ? money(x.discount) : "—"}</td>
                      <td className="px-3 py-2 text-end text-wine">{x.refunds ? `-${money(x.refunds)}` : "—"}</td>
                      <td className="px-3 py-2 text-end font-bold">{money(x.net)}</td>
                      <td className="px-3 py-2 text-end">{money(x.cash)}</td>
                      <td className="px-3 py-2 text-end">{money(x.card)}</td>
                      <td className="px-3 py-2 text-end">{money(x.avg)}</td>
                      <td className="px-3 py-2 text-end">{level === "shift" ? (x.shifts && !x.openShifts ? money(x.counted) : "—") : x.shifts}</td>
                      <td className={`px-3 py-2 text-end font-semibold ${x.variance < 0 ? "text-wine" : x.variance > 0 ? "text-olive" : ""}`}>{x.shifts > x.openShifts ? signed(x.variance) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
                {rows!.length > 1 && (
                  <tfoot className="border-t-2 border-line bg-cream-dim/60 font-bold">
                    <tr>
                      <td className="px-3 py-2">{t("admin.posReports.total")}</td>
                      <td className="px-3 py-2 text-end">{sum.salesCount}</td>
                      <td className="px-3 py-2 text-end">{sum.items}</td>
                      <td className="px-3 py-2 text-end">{money(sum.sales)}</td>
                      <td className="px-3 py-2 text-end">{money(sum.discount)}</td>
                      <td className="px-3 py-2 text-end text-wine">{sum.refunds ? `-${money(sum.refunds)}` : "—"}</td>
                      <td className="px-3 py-2 text-end">{money(sum.net)}</td>
                      <td className="px-3 py-2 text-end">{money(sum.cash)}</td>
                      <td className="px-3 py-2 text-end">{money(sum.card)}</td>
                      <td className="px-3 py-2 text-end">{money(sum.avg)}</td>
                      <td className="px-3 py-2 text-end">{level === "shift" ? money(sum.counted) : sum.shifts}</td>
                      <td className={`px-3 py-2 text-end ${sum.variance < 0 ? "text-wine" : ""}`}>{sum.shifts > sum.openShifts ? signed(sum.variance) : "—"}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
