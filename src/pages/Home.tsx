import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import HeroCarousel from "../components/ui/HeroCarousel";
import LinkButton from "../components/ui/LinkButton";
import ProductCard from "../components/ui/ProductCard";
import ProductPhoto from "../components/ui/ProductPhoto";
import PromoBannerStrip from "../components/ui/PromoBannerStrip";
import Reveal from "../components/ui/Reveal";
import SearchWithCategoryIcons from "../components/ui/SearchWithCategoryIcons";
import { useCatalog } from "../context/CatalogContext";
import { useLanguage } from "../context/LanguageContext";
import type { HeroSlide } from "../data/heroSlides";
import { getLocalizedProducts, localizedName } from "../data/localize";
import { DEFAULT_VALUE_STRIP, VALUE_STRIP_ICONS } from "../data/valueStrip";
import { getPrimaryVariant, isProductSoldOut } from "../data/variants";
import { getSingletonDoc } from "../firebase/firestore";
import type { HomepageContentDoc } from "../admin/types";
import type { Product } from "../types";
import { formatPrice } from "../utils/currency";

// Matches Catchy's "Latest Arrivals" display count exactly.
const NEW_ARRIVALS_COUNT = 10;

// TEMPORARY fallback strategy, until Sisley starts receiving and tagging
// genuinely new inventory: every catalog product is eligible (not just
// tag:"new"/"limited" ones), sorted so in-stock products always show
// first. `products` here is already sellable-only (CatalogContext applies
// src/data/sellability.ts), so confirmed out-of-stock products never reach
// this function at all. The sort below only matters for the rare product
// that is kept visible with stock nobody has counted yet (qty: null):
// isProductSoldOut still reads that as sold out, so it goes to the end via
// a stable sort (equal-priority items keep their original catalog order).
//
// This is the one function to replace once real curation exists — e.g.
// swap the body for `products.filter(p => p.tags?.includes("new") ||
// p.tags?.includes("limited"))` (the previous behavior) or a
// createdAt-based query. Nothing else in Home.tsx needs to change, since
// this is its only caller.
function selectNewArrivals(products: Product[]): Product[] {
  return products
    .slice()
    .sort((a, b) => Number(isProductSoldOut(a)) - Number(isProductSoldOut(b)))
    .slice(0, NEW_ARRIVALS_COUNT);
}

// CSS grid column count must always equal the active item count — a fixed
// column count (e.g. always 4) would leave a visibly empty trailing column
// whenever an item is disabled. Literal class strings (not built via
// template interpolation) so Tailwind's content scanner can find them.
const VALUE_STRIP_COLS: Record<number, string> = {
  1: "grid-cols-1",
  2: "grid-cols-2",
  3: "grid-cols-3",
  4: "grid-cols-2 sm:grid-cols-4",
};

export default function Home() {
  const { lang, t } = useLanguage();
  const catalog = useCatalog();
  const products = useMemo(() => getLocalizedProducts(catalog.products, lang), [catalog.products, lang]);
  const [homepageContent, setHomepageContent] = useState<HomepageContentDoc | null>(null);

  useEffect(() => {
    getSingletonDoc<HomepageContentDoc>("siteContent", "homepage").then((doc) => setHomepageContent(doc ?? null));
  }, []);

  const heroSlides: HeroSlide[] | undefined = useMemo(() => {
    if (!homepageContent?.heroSlides?.length) return undefined;
    return homepageContent.heroSlides.map((s) => ({
      type: s.type,
      src: s.src,
      poster: s.poster,
      alt: s.alt,
      badge: s.badge,
      badgeAr: s.badgeAr,
      title: s.title,
      titleAr: s.titleAr,
    }));
  }, [homepageContent]);

  // Admin-controlled text/active-state, fixed icon per id — falls back to
  // DEFAULT_VALUE_STRIP (identical to the previous hardcoded copy) whenever
  // the document doesn't have this field yet.
  const activeValueStripItems = useMemo(() => {
    const items = homepageContent?.valueStrip?.length ? homepageContent.valueStrip : DEFAULT_VALUE_STRIP;
    return items
      .filter((item) => item.active)
      .map((item) => ({ id: item.id, label: localizedName(item.text, item.textAr, lang), Icon: VALUE_STRIP_ICONS[item.id] }));
  }, [homepageContent, lang]);

  // Gated on catalog.loading: CatalogContext briefly serves a bundled
  // static fallback catalog (src/data/products.ts) before the live
  // Firestore snapshot resolves. That fallback can contain stale/archived
  // demo products, which would violate "never show a sold-out product" if
  // shown even momentarily. Waiting the extra beat for the real catalog is
  // imperceptible in normal use and keeps this section always correct.
  const newArrivals = catalog.loading ? [] : selectNewArrivals(products);
  const bestsellers = products.filter((p) => p.tags?.includes("bestseller")).slice(0, 4);

  return (
    <div>
      {/* Hero */}
      <HeroCarousel slides={heroSlides} />

      {/* Search bar + category icons — floats over the hero/content boundary */}
      <section className="container-page relative z-20 mt-6 md:-mt-9">
        <Reveal y={16}>
          <SearchWithCategoryIcons />
        </Reveal>
      </section>

      {/* Promo banners — admin-authored, hidden entirely when none are active */}
      <PromoBannerStrip banners={homepageContent?.banners ?? []} />

      {/* Value strip — admin-controlled via Homepage Content; disabled items
          are removed from the array entirely (not hidden with CSS), and the
          column count always matches the active count, so there's never an
          empty slot. Section itself disappears when every item is off. */}
      {activeValueStripItems.length > 0 && (
        <section className="mt-10 border-y border-line bg-paper md:mt-14">
          <div className={`container-page grid ${VALUE_STRIP_COLS[activeValueStripItems.length]} gap-6 py-7`}>
            {activeValueStripItems.map(({ id, label, Icon }) => (
              <div key={id} className="flex items-center gap-2.5 sm:gap-3">
                <Icon className="h-6 w-6 shrink-0 text-wine sm:h-7 sm:w-7" />
                <p className="text-sm font-medium leading-tight text-ink sm:text-base">{label}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* New arrivals — Catchy-style presentation: a tight, image-forward
          grid (no name/price text beneath the photo), with price revealed
          only on hover/tap via a glass overlay centered on the image.
          Sold-out products are filtered out of newArrivals itself above,
          never merely hidden with CSS, so a fully sold-out product can
          never even reach this markup. */}
      {newArrivals.length > 0 && (
        <section className="container-page py-10 md:py-14">
          <Reveal>
            <h2 className="text-center font-display text-2xl font-semibold tracking-tight sm:text-3xl">
              {t("home.freshArrivals")}
            </h2>
          </Reveal>
          <Reveal delay={0.1} className="mt-8">
            <div className="grid grid-cols-2 gap-1 sm:grid-cols-3 lg:grid-cols-5">
              {newArrivals.map((p) => {
                const variant = getPrimaryVariant(p);
                return (
                  <Link key={p.id} to={`/product/${p.slug}`} className="group relative isolate block">
                    <div className="relative aspect-[3/4] overflow-hidden bg-cream-dim">
                      <ProductPhoto
                        imageId={variant?.imageId ?? ""}
                        imageUrl={variant?.imageUrl}
                        alt={p.name}
                        width={500}
                        aspect={{ w: 3, h: 4 }}
                        className="h-full w-full"
                        imgClassName="transition-transform duration-700 group-hover:scale-105"
                      />
                      <div className="absolute inset-0 flex items-center justify-center invisible bg-ink/20 opacity-0 transition-[opacity,visibility] duration-300 ease-out group-hover:visible group-hover:opacity-100">
                        <span className="rounded-xl border border-paper/30 bg-paper/15 px-4 py-2 text-sm font-bold tracking-wide text-paper shadow-lift backdrop-blur-md sm:text-base">
                          {formatPrice(p.price)}
                        </span>
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          </Reveal>
        </section>
      )}

      {/* Brand story band */}
      <section className="mt-10 bg-wine py-12 text-on-accent md:mt-14 md:py-16">
        <div className="container-page grid grid-cols-1 items-center gap-12 lg:grid-cols-2">
          <Reveal>
            <span className="inline-flex rounded-full bg-on-accent/10 px-4 py-2 text-sm font-bold uppercase tracking-wide text-on-accent/80">
              {t("home.whyBrand")}
            </span>
            <h2 className="mt-5 text-balance font-display text-2xl font-semibold leading-tight sm:text-3xl">
              {t("home.whyBrandTitle")}
            </h2>
            <p className="mt-5 max-w-lg text-base text-on-accent/70">{t("home.whyBrandBody")}</p>
            <LinkButton to="/about" variant="ghost" size="lg" className="mt-8 bg-cream text-ink hover:bg-cream/90">
              {t("home.readOurStory")}
            </LinkButton>
          </Reveal>
          <Reveal delay={0.15}>
            <ProductPhoto
              imageId="1642618276983-51985a775142"
              alt="Runway presentation"
              width={800}
              aspect={{ w: 4, h: 5 }}
              className="mx-auto w-full max-w-sm rounded-2xl"
            />
          </Reveal>
        </div>
      </section>

      {/* Bestsellers */}
      {bestsellers.length > 0 && (
        <section className="container-page py-10 md:py-14">
          <Reveal>
            <div className="flex items-end justify-between gap-4">
              <div>
                <h2 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">
                  {t("home.communityFavorites")}
                </h2>
                <p className="mt-2 text-sm text-ink-soft sm:text-base">{t("home.communityFavoritesSub")}</p>
              </div>
              <Link
                to="/shop?filter=bestseller"
                className="hidden shrink-0 text-base font-semibold text-ink underline decoration-wine decoration-2 underline-offset-4 hover:text-wine sm:block"
              >
                {t("common.viewAll")}
              </Link>
            </div>
          </Reveal>
          <div className="mt-7 grid grid-cols-2 gap-4 sm:gap-6 lg:grid-cols-4">
            {bestsellers.map((p, i) => (
              <Reveal key={p.id} delay={i * 0.08}>
                <ProductCard product={p} />
              </Reveal>
            ))}
          </div>
        </section>
      )}

      {/* Closing CTA */}
      <section className="container-page pb-16 pt-2 md:pb-20">
        <Reveal>
          <div className="rounded-3xl bg-wine px-8 py-14 text-center text-on-accent sm:px-16">
            <h2 className="font-display text-2xl font-semibold sm:text-3xl">{t("home.readyToShop")}</h2>
            <p className="mx-auto mt-3 max-w-md text-on-accent/70">{t("home.readyToShopSub")}</p>
            <LinkButton to="/shop" variant="ghost" size="lg" className="mt-8 bg-cream text-ink hover:bg-cream/90">
              {t("home.startShopping")}
            </LinkButton>
          </div>
        </Reveal>
      </section>
    </div>
  );
}
