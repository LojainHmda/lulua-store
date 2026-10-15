import { CATEGORIES, PRODUCTS } from "../data/products";
import { categoriesApi, productsApi } from "../firebase/collections";
import { AR_CATEGORIES } from "../i18n/arData";
import type { AdminCategory, AdminProduct } from "./types";

// The storefront's built-in categories (what CatalogContext falls back to
// while the Firestore `categories` collection is empty), shaped as admin
// docs with their Arabic name/tagline filled in from AR_CATEGORIES so they
// stay bilingual once they live in Firestore. Doc id = slug.
export function starterCategories(): AdminCategory[] {
  return CATEGORIES.map((cat, i) => ({
    id: cat.slug,
    slug: cat.slug,
    name: cat.name,
    nameAr: cat.nameAr ?? AR_CATEGORIES[cat.slug]?.name ?? "",
    tagline: cat.tagline,
    taglineAr: cat.taglineAr ?? AR_CATEGORIES[cat.slug]?.tagline ?? "",
    imageId: cat.imageId,
    imageUrl: cat.imageUrl ?? "",
    icon: cat.icon ?? "",
    order: i,
  }));
}

// Writes the built-in categories to Firestore. Must run before the first
// real category is created: the storefront only falls back to the built-in
// list while the collection is empty, so creating one category alone would
// make all the built-in ones disappear from the store.
export async function seedStarterCategories(): Promise<number> {
  const cats = starterCategories();
  await Promise.all(
    cats.map(({ id, ...data }) => categoriesApi.createWithId(id, data satisfies Omit<AdminCategory, "id">))
  );
  return cats.length;
}

// Seeds Firestore with the storefront's built-in starter catalog, preserving
// the original slugs/ids so the existing Arabic translation lookup tables
// (keyed by these same ids) keep matching after seeding.
export async function seedStarterCatalog(): Promise<{ products: number; categories: number }> {
  await seedStarterCategories();

  await Promise.all(
    PRODUCTS.map((p) =>
      productsApi.createWithId(p.id, {
        slug: p.slug,
        name: p.name,
        category: p.category,
        price: p.price,
        compareAtPrice: p.compareAtPrice,
        colorVariants: p.colorVariants,
        sizes: p.sizes,
        tags: p.tags,
        rating: p.rating,
        reviewCount: p.reviewCount,
        description: p.description,
        details: p.details,
        status: "active",
      } satisfies Omit<AdminProduct, "id">)
    )
  );

  return { products: PRODUCTS.length, categories: CATEGORIES.length };
}
