import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useCatalog } from "../../context/CatalogContext";
import { useLanguage } from "../../context/LanguageContext";
import { getLocalizedCategories } from "../../data/localize";
import { resolveCategoryIcon } from "./CategoryIcons";
import HomeSearchBar from "./HomeSearchBar";

function CategoryIconLink({ slug, name, icon }: { slug: string; name: string; icon?: string }) {
  const Icon = resolveCategoryIcon(icon);
  return (
    <Link to={`/shop/${slug}`} className="group flex w-14 shrink-0 flex-col items-center gap-1.5 sm:w-16 sm:gap-2">
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-wine text-white shadow-soft transition-colors duration-200 ease-out group-hover:bg-white group-hover:text-wine sm:h-14 sm:w-14">
        <Icon className="h-5 w-5 transition-transform duration-200 ease-out group-hover:scale-110 sm:h-6 sm:w-6" />
      </span>
      <span className="line-clamp-1 text-center text-[11px] font-semibold text-ink-soft group-hover:text-wine sm:text-sm">
        {name}
      </span>
    </Link>
  );
}

// One reusable, admin-driven row: every active category renders here, in
// the exact order set on /admin/categories (drag-to-reorder), with the
// icon chosen there — no hardcoded slug->icon map and no hardcoded
// left/right split. A category the admin hasn't assigned an icon to yet
// still renders (resolveCategoryIcon() falls back to a generic glyph
// instead of silently disappearing from the row, which is what used to
// happen for any slug missing from the old hardcoded ICONS map).
export default function SearchWithCategoryIcons() {
  const { lang } = useLanguage();
  const catalog = useCatalog();
  const categories = useMemo(() => getLocalizedCategories(catalog.categories, lang), [catalog.categories, lang]);

  return (
    <div className="mx-auto w-full max-w-6xl">
      <div className="mx-auto max-w-2xl">
        <HomeSearchBar />
      </div>

      {categories.length > 0 && (
        <div className="relative z-10 mt-6 flex flex-wrap items-start justify-center gap-x-3 gap-y-4 sm:mt-7 sm:gap-x-6 sm:gap-y-5">
          {categories.map((c) => (
            <CategoryIconLink key={c.slug} slug={c.slug} name={c.name} icon={c.icon} />
          ))}
        </div>
      )}
    </div>
  );
}
