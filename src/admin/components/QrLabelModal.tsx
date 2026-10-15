import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { useLanguage } from "../../context/LanguageContext";
import { formatPrice } from "../../utils/currency";
import { ProductCodeModal } from "./ProductCodeModal";
import { AdminButton } from "./ui";

// Storefront routing and the QR payload itself (`/product/${slug}`) are
// unchanged from before — only the modal chrome/print mechanism changed,
// from a window.open() popup to an in-page portal + @media print area (see
// ProductCodeModal). Any QR label already printed against this URL keeps
// resolving exactly as it always has.
export function QrLabelModal({ slug, name, price, onClose }: { slug: string; name: string; price: number; onClose: () => void }) {
  const { t } = useLanguage();
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const url = `${window.location.origin}/product/${slug}`;

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(url, { width: 480, margin: 2, color: { dark: "#1c1a17", light: "#fffefc" } }).then((d) => {
      if (!cancelled) setDataUrl(d);
    });
    return () => {
      cancelled = true;
    };
  }, [url]);

  function handleDownload() {
    if (!dataUrl) return;
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = `${slug}-qr.png`;
    a.click();
  }

  return (
    <ProductCodeModal
      printAreaId="admin-qr-print-area"
      title={t("admin.qr.title")}
      onClose={onClose}
      footer={
        <>
          <AdminButton variant="secondary" className="flex-1" disabled={!dataUrl} onClick={() => window.print()}>
            {t("admin.qr.print")}
          </AdminButton>
          <AdminButton variant="primary" className="flex-1" disabled={!dataUrl} onClick={handleDownload}>
            {t("admin.qr.downloadPng")}
          </AdminButton>
        </>
      }
    >
      {dataUrl ? (
        <img src={dataUrl} alt={`${t("admin.qr.altPrefix")} ${name}`} className="h-56 w-56 rounded-xl border border-line" />
      ) : (
        <div className="flex h-56 w-56 items-center justify-center rounded-xl border border-line text-sm text-ink-faint">{t("admin.qr.generating")}</div>
      )}
      <div>
        <p className="font-semibold text-ink">{name}</p>
        <p className="text-sm text-ink-faint" dir="ltr">
          {formatPrice(price)}
        </p>
        <p className="mt-1 text-xs text-ink-faint print:hidden" dir="ltr">
          {url}
        </p>
      </div>
    </ProductCodeModal>
  );
}
