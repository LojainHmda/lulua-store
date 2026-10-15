export interface Category {
  slug: string;
  name: string;
  tagline: string;
  imageId: string;
  imageUrl?: string;
  nameAr?: string;
  taglineAr?: string;
  // Key into CATEGORY_ICONS (src/components/ui/CategoryIcons.tsx), not a
  // slug — an admin can assign any icon to any category. Missing/unknown
  // keys resolve to a generic fallback via resolveCategoryIcon(), never a
  // blank gap in the nav.
  icon?: string;
  // Admin-controlled display order (lower first) — see CategoryList.tsx's
  // drag-to-reorder. Optional because the static offline fallback catalog
  // (src/data/products.ts) relies on its own array order instead.
  order?: number;
  // Firestore doc id — needed to resolve parentId links (which point at doc
  // ids, not slugs). Absent on the static offline fallback catalog.
  id?: string;
  // Doc id of the parent category; unset/null = top level. See
  // src/data/categoryTree.ts for the shared tree helpers.
  parentId?: string | null;
  // false = hidden from the POS and the storefront (kept for the admin).
  // Unset counts as active so pre-existing docs keep showing.
  isActive?: boolean;
}

export interface SizeStock {
  size: string;
  // null = quantity genuinely unknown (never confirmed against a real
  // count) — distinct from 0, which means confirmed sold out. Never treat
  // null as 0 or as unlimited; see src/admin/productVariants.ts and
  // src/data/variants.ts for the shared helpers that handle this safely.
  qty: number | null;
  qtyUnknown?: boolean;
}

export interface ColorVariant {
  id: string;
  colorName: string;
  colorNameAr?: string;
  colorHex: string;
  imageId?: string;
  imageUrl?: string;
  gallery?: string[];
  // Display order (lower first) — colorVariants[0] is "the primary/
  // default color" throughout the storefront. See
  // src/admin/types.ts's AdminColorVariant.order and
  // src/admin/productVariants.ts's joinProductFields() (reused directly
  // by CatalogContext.tsx) for how this is populated/kept sorted.
  order?: number;
  sizeStock: SizeStock[];
}

export interface Product {
  id: string;
  slug: string;
  // Optional manual barcode override — mirrors AdminProduct.sku. Only
  // surfaced here so the admin-only barcode/QR actions on the storefront
  // product page derive the exact same value ProductForm.tsx does.
  sku?: string;
  name: string;
  category: string;
  price: number;
  compareAtPrice?: number;
  colorVariants: ColorVariant[];
  sizes: string[];
  tags?: ("new" | "bestseller" | "sale" | "limited")[];
  rating: number;
  reviewCount: number;
  description: string;
  details: string[];
  nameAr?: string;
  descriptionAr?: string;
  detailsAr?: string[];
  videoUrl?: string;
}
