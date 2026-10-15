import type { AdminProduct } from "./types";

// AddOrderItemModal.tsx's own product-list filter predicate, extracted so
// the category+search interaction is directly testable without mounting the
// modal. Deliberately separate from orderListSearch.ts (that's OrderList.tsx's
// order-row search, a different domain entirely) and from
// src/components/admin/orderSearch.ts's token/synonym-aware search (built for
// the global ⌘K lookup, not this picker) -- this keeps the exact simple
// "does the product's name/Arabic name contain what was typed" behavior the
// modal already had before category navigation was added.
export function productMatchesAddItemSearch(product: Pick<AdminProduct, "name" | "nameAr">, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return product.name.toLowerCase().includes(q) || (product.nameAr ?? "").toLowerCase().includes(q);
}

// Category first, then search within whatever the category narrowed it to --
// mirrors the storefront's own, already-established category+search order
// (src/pages/Shop.tsx's `filtered` useMemo: category filter applied before
// the search filter), so a category selection here behaves exactly the way
// staff already know it does when browsing the shop: search stays scoped to
// the selected category rather than silently reaching outside it. Selecting
// "All" (categorySlug null) removes that narrowing entirely, back to a plain
// search over every product -- the modal's original behavior before this.
export function filterProductsForAddItem<T extends Pick<AdminProduct, "name" | "nameAr" | "category">>(
  products: T[],
  { search, categorySlug }: { search: string; categorySlug: string | null }
): T[] {
  let list = products;
  if (categorySlug) list = list.filter((p) => p.category === categorySlug);
  const q = search.trim();
  if (q) list = list.filter((p) => productMatchesAddItemSearch(p, q));
  return list;
}
