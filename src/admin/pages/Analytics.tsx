import { collection, getCountFromServer, limit, orderBy, query, Timestamp, where } from "firebase/firestore";
import { useEffect, useMemo, useState } from "react";
import { db } from "../../firebase/config";
import {
  analyticsDailyApi,
  categoriesApi,
  categoryStatsApi,
  categoryViewsDailyApi,
  productsApi,
  productStatsApi,
  productViewsDailyApi,
} from "../../firebase/collections";
import { useLanguage } from "../../context/LanguageContext";
import { localizedName } from "../../data/localize";
import AdminIcon from "../components/AdminIcons";
import { Card, EmptyState, PageHeader, PageLoading } from "../components/ui";
import { resolveProductImageSrc } from "../imageSrc";
import { normalizeProduct } from "../productVariants";
import type {
  AdminCategory,
  AdminProduct,
  AnalyticsDailyDoc,
  CategoryStatsDoc,
  CategoryViewDailyDoc,
  ProductStatsDoc,
  ProductViewDailyDoc,
} from "../types";

type RangeKey = "today" | "7d" | "30d" | "all";

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function dateKeyDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function rangeCutoff(range: RangeKey): string | null {
  if (range === "today") return todayKey();
  if (range === "7d") return dateKeyDaysAgo(6);
  if (range === "30d") return dateKeyDaysAgo(29);
  return null;
}

function sumRange(docs: AnalyticsDailyDoc[], cutoff: string | null) {
  return docs.reduce(
    (acc, d) => {
      if (cutoff && d.date < cutoff) return acc;
      acc.visits += d.visits ?? 0;
      acc.pageviews += d.pageviews ?? 0;
      return acc;
    },
    { visits: 0, pageviews: 0 }
  );
}

const RANGE_OPTIONS: { key: RangeKey; labelKey: string }[] = [
  { key: "today", labelKey: "admin.analytics.rangeToday" },
  { key: "7d", labelKey: "admin.analytics.range7d" },
  { key: "30d", labelKey: "admin.analytics.range30d" },
  { key: "all", labelKey: "admin.analytics.rangeAll" },
];

function RangeTabs({ value, onChange }: { value: RangeKey; onChange: (v: RangeKey) => void }) {
  const { t } = useLanguage();
  return (
    <div className="flex gap-1 rounded-lg bg-cream-dim p-1">
      {RANGE_OPTIONS.map((o) => (
        <button
          key={o.key}
          onClick={() => onChange(o.key)}
          className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
            value === o.key ? "bg-paper text-ink shadow-soft" : "text-ink-soft hover:text-ink"
          }`}
        >
          {t(o.labelKey)}
        </button>
      ))}
    </div>
  );
}

export default function Analytics() {
  const { t, lang } = useLanguage();
  const [loading, setLoading] = useState(true);
  const [liveCount, setLiveCount] = useState<number | null>(null);
  const [dailyDocs, setDailyDocs] = useState<AnalyticsDailyDoc[]>([]);
  const [products, setProducts] = useState<AdminProduct[]>([]);
  const [categories, setCategories] = useState<AdminCategory[]>([]);
  const [productStats, setProductStats] = useState<ProductStatsDoc[]>([]);
  const [categoryStats, setCategoryStats] = useState<CategoryStatsDoc[]>([]);
  const [productViewsDaily, setProductViewsDaily] = useState<ProductViewDailyDoc[]>([]);
  const [categoryViewsDaily, setCategoryViewsDaily] = useState<CategoryViewDailyDoc[]>([]);
  const [productRange, setProductRange] = useState<RangeKey>("7d");
  const [categoryRange, setCategoryRange] = useState<RangeKey>("7d");

  useEffect(() => {
    const cutoff30 = dateKeyDaysAgo(29);
    Promise.all([
      analyticsDailyApi.list([orderBy("date", "desc"), limit(3650)]),
      productsApi.list(),
      categoriesApi.list(),
      productStatsApi.list(),
      categoryStatsApi.list(),
      productViewsDailyApi.list([where("date", ">=", cutoff30)]),
      categoryViewsDailyApi.list([where("date", ">=", cutoff30)]),
    ]).then(([daily, prods, cats, pStats, cStats, pViewsDaily, cViewsDaily]) => {
      setDailyDocs(daily);
      setProducts(prods.map(normalizeProduct));
      setCategories(cats);
      setProductStats(pStats);
      setCategoryStats(cStats);
      setProductViewsDaily(pViewsDaily);
      setCategoryViewsDaily(cViewsDaily);
      setLoading(false);
    }).catch(() => {
      setLoading(false);
    });
  }, []);

  // Polled rather than a live onSnapshot listener — a getCountFromServer()
  // aggregation is a cheap fixed-cost read regardless of how many visitors
  // match, while an onSnapshot on a query that could match hundreds of
  // constantly-heartbeating presence docs would push a lot more data for a
  // widget that only needs to show one number.
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const cutoff = Timestamp.fromMillis(Date.now() - 90_000);
        const snap = await getCountFromServer(query(collection(db, "presence"), where("lastSeen", ">", cutoff)));
        if (!cancelled) setLiveCount(snap.data().count);
      } catch {
        if (!cancelled) setLiveCount(0);
      }
    }
    poll();
    const timer = window.setInterval(poll, 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const todayStats = useMemo(() => dailyDocs.find((d) => d.date === todayKey()), [dailyDocs]);
  const weekStats = useMemo(() => sumRange(dailyDocs, dateKeyDaysAgo(6)), [dailyDocs]);
  const monthStats = useMemo(() => sumRange(dailyDocs, dateKeyDaysAgo(29)), [dailyDocs]);
  const allTimeStats = useMemo(() => sumRange(dailyDocs, null), [dailyDocs]);

  const dailyChart = useMemo(() => {
    const days: { label: string; visits: number }[] = [];
    for (let i = 13; i >= 0; i--) {
      const key = dateKeyDaysAgo(i);
      const match = dailyDocs.find((d) => d.date === key);
      const d = new Date();
      d.setDate(d.getDate() - i);
      days.push({ label: d.toLocaleDateString(lang === "ar" ? "ar" : "en-US", { month: "short", day: "numeric" }), visits: match?.visits ?? 0 });
    }
    return days;
  }, [dailyDocs, lang]);
  const maxDailyVisits = Math.max(1, ...dailyChart.map((d) => d.visits));

  const topProducts = useMemo(() => {
    const byId = new Map<string, { views: number; quickAdds: number }>();
    if (productRange === "all") {
      productStats.forEach((p) => byId.set(p.id, { views: p.views ?? 0, quickAdds: p.quickAdds ?? 0 }));
    } else {
      const cutoff = rangeCutoff(productRange)!;
      productViewsDaily.forEach((row) => {
        if (row.date < cutoff) return;
        const cur = byId.get(row.productId) ?? { views: 0, quickAdds: 0 };
        cur.views += row.views ?? 0;
        cur.quickAdds += row.quickAdds ?? 0;
        byId.set(row.productId, cur);
      });
    }
    return [...byId.entries()]
      .map(([id, stats]) => {
        const product = products.find((p) => p.id === id);
        return { id, name: product ? localizedName(product.name, product.nameAr, lang) : id, image: product ? resolveProductImageSrc(product) : "", ...stats };
      })
      .filter((p) => p.views + p.quickAdds > 0)
      .sort((a, b) => (b.views + b.quickAdds) - (a.views + a.quickAdds))
      .slice(0, 8);
  }, [productRange, productStats, productViewsDaily, products, lang]);

  const topCategories = useMemo(() => {
    const byId = new Map<string, number>();
    if (categoryRange === "all") {
      categoryStats.forEach((c) => byId.set(c.id, c.views ?? 0));
    } else {
      const cutoff = rangeCutoff(categoryRange)!;
      categoryViewsDaily.forEach((row) => {
        if (row.date < cutoff) return;
        byId.set(row.category, (byId.get(row.category) ?? 0) + (row.views ?? 0));
      });
    }
    return [...byId.entries()]
      .map(([id, views]) => {
        const cat = categories.find((c) => c.slug === id);
        return { id, name: cat ? localizedName(cat.name, cat.nameAr, lang) : id, views };
      })
      .filter((c) => c.views > 0)
      .sort((a, b) => b.views - a.views)
      .slice(0, 8);
  }, [categoryRange, categoryStats, categoryViewsDaily, categories, lang]);

  if (loading) return <PageLoading />;

  const maxProductScore = topProducts.length ? topProducts[0].views + topProducts[0].quickAdds : 0;
  const maxCategoryViews = topCategories.length ? topCategories[0].views : 0;

  return (
    <div>
      <PageHeader title={t("admin.nav.analytics")} description={t("admin.analytics.subtitle")} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-5">
        <Card className="p-5 sm:col-span-2">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="relative flex h-2.5 w-2.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-olive opacity-75" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-olive" />
                </span>
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">{t("admin.analytics.activeNow")}</p>
              </div>
              <p className="mt-2 text-4xl font-bold text-ink">{liveCount ?? "—"}</p>
              <p className="mt-1 text-sm text-ink-soft">{t("admin.analytics.activeNowSub")}</p>
            </div>
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-wine-light text-wine">
              <AdminIcon name="eye" className="h-6 w-6" />
            </div>
          </div>
        </Card>

        <Card className="p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">{t("admin.analytics.today")}</p>
          <p className="mt-1 text-2xl font-bold text-ink">{todayStats?.visits ?? 0}</p>
          <p className="text-xs text-ink-faint">{todayStats?.pageviews ?? 0} {t("admin.analytics.pageviews")}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">{t("admin.analytics.thisWeek")}</p>
          <p className="mt-1 text-2xl font-bold text-ink">{weekStats.visits}</p>
          <p className="text-xs text-ink-faint">{weekStats.pageviews} {t("admin.analytics.pageviews")}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">{t("admin.analytics.thisMonth")}</p>
          <p className="mt-1 text-2xl font-bold text-ink">{monthStats.visits}</p>
          <p className="text-xs text-ink-faint">{monthStats.pageviews} {t("admin.analytics.pageviews")}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">{t("admin.analytics.allTime")}</p>
          <p className="mt-1 text-2xl font-bold text-ink">{allTimeStats.visits}</p>
          <p className="text-xs text-ink-faint">{allTimeStats.pageviews} {t("admin.analytics.pageviews")}</p>
        </Card>
      </div>

      <Card className="mt-6 p-5">
        <h2 className="mb-5 font-display text-base font-bold text-ink">{t("admin.analytics.visits14days")}</h2>
        {allTimeStats.visits === 0 ? (
          <EmptyState icon="chart" title={t("admin.analytics.noVisitsYet")} body={t("admin.analytics.noVisitsBody")} />
        ) : (
          <div className="flex h-40 items-end gap-2">
            {dailyChart.map((d, i) => (
              <div key={i} className="flex flex-1 flex-col items-center gap-1.5">
                <div className="flex h-32 w-full items-end">
                  <div
                    className="w-full rounded-t-md bg-wine transition-all"
                    style={{ height: `${Math.max(4, (d.visits / maxDailyVisits) * 100)}%` }}
                    title={`${d.visits}`}
                  />
                </div>
                <span className="text-[10px] text-ink-faint">{d.label}</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card className="p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-display text-base font-bold text-ink">{t("admin.analytics.topProducts")}</h2>
            <RangeTabs value={productRange} onChange={setProductRange} />
          </div>
          {topProducts.length === 0 ? (
            <p className="text-sm text-ink-faint">{t("admin.analytics.noProductViews")}</p>
          ) : (
            <div className="flex flex-col gap-3">
              {topProducts.map((p, i) => {
                const total = p.views + p.quickAdds;
                return (
                  <div key={p.id} className="flex items-center gap-3">
                    <span className="w-4 shrink-0 text-xs font-bold text-ink-faint">{i + 1}</span>
                    <div className="h-9 w-9 shrink-0 overflow-hidden rounded-lg bg-cream-dim">
                      {p.image && <img src={p.image} alt="" className="h-full w-full object-cover" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-ink">{p.name}</p>
                      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-cream-dim">
                        <div className="h-full rounded-full bg-wine" style={{ width: `${maxProductScore ? (total / maxProductScore) * 100 : 0}%` }} />
                      </div>
                    </div>
                    <span className="shrink-0 text-sm font-bold text-ink">{total}</span>
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        <Card className="p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-display text-base font-bold text-ink">{t("admin.analytics.topCategories")}</h2>
            <RangeTabs value={categoryRange} onChange={setCategoryRange} />
          </div>
          {topCategories.length === 0 ? (
            <p className="text-sm text-ink-faint">{t("admin.analytics.noCategoryViews")}</p>
          ) : (
            <div className="flex flex-col gap-2.5">
              {topCategories.map((c) => (
                <div key={c.id} className="flex items-center gap-3">
                  <span className="w-24 shrink-0 truncate text-sm text-ink-soft">{c.name}</span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-cream-dim">
                    <div className="h-full rounded-full bg-wine" style={{ width: `${maxCategoryViews ? (c.views / maxCategoryViews) * 100 : 0}%` }} />
                  </div>
                  <span className="w-8 shrink-0 text-end text-sm font-semibold text-ink">{c.views}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <p className="mt-6 flex items-start gap-2 text-xs text-ink-faint">
        <AdminIcon name="info" className="h-4 w-4 shrink-0" />
        {t("admin.analytics.privacyNote")}
      </p>
    </div>
  );
}
