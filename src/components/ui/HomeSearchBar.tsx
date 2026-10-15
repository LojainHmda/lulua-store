import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useCatalog } from "../../context/CatalogContext";
import { useLanguage } from "../../context/LanguageContext";
import { getLocalizedCategoryBySlug, getLocalizedProducts } from "../../data/localize";
import { getPrimaryVariant } from "../../data/variants";
import ProductPhoto from "./ProductPhoto";
import { formatPrice } from "../../utils/currency";

export default function HomeSearchBar() {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const { lang, t } = useLanguage();
  const catalog = useCatalog();

  const products = useMemo(() => getLocalizedProducts(catalog.products, lang), [catalog.products, lang]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return products
      .filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.category.toLowerCase().includes(q) ||
          p.colorVariants.some((v) => v.colorName.toLowerCase().includes(q))
      )
      .slice(0, 5);
  }, [products, query]);

  const suggestions = useMemo(() => products.filter((p) => p.tags?.includes("bestseller")).slice(0, 4), [products]);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  function goToResults(q: string) {
    if (!q.trim()) return;
    navigate(`/shop?q=${encodeURIComponent(q.trim())}`);
    setOpen(false);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    goToResults(query);
  }

  const showDropdown = open && (matches.length > 0 || query.trim().length > 0 || suggestions.length > 0);

  return (
    <div ref={wrapRef} className="relative mx-auto w-full max-w-2xl">
      <form onSubmit={submit}>
        <div className="flex items-center gap-2 rounded-full bg-paper py-3 ps-4 pe-2 shadow-lift ring-1 ring-ink/5 sm:gap-2.5 sm:py-3 sm:ps-5 sm:pe-2.5">
          <SearchIcon className="h-5 w-5 shrink-0 text-wine/60" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setOpen(true)}
            placeholder={t("homeSearch.placeholder")}
            aria-label={t("homeSearch.searchLabel")}
            className="w-full min-w-0 truncate bg-transparent text-base text-ink outline-none placeholder:text-ink-faint"
          />
          <button
            type="submit"
            className="hidden shrink-0 rounded-full bg-wine px-5 py-2.5 text-sm font-bold text-on-accent transition-colors hover:bg-wine-dark sm:block"
          >
            {t("homeSearch.search")}
          </button>
        </div>
      </form>

      <AnimatePresence>
        {showDropdown && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="absolute inset-x-0 top-full z-30 mt-3 overflow-hidden rounded-2xl bg-paper shadow-lift ring-1 ring-ink/5"
          >
            {query.trim() ? (
              matches.length > 0 ? (
                <ul>
                  {matches.map((p) => {
                    const cat = getLocalizedCategoryBySlug(catalog.allCategories, p.category, lang);
                    const variant = getPrimaryVariant(p);
                    return (
                      <li key={p.id}>
                        <Link
                          to={`/product/${p.slug}`}
                          onClick={() => setOpen(false)}
                          className="flex items-center gap-4 px-5 py-3 transition-colors hover:bg-cream-dim"
                        >
                          <ProductPhoto
                            imageId={variant?.imageId ?? ""}
                            imageUrl={variant?.imageUrl}
                            alt={p.name}
                            width={100}
                            aspect={{ w: 1, h: 1 }}
                            className="h-14 w-14 shrink-0 rounded-lg"
                          />
                          <div className="min-w-0 flex-1">
                            <p className="truncate font-semibold text-ink">{p.name}</p>
                            <p className="truncate text-sm text-ink-soft">
                              {cat?.name ?? p.category} · {variant?.colorName}
                            </p>
                          </div>
                          <span className="shrink-0 font-semibold text-ink">{formatPrice(p.price)}</span>
                        </Link>
                      </li>
                    );
                  })}
                  <li className="border-t border-line">
                    <button
                      onClick={() => goToResults(query)}
                      className="block w-full px-5 py-3.5 text-center text-base font-semibold text-wine hover:bg-cream-dim"
                    >
                      {t("homeSearch.viewAllResults")} &ldquo;{query}&rdquo;
                    </button>
                  </li>
                </ul>
              ) : (
                <p className="px-5 py-8 text-center text-base text-ink-soft">
                  {t("homeSearch.noMatches")} &ldquo;{query}&rdquo; — {t("homeSearch.tryAnother")}
                </p>
              )
            ) : (
              <div className="p-5">
                <p className="mb-3 text-sm font-bold uppercase tracking-wide text-ink-faint">{t("homeSearch.popularNow")}</p>
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                  {suggestions.map((p) => (
                    <Link key={p.id} to={`/product/${p.slug}`} onClick={() => setOpen(false)} className="group">
                      <ProductPhoto
                        imageId={getPrimaryVariant(p)?.imageId ?? ""}
                        imageUrl={getPrimaryVariant(p)?.imageUrl}
                        alt={p.name}
                        width={220}
                        aspect={{ w: 4, h: 5 }}
                        className="aspect-[4/5] w-full rounded-xl"
                        imgClassName="transition-transform duration-300 group-hover:scale-105"
                      />
                      <p className="mt-2 truncate text-sm font-semibold text-ink">{p.name}</p>
                      <p className="text-sm text-ink-soft">{formatPrice(p.price)}</p>
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 19 19" fill="none">
      <circle cx="8.5" cy="8.5" r="6.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M13.5 13.5L17.5 17.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
