import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { Navigate, useLocation, useNavigate, useParams } from "react-router-dom";
import { AccordionItem } from "../components/ui/Accordion";
import Button from "../components/ui/Button";
import { PlayIcon } from "../components/ui/Icons";
import { SizeGuideModal } from "../components/ui/InfoModals";
import ProductCard from "../components/ui/ProductCard";
import ProductPhoto from "../components/ui/ProductPhoto";
import QuantityStepper from "../components/ui/QuantityStepper";
import Rail from "../components/ui/Rail";
import Reveal from "../components/ui/Reveal";
import { useCart } from "../context/CartContext";
import { useCatalog } from "../context/CatalogContext";
import { useLanguage } from "../context/LanguageContext";
import { getLocalizedCategoryBySlug, getLocalizedProductBySlug, getLocalizedRelatedProducts } from "../data/localize";
import { getVariant, getVariantStockFor, isSizeAvailable, isVariantSoldOut } from "../data/variants";
import { exceedsCheckoutSafeLimit } from "../admin/productVariants";
import { ProductCodeActions } from "../components/admin/ProductCodeActions";
import { trackProductView } from "../analytics/track";
import { formatPrice } from "../utils/currency";

const VIEWS = [
  { key: "full" as const, labelKey: "product.fullLook" },
  { key: "detail" as const, labelKey: "product.detail" },
];

export default function ProductDetail() {
  const { slug } = useParams();
  const { lang, t } = useLanguage();
  const catalog = useCatalog();
  const { addItem } = useCart();
  const navigate = useNavigate();
  const location = useLocation();

  // location.key === "default" means this is the entry point of the SPA's
  // own history (a direct link/new tab, no prior in-app page to return
  // to) -- navigate(-1) in that case would either no-op or leave the app
  // entirely, so it falls back to the shop grid instead. Otherwise
  // navigate(-1) is real browser-history back, which is what restores the
  // customer's exact previous category/search/filter (those already live
  // in the URL — see Shop.tsx's useSearchParams), not just "some shop page".
  function handleBack() {
    if (location.key !== "default") navigate(-1);
    else navigate("/shop");
  }

  // All hooks must run on every render regardless of whether the product is
  // found yet, since `product` can flip from undefined -> defined within the
  // same mounted instance while the live Firestore listener is still
  // resolving (see catalog.loading below) — bailing out early before these
  // would violate the Rules of Hooks (a real bug this component used to
  // have, surfaced by that loading state).
  const product = useMemo(
    () => (slug ? getLocalizedProductBySlug(catalog.products, slug, lang) : undefined),
    [catalog.products, slug, lang]
  );

  const [variantId, setVariantId] = useState<string>(product?.colorVariants[0]?.id ?? "");
  const [size, setSize] = useState<string | null>(null);
  const [qty, setQty] = useState(1);
  const [view, setView] = useState<(typeof VIEWS)[number]["key"] | "video">("full");
  const [sizeError, setSizeError] = useState(false);
  const [added, setAdded] = useState(false);
  const [sizeGuideOpen, setSizeGuideOpen] = useState(false);

  // Keyed on the id, not the whole product object: the live catalog listener
  // hands back a brand-new Product reference on EVERY snapshot (any product
  // changing anywhere, plus every language toggle), which would otherwise wipe
  // the shopper's size/color/qty selection mid-session. Same reasoning as the
  // analytics effect below.
  useEffect(() => {
    setVariantId(product?.colorVariants[0]?.id ?? "");
    setSize(null);
    setQty(1);
    setView("full");
    setAdded(false);
  }, [product?.id]);

  // Analytics: a real product view, for the admin "most viewed" insights.
  // Keyed on the id (not the whole product object, which gets a new
  // reference on every language toggle) so switching EN/AR on the same
  // page never double-counts a view.
  useEffect(() => {
    if (product) trackProductView(product.id, product.category);
  }, [product?.id]);

  const related = useMemo(
    () => (product ? getLocalizedRelatedProducts(catalog.products, product, lang) : []),
    [catalog.products, product, lang]
  );
  const category = useMemo(
    () => (product ? getLocalizedCategoryBySlug(catalog.allCategories, product.category, lang) : undefined),
    [catalog.allCategories, product, lang]
  );

  if (!product) {
    if (catalog.loading) {
      return (
        <div className="flex min-h-[60vh] items-center justify-center">
          <span className="h-8 w-8 animate-spin rounded-full border-2 border-wine border-t-transparent" />
        </div>
      );
    }
    return <Navigate to="/404" replace />;
  }

  const activeVariant = getVariant(product, variantId);
  // Single source of truth for size availability — see data/variants.ts.
  // null (unconfirmed), 0, and a missing sizeStock entry are all the same
  // "can't buy this" answer to a shopper; no distinction is drawn here.
  const variantSoldOut = isVariantSoldOut(product.sizes, activeVariant);
  const selectedStock = size ? getVariantStockFor(activeVariant, size) : null;

  function handleSelectVariant(id: string) {
    setVariantId(id);
    setSize(null);
    setQty(1);
    setSizeError(false);
  }

  // See exceedsCheckoutSafeLimit's own comment for why this exists: a
  // small set of catalog products have more variant/size combinations than
  // the checkout security rules can validate within Firestore's expression
  // budget. Rather than let a shopper fill out the whole checkout form and
  // then hit a confusing permission error, this is caught up front.
  const checkoutUnavailable = exceedsCheckoutSafeLimit(product);
  // Nothing purchasable in this color at all — the CTA below is replaced
  // with a plain "out of stock" message instead of leaving a dead Add to
  // Bag button up for the customer to click into a confusing dead end.
  const addToBagUnavailable = checkoutUnavailable || variantSoldOut;

  const handleAdd = () => {
    if (addToBagUnavailable) return;
    if (!size) {
      setSizeError(true);
      return;
    }
    if (!activeVariant) return;
    addItem(product, activeVariant.id, size, qty);
    setAdded(true);
    window.setTimeout(() => setAdded(false), 1800);
  };

  return (
    <div className="container-page pb-28 pt-5 md:pt-6 lg:pb-12">
      <button
        type="button"
        onClick={handleBack}
        aria-label={t("product.back")}
        className="mb-4 inline-flex items-center gap-1.5 text-sm font-semibold text-ink-soft transition-colors hover:text-wine"
      >
        <svg className="h-4 w-4 rtl:-scale-x-100" viewBox="0 0 20 20" fill="none">
          <path d="M12.5 4l-6 6 6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {t("product.back")}
      </button>
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2 lg:gap-12">
        {/* Gallery */}
        <div>
          <div className="relative overflow-hidden rounded-2xl">
            <AnimatePresence mode="wait">
              <motion.div
                key={view}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
              >
                {view === "video" && product.videoUrl ? (
                  <video
                    src={product.videoUrl}
                    className="aspect-[4/5] w-full bg-cream-dim object-cover dark:ring-1 dark:ring-white/10"
                    controls
                    playsInline
                    autoPlay
                    preload="metadata"
                    aria-label={`${t("product.video")} — ${product.name}`}
                  />
                ) : (
                  <ProductPhoto
                    imageId={activeVariant?.imageId ?? ""}
                    imageUrl={activeVariant?.imageUrl}
                    alt={product.name}
                    width={1100}
                    aspect={{ w: 4, h: 5 }}
                    className="aspect-[4/5] w-full"
                    imgClassName={view === "detail" ? "scale-[1.6]" : ""}
                    focus={view === "detail" ? "50% 20%" : undefined}
                    priority
                  />
                )}
              </motion.div>
            </AnimatePresence>
            {product.tags?.includes("sale") && (
              <span className="absolute start-5 top-5 rounded-full bg-wine px-3.5 py-2 text-sm font-bold uppercase tracking-wide text-on-accent">
                {t("shop.tagSale")}
              </span>
            )}
          </div>

          <div className="mt-4 flex gap-3">
            {VIEWS.map((v) => (
              <button
                key={v.key}
                onClick={() => setView(v.key)}
                className={`overflow-hidden rounded-xl border transition-colors ${
                  view === v.key ? "border-ink" : "border-line hover:border-ink-faint"
                }`}
                aria-label={t(v.labelKey)}
              >
                <ProductPhoto
                  imageId={activeVariant?.imageId ?? ""}
                  imageUrl={activeVariant?.imageUrl}
                  alt=""
                  width={140}
                  aspect={{ w: 1, h: 1 }}
                  className="h-20 w-20"
                  imgClassName={v.key === "detail" ? "scale-[1.6]" : ""}
                  focus={v.key === "detail" ? "50% 20%" : undefined}
                />
              </button>
            ))}
            {/* Only ever rendered when this product actually has a video —
                no placeholder/empty thumbnail for products without one. */}
            {product.videoUrl && (
              <button
                onClick={() => setView("video")}
                aria-label={t("product.playVideo")}
                className={`relative h-20 w-20 shrink-0 overflow-hidden rounded-xl border transition-colors ${
                  view === "video" ? "border-ink" : "border-line hover:border-ink-faint"
                }`}
              >
                <video src={product.videoUrl} className="h-full w-full object-cover" muted playsInline preload="metadata" />
                <span className="absolute inset-0 flex items-center justify-center bg-ink/25">
                  <PlayIcon className="h-7 w-7 text-paper drop-shadow" />
                </span>
              </button>
            )}
          </div>
        </div>

        {/* Info — capped width and sticky on desktop so it stays beside the photo
            instead of spreading thin across the half-page column. */}
        <div className="w-full max-w-xl lg:sticky lg:top-24 lg:self-start">
          <div className="border-b border-line pb-3">
            <p className="text-xs font-bold uppercase tracking-wide text-wine">{category?.name ?? product.category}</p>
            <h1 className="mt-1 font-display text-xl font-semibold leading-snug tracking-tight sm:text-2xl">{product.name}</h1>

            <div className="mt-2 flex items-baseline gap-2.5">
              <span className="text-lg font-bold text-ink">{formatPrice(product.price)}</span>
              {product.compareAtPrice && (
                <span className="text-sm text-ink-faint line-through">{formatPrice(product.compareAtPrice)}</span>
              )}
            </div>
          </div>

          <p className="mt-3 text-sm leading-normal text-ink-soft">{product.description}</p>

          {/* Color */}
          <div className="mt-4">
            <p className="mb-1.5 text-sm font-bold text-ink">
              {t("product.color")}
              {activeVariant?.colorName && <span className="font-normal text-ink-soft"> — {activeVariant.colorName}</span>}
            </p>
            {product.colorVariants.length > 1 ? (
              <div className="flex flex-wrap gap-2.5">
                {product.colorVariants.map((v) => (
                  <button
                    key={v.id}
                    onClick={() => handleSelectVariant(v.id)}
                    aria-label={v.colorName}
                    aria-pressed={v.id === variantId}
                    className={`flex h-9 w-9 items-center justify-center rounded-full transition-all ${
                      v.id === variantId ? "ring-2 ring-wine ring-offset-2 ring-offset-paper" : "ring-1 ring-inset ring-ink/10"
                    }`}
                  >
                    <span className="block h-6 w-6 rounded-full" style={{ backgroundColor: v.colorHex }} />
                  </button>
                ))}
              </div>
            ) : (
              <div className="flex w-fit items-center gap-2.5 rounded-full border border-line bg-paper py-1.5 ps-1.5 pe-4">
                <span
                  className="h-6 w-6 rounded-full ring-1 ring-inset ring-ink/10"
                  style={{ backgroundColor: activeVariant?.colorHex }}
                />
                <span className="text-sm font-medium text-ink">{activeVariant?.colorName}</span>
              </div>
            )}
          </div>

          {/* Size */}
          <div className="mt-4">
            <div className="mb-1.5 flex items-center justify-between">
              <p className="text-sm font-bold text-ink">
                {t("product.size")} {size && <span className="font-normal text-ink-soft">— {size}</span>}
              </p>
              <button
                type="button"
                onClick={() => setSizeGuideOpen(true)}
                className="text-sm font-semibold text-ink-soft underline underline-offset-2 hover:text-wine"
              >
                {t("product.sizeGuide")}
              </button>
            </div>
            <div className="flex flex-wrap gap-2.5">
              {product.sizes.map((s) => {
                const available = isSizeAvailable(activeVariant, s);
                return (
                  <button
                    key={s}
                    disabled={!available}
                    onClick={() => {
                      setSize(s);
                      setQty(1);
                      setSizeError(false);
                    }}
                    className={`relative min-w-[2.75rem] rounded-xl border px-3 py-2 text-sm font-semibold transition-colors ${
                      size === s
                        ? "border-ink bg-ink text-paper"
                        : available
                        ? "border-line text-ink hover:border-ink"
                        : "border-line text-ink-faint line-through"
                    }`}
                  >
                    {s}
                  </button>
                );
              })}
            </div>
            {!variantSoldOut && product.sizes.some((s) => !isSizeAvailable(activeVariant, s)) && (
              <p className="mt-1.5 text-xs text-ink-faint">{t("product.outOfStockHint")}</p>
            )}
            <AnimatePresence>
              {sizeError && (
                <motion.p
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="mt-2 text-sm font-semibold text-wine"
                >
                  {t("product.pickSize")}
                </motion.p>
              )}
            </AnimatePresence>
          </div>

          {/* Qty + CTA */}
          {checkoutUnavailable ? (
            <p className="mt-4 rounded-xl bg-cream-dim px-4 py-3.5 text-sm font-semibold text-ink-soft">
              {t("product.checkoutUnavailable")}
            </p>
          ) : variantSoldOut ? (
            <p className="mt-4 rounded-xl bg-cream-dim px-4 py-3.5 text-sm font-semibold text-wine">
              {t("product.colorSoldOut")}
            </p>
          ) : (
            <div className="mt-4 flex items-center gap-4">
              <QuantityStepper qty={qty} max={selectedStock ?? undefined} onChange={(q) => setQty(Math.max(1, q))} />
              <Button size="lg" className="flex-1" onClick={handleAdd}>
                {added ? t("product.addedToBag") : `${t("product.addToBag")} — ${formatPrice(product.price * qty)}`}
              </Button>
            </div>
          )}

          {/* Owner/admin only — renders nothing for a normal customer. */}
          <ProductCodeActions sku={product.sku} slug={product.slug} name={product.name} price={product.price} className="mt-3" />

          <div className="mt-4">
            <AccordionItem title={t("product.detailsCare")}>
              <ul className="list-inside list-disc space-y-1.5">
                {product.details.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            </AccordionItem>
            <AccordionItem title={t("product.sizeFitTitle")}>{t("product.sizeFitBody")}</AccordionItem>
          </div>
        </div>
      </div>

      {/* Sticky mobile add-to-cart */}
      <div className="fixed inset-x-0 bottom-0 z-40 flex items-center gap-3 border-t border-line bg-paper px-4 py-3 shadow-lift lg:hidden">
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-bold text-ink">{product.name}</p>
          <p className="text-base text-ink-soft">{formatPrice(product.price)}</p>
        </div>
        {!addToBagUnavailable && <Button onClick={handleAdd}>{added ? t("product.added") : t("product.addToBag")}</Button>}
      </div>

      {related.length > 0 && (
        <section className="mt-20 pb-16 md:mt-28">
          <Reveal>
            <h2 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">{t("product.youMightAlsoLike")}</h2>
          </Reveal>
          <Reveal delay={0.1} className="mt-8">
            <Rail>
              {related.map((p) => (
                <div key={p.id} className="w-[72%] shrink-0 snap-start sm:w-[42%] lg:w-[24%]">
                  <ProductCard product={p} />
                </div>
              ))}
            </Rail>
          </Reveal>
        </section>
      )}

      <SizeGuideModal open={sizeGuideOpen} onClose={() => setSizeGuideOpen(false)} />
    </div>
  );
}
