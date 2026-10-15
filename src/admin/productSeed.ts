import { PRODUCTS } from "../data/products";
import { AR_COLORS, AR_PRODUCTS } from "../i18n/arData";
import type { AdminColorVariant, AdminProduct } from "./types";

// Sample products for `npm run seed:products` (scripts/seed-products.mjs).
//
// Built from the storefront's built-in demo catalog (src/data/products.ts),
// which is what the store shows while Firestore has no active products, so
// seeding restores exactly those products as real, editable documents.
// Each record is shaped like what ProductForm builds when an admin creates
// a product by hand: bilingual name/description/details, a barcode SKU,
// per-color variants with an Arabic color name, an image and per-size stock,
// tags always an array, status "active".
//
// Pure data, no Firestore access: the script does the writes, using the
// same splitProductFields()/computeStockDeltas() path ProductForm uses.

// ProductForm's ALL_SIZES. Products whose sizes fall outside it (the
// built-in sandals use numeric shoe sizes) can't be created or edited
// through the form, so they're left out.
const FORM_SIZES = ["XS", "S", "M", "L", "XL", "One Size"];

// Deterministic EAN-13 in the same 729 (Israel) range as the form's SKU
// placeholder, so each product's barcode stays stable across runs.
function ean13(index: number): string {
  const body = `729100${String(index).padStart(6, "0")}`;
  const sum = [...body].reduce((acc, d, i) => acc + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return body + ((10 - (sum % 10)) % 10);
}

// Same "<color-slug>-<suffix>" format newVariantId() produces, but with the
// product id as the suffix instead of a random one, so re-runs match.
function variantId(colorName: string, productId: string): string {
  const base = colorName.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  return `${base || "color"}-${productId}`;
}

export const SEED_PRODUCTS: AdminProduct[] = PRODUCTS.filter((p) => p.sizes.every((s) => FORM_SIZES.includes(s))).map((p, i) => {
  const ar = AR_PRODUCTS[p.id];
  const colorVariants: AdminColorVariant[] = p.colorVariants.map((v, order) => ({
    id: variantId(v.colorName, p.id),
    colorName: v.colorName,
    colorNameAr: AR_COLORS[v.colorName] ?? "",
    colorHex: v.colorHex,
    imageId: v.imageId,
    order,
    sizeStock: v.sizeStock.map((s) => ({ size: s.size, qty: s.qty })),
  }));
  return {
    id: p.id,
    slug: p.slug,
    sku: ean13(i + 1),
    name: p.name,
    nameAr: ar?.name ?? "",
    category: p.category,
    price: p.price,
    compareAtPrice: p.compareAtPrice,
    colorVariants,
    sizes: [...p.sizes],
    tags: [...(p.tags ?? [])],
    rating: p.rating,
    reviewCount: p.reviewCount,
    description: p.description,
    descriptionAr: ar?.description ?? "",
    details: [...p.details],
    detailsAr: [...(ar?.details ?? [])],
    status: "active",
    videoUrl: undefined,
  };
});
