import { AnimatePresence, motion } from "motion/react";
import { Link, useNavigate } from "react-router-dom";
import { useCart } from "../../context/CartContext";
import { useCatalog } from "../../context/CatalogContext";
import { useLanguage } from "../../context/LanguageContext";
import { getLocalizedProductById } from "../../data/localize";
import { getVariant, getVariantStockFor } from "../../data/variants";
import Button from "../ui/Button";
import ProductPhoto from "../ui/ProductPhoto";
import QuantityStepper from "../ui/QuantityStepper";
import { formatPrice } from "../../utils/currency";

export default function CartDrawer() {
  const { lines, isOpen, close, setQty, removeLine, subtotal } = useCart();
  const { lang, dir, t } = useLanguage();
  const catalog = useCatalog();
  const navigate = useNavigate();

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="fixed inset-0 z-[70] bg-black/40 backdrop-blur-[2px]"
            onClick={close}
          />
          <motion.aside
            key="drawer"
            initial={{ x: dir === "rtl" ? "-100%" : "100%" }}
            animate={{ x: 0 }}
            exit={{ x: dir === "rtl" ? "-100%" : "100%" }}
            transition={{ type: "spring", stiffness: 340, damping: 36 }}
            className="fixed end-0 top-0 z-[71] flex h-full w-full max-w-sm flex-col bg-paper shadow-lift"
            role="dialog"
            aria-modal="true"
            aria-label={t("cart.yourBag")}
          >
            <div className="flex items-center justify-between border-b border-line px-5 py-3">
              <h2 className="font-display text-lg font-bold">
                {t("cart.yourBag")} {lines.length > 0 && <span className="text-wine">({lines.length})</span>}
              </h2>
              <button
                onClick={close}
                aria-label={t("cart.closeCart")}
                className="flex h-8 w-8 items-center justify-center rounded-full text-wine transition-colors hover:bg-cream-dim"
              >
                <svg className="h-3.5 w-3.5" viewBox="0 0 18 18" fill="none">
                  <path d="M1 1L17 17M17 1L1 17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            </div>

            {lines.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
                <div className="h-20 w-20 rounded-full bg-sand" />
                <p className="font-display text-xl font-bold text-ink">{t("cart.empty")}</p>
                <p className="text-base text-ink-soft">{t("cart.emptySub")}</p>
                <Button variant="primary" onClick={close}>
                  {t("cart.keepBrowsing")}
                </Button>
              </div>
            ) : (
              <>
                {/* data-lenis-prevent: the global smooth-scroll instance
                    (useLenis, src/hooks/useLenis.ts) otherwise intercepts
                    wheel/touch here and tries to scroll the page behind
                    this drawer instead of this list — see the cart-
                    scrolling audit. overscroll-contain stops the list's own
                    scroll from chaining into that page once it hits the
                    top/bottom edge. Only affects this list's scroll
                    handling, not any of its content or controls. */}
                <ul data-lenis-prevent className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-5 py-1">
                  <AnimatePresence initial={false}>
                    {lines.map((line) => {
                      // allProducts (not the sellable-only listing): a line already
                      // in the bag must keep its live photo/stock even if the
                      // product has since become unsellable.
                      const product = getLocalizedProductById(catalog.allProducts, line.productId, lang);
                      const liveVariant = product ? getVariant(product, line.variantId) : undefined;
                      const displayName = product?.name ?? line.name;
                      const displayColor = liveVariant?.colorName ?? line.color;
                      // Undefined (catalog snapshot not resolved yet) leaves
                      // the stepper uncapped rather than momentarily
                      // clamping it to 0 before the live data arrives; a
                      // resolved null (never-confirmed stock) is floored to
                      // 0 same as everywhere else this qty is checked.
                      const liveStock = product ? Math.max(0, getVariantStockFor(liveVariant, line.size) ?? 0) : undefined;
                      return (
                        <motion.li
                          key={line.key}
                          layout
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: "auto" }}
                          exit={{ opacity: 0, x: dir === "rtl" ? -40 : 40 }}
                          transition={{ duration: 0.25 }}
                          className="flex gap-3 border-b border-line py-3 last:border-0"
                        >
                          <ProductPhoto
                            imageId={liveVariant?.imageId ?? line.imageId ?? ""}
                            imageUrl={liveVariant?.imageUrl ?? line.imageUrl}
                            alt={displayName}
                            width={200}
                            aspect={{ w: 1, h: 1 }}
                            className="h-16 w-16 shrink-0 rounded-lg"
                          />
                          <div className="flex min-w-0 flex-1 flex-col gap-1">
                            <div className="flex items-start justify-between gap-2">
                              <Link
                                to={`/product/${line.slug}`}
                                onClick={close}
                                className="font-display text-sm font-bold leading-tight hover:text-wine"
                              >
                                {displayName}
                              </Link>
                              <span className="whitespace-nowrap text-sm font-semibold text-ink">
                                {formatPrice(line.price * line.qty)}
                              </span>
                            </div>
                            <p className="text-xs text-ink-soft">
                              {displayColor} · {line.size}
                            </p>
                            <div className="flex items-center justify-between">
                              <QuantityStepper size="sm" qty={line.qty} max={liveStock} onChange={(q) => setQty(line.key, q)} />
                              <button
                                onClick={() => removeLine(line.key)}
                                className="text-xs font-semibold text-ink-faint underline-offset-2 hover:text-wine hover:underline"
                              >
                                {t("cart.remove")}
                              </button>
                            </div>
                          </div>
                        </motion.li>
                      );
                    })}
                  </AnimatePresence>
                </ul>

                <div className="border-t border-line px-5 py-3.5">
                  <div className="mb-1 flex items-center justify-between text-sm">
                    <span className="text-ink-soft">{t("cart.subtotal")}</span>
                    <span className="font-display text-base font-bold">{formatPrice(subtotal)}</span>
                  </div>
                  <p className="mb-3 text-xs text-ink-faint">{t("cart.shippingNote")}</p>
                  <Button
                    fullWidth
                    size="sm"
                    onClick={() => {
                      close();
                      navigate("/checkout");
                    }}
                  >
                    {t("cart.checkout")}
                  </Button>
                  {/* Closes the drawer only, no navigation -- the customer
                      is already on whatever page they were shopping from
                      (shop grid, a product page, home), so simply revealing
                      it again is "continue shopping". Same handler and same
                      translation key the empty-cart state already uses for
                      this exact action, just styled as a secondary/outline
                      button here so it stays clearly distinct from the
                      solid Checkout button above it. */}
                  <Button fullWidth variant="outline" size="sm" className="mt-2" onClick={close}>
                    {t("cart.keepBrowsing")}
                  </Button>
                </div>
              </>
            )}
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
