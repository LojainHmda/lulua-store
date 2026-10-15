import { useLanguage } from "../../context/LanguageContext";
import { useBarcodeImage } from "../../hooks/useBarcodeImage";
import { formatPrice } from "../../utils/currency";
import { productBarcodeValue } from "../productBarcode";
import { ProductCodeModal } from "./ProductCodeModal";
import { AdminButton } from "./ui";

// productBarcodeValue() derives the printed value live from sku/slug — there
// is no "generate" step and nothing is written to Firestore. Editing or
// clearing the product's sku field changes what this renders the next time
// it's opened, automatically.
export function BarcodeLabelModal({
  sku,
  slug,
  name,
  price,
  onClose,
}: {
  sku?: string;
  slug: string;
  name: string;
  price: number;
  onClose: () => void;
}) {
  const { t } = useLanguage();
  const value = productBarcodeValue({ sku, slug });
  const dataUrl = useBarcodeImage(value);

  function handleDownload() {
    if (!dataUrl) return;
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = `${slug}-barcode.png`;
    a.click();
  }

  return (
    <ProductCodeModal
      printAreaId="admin-barcode-print-area"
      title={t("admin.barcode.title")}
      onClose={onClose}
      footer={
        <>
          <AdminButton variant="secondary" className="flex-1" disabled={!dataUrl} onClick={() => window.print()}>
            {t("admin.barcode.print")}
          </AdminButton>
          <AdminButton variant="primary" className="flex-1" disabled={!dataUrl} onClick={handleDownload}>
            {t("admin.barcode.downloadPng")}
          </AdminButton>
        </>
      }
    >
      {dataUrl ? (
        <img
          src={dataUrl}
          alt={`${t("admin.barcode.altPrefix")} ${name}`}
          className="h-28 w-full rounded-xl border border-line bg-white object-contain p-3"
        />
      ) : (
        <div className="flex h-28 w-full items-center justify-center rounded-xl border border-line text-sm text-ink-faint">
          {t("admin.barcode.generating")}
        </div>
      )}
      <div>
        <p className="font-semibold text-ink">{name}</p>
        <p className="text-sm text-ink-faint" dir="ltr">
          {formatPrice(price)}
        </p>
      </div>
    </ProductCodeModal>
  );
}
