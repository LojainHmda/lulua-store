import { orderBy, Timestamp, where } from "../../db/firestore";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useLanguage } from "../../context/LanguageContext";
import { localizedName } from "../../data/localize";
import { branchesApi, ordersApi, registersApi } from "../../firebase/collections";
import { setSingletonDoc, subscribeSingletonDoc } from "../../firebase/firestore";
import { tsDate } from "../../firebase/posReturn";
import { formatPrice } from "../../utils/currency";
import { useAdminAuth } from "../AdminAuthContext";
import { PromotionsManager } from "../components/PromotionsManager";
import { useToast } from "../components/ToastContext";
import { AdminButton, AdminInput, AdminNumberInput, AdminSelect, Card, PageHeader, PageLoading } from "../components/ui";
import { logActivity } from "../logActivity";
import { POS_DISCOUNT_POLICY_DEFAULTS } from "../posDiscounts";
import { POS_RANGES, rangeBounds, toInputDate, type PosRange } from "../posDateRange";
import type { AdminOrder, Branch, PosDiscountPolicyDoc, Register } from "../types";

const FILTER_CONTROL = "!w-auto !py-1.5 min-w-[9rem]";

// Discounts at the till, owner/admin only: the cashier limit (the one place
// it's set -- the till and the server rules both read settings/posDiscounts)
// and every discount actually given, by date, branch, register and cashier.
export default function PosDiscounts() {
  const { t, lang } = useLanguage();
  const toast = useToast();
  const { profile } = useAdminAuth();
  const [policy, setPolicy] = useState<PosDiscountPolicyDoc | null>(null);
  const [limitDraft, setLimitDraft] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [registers, setRegisters] = useState<Register[]>([]);
  const [orders, setOrders] = useState<AdminOrder[] | null>(null);
  const [range, setRange] = useState<PosRange>("today");
  const [from, setFrom] = useState(toInputDate(new Date()));
  const [to, setTo] = useState(toInputDate(new Date()));
  const [branchFilter, setBranchFilter] = useState("all");
  const [registerFilter, setRegisterFilter] = useState("all");
  const [cashierFilter, setCashierFilter] = useState("all");
  // Automatic promotions (created here) | manual discounts typed at the till.
  const [tab, setTab] = useState<"promotions" | "manual">("promotions");

  const { start, end } = useMemo(() => rangeBounds(range, from, to), [range, from, to]);

  useEffect(() => {
    branchesApi.list().then((b) => setBranches(b.sort((x, y) => x.name.localeCompare(y.name))));
    const u1 = registersApi.subscribe(setRegisters);
    const u2 = subscribeSingletonDoc<PosDiscountPolicyDoc>("settings", "posDiscounts", (d) => {
      const p = { ...POS_DISCOUNT_POLICY_DEFAULTS, ...d };
      setPolicy(p);
      setLimitDraft(p.cashierMaxPercent);
    });
    return () => {
      u1();
      u2();
    };
  }, []);

  useEffect(() => {
    setOrders(null);
    return ordersApi.subscribe(setOrders, [
      where("source", "==", "pos"),
      where("createdAt", ">=", Timestamp.fromDate(start)),
      where("createdAt", "<", Timestamp.fromDate(end)),
      orderBy("createdAt", "desc"),
    ]);
  }, [start, end]);

  async function saveLimit() {
    if (limitDraft === null) return;
    const cashierMaxPercent = Math.max(0, Math.min(100, Math.round(limitDraft * 100) / 100));
    setSaving(true);
    try {
      await setSingletonDoc("settings", "posDiscounts", { cashierMaxPercent });
      if (profile) await logActivity(profile, "settings.posDiscountsUpdated", `${cashierMaxPercent}%`);
      toast.success(t("admin.settings.saved"));
    } catch {
      toast.error(t("admin.settings.posDiscounts.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  // Sales in the window (not cancelled) that match the filters; the
  // discounted ones are what the report lists.
  const inScope = useMemo(
    () =>
      (orders ?? []).filter(
        (o) =>
          o.status !== "cancelled" &&
          (branchFilter === "all" || o.branchId === branchFilter) &&
          (registerFilter === "all" || o.registerId === registerFilter) &&
          (cashierFilter === "all" || (o.operatorId ?? o.cashierUid) === cashierFilter)
      ),
    [orders, branchFilter, registerFilter, cashierFilter]
  );
  const discounted = useMemo(() => inScope.filter((o) => (o.discount ?? 0) > 0), [inScope]);
  // The two parts of a sale's discount (older sales: all manual).
  const promoOf = (o: AdminOrder) => o.promoDiscount ?? 0;
  const manualOf = (o: AdminOrder) => o.manualDiscount ?? (o.promoDiscount ? 0 : (o.discount ?? 0));

  const cashiers = useMemo(() => {
    const m = new Map<string, string>();
    (orders ?? []).forEach((o) => {
      const id = o.operatorId ?? o.cashierUid;
      if (id) m.set(id, o.cashierName ?? id);
    });
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [orders]);

  const kpis = useMemo(() => {
    const total = discounted.reduce((s, o) => s + (o.discount ?? 0), 0);
    const discountedGross = discounted.reduce((s, o) => s + o.subtotal, 0);
    return {
      count: discounted.length,
      share: inScope.length ? (discounted.length / inScope.length) * 100 : 0,
      total,
      promo: discounted.reduce((s, o) => s + promoOf(o), 0),
      manual: discounted.reduce((s, o) => s + manualOf(o), 0),
      avg: discounted.length ? total / discounted.length : 0,
      rate: discountedGross ? (total / discountedGross) * 100 : 0,
    };
  }, [discounted, inScope]);

  // Per cashier: who gives discounts, how often and how much.
  const byCashier = useMemo(() => {
    const m = new Map<string, { name: string; sales: number; discounted: number; total: number; max: number }>();
    inScope.forEach((o) => {
      const id = o.operatorId ?? o.cashierUid ?? "—";
      const e = m.get(id) ?? { name: o.cashierName ?? "—", sales: 0, discounted: 0, total: 0, max: 0 };
      e.sales += 1;
      const manualAmount = manualOf(o);
      if (manualAmount > 0) {
        e.discounted += 1;
        e.total += manualAmount;
        e.max = Math.max(e.max, o.subtotal - promoOf(o) > 0 ? (manualAmount / (o.subtotal - promoOf(o))) * 100 : 0);
      }
      m.set(id, e);
    });
    return [...m.values()].filter((e) => e.discounted > 0).sort((a, b) => b.total - a.total);
  }, [inScope]);

  const registerOptions = registers.filter((r) => branchFilter === "all" || r.branchId === branchFilter).sort((a, b) => a.name.localeCompare(b.name));
  const branchLabel = (id?: string) => {
    const b = branches.find((x) => x.id === id);
    return b ? localizedName(b.name, b.nameAr, lang) : "—";
  };
  const fmtTime = (v: unknown) => {
    const d = tsDate(v);
    if (!d) return "—";
    return d.toLocaleString(lang === "ar" ? "ar" : "en-US", range === "today" ? { hour: "2-digit", minute: "2-digit" } : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  };
  const pct = (n: number) => `${Math.round(n * 10) / 10}%`;

  return (
    <div>
      <PageHeader title={t("admin.nav.posDiscounts")} description={t("admin.posDiscounts.subtitle")} />

      <div className="mb-4 flex rounded-lg border border-line bg-paper p-0.5 sm:w-fit" role="tablist">
        {(["promotions", "manual"] as const).map((x) => (
          <button
            key={x}
            role="tab"
            aria-selected={tab === x}
            onClick={() => setTab(x)}
            className={`flex-1 whitespace-nowrap rounded-md px-4 py-1.5 text-sm font-semibold ${tab === x ? "bg-wine text-on-accent" : "text-ink-soft hover:text-ink"}`}
          >
            {t(`admin.posDiscounts.tab.${x}`)}
          </button>
        ))}
      </div>

      {/* The cashier limit: read live by every till and enforced by the server. */}
      <Card className={`mb-4 flex-wrap items-end gap-3 p-4 ${tab === "manual" ? "flex" : "hidden"}`}>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-ink">{t("admin.settings.posDiscounts.cashierMax")}</p>
          <p className="text-xs text-ink-faint">{t("admin.posDiscounts.limitHint")}</p>
        </div>
        {policy === null ? (
          <PageLoading />
        ) : (
          <>
            <div className="flex items-center gap-1.5">
              <AdminNumberInput min={0} max={100} value={limitDraft} onChange={setLimitDraft} className="!w-24 !py-1.5 text-end" />
              <span className="text-sm font-semibold text-ink-soft">%</span>
            </div>
            <AdminButton variant="primary" loading={saving} disabled={limitDraft === null || limitDraft === policy.cashierMaxPercent} onClick={() => void saveLimit()}>
              {t("admin.settings.save")}
            </AdminButton>
          </>
        )}
      </Card>

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
        </div>
      </div>

      {tab === "promotions" && <PromotionsManager branches={branches} orders={orders === null ? null : inScope} />}

      {tab === "manual" && orders === null ? (
        <PageLoading />
      ) : tab === "manual" ? (
        <>
          <Card className="mb-4 grid grid-cols-2 divide-line overflow-hidden p-0 sm:grid-cols-5 sm:divide-x rtl:sm:divide-x-reverse">
            {[
              { label: t("admin.posDiscounts.discountedSales"), value: `${kpis.count}`, sub: `${pct(kpis.share)} ${t("admin.posDiscounts.ofSales")}` },
              { label: t("admin.posDiscounts.totalGiven"), value: kpis.total > 0 ? `-${formatPrice(kpis.total)}` : formatPrice(0), accent: true },
              { label: t("admin.posDiscounts.byPromotions"), value: kpis.promo > 0 ? `-${formatPrice(kpis.promo)}` : formatPrice(0) },
              { label: t("admin.posDiscounts.byManual"), value: kpis.manual > 0 ? `-${formatPrice(kpis.manual)}` : formatPrice(0) },
              { label: t("admin.posDiscounts.avgRate"), value: pct(kpis.rate), sub: `${t("admin.posDiscounts.avgDiscount")} ${formatPrice(kpis.avg)}` },
            ].map((k) => (
              <div key={k.label} className={`px-4 py-3 ${k.accent ? "bg-wine-light/50" : ""}`}>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">{k.label}</p>
                <p className={`mt-0.5 font-display text-lg font-bold ${k.accent ? "text-wine" : "text-ink"}`}>{k.value}</p>
                {k.sub && <p className="text-[11px] text-ink-faint">{k.sub}</p>}
              </div>
            ))}
          </Card>

          {byCashier.length > 0 && (
            <Card className="mb-4 overflow-x-auto p-0">
              <table className="w-full text-sm">
                <thead className="whitespace-nowrap bg-cream-dim text-xs uppercase text-ink-faint">
                  <tr>
                    <th className="px-4 py-2 text-start">{t("pos.branch.cashier")}</th>
                    <th className="px-4 py-2 text-end">{t("admin.posDiscounts.discountedSales")}</th>
                    <th className="px-4 py-2 text-end">{t("admin.posDiscounts.highest")}</th>
                    <th className="px-4 py-2 text-end">{t("admin.posDiscounts.totalGiven")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {byCashier.map((c) => (
                    <tr key={c.name}>
                      <td className="px-4 py-2 font-semibold text-ink">{c.name}</td>
                      <td className="px-4 py-2 text-end">
                        {c.discounted} / {c.sales}
                      </td>
                      <td className="px-4 py-2 text-end">{pct(c.max)}</td>
                      <td className="px-4 py-2 text-end font-semibold text-wine">-{formatPrice(c.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}

          <h2 className="mb-2 flex items-center gap-2 font-display text-base font-bold text-ink">
            {t("admin.posDiscounts.discountedSalesList")}
            <span className="rounded-full bg-cream-dim px-2 py-0.5 text-xs font-bold text-ink-soft">{discounted.length}</span>
          </h2>
          {discounted.length === 0 ? (
            <Card className="px-4 py-5 text-center text-sm text-ink-faint">{t("admin.posDiscounts.none")}</Card>
          ) : (
            <Card className="overflow-x-auto p-0">
              <table className="w-full text-sm">
                <thead className="whitespace-nowrap bg-cream-dim text-xs uppercase text-ink-faint">
                  <tr>
                    <th className="px-3 py-2 text-start">{t("pos.branch.time")}</th>
                    <th className="px-3 py-2 text-start">#</th>
                    <th className="px-3 py-2 text-start">{t("pos.branch.branch")}</th>
                    <th className="px-3 py-2 text-start">{t("pos.branch.cashier")}</th>
                    <th className="px-3 py-2 text-end">{t("admin.orderDetail.subtotal")}</th>
                    <th className="px-3 py-2 text-end">{t("pos.terminal.discountLabel")}</th>
                    <th className="px-3 py-2 text-end">{t("admin.orders.colTotal")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {discounted.map((o) => {
                    const rate = o.subtotal ? ((o.discount ?? 0) / o.subtotal) * 100 : 0;
                    return (
                      <tr key={o.id} className="hover:bg-cream-dim/50">
                        <td className="whitespace-nowrap px-3 py-2 text-ink-soft">{fmtTime(o.createdAt)}</td>
                        <td className="px-3 py-2">
                          <Link to={`/admin/orders/${o.id}`} className="font-mono text-xs font-semibold text-wine hover:underline">
                            {o.orderNumber}
                          </Link>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-ink">
                          {o.branchCode ?? branchLabel(o.branchId)} · {o.registerName ?? "—"}
                        </td>
                        <td className="px-3 py-2 text-ink">{o.cashierName ?? "—"}</td>
                        <td className="px-3 py-2 text-end">{formatPrice(o.subtotal)}</td>
                        <td className="whitespace-nowrap px-3 py-2 text-end font-semibold text-wine">
                          -{formatPrice(o.discount ?? 0)} <span className="text-[11px] font-normal text-ink-faint">({o.discountPercent ? `${o.discountPercent}%` : pct(rate)})</span>
                          {promoOf(o) > 0 && (
                            <span className="block text-[11px] font-normal text-olive">
                              {o.promotions?.map((x) => x.name).join(", ")} -{formatPrice(promoOf(o))}
                            </span>
                          )}
                          {promoOf(o) > 0 && manualOf(o) > 0 && (
                            <span className="block text-[11px] font-normal text-ink-faint">
                              {t("pos.discount.manual")} -{formatPrice(manualOf(o))}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-end font-semibold text-ink">{formatPrice(o.total)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Card>
          )}
        </>
      ) : null}
    </div>
  );
}
