import { useEffect, useMemo, useState } from "react";
import { ordersApi, productsApi } from "../../firebase/collections";
import { useLanguage } from "../../context/LanguageContext";
import { Card, EmptyState, PageHeader, PageLoading } from "../components/ui";
import type { AdminOrder, AdminProduct } from "../types";
import { formatPrice } from "../../utils/currency";

function tsToDate(v: unknown): Date | null {
  const ts = v as { toDate?: () => Date } | undefined;
  return ts?.toDate ? ts.toDate() : null;
}

export default function Reports() {
  const { t, lang } = useLanguage();
  const [orders, setOrders] = useState<AdminOrder[]>([]);
  const [products, setProducts] = useState<AdminProduct[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([ordersApi.list(), productsApi.list()]).then(([o, p]) => {
      setOrders(o);
      setProducts(p);
      setLoading(false);
    });
  }, []);

  const validOrders = useMemo(() => orders.filter((o) => o.status !== "cancelled"), [orders]);
  const totalRevenue = useMemo(() => validOrders.reduce((s, o) => s + o.total, 0), [validOrders]);
  const avgOrderValue = validOrders.length ? totalRevenue / validOrders.length : 0;

  const dailyRevenue = useMemo(() => {
    const days: { label: string; total: number }[] = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      d.setHours(0, 0, 0, 0);
      days.push({ label: d.toLocaleDateString(lang === "ar" ? "ar" : "en-US", { month: "short", day: "numeric" }), total: 0 });
    }
    validOrders.forEach((o) => {
      const date = tsToDate(o.createdAt);
      if (!date) return;
      const diffDays = Math.floor((Date.now() - date.getTime()) / 86400000);
      if (diffDays >= 0 && diffDays < 14) {
        days[13 - diffDays].total += o.total;
      }
    });
    return days;
  }, [validOrders, lang]);

  const maxDaily = Math.max(1, ...dailyRevenue.map((d) => d.total));

  const topProducts = useMemo(() => {
    const counts = new Map<string, { name: string; qty: number; revenue: number }>();
    validOrders.forEach((o) => {
      o.lines.forEach((line) => {
        const existing = counts.get(line.name) ?? { name: line.name, qty: 0, revenue: 0 };
        existing.qty += line.qty;
        existing.revenue += line.price * line.qty;
        counts.set(line.name, existing);
      });
    });
    return [...counts.values()].sort((a, b) => b.qty - a.qty).slice(0, 5);
  }, [validOrders]);

  const statusBreakdown = useMemo(() => {
    const counts: Record<string, number> = {};
    orders.forEach((o) => {
      counts[o.status] = (counts[o.status] ?? 0) + 1;
    });
    return counts;
  }, [orders]);

  if (loading) return <PageLoading />;

  return (
    <div>
      <PageHeader title={t("admin.nav.reports")} description={t("admin.reports.subtitle")} />

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Card className="p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">{t("admin.dashboard.revenue")}</p>
          <p className="mt-1 text-2xl font-bold text-ink">{formatPrice(totalRevenue)}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">{t("admin.nav.orders")}</p>
          <p className="mt-1 text-2xl font-bold text-ink">{orders.length}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">{t("admin.reports.avgOrderValue")}</p>
          <p className="mt-1 text-2xl font-bold text-ink">{formatPrice(avgOrderValue)}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">{t("admin.nav.products")}</p>
          <p className="mt-1 text-2xl font-bold text-ink">{products.length}</p>
        </Card>
      </div>

      <Card className="mt-6 p-5">
        <h2 className="mb-5 font-display text-base font-bold text-ink">{t("admin.reports.revenue14days")}</h2>
        {totalRevenue === 0 ? (
          <EmptyState icon="chart" title={t("admin.reports.noRevenueYet")} body={t("admin.reports.chartsBody")} />
        ) : (
          <div className="flex h-40 items-end gap-2">
            {dailyRevenue.map((d) => (
              <div key={d.label} className="flex flex-1 flex-col items-center gap-1.5">
                <div className="w-full rounded-t-md bg-wine transition-all" style={{ height: `${Math.max(4, (d.total / maxDaily) * 100)}%` }} title={formatPrice(d.total)} />
                <span className="text-[10px] text-ink-faint">{d.label}</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card className="p-5">
          <h2 className="mb-4 font-display text-base font-bold text-ink">{t("admin.reports.topProducts")}</h2>
          {topProducts.length === 0 ? (
            <p className="text-sm text-ink-faint">{t("admin.reports.noSalesYet")}</p>
          ) : (
            <div className="flex flex-col divide-y divide-line">
              {topProducts.map((p) => (
                <div key={p.name} className="flex items-center justify-between py-2.5 text-sm">
                  <span className="font-medium text-ink">{p.name}</span>
                  <span className="text-ink-soft">
                    {p.qty} {t("admin.reports.sold")} · {formatPrice(p.revenue)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card className="p-5">
          <h2 className="mb-4 font-display text-base font-bold text-ink">{t("admin.reports.ordersByStatus")}</h2>
          {orders.length === 0 ? (
            <p className="text-sm text-ink-faint">{t("admin.dashboard.noOrdersYet")}</p>
          ) : (
            <div className="flex flex-col gap-2.5">
              {Object.entries(statusBreakdown).map(([status, count]) => (
                <div key={status} className="flex items-center gap-3">
                  <span className="w-24 shrink-0 text-sm capitalize text-ink-soft">{t(`admin.orderStatus.${status}`)}</span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-cream-dim">
                    <div className="h-full rounded-full bg-wine" style={{ width: `${(count / orders.length) * 100}%` }} />
                  </div>
                  <span className="w-6 shrink-0 text-end text-sm font-semibold text-ink">{count}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
