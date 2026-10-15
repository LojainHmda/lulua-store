import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { Modal } from "../../components/Modal";
import { ReceiptPreview, orderToReceiptData } from "../../../receipts/ReceiptPreview";
import { buildOrderQrTargetUrl } from "../../../receipts/renderReceipt";
import { useLanguage } from "../../../context/LanguageContext";
import { useBarcodeImage } from "../../../hooks/useBarcodeImage";
import type { AdminOrder } from "../../types";

export function InvoiceModal({
  order,
  skuByProductId,
  onClose,
}: {
  order: AdminOrder;
  // Optional -- OrderDetail.tsx already loads live product data for its own
  // stock lookups, so it passes the same productId->SKU map through here
  // rather than this modal re-fetching anything itself. Printed invoices
  // reached from elsewhere with no product data on hand simply omit it and
  // print without a SKU line, same as an order line whose product was
  // since deleted.
  skuByProductId?: Record<string, string>;
  onClose: () => void;
}) {
  const { t } = useLanguage();
  const [lang, setLang] = useState<"en" | "ar">("en");
  const [printBlocked, setPrintBlocked] = useState(false);

  // Both codes are generated HERE, not inside renderReceipt.ts -- this
  // component already lives in the admin bundle (jsbarcode is already
  // pulled in by BarcodeLabelModal.tsx, qrcode by QrLabelModal.tsx), so
  // generating them here costs the customer-facing storefront bundle
  // nothing, unlike generating them inside the shared receipt-drawing
  // module would have (that module is also reachable from
  // OrderConfirmation.tsx/AccountOrderDetail.tsx).
  const barcodeDataUrl = useBarcodeImage(order.orderNumber);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    // Same call shape as QrLabelModal.tsx's product QR -- same palette too,
    // so both admin-generated codes look consistent everywhere they appear.
    QRCode.toDataURL(buildOrderQrTargetUrl(window.location.origin, order.id), { width: 240, margin: 1, color: { dark: "#1c1a17", light: "#fffefc" } }).then(
      (d) => {
        if (!cancelled) setQrDataUrl(d);
      },
      () => {
        // Never block the invoice over a QR failure -- the barcode and the
        // rest of the document still render fine without it.
        if (!cancelled) setQrDataUrl(null);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [order.id]);

  const data = orderToReceiptData(order, skuByProductId, barcodeDataUrl, qrDataUrl);

  return (
    <Modal open onClose={onClose} title={order.source === "pos" ? t("admin.orderDetail.receipt") : t("admin.orderDetail.invoice")} width="sm">
      <div className="flex flex-col items-center gap-4">
        <div className="flex gap-2 self-center rounded-full bg-cream-dim p-1">
          <button
            onClick={() => setLang("en")}
            className={`rounded-full px-4 py-1.5 text-sm font-semibold ${lang === "en" ? "bg-paper text-ink shadow-sm" : "text-ink-soft"}`}
          >
            English
          </button>
          <button
            onClick={() => setLang("ar")}
            className={`rounded-full px-4 py-1.5 text-sm font-semibold ${lang === "ar" ? "bg-paper text-ink shadow-sm" : "text-ink-soft"}`}
          >
            العربية
          </button>
        </div>
        <ReceiptPreview data={data} lang={lang} orderNumber={order.orderNumber} onPopupBlocked={() => setPrintBlocked(true)} />
        {printBlocked && (
          <p className="max-w-sm rounded-lg bg-wine-light px-3 py-2 text-sm font-semibold text-wine">{t("admin.orderDetail.printPopupBlocked")}</p>
        )}
      </div>
    </Modal>
  );
}
