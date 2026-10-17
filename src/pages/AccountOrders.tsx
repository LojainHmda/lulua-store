import { collection, onSnapshot, orderBy, query, where } from "../db/firestore";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import AccountShell from "../components/account/AccountShell";
import { useCustomerAuth } from "../context/CustomerAuthContext";
import { useLanguage, type Lang } from "../context/LanguageContext";
import { db, isBackendConfigured } from "../firebase/config";
import type { AdminOrder, OrderStatus } from "../admin/types";
import { formatPrice } from "../utils/currency";

function formatDate(value: unknown, lang: Lang): string {
  const ts = value as { toDate?: () => Date } | undefined;
  const date = ts?.toDate ? ts.toDate() : null;
  return date ? date.toLocaleDateString(lang === "ar" ? "ar" : "en-US", { year: "numeric", month: "short", day: "numeric" }) : "";
}

const STATUS_KEY: Record<OrderStatus, string> = {
  pending: "account.statusPending",
  processing: "account.statusProcessing",
  ready: "account.statusReady",
  shipped: "account.statusShipped",
  delivered: "account.statusDelivered",
  completed: "account.statusCompleted",
  cancelled: "account.statusCancelled",
  refunded: "account.statusRefunded",
};

export default function AccountOrders() {
  const { firebaseUser } = useCustomerAuth();
  const { lang, t } = useLanguage();
  const [orders, setOrders] = useState<AdminOrder[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isBackendConfigured || !firebaseUser) {
      setOrders([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const q = query(collection(db, "orders"), where("customerId", "==", firebaseUser.uid), orderBy("createdAt", "desc"));
    const unsub = onSnapshot(
      q,
      (snap) => {
        setOrders(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as AdminOrder));
        setLoading(false);
      },
      () => {
        setOrders([]);
        setLoading(false);
      }
    );
    return () => unsub();
  }, [firebaseUser]);

  return (
    <AccountShell title={t("account.myAccount")}>
      {loading ? (
        <div className="flex justify-center py-12">
          <span className="h-6 w-6 animate-spin rounded-full border-2 border-wine border-t-transparent" />
        </div>
      ) : orders.length === 0 ? (
        <div className="rounded-2xl bg-paper p-8 text-center shadow-soft">
          <p className="font-display text-xl font-bold text-ink">{t("account.noOrders")}</p>
          <p className="mt-1.5 text-base text-ink-soft">{t("account.noOrdersSub")}</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {orders.map((order) => (
            <li key={order.id}>
              <Link
                to={`/account/orders/${order.id}`}
                className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-paper p-5 shadow-soft transition-shadow hover:shadow-card"
              >
                <div>
                  <p className="font-display text-lg font-bold text-ink">
                    {t("account.orderNumber")} #{order.orderNumber}
                  </p>
                  <p className="text-sm text-ink-soft">
                    {t("account.placedOn")} {formatDate(order.createdAt, lang)}
                  </p>
                </div>
                <div className="flex items-center gap-4">
                  <span className="rounded-full bg-sand px-3.5 py-1.5 text-sm font-semibold text-wine-dark">
                    {t(STATUS_KEY[order.status])}
                  </span>
                  <span className="font-display text-lg font-bold text-ink">{formatPrice(order.total)}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </AccountShell>
  );
}
