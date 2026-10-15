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
  {
    slug: "pajamas",
    name: "Pajamas",
    nameAr: "بيجامات",
    icon: "pajamas",
    children: [
      { slug: "pajamas-two-piece", name: "Two-piece", nameAr: "قطعتين", icon: "set" },
      { slug: "pajamas-bermuda", name: "Bermuda", nameAr: "برمودا", icon: "shorts" },
      { slug: "pajamas-pants-button-blouse", name: "Pants with button blouse", nameAr: "بنطلون مع بلوز بزرار", icon: "pajamas" },
      { slug: "pajamas-shorts-button-blouse", name: "Shorts with button blouse", nameAr: "شورت مع بلوز بزرار", icon: "pajamas" },
      { slug: "pajamas-shorts-pants-blouse", name: "Shorts with blouse and pants with blouse", nameAr: "شورت مع بلوز وبنطلون مع بلوز", icon: "shorts" },
    ],
  },
  {
    slug: "panties",
    name: "Panties",
    nameAr: "كلوت",
    icon: "underwear",
    children: [
      { slug: "panties-cotton", name: "Cotton", nameAr: "قطن", icon: "underwear" },
      { slug: "panties-lycra", name: "Lycra", nameAr: "لايكرا", icon: "underwear" },
      { slug: "panties-high-waist", name: "High waist", nameAr: "خصر عالي", icon: "underwear" },
      { slug: "panties-low-waist", name: "Low waist", nameAr: "خصر واطي", icon: "underwear" },
    ],
  },
  { slug: "bridal-changes", name: "Bridal changes", nameAr: "غيرات عراسي", icon: "heart" },
  { slug: "bras", name: "Bras", nameAr: "ستيانات", icon: "bra" },
  { slug: "pajama-sets", name: "Pajama sets", nameAr: "اطقم بيجامات", icon: "set" },
  { slug: "camisoles", name: "Camisoles", nameAr: "شباحات", icon: "camisole" },
  { slug: "shapewear", name: "Shapewear", nameAr: "مشدات", icon: "corset" },
  { slug: "shorts", name: "Shorts", nameAr: "شورتات", icon: "shorts" },
  { slug: "shirts", name: "Shirts", nameAr: "قمصان", icon: "shirt" },
  { slug: "bridal", name: "Bridal", nameAr: "عرايسي", icon: "ring" },
  { slug: "leggings", name: "Leggings", nameAr: "فيزونات", icon: "leggings" },
  { slug: "trousers", name: "Trousers", nameAr: "بلاطين", icon: "pants" },
  { slug: "tracksuits", name: "Tracksuits", nameAr: "ترنينجات", icon: "tracksuit" },
  { slug: "bath-sets", name: "Bath sets", nameAr: "اطقم حمام", icon: "bathtub" },
  { slug: "bath-supplies", name: "Bath supplies", nameAr: "لوازم حمام", icon: "soap" },
  { slug: "pillows", name: "Pillows", nameAr: "مخدات", icon: "pillow" },
  { slug: "buckets", name: "Buckets", nameAr: "جوادل", icon: "bucket" },
  { slug: "kitchen-supplies", name: "Kitchen supplies", nameAr: "لوازم مطبخ", icon: "kitchen" },
  { slug: "white-sets", name: "White sets", nameAr: "طقم ابيض", icon: "bedding" },
  { slug: "socks", name: "Socks", nameAr: "جرابات", icon: "socks" },
  { slug: "rugs", name: "Rugs", nameAr: "دعاسات", icon: "rug" },
];
