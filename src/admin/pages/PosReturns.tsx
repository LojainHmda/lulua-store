import { orderBy, Timestamp, where } from "../../db/firestore";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { branchesApi, posReturnsApi, registersApi } from "../../firebase/collections";
import { tsDate } from "../../firebase/posReturn";
import { useLanguage } from "../../context/LanguageContext";
import { localizedName } from "../../data/localize";
import { formatPrice } from "../../utils/currency";
import { PosReturnDetailModal } from "../components/PosReturnDetail";
import { AdminInput, AdminSelect, Card, PageHeader, PageLoading, SearchInput } from "../components/ui";
import { POS_RANGES, rangeBounds, toInputDate, type PosRange } from "../posDateRange";
import { RETURN_REASON_LABEL_KEY } from "../returnsHelpers";
import type { Branch, PosRefundMethod, PosReturn, Register } from "../types";

const FILTER_CONTROL = "!w-auto !py-1.5 min-w-[9rem]";

// Every in-store return (refund) across branches and registers: owner/admin
// only. Filter by date, the branch/register/cashier that took it back,
// refund method and receipt / no receipt; totals on top, each return opens
// its full details and refund receipt.
export default function PosReturns() {
  const { t, lang } = useLanguage();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [registers, setRegisters] = useState<Register[]>([]);
  const [returns, setReturns] = useState<PosReturn[] | null>(null);
  const [range, setRange] = useState<PosRange>("today");
  const [from, setFrom] = useState(toInputDate(new Date()));
  const [to, setTo] = useState(toInputDate(new Date()));
  const [branchFilter, setBranchFilter] = useState("all");
  const [registerFilter, setRegisterFilter] = useState("all");
  const [cashierFilter, setCashierFilter] = useState("all");
  const [methodFilter, setMethodFilter] = useState<"all" | PosRefundMethod>("all");
  const [kindFilter, setKindFilter] = useState<"all" | PosReturn["kind"]>("all");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<PosReturn | null>(null);

  const { start, end } = useMemo(() => rangeBounds(range, from, to), [range, from, to]);

  useEffect(() => {
    branchesApi.list().then((b) => setBranches(b.sort((x, y) => x.name.localeCompare(y.name))));
    return registersApi.subscribe(setRegisters);
  }, []);

  useEffect(() => {
    setReturns(null);
    return posReturnsApi.subscribe(setReturns, [
      where("createdAt", ">=", Timestamp.fromDate(start)),
      where("createdAt", "<", Timestamp.fromDate(end)),
      orderBy("createdAt", "desc"),
    ]);
  }, [start, end]);

  const cashiers = useMemo(() => {
    const m = new Map<string, string>();
    (returns ?? []).forEach((r) => m.set(r.operatorId ?? r.cashierUid, r.cashierName));
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [returns]);

  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase();
    return (returns ?? []).filter(
      (r) =>
        (branchFilter === "all" || r.branchId === branchFilter) &&
        (registerFilter === "all" || r.registerId === registerFilter) &&
        (cashierFilter === "all" || (r.operatorId ?? r.cashierUid) === cashierFilter) &&
        (methodFilter === "all" || r.refundMethod === methodFilter) &&
        (kindFilter === "all" || r.kind === kindFilter) &&
        (!q || r.returnNumber.includes(q) || (r.orderNumber ?? "").includes(q) || r.lines.some((l) => l.name.toUpperCase().includes(q)))
    );
  }, [returns, branchFilter, registerFilter, cashierFilter, methodFilter, kindFilter, search]);

  const kpis = useMemo(() => {
    const sum = (f: (r: PosReturn) => number) => filtered.reduce((s, r) => s + f(r), 0);
    const units = (restock: boolean) => sum((r) => r.lines.reduce((n, l) => n + (l.restock === restock ? l.qty : 0), 0));
    return {
      count: filtered.length,
      total: sum((r) => r.refundTotal),
      cash: sum((r) => r.cashRefund),
      card: sum((r) => r.cardRefund),
      items: sum((r) => r.itemCount),
      restocked: units(true),
      damaged: units(false),
    };
  }, [filtered]);

  const branchLabel = (id?: string, fallback?: string) => {
    const b = branches.find((x) => x.id === id);
    return b ? localizedName(b.name, b.nameAr, lang) : (fallback ?? "—");
  };
  const registerOptions = registers.filter((r) => branchFilter === "all" || r.branchId === branchFilter).sort((a, b) => a.name.localeCompare(b.name));
  const fmtTime = (v: unknown) => {
    const d = tsDate(v);
    if (!d) return "—";
    return d.toLocaleString(lang === "ar" ? "ar" : "en-US", range === "today" ? { hour: "2-digit", minute: "2-digit" } : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  };

  return (
    <div>
      <PageHeader title={t("admin.nav.posReturns")} description={t("admin.posReturns.subtitle")} />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-line bg-paper p-0.5" role="radiogroup">
          {POS_RANGES.map((r) => (
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
          <AdminSelect value={methodFilter} onChange={(e) => setMethodFilter(e.target.value as typeof methodFilter)} className={FILTER_CONTROL}>
            <option value="all">{t("admin.posReturns.allMethods")}</option>
            {(["cash", "card", "split"] as PosRefundMethod[]).map((m) => (
              <option key={m} value={m}>
                {t(`pos.terminal.payment.${m}`)}
              </option>
            ))}
          </AdminSelect>
          <AdminSelect value={kindFilter} onChange={(e) => setKindFilter(e.target.value as typeof kindFilter)} className={FILTER_CONTROL}>
            <option value="all">{t("admin.posReturns.allKinds")}</option>
            <option value="receipt">{t("admin.posReturns.withReceipt")}</option>
            <option value="no_receipt">{t("pos.returns.noReceiptShort")}</option>
          </AdminSelect>
        </div>
      </div>

      {returns === null ? (
        <PageLoading />
      ) : (
        <>
          <Card className="mb-4 grid grid-cols-2 divide-line overflow-hidden p-0 sm:grid-cols-4 lg:grid-cols-7 lg:divide-x rtl:lg:divide-x-reverse">
            {[
              { label: t("pos.returns.returnsCount"), value: String(kpis.count) },
              { label: t("pos.returns.refundTotal"), value: kpis.total > 0 ? `-${formatPrice(kpis.total)}` : formatPrice(0), accent: true },
              { label: t("pos.returns.cashRefunds"), value: kpis.cash > 0 ? `-${formatPrice(kpis.cash)}` : formatPrice(0) },
              { label: t("pos.returns.cardRefunds"), value: kpis.card > 0 ? `-${formatPrice(kpis.card)}` : formatPrice(0) },
              { label: t("admin.posReturns.itemsReturned"), value: String(kpis.items) },
              { label: t("pos.returns.backToStock"), value: String(kpis.restocked) },
              { label: t("pos.returns.damaged"), value: String(kpis.damaged) },
            ].map((k) => (
              <div key={k.label} className={`px-4 py-3 ${k.accent ? "bg-wine-light/50" : ""}`}>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">{k.label}</p>
                <p className={`mt-0.5 font-display text-lg font-bold ${k.accent ? "text-wine" : "text-ink"}`}>{k.value}</p>
              </div>
            ))}
          </Card>

          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 font-display text-base font-bold text-ink">
              {t("pos.returns.title")}
              <span className="rounded-full bg-cream-dim px-2 py-0.5 text-xs font-bold text-ink-soft">{filtered.length}</span>
            </h2>
            <SearchInput value={search} onChange={setSearch} placeholder={t("admin.posReturns.searchPlaceholder")} />
          </div>

          {filtered.length === 0 ? (
            <Card className="px-4 py-5 text-center text-sm text-ink-faint">{t("pos.returns.noReturns")}</Card>
          ) : (
            <Card className="overflow-x-auto p-0">
              <table className="w-full text-sm">
                <thead className="whitespace-nowrap bg-cream-dim text-xs uppercase text-ink-faint">
                  <tr>
                    <th className="px-3 py-2 text-start">{t("pos.branch.time")}</th>
                    <th className="px-3 py-2 text-start">#</th>
                    <th className="px-3 py-2 text-start">{t("pos.returns.originalSale")}</th>
                    <th className="px-3 py-2 text-start">{t("pos.returns.returnedAt")}</th>
                    <th className="px-3 py-2 text-start">{t("pos.branch.cashier")}</th>
                    <th className="px-3 py-2 text-start">{t("pos.returns.item")}</th>
                    <th className="px-3 py-2 text-start">{t("pos.returns.reason")}</th>
                    <th className="px-3 py-2 text-start">{t("pos.returns.refundMethod")}</th>
                    <th className="px-3 py-2 text-end">{t("pos.returns.refundTotal")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {filtered.map((r) => {
                    const damaged = r.lines.reduce((n, l) => n + (l.restock ? 0 : l.qty), 0);
                    return (
                      <tr key={r.id} onClick={() => setOpen(r)} className="cursor-pointer hover:bg-cream-dim/50">
                        <td className="whitespace-nowrap px-3 py-2 text-ink-soft">{fmtTime(r.createdAt)}</td>
                        <td className="px-3 py-2 font-mono text-xs font-semibold text-wine">{r.returnNumber}</td>
                        <td className="px-3 py-2 font-mono text-xs">
                          {r.orderId ? (
                            <Link to={`/admin/orders/${r.orderId}`} onClick={(e) => e.stopPropagation()} className="text-wine hover:underline">
                              {r.orderNumber}
                            </Link>
                          ) : (
                            <span className="text-ink-faint">{t("pos.returns.noReceiptShort")}</span>
                          )}
                          {r.saleBranchId && r.saleBranchId !== r.branchId && (
                            <span className="ms-1 font-sans text-[11px] text-ink-faint">({branchLabel(r.saleBranchId, r.saleBranchName)})</span>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-ink">
                          {r.branchCode ?? branchLabel(r.branchId, r.branchName)} · {r.registerName ?? "—"}
                        </td>
                        <td className="px-3 py-2 text-ink">{r.cashierName}</td>
                        <td className="px-3 py-2">
                          <span className="block max-w-[16rem] truncate text-ink">{r.lines.map((l) => `${l.name} ×${l.qty}`).join(", ")}</span>
                          {damaged > 0 && <span className="text-[11px] font-semibold text-wine">{t("pos.returns.damaged")}: {damaged}</span>}
                        </td>
                        <td className="px-3 py-2 text-ink-soft">{t(RETURN_REASON_LABEL_KEY[r.reason])}</td>
                        <td className="px-3 py-2 text-ink-soft">{t(`pos.terminal.payment.${r.refundMethod}`)}</td>
                        <td className="px-3 py-2 text-end font-semibold text-wine">-{formatPrice(r.refundTotal)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Card>
          )}
        </>
      )}

      <PosReturnDetailModal ret={open} onClose={() => setOpen(null)} />
    </div>
  );
}
