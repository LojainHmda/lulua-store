import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import ProductCard from "../components/ui/ProductCard";
import ProductPhoto from "../components/ui/ProductPhoto";
import { useCatalog } from "../context/CatalogContext";
import { useLanguage } from "../context/LanguageContext";
import { subtreeSlugs } from "../data/categoryTree";
import { getLocalizedCategories, getLocalizedProducts } from "../data/localize";
import { trackCategoryView } from "../analytics/track";

type SortKey = "featured" | "price-asc" | "price-desc";

const SORT_LABEL_KEYS: Record<SortKey, string> = {
  featured: "shop.sortFeatured",
  "price-asc": "shop.sortPriceAsc",
  "price-desc": "shop.sortPriceDesc",
};
type TagKey = "new" | "bestseller" | "sale" | "limited";

// The "All Products" view (no :category param, no search query) has no
// category doc to pull a banner image/tagline from, so it used to fall back
// to a flat, image-less strip while every real category got a proper photo
// banner. This gives it the same treatment as any other category.
const ALL_PRODUCTS_IMAGE_ID = "1618333452884-5c8d211ed2ad";

// The whole catalog used to render into one unpaginated grid. 24 divides
// evenly into the 2/4-column layouts, so a page never ends on a ragged row.
const PAGE_SIZE = 24;

export default function Shop() {
  const { category } = useParams();
  const [params, setParams] = useSearchParams();
  const [sort, setSort] = useState<SortKey>("featured");
  const { lang, t } = useLanguage();
  const catalog = useCatalog();

  const products = useMemo(() => getLocalizedProducts(catalog.products, lang), [catalog.products, lang]);

  const TAG_FILTERS: { key: TagKey; label: string }[] = [
    { key: "new", label: t("shop.tagNew") },
    { key: "bestseller", label: t("shop.tagBestseller") },
    { key: "sale", label: t("shop.tagSale") },
    { key: "limited", label: t("shop.tagLimited") },
  ];

  // Looked up across every depth (a subcategory has its own URL too), and
  // "in this category" includes everything under it.
  const allCategories = useMemo(() => getLocalizedCategories(catalog.allCategories, lang), [catalog.allCategories, lang]);
  const activeCategory = allCategories.find((c) => c.slug === category);
  const activeSlugs = useMemo(
    () => (activeCategory ? subtreeSlugs(allCategories, activeCategory.id ?? activeCategory.slug) : null),
    [allCategories, activeCategory]
  );
  const query = params.get("q") ?? "";
  const activeTag = params.get("filter") as TagKey | null;

  // Analytics: browsing a specific category is a real interest signal for
  // the admin "top categories" insights, on top of the per-product-view
  // attribution tracked in ProductDetail.
  useEffect(() => {
    if (activeCategory) trackCategoryView(activeCategory.slug);
  }, [activeCategory?.slug]);

  function setTag(tag: TagKey | null) {
    const next = new URLSearchParams(params);
    if (tag) next.set("filter", tag);
    else next.delete("filter");
    setParams(next, { replace: true });
  }

  const filtered = useMemo(() => {
    let list = products.slice();
    if (activeSlugs) list = list.filter((p) => activeSlugs.has(p.category));
    if (query) {
      const q = query.toLowerCase();
      list = list.filter((p) => p.name.toLowerCase().includes(q) || p.category.toLowerCase().includes(q));
    }
    if (activeTag) list = list.filter((p) => p.tags?.includes(activeTag));

    switch (sort) {
      case "price-asc":
        list.sort((a, b) => a.price - b.price);
        break;
      case "price-desc":
        list.sort((a, b) => b.price - a.price);
        break;
    }
    return list;
  }, [products, activeSlugs, query, activeTag, sort]);

  // Client-side "load more" paging. Any change to the category, search text,
  // tag filter or sort order snaps back to the first page — otherwise a
  // narrower filter would leave the shopper looking at a partial list they
  // didn't ask to expand.
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [activeCategory?.slug, query, activeTag, sort]);

  const visible = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount]);
  const hasMore = filtered.length > visible.length;

  return (
    <div>
      <section className="relative overflow-hidden">
        {activeCategory ? (
          <ProductPhoto
            imageId={activeCategory.imageId}
            imageUrl={activeCategory.imageUrl}
            alt=""
            width={1600}
            aspect={{ w: 16, h: 6 }}
            className="absolute inset-0"
            imgClassName="opacity-90"
            priority
          />
        ) : (
          !query && (
            <ProductPhoto
              imageId={ALL_PRODUCTS_IMAGE_ID}
              alt=""
              width={1600}
              aspect={{ w: 16, h: 6 }}
              className="absolute inset-0"
              imgClassName="opacity-90"
              priority
            />
          )
        )}
        <div
          className={`absolute inset-0 ${
            activeCategory || !query ? "bg-gradient-to-t from-black/80 via-black/25 to-black/10" : "bg-cream-dim"
          }`}
        />
        <div
          className={`container-page relative py-14 md:py-20 ${
            // A photo banner's overlay only darkens bottom-to-top, so a
            // right-aligned (RTL) or otherwise differently-cropped heading
            // can still land over a lighter patch of the photo. A shadow
            // keeps the text readable regardless of what's behind it,
            // instead of depending on every future banner photo happening
            // to be dark exactly where the text lands in both directions.
            activeCategory || !query ? "[text-shadow:0_2px_10px_rgba(0,0,0,0.6)]" : ""
          }`}
        >
          <p
            className={`text-base font-bold uppercase tracking-wide ${
              activeCategory || !query ? "text-on-accent/75" : "text-ink-soft"
            }`}
          >
            {query ? t("shop.searchResults") : t("shop.shop")}
          </p>
          <h1
            className={`mt-2 font-display text-3xl font-semibold tracking-tight sm:text-4xl ${
              activeCategory || !query ? "text-on-accent" : "text-ink"
            }`}
          >
            {query ? `"${query}"` : activeCategory ? activeCategory.name : t("shop.allProducts")}
          </h1>
          {activeCategory && <p className="mt-2 max-w-md text-base text-on-accent/80">{activeCategory.tagline}</p>}
          {!activeCategory && !query && <p className="mt-2 max-w-md text-base text-on-accent/80">{t("shop.allProductsTagline")}</p>}
        </div>
      </section>

      <section className="container-page pb-8 pt-5 md:pb-12 md:pt-6">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line pb-5">
          <div className="flex flex-wrap items-center gap-2.5">
            {TAG_FILTERS.map((tag) => (
              <button
                key={tag.key}
                onClick={() => setTag(activeTag === tag.key ? null : tag.key)}
                className={`rounded-full border px-4 py-2 text-sm font-bold uppercase tracking-wide transition-colors ${
                  activeTag === tag.key
                    ? "border-ink bg-ink text-paper"
                    : "border-line bg-paper text-ink-soft hover:border-ink"
                }`}
              >
                {tag.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-3">
            <span className="text-sm text-ink-soft">
              {filtered.length} {t("shop.items")}
            </span>
            {/* The invisible label sizes the pill to the selected option, so the
                native select doesn't stretch to its longest option. */}
            <div className="relative inline-grid">
              <span aria-hidden className="invisible whitespace-nowrap border py-2 pe-9 ps-4 text-sm font-semibold">
                {t(SORT_LABEL_KEYS[sort])}
              </span>
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as SortKey)}
                className="absolute inset-0 w-full cursor-pointer appearance-none rounded-full border border-line bg-paper py-2 pe-9 ps-4 text-sm font-semibold text-ink outline-none focus:border-wine"
              >
                {(Object.keys(SORT_LABEL_KEYS) as SortKey[]).map((key) => (
                  <option key={key} value={key}>
                    {t(SORT_LABEL_KEYS[key])}
                  </option>
                ))}
              </select>
              <svg
                aria-hidden
                viewBox="0 0 20 20"
                fill="currentColor"
                className="pointer-events-none absolute end-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-soft"
              >
                <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.17l3.71-3.94a.75.75 0 1 1 1.08 1.04l-4.25 4.5a.75.75 0 0 1-1.08 0l-4.25-4.5a.75.75 0 0 1 .02-1.06Z" clipRule="evenodd" />
              </svg>
            </div>
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-24 text-center">
            <p className="font-display text-3xl font-bold">{t("shop.noMatches")}</p>
            <p className="text-lg text-ink-soft">{t("shop.noMatchesSub")}</p>
          </div>
        ) : (
          <>
            <motion.div className="mt-8 grid grid-cols-2 gap-x-4 gap-y-9 sm:gap-x-6 lg:grid-cols-4">
              <AnimatePresence mode="popLayout">
                {visible.map((p, i) => (
                  <motion.div
                    key={p.id}
                    layout
                    initial={{ opacity: 0, y: 16 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.94 }}
                    transition={{ duration: 0.35, delay: Math.min(i % PAGE_SIZE, 10) * 0.03, ease: [0.16, 1, 0.3, 1] }}
                  >
                    <ProductCard product={p} />
                  </motion.div>
                ))}
              </AnimatePresence>
            </motion.div>

            {hasMore && (
              <div className="mt-12 flex flex-col items-center gap-3">
                <p className="text-sm text-ink-soft">
                  {t("shop.showing")} {visible.length} {t("shop.of")} {filtered.length}
                </p>
                <button
                  type="button"
                  onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
                  className="rounded-full border border-ink px-6 py-2.5 text-sm font-bold uppercase tracking-wide text-ink transition-colors hover:bg-ink hover:text-paper"
                >
                  {t("shop.loadMore")}
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
