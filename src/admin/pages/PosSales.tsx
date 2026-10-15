import { orderBy, Timestamp, where } from "firebase/firestore";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { branchesApi, ordersApi, registersApi, registerSessionsApi } from "../../firebase/collections";
import { closeRegister, RegisterSessionError, sessionExpectedCash } from "../../firebase/registerSession";
import { NumberInput, type NumericValue } from "../../components/ui/NumberInput";
import { useLanguage } from "../../context/LanguageContext";
import { localizedName } from "../../data/localize";
import { useAdminAuth } from "../AdminAuthContext";
import { Modal } from "../components/Modal";
import { ShiftDetailModal } from "../components/ShiftHistory";
import { useToast } from "../components/ToastContext";
import { AdminButton, AdminInput, AdminSelect, Badge, Card, PageHeader, PageLoading } from "../components/ui";
import { logActivity } from "../logActivity";
import type { AdminOrder, Branch, Register, RegisterSession } from "../types";
import { formatPrice } from "../../utils/currency";

type Range = "today" | "yesterday" | "7d" | "month" | "custom";

// Shared admin field style is full-width; filters here size to their content.
const FILTER_CONTROL = "!w-auto !py-1.5 min-w-[9rem]";

function SectionTitle({ title, count }: { title: string; count: number }) {
  return (
    <h2 className="mb-2 mt-5 flex items-center gap-2 font-display text-base font-bold text-ink">
      {title}
      <span className="rounded-full bg-cream-dim px-2 py-0.5 text-xs font-bold text-ink-soft">{count}</span>
    </h2>
  );
}

function EmptyRow({ text }: { text: string }) {
  return <Card className="px-4 py-5 text-center text-sm text-ink-faint">{text}</Card>;
}

function tsToDate(v: unknown): Date | null {
  const ts = v as { toDate?: () => Date } | undefined;
  return ts?.toDate ? ts.toDate() : null;
}

function dayStart(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function toInputDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function rangeBounds(range: Range, from: string, to: string): { start: Date; end: Date } {
  const today = dayStart(new Date());
  const end = new Date(today);
  end.setDate(end.getDate() + 1);
  switch (range) {
    case "today":
      return { start: today, end };
    case "yesterday": {
      const s = new Date(today);
      s.setDate(s.getDate() - 1);
      return { start: s, end: today };
    }
    case "7d": {
      const s = new Date(today);
      s.setDate(s.getDate() - 6);
      return { start: s, end };
    }
    case "month":
      return { start: new Date(today.getFullYear(), today.getMonth(), 1), end };
    case "custom": {
      const s = from ? dayStart(new Date(`${from}T00:00:00`)) : today;
      const e = to ? dayStart(new Date(`${to}T00:00:00`)) : today;
      e.setDate(e.getDate() + 1);
      return { start: s, end: e };
    }
  }
}

// Every branch's in-store sales in one place: owner/admin only. Filter by
// branch, register, cashier and date; totals, a per-branch breakdown, the
// individual sales, and the register sessions (shifts) in the same window --
// including force-closing a till someone forgot to close.
export default function PosSales() {
  const toast = useToast();
  const { t, lang } = useLanguage();
  const { profile } = useAdminAuth();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [registers, setRegisters] = useState<Register[]>([]);
  const [orders, setOrders] = useState<AdminOrder[] | null>(null);
  const [sessions, setSessions] = useState<RegisterSession[]>([]);
  const [openSessions, setOpenSessions] = useState<RegisterSession[]>([]);
  const [range, setRange] = useState<Range>("today");
  const [from, setFrom] = useState(toInputDate(new Date()));
  const [to, setTo] = useState(toInputDate(new Date()));
  const [branchFilter, setBranchFilter] = useState("all");
  const [registerFilter, setRegisterFilter] = useState("all");
  const [cashierFilter, setCashierFilter] = useState("all");
  const [forceClose, setForceClose] = useState<RegisterSession | null>(null);
  const [countedCash, setCountedCash] = useState<NumericValue>(null);
  const [closing, setClosing] = useState(false);
  const [detail, setDetail] = useState<RegisterSession | null>(null);

  const { start, end } = useMemo(() => rangeBounds(range, from, to), [range, from, to]);

  useEffect(() => {
    branchesApi.list().then((b) => setBranches(b.sort((x, y) => x.name.localeCompare(y.name))));
    const u1 = registersApi.subscribe(setRegisters);
    const u2 = registerSessionsApi.subscribe(setOpenSessions, [where("status", "==", "open")]);
    return () => {
      u1();
      u2();
    };
  }, []);

  useEffect(() => {
    setOrders(null);
    const u1 = ordersApi.subscribe(setOrders, [
      where("source", "==", "pos"),
      where("createdAt", ">=", Timestamp.fromDate(start)),
      where("createdAt", "<", Timestamp.fromDate(end)),
      orderBy("createdAt", "desc"),
    ]);
    const u2 = registerSessionsApi.subscribe(setSessions, [
      where("openedAt", ">=", Timestamp.fromDate(start)),
      where("openedAt", "<", Timestamp.fromDate(end)),
      orderBy("openedAt", "desc"),
    ]);
    return () => {
      u1();
      u2();
    };
  }, [start, end]);

  const branchName = (id?: string) => {
    const b = branches.find((x) => x.id === id);
    return b ? localizedName(b.name, b.nameAr, lang) : "—";
  };

  const matches = useCallback(
    (o: { branchId?: string; registerId?: string }, cashierUid?: string) =>
      (branchFilter === "all" || o.branchId === branchFilter) &&
      (registerFilter === "all" || o.registerId === registerFilter) &&
      (cashierFilter === "all" || cashierUid === cashierFilter),
    [branchFilter, registerFilter, cashierFilter]
  );

  const filtered = useMemo(
    // On a POS device cashierUid is the till itself; operatorId is the person.
    () => (orders ?? []).filter((o) => o.status !== "cancelled" && matches(o, o.operatorId ?? o.cashierUid)),
    [orders, matches]
  );

  const cashiers = useMemo(() => {
    const m = new Map<string, string>();
    (orders ?? []).forEach((o) => {
      const id = o.operatorId ?? o.cashierUid;
      if (id) m.set(id, o.cashierName ?? o.cashierEmail ?? id);
    });
    sessions.forEach((s) => m.set(s.operatorId ?? s.cashierId, s.cashierName));
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [orders, sessions]);

  const kpis = useMemo(() => {
    const gross = filtered.reduce((s, o) => s + o.total, 0);
    return {
      count: filtered.length,
      gross,
      cash: filtered.reduce((s, o) => s + (o.cashAmount ?? 0), 0),
      card: filtered.reduce((s, o) => s + (o.cardAmount ?? 0), 0),
      discount: filtered.reduce((s, o) => s + (o.discount ?? 0), 0),
      items: filtered.reduce((s, o) => s + o.lines.reduce((n, l) => n + l.qty, 0), 0),
      avg: filtered.length ? gross / filtered.length : 0,
    };
  }, [filtered]);

  const byBranch = useMemo(() => {
    const m = new Map<string, { count: number; gross: number; cash: number; card: number }>();
    filtered.forEach((o) => {
      const k = o.branchId ?? "—";
      const e = m.get(k) ?? { count: 0, gross: 0, cash: 0, card: 0 };
      e.count += 1;
      e.gross += o.total;
      e.cash += o.cashAmount ?? 0;
      e.card += o.cardAmount ?? 0;
      m.set(k, e);
    });
    return [...m.entries()].sort((a, b) => b[1].gross - a[1].gross);
  }, [filtered]);

  // Shifts opened in the window, plus any still-open shift from before it
  // (a till left open overnight must never drop out of view).
  const shownSessions = useMemo(() => {
    const m = new Map<string, RegisterSession>();
    [...openSessions, ...sessions].forEach((s) => m.set(s.id, s));
    return [...m.values()]
      .filter((s) => matches(s, s.operatorId ?? s.cashierId))
      .sort((a, b) => (tsToDate(b.openedAt)?.getTime() ?? 0) - (tsToDate(a.openedAt)?.getTime() ?? 0));
  }, [openSessions, sessions, matches]);

  const registerOptions = registers.filter((r) => branchFilter === "all" || r.branchId === branchFilter).sort((a, b) => a.name.localeCompare(b.name));

  async function handleForceClose() {
    if (!forceClose || !profile) return;
    setClosing(true);
    try {
      await closeRegister(forceClose.id, countedCash, { uid: profile.id, email: profile.email, displayName: profile.displayName });
      await logActivity(profile, "pos.registerForceClosed", `${forceClose.branchName ?? ""} · ${forceClose.registerName ?? ""} · ${forceClose.cashierName}`);
      toast.success(t("pos.closeRegister.closed"));
      setForceClose(null);
    } catch (err) {
      toast.error(err instanceof RegisterSessionError ? err.message : t("admin.posSales.closeFailed"));
    } finally {
      setClosing(false);
    }
  }

  const fmtTime = (v: unknown, withDate = range !== "today") => {
    const d = tsToDate(v);
    if (!d) return "—";
    return d.toLocaleString(lang === "ar" ? "ar" : "en-US", withDate ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit" });
  };

  return (
    <div>
      <PageHeader title={t("admin.nav.posSales")} description={t("admin.posSales.subtitle")} />

      {/* One compact toolbar: date range on the left, who/where on the right. */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-line bg-paper p-0.5" role="radiogroup">
          {(["today", "yesterday", "7d", "month", "custom"] as Range[]).map((r) => (
            <button
              key={r}
              role="radio"
              aria-checked={range === r}
              onClick={() => setRange(r)}
              className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-semibold ${range === r ? "bg-wine text-on-accent" : "text-ink-soft hover:text-ink"}`}
            >
              {t(`admin.posSales.range.${r}`)}
            </button>
          ))}
        </div>
        {range === "custom" && (
          <div className="flex items-center gap-1.5">
            <AdminInput type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className={FILTER_CONTROL} />
            <span className="text-ink-faint">→</span>
            <AdminInput type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className={FILTER_CONTROL} />
          </div>
        )}
        <div className="ms-auto flex flex-wrap items-center gap-2">
          <AdminSelect
            value={branchFilter}
            onChange={(e) => {
              setBranchFilter(e.target.value);
              setRegisterFilter("all");
            }}
            className={FILTER_CONTROL}
          >
            <option value="all">{t("admin.posSales.allBranches")}</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.code} · {localizedName(b.name, b.nameAr, lang)}
              </option>
            ))}
          </AdminSelect>
          <AdminSelect value={registerFilter} onChange={(e) => setRegisterFilter(e.target.value)} className={FILTER_CONTROL}>
            <option value="all">{t("pos.branch.allRegisters")}</option>
            {registerOptions.map((r) => (
              <option key={r.id} value={r.id}>
                {branchFilter === "all" ? `${branches.find((b) => b.id === r.branchId)?.code ?? "?"} · ` : ""}
                {r.name}
              </option>
            ))}
          </AdminSelect>
          <AdminSelect value={cashierFilter} onChange={(e) => setCashierFilter(e.target.value)} className={FILTER_CONTROL}>
            <option value="all">{t("admin.posSales.allCashiers")}</option>
            {cashiers.map(([uid, name]) => (
              <option key={uid} value={uid}>
                {name}
              </option>
            ))}
          </AdminSelect>
        </div>
      </div>

      {orders === null ? (
        <PageLoading />
      ) : (
        <>
          <Card className="mb-4 grid grid-cols-2 divide-line overflow-hidden p-0 sm:grid-cols-4 lg:grid-cols-7 lg:divide-x rtl:lg:divide-x-reverse">
            {[
              { label: t("pos.closeRegister.salesCount"), value: String(kpis.count) },
              { label: t("pos.branch.gross"), value: formatPrice(kpis.gross) },
              { label: t("pos.terminal.cash"), value: formatPrice(kpis.cash) },
              { label: t("pos.terminal.card"), value: formatPrice(kpis.card) },
              { label: t("pos.terminal.discountLabel"), value: formatPrice(kpis.discount) },
              { label: t("pos.branch.items"), value: String(kpis.items) },
              { label: t("admin.posSales.avgTicket"), value: formatPrice(kpis.avg) },
            ].map((k, i) => (
              <div key={k.label} className={`px-4 py-3 ${i === 1 ? "bg-wine-light/50" : ""}`}>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">{k.label}</p>
                <p className="mt-0.5 font-display text-lg font-bold text-ink">{k.value}</p>
              </div>
            ))}
          </Card>

          {branchFilter === "all" && byBranch.length > 0 && (
            <Card className="mb-4 overflow-x-auto p-0">
              <table className="w-full text-sm">
                <thead className="whitespace-nowrap bg-cream-dim text-xs uppercase text-ink-faint">
                  <tr>
                    <th className="px-4 py-2 text-start">{t("pos.branch.branch")}</th>
                    <th className="px-4 py-2 text-end">{t("pos.closeRegister.salesCount")}</th>
                    <th className="px-4 py-2 text-end">{t("pos.terminal.cash")}</th>
                    <th className="px-4 py-2 text-end">{t("pos.terminal.card")}</th>
                    <th className="px-4 py-2 text-end">{t("pos.branch.gross")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {byBranch.map(([id, e]) => (
                    <tr key={id}>
                      <td className="px-4 py-2 font-semibold text-ink">{id === "—" ? t("admin.posSales.noBranch") : branchName(id)}</td>
                      <td className="px-4 py-2 text-end">{e.count}</td>
                      <td className="px-4 py-2 text-end">{formatPrice(e.cash)}</td>
                      <td className="px-4 py-2 text-end">{formatPrice(e.card)}</td>
                      <td className="px-4 py-2 text-end font-semibold">{formatPrice(e.gross)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}

          <SectionTitle title={t("admin.posSales.sales")} count={filtered.length} />
          {filtered.length === 0 ? (
            <EmptyRow text={t("admin.posSales.noSales")} />
          ) : (
            <Card className="overflow-x-auto p-0">
              <table className="w-full text-sm">
                <thead className="whitespace-nowrap bg-cream-dim text-xs uppercase text-ink-faint">
                  <tr>
                    <th className="px-3 py-2 text-start">{t("pos.branch.time")}</th>
                    <th className="px-3 py-2 text-start">#</th>
                    <th className="px-3 py-2 text-start">{t("pos.branch.branch")}</th>
                    <th className="px-3 py-2 text-start">{t("pos.branch.register")}</th>
                    <th className="px-3 py-2 text-start">{t("pos.branch.cashier")}</th>
                    <th className="px-3 py-2 text-end">{t("pos.branch.items")}</th>
                    <th className="px-3 py-2 text-start">{t("pos.branch.payment")}</th>
                    <th className="px-3 py-2 text-end">{t("admin.orders.colTotal")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {filtered.map((o) => (
                    <tr key={o.id} className="hover:bg-cream-dim/50">
                      <td className="px-3 py-2 text-ink-soft">{fmtTime(o.createdAt)}</td>
                      <td className="px-3 py-2">
                        <Link to={`/admin/orders/${o.id}`} className="font-mono text-xs font-semibold text-wine hover:underline">
                          {o.orderNumber}
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-ink">{o.branchCode ?? (o.branchId ? branchName(o.branchId) : "—")}</td>
                      <td className="px-3 py-2 text-ink">{o.registerName ?? "—"}</td>
                      <td className="px-3 py-2 text-ink">{o.cashierName ?? "—"}</td>
                      <td className="px-3 py-2 text-end">{o.lines.reduce((n, l) => n + l.qty, 0)}</td>
                      <td className="px-3 py-2 text-ink-soft">{o.paymentMethod ? t(`pos.terminal.payment.${o.paymentMethod}`) : "—"}</td>
                      <td className="px-3 py-2 text-end font-semibold text-ink">
                        {formatPrice(o.total)}
                        {(o.discount ?? 0) > 0 && <span className="block text-[11px] font-normal text-ink-faint">-{formatPrice(o.discount ?? 0)}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}

          <SectionTitle title={t("admin.posSales.shifts")} count={shownSessions.length} />
          {shownSessions.length === 0 ? (
            <EmptyRow text={t("admin.posSales.noShifts")} />
          ) : (
            <Card className="overflow-x-auto p-0">
              <table className="w-full text-sm">
                <thead className="whitespace-nowrap bg-cream-dim text-xs uppercase text-ink-faint">
                  <tr>
                    <th className="px-3 py-2" />
                    <th className="px-3 py-2 text-start">{t("pos.branch.branch")}</th>
                    <th className="px-3 py-2 text-start">{t("pos.branch.cashier")}</th>
                    <th className="px-3 py-2 text-start">{t("admin.posSales.opened")}</th>
                    <th className="px-3 py-2 text-start">{t("admin.posSales.closed")}</th>
                    <th className="px-3 py-2 text-end">{t("pos.closeRegister.salesCount")}</th>
                    <th className="px-3 py-2 text-end">{t("pos.branch.gross")}</th>
                    <th className="px-3 py-2 text-end">{t("pos.openRegister.startingCash")}</th>
                    <th className="px-3 py-2 text-end">{t("pos.closeRegister.expectedCash")}</th>
                    <th className="px-3 py-2 text-end">{t("admin.posSales.counted")}</th>
                    <th className="px-3 py-2 text-end">{t("admin.posSales.variance")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {shownSessions.map((s) => {
                    const expected = s.expectedCash ?? sessionExpectedCash(s);
                    return (
                      <tr key={s.id}>
                        {/* Actions first so Force close is never scrolled out of view. */}
                        <td className="whitespace-nowrap px-3 py-2 text-start">
                          {s.status === "open" && (
                            <AdminButton
                              size="sm"
                              variant="danger"
                              onClick={() => {
                                setForceClose(s);
                                setCountedCash(null);
                              }}
                            >
                              {t("admin.posSales.forceClose")}
                            </AdminButton>
                          )}{" "}
                          <AdminButton size="sm" onClick={() => setDetail(s)}>
                            {t("admin.shifts.view")}
                          </AdminButton>
                        </td>
                        <td className="px-3 py-2 text-ink">
                          {s.branchName ?? "—"} · {s.registerName ?? "—"}
                        </td>
                        <td className="px-3 py-2 text-ink">{s.cashierName}</td>
                        <td className="px-3 py-2 text-ink-soft">{fmtTime(s.openedAt, true)}</td>
                        <td className="px-3 py-2 text-ink-soft">{s.status === "open" ? <Badge tone="success">{t("admin.posSales.open")}</Badge> : fmtTime(s.closedAt, true)}</td>
                        <td className="px-3 py-2 text-end">{s.salesCount}</td>
                        <td className="px-3 py-2 text-end">{formatPrice(s.grossTotal)}</td>
                        <td className="px-3 py-2 text-end">{formatPrice(s.startingCash)}</td>
                        <td className="px-3 py-2 text-end">{formatPrice(expected)}</td>
                        <td className="px-3 py-2 text-end">{s.countedCash !== undefined ? formatPrice(s.countedCash) : "—"}</td>
                        <td className={`px-3 py-2 text-end font-semibold ${(s.variance ?? 0) < 0 ? "text-wine" : (s.variance ?? 0) > 0 ? "text-olive" : "text-ink-soft"}`}>
                          {s.variance !== undefined ? formatPrice(s.variance) : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Card>
          )}
        </>
      )}

      <Modal open={!!forceClose} onClose={() => setForceClose(null)} title={t("admin.posSales.forceClose")} width="sm">
        {forceClose && (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-ink-soft">
              {forceClose.branchName} · {forceClose.registerName} · {forceClose.cashierName}
            </p>
            <p className="text-sm text-ink">
              {t("pos.closeRegister.expectedCash")}: <b>{formatPrice(sessionExpectedCash(forceClose))}</b>
            </p>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-semibold text-ink">{t("admin.posSales.countedOptional")}</span>
              <NumberInput
                min={0}
                nullable
                autoFocus
                value={countedCash}
                onChange={setCountedCash}
                placeholder="—"
                className="rounded-lg border border-line bg-paper px-3 py-2.5 outline-none focus:border-wine"
              />
              <span className="text-xs text-ink-faint">{t("admin.posSales.countedOptionalHint")}</span>
            </label>
            <AdminButton variant="primary" loading={closing} className="w-full justify-center" onClick={() => void handleForceClose()}>
              {t("pos.layout.closeRegister")}
            </AdminButton>
          </div>
        )}
      </Modal>

      <ShiftDetailModal session={detail} onClose={() => setDetail(null)} />
    </div>
  );
}
