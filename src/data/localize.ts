import type { Lang } from "../context/LanguageContext";
import { AR_CATEGORIES, AR_COLORS, AR_PRODUCTS } from "../i18n/arData";
import type { Category, Product } from "../types";

// Generic name/nameAr picker for anywhere that just needs the right string
// for the current language without the full Product/Category shape — the
// admin and POS types carry the same nameAr-style fields but aren't the
// storefront Product/Category types the functions below operate on.
export function localizedName(name: string, nameAr: string | undefined, lang: Lang): string {
  return lang === "ar" && nameAr ? nameAr : name;
}

export function localizeProduct(product: Product, lang: Lang): Product {
  if (lang === "en") return product;
  const tr = AR_PRODUCTS[product.id];
  return {
    ...product,
    name: product.nameAr || tr?.name || product.name,
    description: product.descriptionAr || tr?.description || product.description,
    details: product.detailsAr?.length ? product.detailsAr : tr?.details ?? product.details,
    colorVariants: product.colorVariants.map((v) => ({
      ...v,
      colorName: v.colorNameAr || AR_COLORS[v.colorName] || v.colorName,
    })),
  };
}

export function localizeCategory(category: Category, lang: Lang): Category {
  if (lang === "en") return category;
  const tr = AR_CATEGORIES[category.slug];
  return {
    ...category,
    name: category.nameAr || tr?.name || category.name,
    tagline: category.taglineAr || tr?.tagline || category.tagline,
  };
}

export function getLocalizedProducts(products: Product[], lang: Lang): Product[] {
  return products.map((p) => localizeProduct(p, lang));
}

export function getLocalizedCategories(categories: Category[], lang: Lang): Category[] {
  return categories.map((c) => localizeCategory(c, lang));
}

export function getLocalizedProductBySlug(products: Product[], slug: string, lang: Lang): Product | undefined {
  const product = products.find((p) => p.slug === slug);
  return product ? localizeProduct(product, lang) : undefined;
}

export function getLocalizedProductById(products: Product[], id: string, lang: Lang): Product | undefined {
  const product = products.find((p) => p.id === id);
  return product ? localizeProduct(product, lang) : undefined;
}

export function getLocalizedCategoryBySlug(categories: Category[], slug: string, lang: Lang): Category | undefined {
  const category = categories.find((c) => c.slug === slug);
  return category ? localizeCategory(category, lang) : undefined;
}

export function getLocalizedRelatedProducts(products: Product[], product: Product, lang: Lang, count = 4): Product[] {
  return products
    .filter((p) => p.category === product.category && p.id !== product.id)
    .slice(0, count)
    .map((p) => localizeProduct(p, lang));
}
