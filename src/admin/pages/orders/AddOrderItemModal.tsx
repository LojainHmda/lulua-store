import { useEffect, useMemo, useState, type ReactNode } from "react";
import { filterProductsForAddItem } from "../../addOrderItemFilter";
import { normalizeProduct, totalStock } from "../../productVariants";
import { matchProductFromScan } from "../../scanProductMatch";
import { categoriesApi, productsApi } from "../../../firebase/collections";
import { resolveImageSrc } from "../../imageSrc";
import AdminIcon from "../../components/AdminIcons";
import { resolveCategoryIcon } from "../../../components/ui/CategoryIcons";
import { Modal } from "../../components/Modal";
import { AdminButton, AdminNumberInput, SearchInput } from "../../components/ui";
import { useLanguage } from "../../../context/LanguageContext";
import { localizedName } from "../../../data/localize";
import { CameraScannerModal } from "../../../pos/CameraScannerModal";
import { useBarcodeScanner } from "../../../pos/useBarcodeScanner";
import type { AdminCategory, AdminProduct } from "../../types";
import { formatPrice } from "../../../utils/currency";

export interface AddedLine {
  productId: string;
  variantId: string;
  size: string;
  qty: number;
  name: string;
  color: string;
  price: number;
  imageId?: string;
  imageUrl?: string;
}

// One compact icon+label chip, shared by the "All" entry and every real
// category in the row below. Sizing/active-state styling mirrors the
// existing admin icon picker's exact selected/unselected treatment
// (src/admin/pages/categories/CategoryList.tsx's CategoryIconPicker: h-12
// w-12 circle, bg-wine text-white + ring when selected, bg-cream-dim
// text-ink-soft otherwise) -- the icon itself stays a deliberately
// prominent h-6 w-6 inside it, never shrunk down.
function CategoryNavChip({ active, label, icon, onClick }: { active: boolean; label: string; icon: ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active} className="flex w-16 shrink-0 flex-col items-center gap-1.5 rounded-lg p-1 text-center">
      <span
        className={`flex h-12 w-12 items-center justify-center rounded-full transition-colors ${
          active ? "bg-wine text-white ring-2 ring-wine ring-offset-2 ring-offset-paper" : "bg-cream-dim text-ink-soft hover:bg-wine-light hover:text-wine"
        }`}
      >
        {icon}
      </span>
      <span className={`line-clamp-1 text-[11px] font-semibold ${active ? "text-wine" : "text-ink-soft"}`}>{label}</span>
    </button>
  );
}

export function AddOrderItemModal({
  open,
  onClose,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  onAdd: (line: AddedLine) => void;
}) {
  const { t, lang } = useLanguage();
  const [products, setProducts] = useState<AdminProduct[]>([]);
  const [categories, setCategories] = useState<AdminCategory[]>([]);
  const [search, setSearch] = useState("");
  const [selectedCategorySlug, setSelectedCategorySlug] = useState<string | null>(null);
  const [selectedProduct, setSelectedProduct] = useState<AdminProduct | null>(null);
  const [variantId, setVariantId] = useState<string | null>(null);
  const [size, setSize] = useState<string | null>(null);
  const [qty, setQty] = useState(1);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scanMessage, setScanMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    productsApi.list().then((list) => setProducts(list.map(normalizeProduct).filter((p) => p.status === "active")));
    // One-shot fetch, deliberately mirroring the products fetch just above
    // (not a live .subscribe()) -- this modal already doesn't live-update
    // products while open, so categories get the same treatment rather than
    // introducing a new, inconsistent listener just for this. Same source of
    // truth as /admin/categories (categoriesApi = createCollectionApi
    // <AdminCategory>("categories")) -- no separate/duplicate category data.
    categoriesApi.list().then(setCategories);
  }, [open]);

  useEffect(() => {
    if (!open) {
      setSearch("");
      setSelectedCategorySlug(null);
      setSelectedProduct(null);
      setVariantId(null);
      setSize(null);
      setQty(1);
      setScannerOpen(false);
      setScanMessage(null);
    }
  }, [open]);

  // AdminCategory has no visibility/active field at all (confirmed against
  // /admin/categories' own CategoryList.tsx and CatalogContext.tsx) -- every
  // category document is shown, exactly like the storefront's own category
  // rail does. Sorted by "order" with the same safe fallback CatalogContext.tsx
  // uses (a category doc missing "order" sinks to the end rather than
  // silently disappearing or landing first).
  const sortedCategories = useMemo(
    () => [...categories].sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER)),
    [categories]
  );

  // Category first, then search within it -- see addOrderItemFilter.ts for
  // why (mirrors Shop.tsx's existing category+search order on the
  // storefront, so this behaves the way staff already expect it to).
  const filtered = useMemo(
    () => filterProductsForAddItem(products, { search, categorySlug: selectedCategorySlug }),
    [products, search, selectedCategorySlug]
  );

  function selectProduct(p: AdminProduct) {
    setSelectedProduct(p);
    setVariantId(p.colorVariants[0]?.id ?? null);
    setSize(null);
  }

  // Identifies the product only — never adds it directly. A match just
  // opens the same variant/size/qty picker below that a typed search
  // result would, so scanning can never skip that explicit confirmation
  // step. Mirrors Terminal.tsx's handleScan exactly (same matcher, same
  // "no match" messaging), just landing on selectProduct() instead of
  // opening POS's separate ProductPicker.
  function handleScan(code: string) {
    setScannerOpen(false);
    const product = matchProductFromScan(products, code);
    if (!product) {
      setScanMessage(t("pos.terminal.noProductMatched"));
      setTimeout(() => setScanMessage(null), 3000);
      return;
    }
    setScanMessage(null);
    selectProduct(product);
  }

  // Only acts while this modal is actually open — the hook's own listener
  // is always mounted (matching how Terminal.tsx uses it), but this modal,
  // unlike the POS page, can remain mounted-but-closed, so a stray scan
  // elsewhere on the page must not silently open this picker.
  useBarcodeScanner((code) => {
    if (open && !selectedProduct) handleScan(code);
  });

  const activeVariant = selectedProduct?.colorVariants.find((v) => v.id === variantId) ?? null;
  const activeStock = activeVariant?.sizeStock.find((s) => s.size === size);

  function handleAdd() {
    if (!selectedProduct || !activeVariant || !size || !activeStock) return;
    onAdd({
      productId: selectedProduct.id,
      variantId: activeVariant.id,
      size,
      qty,
      name: selectedProduct.name,
      color: activeVariant.colorName,
      price: selectedProduct.price,
      imageId: activeVariant.imageId,
      imageUrl: activeVariant.imageUrl,
    });
    onClose();
  }

  return (
    <>
      <Modal open={open} onClose={onClose} title={t("admin.orderDetail.addItem")} width="lg">
      {!selectedProduct ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <SearchInput value={search} onChange={setSearch} placeholder={t("admin.products.searchPlaceholder")} />
            </div>
            <button
              type="button"
              onClick={() => setScannerOpen(true)}
              aria-label={t("pos.terminal.scanQrCode")}
              title={t("pos.terminal.scanQrCode")}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-line text-ink hover:bg-cream-dim"
            >
              <AdminIcon name="barcode" className="h-4.5 w-4.5" />
            </button>
          </div>
          {scanMessage && <p className="rounded-lg bg-sand px-3 py-2 text-center text-sm font-semibold text-wine-dark">{scanMessage}</p>}
          {/* Category navigation -- client-side filter only, over the same
              products already fetched above; no per-category (or any new)
              Firestore listener. Single horizontally-scrolling row rather
              than a wrapping grid, so an arbitrary number of categories never
              costs extra vertical space -- a touch-friendly, well-understood
              pattern (same idea as the storefront's own category rail,
              SearchWithCategoryIcons.tsx), and it stays usable inside this
              modal's fixed max-w-2xl width. */}
          {sortedCategories.length > 0 && (
            <div className="thin-scrollbar flex gap-2 overflow-x-auto pb-1">
              <CategoryNavChip
                active={!selectedCategorySlug}
                label={t("admin.orderDetail.allCategories")}
                icon={<AdminIcon name="grid" className="h-6 w-6" />}
                onClick={() => setSelectedCategorySlug(null)}
              />
              {sortedCategories.map((cat) => {
                const Icon = resolveCategoryIcon(cat.icon);
                return (
                  <CategoryNavChip
                    key={cat.id}
                    active={selectedCategorySlug === cat.slug}
                    label={localizedName(cat.name, cat.nameAr, lang)}
                    icon={<Icon className="h-6 w-6" />}
                    onClick={() => setSelectedCategorySlug(cat.slug)}
                  />
                );
              })}
            </div>
          )}
          <div className="grid max-h-96 grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3">
            {filtered.map((p) => (
              <button
                key={p.id}
                onClick={() => selectProduct(p)}
                className="flex flex-col gap-2 rounded-xl border border-line p-2.5 text-start hover:border-wine"
              >
                <div className="aspect-square overflow-hidden rounded-lg bg-cream-dim">
                  {resolveImageSrc(p.colorVariants[0] ?? {}) && (
                    <img src={resolveImageSrc(p.colorVariants[0] ?? {})} alt={localizedName(p.name, p.nameAr, lang)} className="h-full w-full object-cover" />
                  )}
                </div>
                <div>
                  <p className="line-clamp-1 text-sm font-semibold text-ink">{localizedName(p.name, p.nameAr, lang)}</p>
                  <p className="text-xs text-ink-faint">
                    {formatPrice(p.price)} · {totalStock(p)} {t("admin.inventory.inStock")}
                  </p>
                </div>
              </button>
            ))}
            {filtered.length === 0 && <p className="col-span-full py-8 text-center text-sm text-ink-faint">{t("admin.orderDetail.noProductsFound")}</p>}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <button onClick={() => setSelectedProduct(null)} className="self-start text-sm font-semibold text-wine hover:underline">
            {t("admin.orderDetail.chooseDifferent")}
          </button>
          <div className="flex items-center gap-3">
            <div className="h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-cream-dim">
              {resolveImageSrc(activeVariant ?? selectedProduct.colorVariants[0] ?? {}) && (
                <img
                  src={resolveImageSrc(activeVariant ?? selectedProduct.colorVariants[0] ?? {})}
                  alt={localizedName(selectedProduct.name, selectedProduct.nameAr, lang)}
                  className="h-full w-full object-cover"
                />
              )}
            </div>
            <div>
              <p className="font-semibold text-ink">{localizedName(selectedProduct.name, selectedProduct.nameAr, lang)}</p>
              <p className="text-sm text-ink-faint">{formatPrice(selectedProduct.price)}</p>
            </div>
          </div>

          <div>
            <p className="mb-2 text-sm font-semibold text-ink">{t("admin.inventory.color")}</p>
            <div className="flex flex-wrap gap-2">
              {selectedProduct.colorVariants.map((v) => (
                <button
                  key={v.id}
                  onClick={() => {
                    setVariantId(v.id);
                    setSize(null);
                  }}
                  className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm ${
                    variantId === v.id ? "border-wine bg-wine-light text-wine-dark" : "border-line text-ink-soft"
                  }`}
                >
                  <span className="h-3.5 w-3.5 rounded-full border border-line/60" style={{ backgroundColor: v.colorHex }} />
                  {localizedName(v.colorName, v.colorNameAr, lang)}
                </button>
              ))}
            </div>
          </div>

          {activeVariant && (
            <div>
              <p className="mb-2 text-sm font-semibold text-ink">{t("admin.orderDetail.size")}</p>
              <div className="flex flex-wrap gap-2">
                {activeVariant.sizeStock.map((s) => (
                  <button
                    key={s.size}
                    disabled={s.qty === 0 || s.qty === null}
                    title={s.qty === null ? t("admin.inventory.unknownHint") : undefined}
                    onClick={() => setSize(s.size)}
                    className={`rounded-lg border px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-40 ${
                      size === s.size ? "border-wine bg-wine-light text-wine-dark" : "border-line text-ink-soft"
                    }`}
                  >
                    {s.size} ({s.qty === null ? t("admin.inventory.unknown") : s.qty})
                  </button>
                ))}
              </div>
            </div>
          )}

          {activeStock && (
            <div className="flex items-center gap-3">
              <p className="text-sm font-semibold text-ink">{t("admin.orderDetail.quantity")}</p>
              <AdminNumberInput
                min={1}
                integerOnly
                max={activeStock.qty ?? undefined}
                value={qty}
                onChange={(v) => v !== null && setQty(v)}
                className="w-20 !py-1.5 text-sm"
              />
              <span className="text-xs text-ink-faint">
                {activeStock.qty === null ? t("admin.inventory.unknown") : `${activeStock.qty} ${t("admin.orderDetail.available")}`}
              </span>
            </div>
          )}

          <div className="flex justify-end">
            <AdminButton variant="primary" disabled={!size} onClick={handleAdd}>
              {t("admin.orderDetail.addToOrder")}
            </AdminButton>
          </div>
        </div>
      )}
      </Modal>
      {scannerOpen && <CameraScannerModal onScan={handleScan} onClose={() => setScannerOpen(false)} />}
    </>
  );
}
