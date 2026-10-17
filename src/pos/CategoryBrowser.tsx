import { useMemo } from "react";
import AdminIcon from "../admin/components/AdminIcons";
import type { AdminCategory } from "../admin/types";
import { resolveCategoryIcon } from "../components/ui/CategoryIcons";
import { useLanguage } from "../context/LanguageContext";
import { childrenOf, effectiveParent, findCategory, pathTo, subtree } from "../data/categoryTree";
import { localizedName } from "../data/localize";

// The till's category navigation: a rail beside the product grid, so the
// screen reads as three columns -- categories | products | sale.
//   "All products"    -> every product
//   tap a category    -> its products (everything under it); if it has
//                        subcategories, the tiles are replaced by just
//                        those subcategories, with a back tile first
//   tap a subcategory -> just its products (its siblings stay shown)
// On phones the same rail becomes a horizontal, scrollable chip strip above
// the products. Categories come from the admin-managed `categories`
// collection (already filtered to visible ones by Terminal); nothing here
// knows any specific category.

// Each top-level category gets its own icon color (in tree order);
// subcategories share their top-level category's color.
const CATEGORY_COLORS = ["#a855f7", "#ec4899", "#ef4444", "#3b82f6", "#22c55e", "#f97316", "#14b8a6", "#eab308", "#6366f1"];

// Category id AND slug -> color, so product cards (which know their
// category by slug) can use the same color as the category tile.
export function useCategoryColors(categories: AdminCategory[]) {
  return useMemo(() => {
    const top = childrenOf(categories, null);
    const m = new Map<string, string>();
    for (const c of categories) {
      const root = pathTo(categories, c.id)[0] ?? c;
      const i = top.findIndex((t) => t.id === root.id);
      const color = CATEGORY_COLORS[(i < 0 ? 0 : i) % CATEGORY_COLORS.length];
      m.set(c.id, color);
      m.set(c.slug, color);
    }
    return m;
  }, [categories]);
}

// A colored icon tile: the color itself for the glyph, a light tint of it
// behind (works in light and dark themes).
export const tintStyle = (color: string) => ({ color, backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)` });

// Products listed per category id, counting everything under it.
export function useSubtreeCounts(categories: AdminCategory[], counts: Map<string, number>) {
  return useMemo(() => {
    const m = new Map<string, number>();
    for (const c of categories) m.set(c.id, subtree(categories, c.id).reduce((n, x) => n + (counts.get(x.slug) ?? 0), 0));
    return m;
  }, [categories, counts]);
}

export function CategoryRail({
  categories,
  selectedId,
  subtreeCounts,
  totalCount,
  onSelect,
}: {
  categories: AdminCategory[];
  // null = "All products".
  selectedId: string | null;
  subtreeCounts: Map<string, number>;
  totalCount: number;
  onSelect: (id: string | null) => void;
}) {
  const { t, lang, dir } = useLanguage();

  // The level shown: the selected category when it has subcategories,
  // otherwise its parent (so a picked subcategory keeps its siblings in view).
  const level = useMemo(() => {
    if (!selectedId) return null;
    const sel = findCategory(categories, selectedId);
    if (!sel) return null;
    return childrenOf(categories, selectedId).length ? selectedId : effectiveParent(categories, sel);
  }, [categories, selectedId]);
  const levelCat = level ? findCategory(categories, level) : undefined;
  const rows = useMemo(() => childrenOf(categories, level), [categories, level]);
  const colors = useCategoryColors(categories);

  if (categories.length === 0) return null;

  // Square tiles, two per row in the rail (a scrollable strip on phones).
  // Subcategory tiles are tinted.
  const tileClass = (active: boolean, empty: boolean, sub: boolean) =>
    `relative flex aspect-square w-[5.5rem] shrink-0 flex-col items-center justify-center gap-1.5 rounded-2xl border p-1.5 text-center transition-[border-color,background-color,transform] duration-150 active:scale-[0.97] md:w-auto ${
      active
        ? "border-wine bg-wine text-on-accent shadow-soft"
        : `${sub ? "border-dashed border-wine/40 bg-cream" : "border-line bg-paper shadow-soft"} text-ink hover:border-wine/50 hover:bg-cream`
    } ${empty && !active ? "opacity-60" : ""}`;
  const iconClass = (active: boolean) =>
    `flex h-10 w-10 items-center justify-center rounded-xl ${active ? "bg-on-accent/20" : "bg-wine-light text-wine"}`;
  const countClass = (active: boolean) => `text-[11px] font-semibold leading-none ${active ? "text-on-accent/80" : "text-ink-faint"}`;

  return (
    <nav
      aria-label={t("pos.categories.title")}
      className="no-scrollbar flex shrink-0 gap-2 overflow-x-auto border-b border-line px-3 py-2 md:grid md:w-56 md:auto-rows-min md:grid-cols-2 md:overflow-y-auto md:overflow-x-hidden md:border-b-0 md:border-e md:p-2.5 lg:w-60"
    >
      {levelCat ? (
        // Back: up one level (to the parent's own subcategories, or the top).
        <button type="button" onClick={() => onSelect(effectiveParent(categories, levelCat))} className={tileClass(false, false, false)}>
          <span className={iconClass(false)}>
            <AdminIcon name={dir === "rtl" ? "chevronRight" : "chevronLeft"} className="h-5 w-5" />
          </span>
          <span className="line-clamp-2 text-xs font-bold leading-tight">{t("pos.categories.back")}</span>
          <span className={countClass(false)}>{localizedName(levelCat.name, levelCat.nameAr, lang)}</span>
        </button>
      ) : (
        <button type="button" onClick={() => onSelect(null)} className={tileClass(selectedId === null, false, false)}>
          <span className={iconClass(selectedId === null)}>
            <AdminIcon name="grid" className="h-5 w-5" />
          </span>
          <span className="line-clamp-2 text-xs font-bold leading-tight">{t("pos.categories.allProducts")}</span>
          <span className={countClass(selectedId === null)}>{totalCount}</span>
        </button>
      )}
      {rows.map((cat) => {
        const Icon = resolveCategoryIcon(cat.icon);
        const active = cat.id === selectedId;
        const count = subtreeCounts.get(cat.id) ?? 0;
        return (
          <button key={cat.id} type="button" onClick={() => onSelect(cat.id)} className={tileClass(active, count === 0, level !== null)}>
            <span className={iconClass(active)} style={active ? undefined : tintStyle(colors.get(cat.id) ?? "#a855f7")}>
              <Icon className="h-6 w-6" />
            </span>
            <span className="line-clamp-2 text-xs font-bold leading-tight">{localizedName(cat.name, cat.nameAr, lang)}</span>
            <span className={countClass(active)}>{count}</span>
          </button>
        );
      })}
    </nav>
  );
}
