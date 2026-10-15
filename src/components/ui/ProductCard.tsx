import { motion } from "motion/react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useCart } from "../../context/CartContext";
import { useLanguage } from "../../context/LanguageContext";
import { useWishlist } from "../../context/WishlistContext";
import { getAvailableSizesFor, getAvailableSizesForProduct, getPrimaryVariant, isProductSoldOut } from "../../data/variants";
import { exceedsCheckoutSafeLimit } from "../../admin/productVariants";
import type { Product } from "../../types";
import ProductPhoto from "./ProductPhoto";
import { formatPrice } from "../../utils/currency";

const TAG_KEY: Record<string, string> = {
  new: "shop.tagNew",
  bestseller: "shop.tagBestseller",
  sale: "shop.tagSale",
  limited: "shop.tagLimited",
};

const TAG_CLASS: Record<string, string> = {
  new: "bg-olive text-paper",
  bestseller: "bg-ink text-paper",
  sale: "bg-wine text-on-accent",
  limited: "bg-paper text-ink border border-ink/20",
};

interface ProductCardProps {
  product: Product;
}

export default function ProductCard({ product }: ProductCardProps) {
  const { t } = useLanguage();
  const wishlist = useWishlist();
  const wished = wishlist.has(product.id);
  const variant = getPrimaryVariant(product);
  // See exceedsCheckoutSafeLimit's comment (src/admin/productVariants.ts)
  // — a handful of catalog products exceed what the checkout security
  // rules can validate. The hover size hint is hidden for them, same as
  // the old Quick Add button was, so the grid never implies a product is
  // shoppable when it structurally isn't.
  const checkoutUnavailable = exceedsCheckoutSafeLimit(product);
  // Persistent, always-visible (not hover/click-gated, works on touch) —
  // true only when NOTHING in ANY color is purchasable. A tile whose
  // primary color happens to be out isn't marked sold out here, since
  // another color on the same product may still be buyable from the
  // product page; see isProductSoldOut's own comment.
  const soldOut = isProductSoldOut(product);
  // Every size available in at least one color, deduplicated, in
  // product.sizes' own declared order — informational only (see
  // getAvailableSizesForProduct's own comment). Unlike the old Quick Add,
  // this is never scoped to just the primary color: a size that's out in
  // the pictured color but in stock in another still belongs here, since
  // nothing here claims to add a specific color+size to the cart anymore.
  const availableSizes = getAvailableSizesForProduct(product);
  // Quick add always adds the pictured (primary) color, so it offers only
  // that color's in-stock sizes.
  const quickAddSizes = getAvailableSizesFor(product.sizes, variant);
  const { addItem } = useCart();
  const navigate = useNavigate();
  const [picking, setPicking] = useState(false);

  function handleQuickAdd() {
    if (!variant || quickAddSizes.length === 0) {
      // Pictured color is out but another may not be — let the product page decide.
      navigate(`/product/${product.slug}`);
      return;
    }
    if (quickAddSizes.length === 1) {
      addItem(product, variant.id, quickAddSizes[0]);
      return;
    }
    setPicking((p) => !p);
  }

  function addSize(size: string) {
    if (!variant) return;
    addItem(product, variant.id, size);
    setPicking(false);
  }

  return (
    <div className="group relative isolate flex flex-col" onMouseLeave={() => setPicking(false)}>
      <div className="relative overflow-hidden rounded-2xl">
        <Link to={`/product/${product.slug}`} className="block">
          <ProductPhoto
            imageId={variant?.imageId ?? ""}
            imageUrl={variant?.imageUrl}
            alt={product.name}
            width={700}
            aspect={{ w: 4, h: 5 }}
            className={`aspect-[4/5] w-full rounded-2xl ${soldOut ? "opacity-60" : ""}`}
            imgClassName="transition-transform duration-500 group-hover:scale-[1.04]"
          />
        </Link>

        {/* Persistent, always-visible — not gated behind hover or Quick Add,
            so touch devices (no hover state at all) see this too. Only
            appears when every color/size is unavailable; see
            isProductSoldOut's own comment for why a single sold-out color
            on an otherwise-available product doesn't trigger this. */}
        {soldOut && (
          <span className="pointer-events-none absolute start-3 top-3 rounded-full bg-ink/85 px-2.5 py-1 text-xs font-bold uppercase tracking-wide text-paper">
            {t("product.soldOut")}
          </span>
        )}
        {!soldOut && (
          <div className="pointer-events-none absolute start-3 top-3 flex flex-col gap-1.5">
            {product.tags?.map((tag) => (
              <span
                key={tag}
                className={`rounded-full px-2.5 py-1 text-xs font-bold uppercase tracking-wide ${TAG_CLASS[tag]}`}
              >
                {t(TAG_KEY[tag])}
              </span>
            ))}
          </div>
        )}

        <button
          onClick={() => wishlist.toggle(product.id)}
          aria-label={t("product.toggleWishlist")}
          aria-pressed={wished}
          className="absolute end-3 top-3 flex h-9 w-9 items-center justify-center rounded-full bg-paper/90 text-ink shadow-soft backdrop-blur-sm"
        >
          <motion.svg
            className="h-4 w-4"
            viewBox="0 0 20 20"
            fill={wished ? "var(--color-wine)" : "none"}
            animate={wished ? { scale: [1, 1.25, 1] } : { scale: 1 }}
            transition={{ duration: 0.3, ease: "easeOut" }}
          >
            <path
              d="M10 17.5s-6.7-4.1-9-8.4C-0.4 5.5 2 2 5.4 2c2 0 3.6 1.2 4.6 2.7C11 3.2 12.6 2 14.6 2 18 2 20.4 5.5 19 9.1c-2.3 4.3-9 8.4-9 8.4z"
              stroke={wished ? "var(--color-wine)" : "var(--color-ink)"}
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
          </motion.svg>
        </button>

        {/* Informational only — not a button, not clickable, adds nothing
            to the cart. Replaces the old Quick Add action; see
            getAvailableSizesForProduct's own comment for why this is
            aggregated across every color instead of scoped to the one
            pictured. Hidden whenever there's nothing to show, same gating
            (!checkoutUnavailable && !soldOut) the old button used, plus a
            check that at least one size actually has stock somewhere. */}
        {!checkoutUnavailable && !soldOut && picking && (
          <div className="absolute bottom-3 end-14 start-3 flex items-center justify-center gap-1 rounded-full bg-ink px-2 py-1.5 shadow-lift">
            {quickAddSizes.map((size) => (
              <button
                key={size}
                type="button"
                onClick={() => addSize(size)}
                className="min-w-[2.25rem] rounded-full px-2 py-1.5 text-sm font-bold uppercase text-paper transition-colors hover:bg-paper hover:text-ink"
              >
                {size}
              </button>
            ))}
          </div>
        )}
        {!checkoutUnavailable && !soldOut && !picking && availableSizes.length > 0 && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute bottom-3 end-14 start-3 flex invisible translate-y-4 items-center justify-center gap-3 rounded-full bg-ink py-3 text-center text-sm font-bold uppercase tracking-wide text-paper opacity-0 shadow-lift transition-[opacity,transform,visibility] duration-300 ease-out group-hover:visible group-hover:translate-y-0 group-hover:opacity-100"
          >
            {availableSizes.map((size) => (
              <span key={size}>{size}</span>
            ))}
          </div>
        )}

        {!checkoutUnavailable && !soldOut && (
          <button
            type="button"
            onClick={handleQuickAdd}
            aria-label={t("product.addToBag")}
            aria-expanded={quickAddSizes.length > 1 ? picking : undefined}
            className={`absolute bottom-3 end-3 flex h-10 w-10 items-center justify-center rounded-full shadow-soft backdrop-blur-sm transition-colors ${
              picking ? "bg-ink text-paper" : "bg-paper/90 text-ink hover:bg-ink hover:text-paper"
            }`}
          >
            <svg className="h-[18px] w-[18px]" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M5 7h10l0.8 10.5a1 1 0 01-1 1.1H5.2a1 1 0 01-1-1.1L5 7z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
              <path d="M7.2 7V5.5a2.8 2.8 0 015.6 0V7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>

      <div className="mt-4 flex items-start justify-between gap-2">
        <div>
          <Link to={`/product/${product.slug}`}>
            <h3 className="font-display text-base font-semibold leading-snug text-ink hover:text-wine">
              {product.name}
            </h3>
          </Link>
          <p className="mt-1 text-sm text-ink-soft">{variant?.colorName}</p>
        </div>
        <div className="shrink-0 text-end">
          <p className="text-base font-semibold text-ink">{formatPrice(product.price)}</p>
          {product.compareAtPrice && (
            <p className="text-sm text-ink-faint line-through">{formatPrice(product.compareAtPrice)}</p>
          )}
        </div>
      </div>
    </div>
  );
}
