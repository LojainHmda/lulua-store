import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { serverTimestamp } from "firebase/firestore";
import { ordersApi } from "../../../firebase/collections";
import { useLanguage } from "../../../context/LanguageContext";
import { localizedName } from "../../../data/localize";
import { useAdminAuth } from "../../AdminAuthContext";
import { useToast } from "../../components/ToastContext";
import { AdminButton, AdminInput, AdminNumberInput, AdminTextarea, Card, Field, PageLoading } from "../../components/ui";
import { logActivity } from "../../logActivity";
import { useOrder } from "./useOrder";

// Dedicated page for one order's Customer & Shipping info -- extracted
// verbatim out of OrderDetail.tsx's former sidebar card (see that file's
// history) so the main Order Detail workspace no longer permanently spends
// space on it. Business logic (fields, save behavior, permission check,
// total recompute) is unchanged; only where it's rendered moved.
export default function OrderCustomerShipping() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { t, lang } = useLanguage();
  const { profile, hasRole } = useAdminAuth();
  const canWrite = hasRole(["owner", "admin"]);
  const { order, setOrder, loading } = useOrder(id);

  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [shippingAddress, setShippingAddress] = useState("");
  const [shippingCost, setShippingCost] = useState(0);
  const [savingCustomerInfo, setSavingCustomerInfo] = useState(false);

  // Keyed on the order id only (not the whole `order` object) -- seeds these
  // fields once when this order first loads. saveCustomerInfo() below calls
  // setOrder() afterward with a new object reference for the same order id;
  // re-seeding from that would only ever restate the values just saved, but
  // keying this narrowly avoids any doubt and matches the same pattern used
  // for draftLines in OrderDetail.tsx.
  useEffect(() => {
    if (!order) return;
    setCustomerName(order.customerName ?? "");
    setCustomerPhone(order.customerPhone ?? "");
    setCustomerEmail(order.customerEmail ?? "");
    setShippingAddress(order.shippingAddress ?? "");
    setShippingCost(order.shipping ?? 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?.id]);

  // Shipping cost is the one field here that also feeds `total` — recomputed
  // the same way placeOrder()/updateOrderLines() always derive it (subtotal
  // - discount + shipping), using the order's current subtotal/discount, so
  // this can never leave total inconsistent with what's actually on the
  // order. Name/phone/email/address are plain corrections with no knock-on
  // math, and — unlike line items — none of these touch inventory, so this
  // isn't gated behind an order-status check the way item editing is.
  async function saveCustomerInfo() {
    if (!order || !profile) return;
    if (!customerName.trim()) {
      toast.error(t("admin.orderDetail.errCustomerNameRequired"));
      return;
    }
    setSavingCustomerInfo(true);
    try {
      const total = order.subtotal - (order.discount ?? 0) + shippingCost;
      const patch = {
        customerName: customerName.trim(),
        customerPhone: customerPhone.trim() || undefined,
        customerEmail: customerEmail.trim() || undefined,
        shippingAddress: shippingAddress.trim() || undefined,
        shipping: shippingCost,
        total,
        customerShippingUpdatedByUid: profile.id,
        customerShippingUpdatedByEmail: profile.email,
        customerShippingUpdatedByName: profile.displayName || profile.email,
        customerShippingUpdatedAt: serverTimestamp(),
      };
      await ordersApi.update(order.id, patch);
      setOrder({ ...order, ...patch });
      await logActivity(profile, "order.customerInfoUpdated", `#${order.orderNumber}`);
      toast.success(t("admin.orderDetail.customerInfoSaved"));
    } catch {
      toast.error(t("admin.orderDetail.customerInfoSaveFailed"));
    } finally {
      setSavingCustomerInfo(false);
    }
  }

  if (loading) return <PageLoading />;
  if (!order) {
    return (
      <div className="text-center text-ink-soft">
        {t("admin.orderDetail.notFound")}{" "}
        <button onClick={() => navigate("/admin/orders")} className="font-semibold text-wine hover:underline">
          {t("admin.orderDetail.backToOrders")}
        </button>
      </div>
    );
  }

  return (
    <div className="pb-16">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
            {t("admin.orderDetail.orderHash")}
            {order.orderNumber}
          </p>
          <h1 className="mt-1 font-display text-2xl font-bold text-ink">{t("admin.orderDetail.customerAndShipping")}</h1>
        </div>
        <AdminButton variant="secondary" onClick={() => navigate(`/admin/orders/${order.id}`)}>
          {t("admin.orderDetail.backToOrder")}
        </AdminButton>
      </div>

      <Card className="max-w-xl p-5">
        {canWrite ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">{t("admin.orders.colCustomer")}</p>
              <Field label={t("admin.orderDetail.customerName")} required>
                <AdminInput value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
              </Field>
              <Field label={t("admin.orderDetail.customerPhone")}>
                <AdminInput type="tel" value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} />
              </Field>
              <Field label={t("admin.orderDetail.customerEmailOptional")}>
                <AdminInput type="email" value={customerEmail} onChange={(e) => setCustomerEmail(e.target.value)} />
              </Field>
            </div>
            <div className="flex flex-col gap-3 border-t border-line pt-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">{t("admin.orderDetail.shipping")}</p>
              <Field label={t("admin.orderDetail.shippingAddress")}>
                <AdminTextarea
                  rows={2}
                  value={shippingAddress}
                  onChange={(e) => setShippingAddress(e.target.value)}
                  placeholder={t("admin.orderDetail.shippingAddressPlaceholder")}
                />
              </Field>
              {(order.deliveryZoneName || order.deliveryZoneNameAr) && (
                <p className="text-xs text-ink-faint">{localizedName(order.deliveryZoneName ?? "", order.deliveryZoneNameAr, lang)}</p>
              )}
              <Field label={t("admin.orderDetail.shippingCost")}>
                <AdminNumberInput min={0} value={shippingCost} onChange={(v) => v !== null && setShippingCost(v)} />
              </Field>
            </div>
            <AdminButton variant="secondary" size="sm" loading={savingCustomerInfo} onClick={saveCustomerInfo}>
              {t("admin.orderDetail.saveCustomerInfo")}
            </AdminButton>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">{t("admin.orders.colCustomer")}</p>
              <p className="font-medium text-ink">{order.customerName}</p>
              {order.customerEmail && <p className="text-sm text-ink-soft">{order.customerEmail}</p>}
              {order.customerPhone && <p className="text-sm text-ink-soft">{order.customerPhone}</p>}
            </div>
            {(order.shippingAddress || order.deliveryZoneName || order.deliveryZoneNameAr) && (
              <div className="flex flex-col gap-1 border-t border-line pt-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">{t("admin.orderDetail.shipping")}</p>
                {order.shippingAddress && <p className="text-sm text-ink-soft">{order.shippingAddress}</p>}
                {(order.deliveryZoneName || order.deliveryZoneNameAr) && (
                  <p className="text-xs text-ink-faint">{localizedName(order.deliveryZoneName ?? "", order.deliveryZoneNameAr, lang)}</p>
                )}
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
