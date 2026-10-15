import { lazy, Suspense, useState } from "react";
import { useLanguage } from "../../context/LanguageContext";
import { useAdminSession } from "../../hooks/useAdminSession";
import AdminIcon from "../../admin/components/AdminIcons";

// Lazy-loaded so jsbarcode/qrcode (and the modal chrome) never reach the
// storefront bundle for a normal customer — mirrors Catchy's own
// React.lazy(() => import('.../AdminProductBarcodeModal')) pattern on its
// storefront product page.
const BarcodeLabelModal = lazy(() =>
  import("../../admin/components/BarcodeLabelModal").then((m) => ({ default: m.BarcodeLabelModal }))
);
const QrLabelModal = lazy(() => import("../../admin/components/QrLabelModal").then((m) => ({ default: m.QrLabelModal })));

// Catchy-style "print this product's codes from wherever you're looking at
// it" actions. Self-gated on useAdminSession (owner/admin only) so this is
// safe to drop into any product surface — admin dashboard or storefront —
// without the caller having to wire up its own authorization check; a
// signed-out visitor or non-admin renders nothing at all. Reuses the exact
// same BarcodeLabelModal/QrLabelModal already wired into ProductForm.tsx —
// one barcode/QR implementation, multiple entry points.
export function ProductCodeActions({
  sku,
  slug,
  name,
  price,
  className,
}: {
  sku?: string;
  slug: string;
  name: string;
  price: number;
  className?: string;
}) {
  const session = useAdminSession();
  const { t } = useLanguage();
  const [barcodeOpen, setBarcodeOpen] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);

  if (!session || (session.role !== "owner" && session.role !== "admin")) return null;

  return (
    <>
      <div className={`flex items-center gap-2 ${className ?? ""}`}>
        <button
          type="button"
          onClick={() => setBarcodeOpen(true)}
          className="flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-cream-dim text-ink-faint transition-colors hover:border-wine hover:text-wine active:scale-95"
          aria-label={t("admin.productForm.barcodeLabel")}
          title={t("admin.productForm.barcodeLabel")}
        >
          <AdminIcon name="barcode" className="h-[18px] w-[18px]" />
        </button>
        <button
          type="button"
          onClick={() => setQrOpen(true)}
          className="flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-cream-dim text-ink-faint transition-colors hover:border-wine hover:text-wine active:scale-95"
          aria-label={t("admin.productForm.qrLabel")}
          title={t("admin.productForm.qrLabel")}
        >
          <AdminIcon name="grid" className="h-[18px] w-[18px]" />
        </button>
      </div>
      <Suspense fallback={null}>
        {barcodeOpen && <BarcodeLabelModal sku={sku} slug={slug} name={name} price={price} onClose={() => setBarcodeOpen(false)} />}
        {qrOpen && <QrLabelModal slug={slug} name={name} price={price} onClose={() => setQrOpen(false)} />}
      </Suspense>
    </>
  );
}
