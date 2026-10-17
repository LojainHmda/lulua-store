import { doc, serverTimestamp, writeBatch } from "../db/firestore";
import { db } from "../firebase/config";
import { renumberTree } from "../data/categoryTree";
import { STORE_CATEGORY_PRESET, type PresetNode } from "../data/storeCategories";
import type { AdminCategory } from "./types";

// Adds every preset category that doesn't exist yet (matched by slug), in
// one batch, after the existing ones; then renumbers `order` across the
// whole collection so the flat order follows the tree. Existing categories
// are never modified except for their `order`. Returns how many were added.
export async function importStoreCategories(existing: AdminCategory[]): Promise<number> {
  const bySlug = new Map(existing.map((c) => [c.slug, c]));
  const added: AdminCategory[] = [];
  let next = existing.reduce((m, c) => Math.max(m, c.order ?? 0), -1) + 1;

  const walk = (nodes: PresetNode[], parentId: string | null) => {
    for (const n of nodes) {
      const found = bySlug.get(n.slug);
      // An existing category with this slug keeps its own id/settings; the
      // preset's children still hang under it.
      const id = found?.id ?? n.slug;
      if (!found) {
        added.push({
          id,
          slug: n.slug,
          name: n.name,
          nameAr: n.nameAr,
          tagline: "",
          taglineAr: "",
          imageId: "",
          imageUrl: "",
          icon: n.icon,
          parentId,
          isActive: true,
          order: next++,
        });
      }
      if (n.children) walk(n.children, id);
    }
  };
  walk(STORE_CATEGORY_PRESET, null);
  if (added.length === 0) return 0;

  const all = [...existing, ...added];
  const renumbered = new Map(renumberTree(all).map((r) => [r.key, r.order]));
  const batch = writeBatch(db);
  for (const c of added) {
    const { id, ...data } = c;
    batch.set(doc(db, "categories", id), {
      ...data,
      order: renumbered.get(id) ?? data.order,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }
  for (const c of existing) {
    const order = renumbered.get(c.id);
    if (order !== undefined) batch.update(doc(db, "categories", c.id), { order });
  }
  await batch.commit();
  return added.length;
}
