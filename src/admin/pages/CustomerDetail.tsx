import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { where } from "firebase/firestore";
import { customersApi, ordersApi } from "../../firebase/collections";
import { useLanguage } from "../../context/LanguageContext";
import AdminIcon from "../components/AdminIcons";
import { AdminButton, Badge, Card, PageHeader, PageLoading } from "../components/ui";
import type { AdminCustomer, AdminOrder, OrderStatus } from "../types";
import { formatPrice } from "../../utils/currency";

const STATUS_TONE: Record<OrderStatus, "neutral" | "warning" | "info" | "success" | "danger"> = {
  pending: "neutral",
  processing: "warning",
  ready: "success",
  shipped: "info",
  delivered: "success",
  completed: "success",
  cancelled: "danger",
  refunded: "danger",
};

function formatDate(value: unknown): string {
  if (!value) return "—";
  const d = typeof value === "object" && value && "toDate" in value ? (value as { toDate: () => Date }).toDate() : new Date(value as string);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

export default function CustomerDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { t } = useLanguage();
  const [customer, setCustomer] = useState<AdminCustomer | null>(null);
  const [orders, setOrders] = useState<AdminOrder[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    Promise.all([customersApi.get(id), ordersApi.list([where("customerId", "==", id)])]).then(([c, o]) => {
      setCustomer(c ?? null);
      setOrders(o.sort((a, b) => (b.createdAt as { seconds?: number })?.seconds ?? 0 - ((a.createdAt as { seconds?: number })?.seconds ?? 0)));
      setLoading(false);
    });
  }, [id]);

  if (loading) return <PageLoading />;
  if (!customer)
    return (
      <EmptyCustomer
        onBack={() => navigate("/admin/customers")}
        label={t("admin.customers.backToCustomers")}
        notFoundLabel={t("admin.customers.notFound")}
      />
    );

  return (
    <div>
      <button
        onClick={() => navigate("/admin/customers")}
        className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-ink-soft hover:text-wine"
      >
        <AdminIcon name="chevronLeft" className="h-4 w-4 rtl:rotate-180" />
        {t("admin.customers.backToCustomers")}
      </button>

      <PageHeader
        title={customer.name}
        description={`${customer.email}${customer.phone ? ` · ${customer.phone}` : ""}`}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card className="p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">{t("admin.nav.orders")}</p>
          <p className="mt-1 font-display text-2xl font-bold text-ink">{customer.ordersCount}</p>
        </Card>
        <Card className="p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">{t("admin.customers.totalSpent")}</p>
          <p className="mt-1 font-display text-2xl font-bold text-ink">{formatPrice(customer.totalSpent)}</p>
        </Card>
        <Card className="p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">{t("admin.customers.customerSince")}</p>
          <p className="mt-1 font-display text-2xl font-bold text-ink">{formatDate(customer.createdAt)}</p>
        </Card>
      </div>

      {customer.notes && (
        <Card className="mt-4 p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">{t("admin.customers.notes")}</p>
          <p className="mt-1 text-sm text-ink-soft">{customer.notes}</p>
        </Card>
      )}

      <h2 className="mb-3 mt-6 font-display text-lg font-bold text-ink">{t("admin.customers.orderHistory")}</h2>
      {orders.length === 0 ? (
        <Card className="p-5 text-center text-sm text-ink-faint">{t("admin.customers.noOrdersYet")}</Card>
      ) : (
        <div className="flex flex-col gap-2">
          {orders.map((o) => (
            <button
              key={o.id}
              onClick={() => navigate(`/admin/orders/${o.id}`)}
              className="flex w-full flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-paper p-4 text-start shadow-soft hover:border-wine"
            >
              <div>
                <p className="font-semibold text-ink">#{o.orderNumber}</p>
                <p className="text-xs text-ink-faint">{formatDate(o.createdAt)}</p>
              </div>
              <Badge tone={STATUS_TONE[o.status]}>{t(`admin.orderStatus.${o.status}`)}</Badge>
              <p className="font-semibold text-ink">{formatPrice(o.total)}</p>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyCustomer({ onBack, label, notFoundLabel }: { onBack: () => void; label: string; notFoundLabel: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-20 text-center">
      <p className="text-ink-soft">{notFoundLabel}</p>
      <AdminButton variant="secondary" onClick={onBack}>
        {label}
      </AdminButton>
    </div>
  );
}
