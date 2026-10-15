import { doc, onSnapshot } from "firebase/firestore";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import AccountShell from "../components/account/AccountShell";
import OrderStatusTimeline from "../components/account/OrderStatusTimeline";
import { StoreModal } from "../components/ui/InfoModals";
import ProductPhoto from "../components/ui/ProductPhoto";
import { useCustomerAuth } from "../context/CustomerAuthContext";
import { useLanguage, type Lang } from "../context/LanguageContext";
import { db, isFirebaseConfigured } from "../firebase/config";
import type { AdminOrder, OrderStatus } from "../admin/types";
import { ReceiptPreview, orderToReceiptData } from "../receipts/ReceiptPreview";
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

export default function AccountOrderDetail() {
  const { id } = useParams<{ id: string }>();
  const { firebaseUser } = useCustomerAuth();
  const { lang, t } = useLanguage();
  const [order, setOrder] = useState<AdminOrder | null | undefined>(undefined);
  const [receiptOpen, setReceiptOpen] = useState(false);

  useEffect(() => {
    if (!isFirebaseConfigured || !firebaseUser || !id) {
      setOrder(null);
      return;
    }
    const unsub = onSnapshot(
      doc(db, "orders", id),
      (snap) => {
        if (!snap.exists() || snap.data().customerId !== firebaseUser.uid) {
          setOrder(null);
          return;
        }
        setOrder({ id: snap.id, ...snap.data() } as AdminOrder);
      },
      () => setOrder(null)
    );
    return () => unsub();
  }, [id, firebaseUser]);

  return (
    <AccountShell title={t("account.orderDetails")}>
      {order === undefined ? (
        <div className="flex justify-center py-12">
          <span className="h-6 w-6 animate-spin rounded-full border-2 border-wine border-t-transparent" />
        </div>
      ) : order === null ? (
        <div className="rounded-2xl bg-paper p-8 text-center shadow-soft">
          <p className="text-base text-ink-soft">{t("account.noOrders")}</p>
          <Link to="/account/orders" className="mt-4 inline-block text-sm font-semibold text-wine underline-offset-2 hover:underline">
            {t("account.backToOrders")}
          </Link>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-display text-xl font-bold text-ink">
                {t("account.orderNumber")} #{order.orderNumber}
              </p>
              <p className="text-sm text-ink-soft">
                {t("account.placedOn")} {formatDate(order.createdAt, lang)}
              </p>
            </div>
            <span className="rounded-full bg-sand px-3.5 py-1.5 text-sm font-semibold text-wine-dark">
              {t(STATUS_KEY[order.status])}
            </span>
          </div>

          <div className="rounded-2xl bg-paper p-6 shadow-soft">
            <OrderStatusTimeline status={order.status} />
          </div>

          <div className="rounded-2xl bg-paper p-6 shadow-soft">
            <h2 className="font-display text-lg font-bold text-ink">{t("account.itemsInOrder")}</h2>
            <ul className="mt-4 flex flex-col gap-4">
              {order.lines.map((line, i) => (
                <li key={`${line.productId}-${i}`} className="flex gap-4 border-b border-line pb-4 last:border-0 last:pb-0">
                  <ProductPhoto
                    imageId={line.imageId ?? ""}
                    imageUrl={line.imageUrl}
                    alt={line.name}
                    width={200}
                    aspect={{ w: 1, h: 1 }}
                    className="h-20 w-20 shrink-0 rounded-xl"
                  />
                  <div className="flex flex-1 flex-col gap-1">
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-display text-base font-bold text-ink">{line.name}</span>
                      <span className="whitespace-nowrap text-base font-semibold text-ink">{formatPrice(line.price * line.qty)}</span>
                    </div>
                    <p className="text-sm text-ink-soft">
                      {line.color} · {line.size} · ×{line.qty}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          {order.shippingAddress && (
            <div className="rounded-2xl bg-paper p-6 shadow-soft">
              <h2 className="font-display text-lg font-bold text-ink">{t("account.shippingAddress")}</h2>
              <p className="mt-2 whitespace-pre-line text-base text-ink-soft">{order.shippingAddress}</p>
            </div>
          )}

          <div className="rounded-2xl bg-paper p-6 shadow-soft">
            <div className="flex items-center justify-between text-base">
              <span className="text-ink-soft">{t("cart.subtotal")}</span>
              <span className="font-semibold text-ink">{formatPrice(order.subtotal)}</span>
            </div>
            <div className="mt-2 flex items-center justify-between text-base">
              <span className="text-ink-soft">{t("account.shippingCost")}</span>
              <span className="font-semibold text-ink">{formatPrice(order.shipping)}</span>
            </div>
            <div className="mt-4 flex items-center justify-between border-t border-line pt-4">
              <span className="font-display text-lg font-bold text-ink">{t("account.orderTotal")}</span>
              <span className="font-display text-xl font-bold text-ink">{formatPrice(order.total)}</span>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setReceiptOpen(true)}
            className="self-start rounded-full border border-line px-5 py-2.5 text-sm font-semibold text-ink hover:bg-cream-dim"
          >
            {order.source === "pos" ? t("admin.orderDetail.receipt") : t("admin.orderDetail.invoice")}
          </button>

          <Link to="/account/orders" className="text-sm font-semibold text-wine underline-offset-2 hover:underline">
            ← {t("account.backToOrders")}
          </Link>

          <StoreModal
            open={receiptOpen}
            onClose={() => setReceiptOpen(false)}
            title={order.source === "pos" ? t("admin.orderDetail.receipt") : t("admin.orderDetail.invoice")}
          >
            <ReceiptPreview data={orderToReceiptData(order)} lang={lang} orderNumber={order.orderNumber} />
          </StoreModal>
        </div>
      )}
    </AccountShell>
  );
}
