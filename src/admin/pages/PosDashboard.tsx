import { orderBy, limit, Timestamp, where } from "firebase/firestore";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { activityLogApi, branchesApi, ordersApi, productsApi, registersApi, registerSessionsApi } from "../../firebase/collections";
import { useLanguage } from "../../context/LanguageContext";
import { useAdminAuth } from "../AdminAuthContext";
import { activityActionLabel } from "../activityActions";
import { localizedName } from "../../data/localize";
import AdminIcon from "../components/AdminIcons";
import { Badge, Card, PageHeader } from "../components/ui";
import { normalizeProduct, totalStock } from "../productVariants";
import type { ActivityLogEntry, AdminOrder, AdminProduct, Branch, Register, RegisterSession } from "../types";
import { formatPrice } from "../../utils/currency";

// Same roles navConfig.ts gives the POS group (POS Sales, Branches): only
// they get the sales/shift widgets. Everyone else sees catalog + stock.
const POS_ROLES = ["owner", "admin"] as const;

function tsToDate(v: unknown): Date | null {
  const ts = v as { toDate?: () => Date } | undefined;
  return ts?.toDate ? ts.toDate() : null;
}

function timeAgo(value: unknown, t: (key: string) => string): string {
  const date = tsToDate(value);
  if (!date) return "";
  const seconds = Math.max(0, (Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return t("admin.dashboard.justNow");
  if (seconds < 3600) return t("admin.dashboard.minAgo").replace("{n}", String(Math.floor(seconds / 60)));
  if (seconds < 86400) return t("admin.dashboard.hourAgo").replace("{n}", String(Math.floor(seconds / 3600)));
  return t("admin.dashboard.dayAgo").replace("{n}", String(Math.floor(seconds / 86400)));
}

// The admin landing page: today's in-store sales, open shifts, registers,
// and stock that needs attention. Online-store figures (web orders,
// customers, reviews) live on the original Dashboard, still routed at
// /admin/store-dashboard but not linked from the POS-focused admin menu.
export default function PosDashboard() {
  const { profile, hasRole } = useAdminAuth();
  const { t, lang } = useLanguage();
  const canSeePos = hasRole([...POS_ROLES]);
  const [sales, setSales] = useState<AdminOrder[] | null>(null);
  const [openSessions, setOpenSessions] = useState<RegisterSession[]>([]);
  const [registers, setRegisters] = useState<Register[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [products, setProducts] = useState<AdminProduct[] | null>(null);
  const [recentActivity, setRecentActivity] = useState<ActivityLogEntry[]>([]);

  useEffect(() => {
    if (!canSeePos) return;
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    // Same query shape as PosSales' "today" range, so it reuses its index.
    const u1 = ordersApi.subscribe(setSales, [where("source", "==", "pos"), where("createdAt", ">=", Timestamp.fromDate(start)), orderBy("createdAt", "desc")]);
    const u2 = registerSessionsApi.subscribe(setOpenSessions, [where("status", "==", "open")]);
    const u3 = registersApi.subscribe(setRegisters);
    branchesApi
      .list()
      .then(setBranches)
      .catch(() => {});
    return () => {
      u1();
      u2();
      u3();
    };
  }, [canSeePos]);

  useEffect(() => {
    productsApi
      .list()
      .then((p) => setProducts(p.map(normalizeProduct)))
      .catch(() => setProducts([]));
    activityLogApi
      .list([orderBy("createdAt", "desc"), limit(8)])
      .then(setRecentActivity)
      .catch(() => {});
  }, []);

  const completed = useMemo(() => (sales ?? []).filter((o) => o.status !== "cancelled"), [sales]);
  const kpis = useMemo(() => {
    const gross = completed.reduce((s, o) => s + o.total, 0);
    return {
      gross,
      count: completed.length,
      avg: completed.length ? gross / completed.length : 0,
      cash: completed.reduce((s, o) => s + (o.cashAmount ?? 0), 0),
      card: completed.reduce((s, o) => s + (o.cardAmount ?? 0), 0),
    };
  }, [completed]);

  const lowStock = useMemo(() => (products ?? []).filter((p) => p.status === "active" && totalStock(p) > 0 && totalStock(p) <= 3), [products]);
  const activeRegisters = registers.filter((r) => r.active);
  const activeBranches = branches.filter((b) => b.active);

  const branchName = (id?: string, fallback?: string) => {
    const b = branches.find((x) => x.id === id);
    return b ? localizedName(b.name, b.nameAr, lang) : (fallback ?? "—");
  };

  const fmtTime = (v: unknown) => {
    const d = tsToDate(v);
    return d ? d.toLocaleTimeString(lang === "ar" ? "ar" : "en-US", { hour: "2-digit", minute: "2-digit" }) : "—";
  };

  const dash = "—";
  const stats = [
    ...(canSeePos
      ? [
          { label: t("admin.posDashboard.salesToday"), value: sales ? formatPrice(kpis.gross) : dash, icon: "chart", to: "/admin/pos-sales" },
          { label: t("admin.posDashboard.transactionsToday"), value: sales ? kpis.count : dash, icon: "bag", to: "/admin/pos-sales" },
          { label: t("admin.posSales.avgTicket"), value: sales ? formatPrice(kpis.avg) : dash, icon: "tag", to: "/admin/pos-sales" },
          { label: t("admin.posDashboard.openShifts"), value: openSessions.length, icon: "history", to: "/admin/pos-sales" },
          { label: t("admin.posDashboard.activeRegisters"), value: `${activeRegisters.length}`, icon: "grid", to: "/admin/branches" },
        ]
      : []),
    { label: t("admin.nav.products"), value: products ? products.length : dash, icon: "shirt", to: "/admin/products" },
    { label: t("admin.dashboard.lowStock"), value: products ? lowStock.length : dash, icon: "box", to: "/admin/inventory" },
  ];

  const quickActions = [
    ...(canSeePos
      ? [
          { label: t("admin.posDashboard.openPos"), icon: "grid", to: "/pos" },
          { label: t("admin.nav.posSales"), icon: "chart", to: "/admin/pos-sales" },
          { label: t("admin.nav.branches"), icon: "map", to: "/admin/branches" },
        ]
      : []),
    { label: t("admin.nav.inventory"), icon: "box", to: "/admin/inventory" },
    { label: t("admin.nav.branchStock"), icon: "box", to: "/admin/branch-stock" },
    ...(hasRole(["owner"]) ? [{ label: t("admin.nav.team"), icon: "shield", to: "/admin/team" }] : []),
  ];

  return (
    <div>
      <PageHeader
        title={`${t("admin.dashboard.welcomeBack")}${profile?.displayName ? (lang === "ar" ? "، " : ", ") + profile.displayName.split(" ")[0] : ""}`}
        description={t("admin.posDashboard.subtitle")}
      />

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-7">
        {stats.map((s) => (
          <Link key={s.label} to={s.to}>
            <Card className="h-full p-4 transition-shadow hover:shadow-card">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-wine-light text-wine">
                <AdminIcon name={s.icon} className="h-4.5 w-4.5" />
              </div>
              <p className="mt-3 text-2xl font-bold text-ink">{s.value}</p>
              <p className="text-xs font-semibold text-ink-soft">{s.label}</p>
            </Card>
          </Link>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {quickActions.map((a) => (
          <Link
            key={a.to}
            to={a.to}
            className="flex items-center gap-2 rounded-lg border border-line bg-paper px-3 py-2 text-sm font-semibold text-wine hover:bg-cream-dim"
          >
            <AdminIcon name={a.icon} className="h-4 w-4" />
            {a.label}
          </Link>
        ))}
      </div>

      {canSeePos && (
        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
          <Card className="p-5 lg:col-span-2">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-display text-lg font-bold text-ink">{t("admin.posDashboard.recentSales")}</h2>
              <Link to="/admin/pos-sales" className="text-sm font-semibold text-wine hover:underline">
                {t("admin.common.viewAll")}
              </Link>
            </div>
            {completed.length === 0 ? (
              <p className="py-8 text-center text-sm text-ink-faint">{t("admin.posSales.noSales")}</p>
            ) : (
              <div className="flex flex-col divide-y divide-line">
                {completed.slice(0, 6).map((o) => (
                  <Link key={o.id} to={`/admin/orders/${o.id}`} className="flex items-center justify-between gap-3 py-3 hover:opacity-80">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-ink">#{o.orderNumber}</p>
                      <p className="truncate text-xs text-ink-soft">
                        {branchName(o.branchId, o.branchName)}
                        {o.registerName ? ` · ${o.registerName}` : ""}
                        {o.cashierName ? ` · ${o.cashierName}` : ""}
                      </p>
                    </div>
                    <div className="shrink-0 text-end">
                      <p className="text-sm font-semibold text-ink">{formatPrice(o.total)}</p>
                      <p className="text-xs text-ink-faint">{fmtTime(o.createdAt)}</p>
                    </div>
                  </Link>
                ))}
              </div>
            )}
            {completed.length > 0 && (
              <div className="mt-3 flex gap-4 border-t border-line pt-3 text-xs font-semibold text-ink-soft">
                <span>
                  {t("admin.posDashboard.cash")}: <span className="text-ink">{formatPrice(kpis.cash)}</span>
                </span>
                <span>
                  {t("admin.posDashboard.card")}: <span className="text-ink">{formatPrice(kpis.card)}</span>
                </span>
              </div>
            )}
          </Card>

          <Card className="p-5">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-display text-lg font-bold text-ink">{t("admin.posDashboard.openShifts")}</h2>
              <Link to="/admin/pos-sales" className="text-sm font-semibold text-wine hover:underline">
                {t("admin.common.viewAll")}
              </Link>
            </div>
            {openSessions.length === 0 ? (
              <p className="py-8 text-center text-sm text-ink-faint">{t("admin.posDashboard.noOpenShifts")}</p>
            ) : (
              <div className="flex flex-col divide-y divide-line">
                {openSessions.map((s) => (
                  <div key={s.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-ink">{s.cashierName}</p>
                      <p className="truncate text-xs text-ink-soft">
                        {branchName(s.branchId, s.branchName)}
                        {s.registerName ? ` · ${s.registerName}` : ""} · {fmtTime(s.openedAt)}
                      </p>
                    </div>
                    <Badge tone="success">{formatPrice(s.grossTotal ?? 0)}</Badge>
                  </div>
                ))}
              </div>
            )}
            <p className="mt-3 border-t border-line pt-3 text-xs font-semibold text-ink-soft">
              {t("admin.posDashboard.branchesSummary")
                .replace("{branches}", String(activeBranches.length))
                .replace("{registers}", String(activeRegisters.length))}
            </p>
          </Card>
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-2">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-display text-lg font-bold text-ink">{t("admin.dashboard.lowStock")}</h2>
            <Link to="/admin/inventory" className="text-sm font-semibold text-wine hover:underline">
              {t("admin.dashboard.manageInventory")}
            </Link>
          </div>
          {lowStock.length === 0 ? (
            <p className="py-8 text-center text-sm text-ink-faint">{t("admin.posDashboard.noLowStock")}</p>
          ) : (
            <div className="flex flex-col divide-y divide-line">
              {lowStock.slice(0, 6).map((p) => (
                <Link key={p.id} to={`/admin/products/${p.id}`} className="flex items-center justify-between py-2.5 text-sm hover:opacity-80">
                  <span className="font-medium text-ink">{localizedName(p.name, p.nameAr, lang)}</span>
                  <span className="font-semibold text-wine">
                    {totalStock(p)} {t("admin.dashboard.left")}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </Card>

        <Card className="p-5">
          <h2 className="mb-4 font-display text-lg font-bold text-ink">{t("admin.dashboard.recentActivity")}</h2>
          {recentActivity.length === 0 ? (
            <p className="py-8 text-center text-sm text-ink-faint">{t("admin.dashboard.noActivityYet")}</p>
          ) : (
            <div className="flex flex-col gap-3.5">
              {recentActivity.map((a) => (
                <div key={a.id} className="flex gap-2.5 text-sm">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-wine" />
                  <div>
                    <p className="text-ink">
                      <span className="font-semibold">{a.actorName}</span> {activityActionLabel(t, a.action)}
                    </p>
                    <p className="text-xs text-ink-faint">
                      {a.target} · {timeAgo(a.createdAt, t)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
