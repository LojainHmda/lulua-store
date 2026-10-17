// Pure data (no Firebase imports) so both the admin import
// (src/admin/storeCategoryPreset.ts) and the Node seed script
// (scripts/seed-categories.mjs) read the exact same tree.
//
// The store's own category list, exactly as the owner gave it. This is
// ONLY the starting data the admin can import from /admin/categories
// ("Add store categories") — once imported, every category is an ordinary
// Firestore doc the admin can rename, re-icon, move, reorder, deactivate or
// delete. Nothing in the POS or storefront reads this list directly.
//
// Doc id = slug, so importing twice never duplicates anything and existing
// products/categories with other slugs are left alone.
export interface PresetNode {
  slug: string;
  name: string;
  nameAr: string;
  icon: string;
  children?: PresetNode[];
}

export const STORE_CATEGORY_PRESET: PresetNode[] = [
  { slug: "women-pajamas", name: "Women's pajamas", nameAr: "بيجامات ستاتي", icon: "pajamas" },
  { slug: "women-underwear", name: "Women's underwear", nameAr: "ملابس داخليه ستاتي", icon: "underwear" },
  { slug: "men-underwear", name: "Men's underwear", nameAr: "ملابس داخليه رجالي", icon: "underwear" },
  {
    slug: "men-pajamas",
    name: "Men's pajamas",
    nameAr: "بيجامات رجالي",
    icon: "pajamas",
    children: [{ slug: "men-pajamas-soba", name: "Soba", nameAr: "سوبا", icon: "pajamas" }],
  },
  { slug: "bridal-nightgowns", name: "Bridal nightgowns", nameAr: "قمصان عرايسي", icon: "nightgown" },
  { slug: "home-furnishings", name: "Home furnishings", nameAr: "فرش منزلي", icon: "bedding" },
  { slug: "kitchen-supplies", name: "Kitchen supplies", nameAr: "لوازم مطبخ", icon: "kitchen" },
  { slug: "baby", name: "Baby", nameAr: "بيبي", icon: "tag" },
];
