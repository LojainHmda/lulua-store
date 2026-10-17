import { doc, getDoc } from "../db/firestore";
import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { StoreModal } from "../components/ui/InfoModals";
import LinkButton from "../components/ui/LinkButton";
import { useCustomerAuth } from "../context/CustomerAuthContext";
import { useLanguage } from "../context/LanguageContext";
import { db, isBackendConfigured } from "../firebase/config";
import type { AdminOrder } from "../admin/types";
import { ReceiptPreview, orderToReceiptData } from "../receipts/ReceiptPreview";

// A real, reloadable route for the post-checkout thank-you screen. This used
// to live only in Checkout's local `result` state, so a refresh or a
// back-button press destroyed the order number for good — there's no backend
// and no confirmation email to recover it from.
//
// Deliberately minimal: guests can't read their own order document (see the
// orders/{id} read rule in firestore.rules — admins, or the signed-in
// customer who owns it), so everything shown here comes from the URL. The
// order number rides along as a query param precisely so it survives a
// reload. Signed-in customers still get the full-detail link to
// /account/orders/:id.
export default function OrderConfirmation() {
  const { orderId } = useParams();
  const [params] = useSearchParams();
  const { firebaseUser } = useCustomerAuth();
  const { lang, t } = useLanguage();
  const [receiptOpen, setReceiptOpen] = useState(false);
  // Only ever attempted for a genuinely signed-in (non-anonymous) customer —
  // same condition already gating the "View order details" link below, the
  // one case this page can safely re-fetch from. Guests keep seeing exactly
  // what they see today: nothing here depends on a live read for them.
  const [order, setOrder] = useState<AdminOrder | null>(null);

  const orderNumber = params.get("number");
  const canFetchOrder = Boolean(orderId && firebaseUser && !firebaseUser.isAnonymous);

  useEffect(() => {
    if (!isBackendConfigured || !canFetchOrder) return;
    let cancelled = false;
    getDoc(doc(db, "orders", orderId!)).then((snap) => {
      if (cancelled || !snap.exists()) return;
      setOrder({ id: snap.id, ...snap.data() } as AdminOrder);
    });
    return () => {
      cancelled = true;
    };
  }, [canFetchOrder, orderId]);

  return (
    <div className="container-page flex min-h-[60vh] flex-col items-center justify-center gap-4 py-20 text-center">
      <h1 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">{t("checkout.orderConfirmedTitle")}</h1>
      <p className="max-w-md text-base text-ink-soft">{t("checkout.orderConfirmedBody")}</p>
      {(orderNumber || orderId) && (
        <p className="text-sm text-ink-faint">
          {t("checkout.orderNumberLabel")}: <span className="font-semibold text-ink">#{orderNumber ?? orderId}</span>
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
        {orderId && firebaseUser && !firebaseUser.isAnonymous && (
          <LinkButton to={`/account/orders/${orderId}`} variant="primary">
            {t("checkout.viewOrder")}
          </LinkButton>
        )}
        <LinkButton to="/shop" variant="outline">
          {t("checkout.continueShopping")}
        </LinkButton>
      </div>
      {order && (
        <button
          type="button"
          onClick={() => setReceiptOpen(true)}
          className="text-sm font-semibold text-wine underline-offset-2 hover:underline"
        >
          {order.source === "pos" ? t("admin.orderDetail.receipt") : t("admin.orderDetail.invoice")}
        </button>
      )}
      {order && (
        <StoreModal
          open={receiptOpen}
          onClose={() => setReceiptOpen(false)}
          title={order.source === "pos" ? t("admin.orderDetail.receipt") : t("admin.orderDetail.invoice")}
        >
          <ReceiptPreview data={orderToReceiptData(order)} lang={lang} orderNumber={order.orderNumber} />
        </StoreModal>
      )}
    </div>
  );
}
