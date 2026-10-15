import { collection, getCountFromServer, orderBy, limit, query, where } from "firebase/firestore";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { db } from "../../firebase/config";
import { activityLogApi, ordersApi, productsApi } from "../../firebase/collections";
import { useLanguage } from "../../context/LanguageContext";
import { useAdminAuth } from "../AdminAuthContext";
import { activityActionLabel } from "../activityActions";
import { localizedName } from "../../data/localize";
import AdminIcon from "../components/AdminIcons";
import { Card, PageHeader } from "../components/ui";
import { normalizeProduct, totalStock } from "../productVariants";
import type { ActivityLogEntry, AdminOrder, AdminProduct } from "../types";
import { formatPrice } from "../../utils/currency";

interface Counts {
  products: number;
  categories: number;
  orders: number;
  customers: number;
  lowStock: number;
  pendingReviews: number;
}

const STATUS_TONE: Record<string, string> = {
  pending: "text-ink-soft",
  processing: "text-wine",
  ready: "text-olive",
  shipped: "text-olive",
  delivered: "text-olive",
  cancelled: "text-ink-faint",
  refunded: "text-ink-faint",
};

function timeAgo(value: unknown, t: (key: string) => string): string {
  const ts = value as { toDate?: () => Date } | undefined;
  const date = ts?.toDate ? ts.toDate() : null;
  if (!date) return "";
  const seconds = Math.max(0, (Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return t("admin.dashboard.justNow");
  if (seconds < 3600) return t("admin.dashboard.minAgo").replace("{n}", String(Math.floor(seconds / 60)));
  if (seconds < 86400) return t("admin.dashboard.hourAgo").replace("{n}", String(Math.floor(seconds / 3600)));
  return t("admin.dashboard.dayAgo").replace("{n}", String(Math.floor(seconds / 86400)));
}

export default function Dashboard() {
  const { profile } = useAdminAuth();
  const { t, lang } = useLanguage();
  const [counts, setCounts] = useState<Counts | null>(null);
  const [revenue, setRevenue] = useState(0);
  const [recentOrders, setRecentOrders] = useState<AdminOrder[]>([]);
  const [recentActivity, setRecentActivity] = useState<ActivityLogEntry[]>([]);
  const [lowStockProducts, setLowStockProducts] = useState<AdminProduct[]>([]);

  useEffect(() => {
    async function load() {
      // Products count comes from the already-fetched list below, not a
      // getCountFromServer() aggregation: that aggregation query returns 0
      // against this collection's rules (status == 'active' || isAnyAdmin())
      // even for an admin who can list every document fine via a normal
      // query — aggregation queries appear not to evaluate the isAnyAdmin()
      // OR-branch the same way list queries do.
      const [categoriesSnap, ordersSnap, customersSnap, reviewsSnap] = await Promise.all([
        getCountFromServer(collection(db, "categories")),
        getCountFromServer(collection(db, "orders")),
        getCountFromServer(collection(db, "customers")),
        getCountFromServer(query(collection(db, "reviews"), where("status", "==", "pending"))),
      ]);

      const products = (await productsApi.list()).map(normalizeProduct);
      const lowStock = products.filter((p) => p.status === "active" && totalStock(p) > 0 && totalStock(p) <= 3);

      const orders = await ordersApi.list([orderBy("createdAt", "desc"), limit(500)]);
      const totalRevenue = orders.filter((o) => o.status !== "cancelled" && o.status !== "refunded").reduce((sum, o) => sum + o.total, 0);

      setCounts({
        products: products.length,
        categories: categoriesSnap.data().count,
        orders: ordersSnap.data().count,
        customers: customersSnap.data().count,
        lowStock: lowStock.length,
        pendingReviews: reviewsSnap.data().count,
      });
      setRevenue(totalRevenue);
      setLowStockProducts(lowStock.slice(0, 5));
      setRecentOrders(orders.slice(0, 5));

      const activity = await activityLogApi.list([orderBy("createdAt", "desc"), limit(8)]);
      setRecentActivity(activity);
    }

    load().catch(() => {});
  }, []);

  const stats = [
    { label: t("admin.dashboard.revenue"), value: formatPrice(revenue), icon: "chart", to: "/admin/reports" },
    { label: t("admin.nav.orders"), value: counts?.orders ?? "—", icon: "bag", to: "/admin/orders" },
    { label: t("admin.nav.products"), value: counts?.products ?? "—", icon: "shirt", to: "/admin/products" },
    { label: t("admin.nav.customers"), value: counts?.customers ?? "—", icon: "users", to: "/admin/customers" },
    { label: t("admin.dashboard.lowStock"), value: counts?.lowStock ?? "—", icon: "box", to: "/admin/inventory" },
    { label: t("admin.dashboard.pendingReviews"), value: counts?.pendingReviews ?? "—", icon: "star", to: "/admin/reviews" },
  ];

  return (
    <div>
      <PageHeader
        title={`${t("admin.dashboard.welcomeBack")}${profile?.displayName ? (lang === "ar" ? "، " : ", ") + profile.displayName.split(" ")[0] : ""}`}
        description={t("admin.dashboard.subtitle")}
      />

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        {stats.map((s) => (
          <Link key={s.label} to={s.to}>
            <Card className="p-4 transition-shadow hover:shadow-card">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-wine-light text-wine">
                <AdminIcon name={s.icon} className="h-4.5 w-4.5" />
              </div>
              <p className="mt-3 text-2xl font-bold text-ink">{s.value}</p>
              <p className="text-xs font-semibold text-ink-soft">{s.label}</p>
            </Card>
          </Link>
        ))}
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-2">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-display text-lg font-bold text-ink">{t("admin.dashboard.recentOrders")}</h2>
            <Link to="/admin/orders" className="text-sm font-semibold text-wine hover:underline">
              {t("admin.common.viewAll")}
            </Link>
          </div>
          {recentOrders.length === 0 ? (
            <p className="py-8 text-center text-sm text-ink-faint">{t("admin.dashboard.noOrdersYet")}</p>
          ) : (
            <div className="flex flex-col divide-y divide-line">
              {recentOrders.map((o) => (
                <Link key={o.id} to={`/admin/orders/${o.id}`} className="flex items-center justify-between py-3 hover:opacity-80">
                  <div>
                    <p className="text-sm font-semibold text-ink">#{o.orderNumber}</p>
                    <p className="text-xs text-ink-soft">{o.customerName}</p>
                  </div>
                  <div className="text-end">
                    <p className="text-sm font-semibold text-ink">{formatPrice(o.total)}</p>
                    <p className={`text-xs font-semibold capitalize ${STATUS_TONE[o.status]}`}>{t(`admin.orderStatus.${o.status}`)}</p>
                  </div>
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

      {lowStockProducts.length > 0 && (
        <Card className="mt-6 p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-display text-lg font-bold text-ink">{t("admin.dashboard.lowStock")}</h2>
            <Link to="/admin/inventory" className="text-sm font-semibold text-wine hover:underline">
              {t("admin.dashboard.manageInventory")}
            </Link>
          </div>
          <div className="flex flex-col divide-y divide-line">
            {lowStockProducts.map((p) => (
              <div key={p.id} className="flex items-center justify-between py-2.5 text-sm">
                <span className="font-medium text-ink">{localizedName(p.name, p.nameAr, lang)}</span>
                <span className="font-semibold text-wine">{totalStock(p)} {t("admin.dashboard.left")}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
