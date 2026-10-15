import { useMemo } from "react";
import AdminIcon from "../admin/components/AdminIcons";
import type { AdminCategory } from "../admin/types";
import { resolveCategoryIcon } from "../components/ui/CategoryIcons";
import { useLanguage } from "../context/LanguageContext";
import { childrenOf, pathTo, subtree } from "../data/categoryTree";
import { localizedName } from "../data/localize";

// The till's category navigation: a rail beside the product grid, so the
// screen reads as three columns -- categories | products | sale.
//   "All products"    -> every product
//   tap a category    -> its products (everything under it); if it has
//                        subcategories they unfold beneath it in the rail
//   tap a subcategory -> just its products
// On phones the same rail becomes a horizontal, scrollable chip strip above
// the products. Categories come from the admin-managed `categories`
// collection (already filtered to visible ones by Terminal); nothing here
// knows any specific category.

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
  const { t, lang } = useLanguage();

  // Top-level categories, plus the children of every category on the path
  // to the selected one, so the open branch unfolds in place.
  const rows = useMemo(() => {
    const open = new Set(selectedId ? pathTo(categories, selectedId).map((c) => c.id) : []);
    const out: { cat: AdminCategory; depth: number }[] = [];
    const walk = (parent: string | null, depth: number) => {
      for (const c of childrenOf(categories, parent)) {
        out.push({ cat: c, depth });
        if (open.has(c.id)) walk(c.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [categories, selectedId]);

  if (categories.length === 0) return null;

  // Square tiles, two per row in the rail (a scrollable strip on phones).
  // Subcategories of the open branch follow their parent, on a tinted tile.
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
      <button type="button" onClick={() => onSelect(null)} className={tileClass(selectedId === null, false, false)}>
        <span className={iconClass(selectedId === null)}>
          <AdminIcon name="grid" className="h-5 w-5" />
        </span>
        <span className="line-clamp-2 text-xs font-bold leading-tight">{t("pos.categories.allProducts")}</span>
        <span className={countClass(selectedId === null)}>{totalCount}</span>
      </button>
      {rows.map(({ cat, depth }) => {
        const Icon = resolveCategoryIcon(cat.icon);
        const active = cat.id === selectedId;
        const count = subtreeCounts.get(cat.id) ?? 0;
        return (
          <button key={cat.id} type="button" onClick={() => onSelect(cat.id)} className={tileClass(active, count === 0, depth > 0)}>
            <span className={iconClass(active)}>
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
