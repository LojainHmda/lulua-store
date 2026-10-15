// Shared category-tree helpers. Categories live in ONE flat Firestore
// collection (`categories`); hierarchy is just an optional `parentId`
// pointing at another category's doc id. Products still reference a single
// category by slug, so "products in X" means "products whose category is X
// or any category under X" — see subtreeSlugs().
//
// Everything here is defensive about bad data: a parentId pointing at a
// missing/deleted doc makes that category top level, and a parent cycle
// (A -> B -> A) can never loop forever.

export interface TreeNode {
  id?: string;
  slug: string;
  parentId?: string | null;
  isActive?: boolean;
  order?: number;
}

// Unset counts as active: docs written before isActive existed stay visible.
export function isCategoryActive(c: { isActive?: boolean }): boolean {
  return c.isActive !== false;
}

function keyOf(c: TreeNode): string {
  return c.id ?? c.slug;
}

function byOrder(a: TreeNode, b: TreeNode): number {
  return (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER);
}

// The parent key a category effectively has: null when unset or dangling.
export function effectiveParent<T extends TreeNode>(list: T[], c: T): string | null {
  const pid = c.parentId;
  if (!pid || pid === keyOf(c)) return null;
  return list.some((x) => keyOf(x) === pid) ? pid : null;
}

export function childrenOf<T extends TreeNode>(list: T[], parentKey: string | null): T[] {
  return list.filter((c) => effectiveParent(list, c) === parentKey).sort(byOrder);
}

export function findCategory<T extends TreeNode>(list: T[], key: string): T | undefined {
  return list.find((c) => keyOf(c) === key);
}

// Root first, ending with the category itself.
export function pathTo<T extends TreeNode>(list: T[], key: string): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  let cur = findCategory(list, key);
  while (cur && !seen.has(keyOf(cur))) {
    seen.add(keyOf(cur));
    out.unshift(cur);
    const pid = effectiveParent(list, cur);
    cur = pid ? findCategory(list, pid) : undefined;
  }
  return out;
}

// The category and everything under it.
export function subtree<T extends TreeNode>(list: T[], key: string): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  const walk = (k: string) => {
    if (seen.has(k)) return;
    seen.add(k);
    const c = findCategory(list, k);
    if (c) out.push(c);
    for (const child of childrenOf(list, k)) walk(keyOf(child));
  };
  walk(key);
  return out;
}

export function subtreeSlugs<T extends TreeNode>(list: T[], key: string): Set<string> {
  return new Set(subtree(list, key).map((c) => c.slug));
}

// Depth-first listing: each parent followed by its children.
export function flattenTree<T extends TreeNode>(list: T[]): { cat: T; depth: number }[] {
  const out: { cat: T; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (parentKey: string | null, depth: number) => {
    for (const c of childrenOf(list, parentKey)) {
      if (seen.has(keyOf(c))) continue;
      seen.add(keyOf(c));
      out.push({ cat: c, depth });
      walk(keyOf(c), depth + 1);
    }
  };
  walk(null, 0);
  // Anything only reachable through a cycle still gets listed, at the top.
  for (const c of [...list].sort(byOrder)) if (!seen.has(keyOf(c))) out.push({ cat: c, depth: 0 });
  return out;
}

// What the POS and storefront may show: active categories whose ancestors
// are all active too (deactivating a group hides everything under it).
export function visibleCategories<T extends TreeNode>(list: T[]): T[] {
  return list.filter((c) => pathTo(list, keyOf(c)).every(isCategoryActive));
}

// `order` values that make a flat sort match the depth-first tree order.
// Returns only the categories whose order actually changes.
export function renumberTree<T extends TreeNode>(list: T[]): { key: string; order: number }[] {
  return flattenTree(list)
    .map(({ cat }, i) => ({ cat, order: i }))
    .filter(({ cat, order }) => cat.order !== order)
    .map(({ cat, order }) => ({ key: keyOf(cat), order }));
}
