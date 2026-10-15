import { useEffect, useMemo, useState } from "react";
import { classifyStoreSaleAvailability, reservationsForLine } from "../../onlineOrderReservations";
import { normalizeProduct, totalStock } from "../../productVariants";
import { matchProductFromScan } from "../../scanProductMatch";
import { productsApi } from "../../../firebase/collections";
import { resolveImageSrc } from "../../imageSrc";
import AdminIcon from "../../components/AdminIcons";
import { Modal } from "../../components/Modal";
import { SearchInput } from "../../components/ui";
import { useLanguage } from "../../../context/LanguageContext";
import { localizedName } from "../../../data/localize";
import { CameraScannerModal } from "../../../pos/CameraScannerModal";
import { useBarcodeScanner } from "../../../pos/useBarcodeScanner";
import type { AdminOrder, AdminProduct } from "../../types";
import { formatPrice } from "../../../utils/currency";

// Read-only "is this exact product/variant/size already committed to an
// online order" check for an employee physically in the store, before they
// sell it to a walk-in customer. Opened from OrderList.tsx's toolbar (see
// that file for why this location, not AddOrderItemModal.tsx or POS -- both
// were explicitly ruled out; a repo-wide sweep found no existing screen that
// already does this, so this is new, minimally-scoped UI).
//
// Deliberately NOT AddOrderItemModal.tsx: this never adds anything to an
// order, never writes to Firestore, and has no qty/"Add to order" step at
// all -- it only ever reads product + already-loaded order data and reports
// what it finds. Deliberately NOT part of POS: Terminal.tsx/ProductPicker
// are untouched; this only reuses their already-shared, non-cart-coupled
// building blocks (matchProductFromScan, useBarcodeScanner,
// CameraScannerModal), exactly as AddOrderItemModal.tsx already did before
// it.
//
// `orders` is passed in from OrderList.tsx's own existing, already-live
// ordersApi.subscribe() -- this component opens NO Firestore listener of its
// own for orders, reusing that one subscription instead of duplicating it.
// It does open one small one-shot productsApi.list() fetch on open (there is
// no existing live/product data on OrderList.tsx to reuse), matching the
// exact one-shot convention AddOrderItemModal.tsx already uses for its own
// product fetch.
//
// `ordersLoading` is OrderList.tsx's own pre-existing `loading` state
// (true until that page's subscription delivers its first snapshot). This
// modal's toolbar trigger isn't gated on that loading state (an employee can
// open it the instant the page renders), so `orders` can briefly still be
// `[]` here for a reason OTHER than "genuinely nothing reserved" -- exactly
// the same "empty looks identical to not-yet-loaded" risk fixed previously
// for AddOrderItemModal.tsx's own now-removed live subscription. Without
// this, a fast employee could see a false "available" reassurance in that
// brief window. There's no button to disable here (this screen never writes
// anything), so the fix is purely presentational: show a neutral "checking"
// state instead of a confident "safe" one until the real data has arrived.
export function ProductAvailabilityCheckModal({
  open,
  onClose,
  orders,
  ordersLoading,
}: {
  open: boolean;
  onClose: () => void;
  orders: AdminOrder[];
  ordersLoading: boolean;
}) {
  const { t, lang } = useLanguage();
  const [products, setProducts] = useState<AdminProduct[]>([]);
  const [search, setSearch] = useState("");
  const [selectedProduct, setSelectedProduct] = useState<AdminProduct | null>(null);
  const [variantId, setVariantId] = useState<string | null>(null);
  const [size, setSize] = useState<string | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scanMessage, setScanMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    productsApi.list().then((list) => setProducts(list.map(normalizeProduct).filter((p) => p.status === "active")));
  }, [open]);

  useEffect(() => {
    if (!open) {
      setSearch("");
      setSelectedProduct(null);
      setVariantId(null);
      setSize(null);
      setScannerOpen(false);
      setScanMessage(null);
    }
  }, [open]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return products;
    return products.filter((p) => p.name.toLowerCase().includes(q) || (p.nameAr ?? "").toLowerCase().includes(q));
  }, [products, search]);

  function selectProduct(p: AdminProduct) {
    setSelectedProduct(p);
    setVariantId(p.colorVariants[0]?.id ?? null);
    setSize(null);
  }

  // Identical resolution mechanism as AddOrderItemModal.tsx/Terminal.tsx --
  // same matcher, same "no match" messaging -- so a barcode resolves to a
  // product the exact same way everywhere in the app. This never adds
  // anything; a match just selects the product for the picker below, exactly
  // like a typed search result would.
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

  useBarcodeScanner((code) => {
    if (open && !selectedProduct) handleScan(code);
  });

  const activeVariant = selectedProduct?.colorVariants.find((v) => v.id === variantId) ?? null;
  const activeStock = activeVariant?.sizeStock.find((s) => s.size === size);

  // Both the barcode path (handleScan -> selectProduct) and the search-grid
  // path (this button's own onClick -> selectProduct) converge on the exact
  // same selectProduct() above -- there is exactly one place
  // selectedProduct/variantId/size get set, so exactly one place this
  // computes, never two separate implementations for the two entry points.
  // No excludeOrderId here (unlike the earlier, wrongly-placed version of
  // this feature inside AddOrderItemModal.tsx): this screen isn't attached
  // to any specific order being edited, so there is no "current order" to
  // exclude from the check.
  const lineReservation = useMemo(() => {
    if (!selectedProduct || !activeVariant || !size) return null;
    return reservationsForLine(orders, { productId: selectedProduct.id, variantId: activeVariant.id, size });
  }, [orders, selectedProduct, activeVariant, size]);

  const availability = useMemo(() => {
    if (!lineReservation || activeStock === undefined) return null;
    return classifyStoreSaleAvailability(activeStock.qty, lineReservation.reservedQty);
  }, [lineReservation, activeStock]);

  return (
    <>
      <Modal open={open} onClose={onClose} title={t("admin.orders.availabilityCheck.title")} width="lg">
        {!selectedProduct ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-ink-soft">{t("admin.orders.availabilityCheck.intro")}</p>
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
                      onClick={() => setSize(s.size)}
                      className={`rounded-lg border px-3 py-1.5 text-sm ${
                        size === s.size ? "border-wine bg-wine-light text-wine-dark" : "border-line text-ink-soft"
                      }`}
                    >
                      {s.size} ({s.qty === null ? t("admin.inventory.unknown") : s.qty})
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* The actual availability check -- see onlineOrderReservations.ts
                for the exact status set/arithmetic. Every size is selectable
                here (unlike AddOrderItemModal's picker) precisely because
                this screen's whole point is to let an employee check a
                sold-out-looking size too and see WHY -- there's no "Add to
                order" step this needs to gate. Tones reuse the app's
                existing order-status color language verbatim (bg-olive-
                light/text-olive = success, bg-sand/text-wine-dark = warning,
                bg-wine-light/text-wine = danger -- see BADGE_TONE in
                components/ui.tsx) rather than a new palette. */}
            {size && (
              <div>
                {ordersLoading ? (
                  <p className="rounded-lg bg-cream-dim px-3 py-2 text-sm text-ink-soft">{t("admin.orders.availabilityCheck.checking")}</p>
                ) : !availability ? null : availability.tier === "safe" ? (
                  <p className="rounded-lg bg-olive-light px-3 py-2 text-sm font-semibold text-olive">
                    {t("admin.orders.availabilityCheck.safe")}
                  </p>
                ) : (
                  <div className={`rounded-lg p-3 ${availability.tier === "block" ? "bg-wine-light" : "bg-sand"}`}>
                    <p className={`text-sm font-bold ${availability.tier === "block" ? "text-wine" : "text-wine-dark"}`}>
                      {t("admin.orders.availabilityCheck.linkedToOnlineOrder")}
                    </p>
                    <p className={`mt-1 text-sm font-semibold ${availability.tier === "block" ? "text-wine" : "text-wine-dark"}`}>
                      {availability.tier === "block"
                        ? t("admin.orders.availabilityCheck.noneAvailable")
                        : t("admin.orders.availabilityCheck.someAvailable").replace("{n}", String(availability.available ?? 0))}
                    </p>
                    <div className="mt-2 grid grid-cols-3 gap-2 text-center">
                      <div>
                        <p className="text-base font-extrabold text-ink">{availability.stock === null ? t("admin.inventory.unknown") : availability.stock}</p>
                        <p className="text-[11px] text-ink-faint">{t("admin.orders.availabilityCheck.stockLabel")}</p>
                      </div>
                      <div>
                        <p className="text-base font-extrabold text-ink">{availability.reserved}</p>
                        <p className="text-[11px] text-ink-faint">{t("admin.orders.availabilityCheck.reservedLabel")}</p>
                      </div>
                      <div>
                        <p className="text-base font-extrabold text-ink">
                          {availability.available === null ? t("admin.inventory.unknown") : Math.max(0, availability.available)}
                        </p>
                        <p className="text-[11px] text-ink-faint">{t("admin.orders.availabilityCheck.availableLabel")}</p>
                      </div>
                    </div>
                    {/* Every contributing order listed individually, never
                        collapsed into a bare count. */}
                    {lineReservation && lineReservation.entries.length > 0 && (
                      <ul className="mt-2.5 flex flex-col gap-1 border-t border-line/50 pt-2 text-xs text-ink-soft">
                        {lineReservation.entries.map((entry) => (
                          <li key={entry.orderId} className="flex items-center justify-between gap-2">
                            <span className="truncate">
                              #{entry.orderNumber} — {entry.customerName}
                            </span>
                            <span className="shrink-0 font-semibold text-ink">
                              {t(`admin.orderStatus.${entry.status}`)} · {entry.qty}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </Modal>
      {scannerOpen && <CameraScannerModal onScan={handleScan} onClose={() => setScannerOpen(false)} />}
    </>
  );
}
