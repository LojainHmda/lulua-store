import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { db, isBackendConfigured } from "../firebase/config";
import { collection, onSnapshot, query, where } from "../db/firestore";
import { childrenOf, visibleCategories } from "../data/categoryTree";
import { CATEGORIES, PRODUCTS } from "../data/products";
import { filterSellable } from "../data/sellability";
import { joinProductFields } from "../admin/productVariants";
import type { Category, Product } from "../types";

interface CatalogContextValue {
  // What customers may see and buy. Every product listing, search, category
  // page, new-arrivals/bestseller section, wishlist, related-products row
  // and product page reads this, so an unsellable product (out of stock,
  // too many colors/sizes for checkout to handle, etc. — see
  // src/data/sellability.ts) can never show up just because one component
  // forgot to filter. The product itself is untouched in Firestore.
  products: Product[];
  // Every active product, sellable or not. ONLY for looking up a specific
  // id the shopper already holds (a cart line, checkout validation) so
  // those keep their precise "out of stock" messages and photos. Never
  // render this as a listing.
  allProducts: Product[];
  // Top-level visible categories — what nav lists (header, footer, home
  // icon row, shop chips) show. With a flat category list (no parentId set
  // anywhere) this is simply every active category, same as before.
  categories: Category[];
  // Every visible category at any depth — for looking up a product's
  // category by slug, and for "products in this category or under it".
  allCategories: Category[];
  // True until the live Firestore listener has resolved at least once (or
  // immediately false if Firebase isn't configured, since then the static
  // fallback is all there ever will be). Pages that 404 on a missing
  // product/category must wait for this before deciding it truly doesn't
  // exist — otherwise a product that only lives in Firestore (any product
  // an admin has added since the static fallback was bundled) briefly 404s
  // on first load, before the live listener's first snapshot arrives.
  loading: boolean;
}

const CatalogContext = createContext<CatalogContextValue>({
  products: filterSellable(PRODUCTS),
  allProducts: PRODUCTS,
  categories: CATEGORIES,
  allCategories: CATEGORIES,
  loading: false,
});

function toStoreProduct(id: string, data: Record<string, unknown>): Product {
  const sizes = Array.isArray(data.sizes) ? (data.sizes as string[]) : [];
  return {
    id,
    slug: String(data.slug ?? id),
    sku: data.sku ? String(data.sku) : undefined,
    name: String(data.name ?? ""),
    category: String(data.category ?? ""),
    price: Number(data.price ?? 0),
    compareAtPrice: data.compareAtPrice ? Number(data.compareAtPrice) : undefined,
    // Reuses the SAME shape-detection/join logic the admin/checkout side
    // uses (src/admin/productVariants.ts's joinProductFields) — handles
    // the new flat (colorVariants + stockByCell), old array, and legacy
    // pre-colorVariants shapes identically, sorted so index 0 is reliably
    // "the primary/default color". AdminColorVariant and this file's
    // ColorVariant are structurally identical, so the result is used
    // directly with no reshaping.
    colorVariants: joinProductFields(data),
    sizes,
    tags: Array.isArray(data.tags) ? (data.tags as Product["tags"]) : undefined,
    rating: Number(data.rating ?? 4.8),
    reviewCount: Number(data.reviewCount ?? 0),
    description: String(data.description ?? ""),
    details: Array.isArray(data.details) ? (data.details as string[]) : [],
    nameAr: data.nameAr ? String(data.nameAr) : undefined,
    descriptionAr: data.descriptionAr ? String(data.descriptionAr) : undefined,
    detailsAr: Array.isArray(data.detailsAr) ? (data.detailsAr as string[]) : undefined,
    videoUrl: data.videoUrl ? String(data.videoUrl) : undefined,
  };
}

function toStoreCategory(id: string, data: Record<string, unknown>): Category {
  return {
    slug: String(data.slug ?? id),
    name: String(data.name ?? ""),
    tagline: String(data.tagline ?? ""),
    imageId: String(data.imageId ?? ""),
    imageUrl: data.imageUrl ? String(data.imageUrl) : undefined,
    nameAr: data.nameAr ? String(data.nameAr) : undefined,
    taglineAr: data.taglineAr ? String(data.taglineAr) : undefined,
    icon: data.icon ? String(data.icon) : undefined,
    order: typeof data.order === "number" ? data.order : undefined,
    id,
    parentId: data.parentId ? String(data.parentId) : null,
    isActive: data.isActive === false ? false : undefined,
  };
}

export function CatalogProvider({ children }: { children: ReactNode }) {
  const [liveProducts, setLiveProducts] = useState<Product[] | null>(null);
  const [liveCategories, setLiveCategories] = useState<Category[] | null>(null);
  const [productsLoaded, setProductsLoaded] = useState(!isBackendConfigured);

  useEffect(() => {
    if (!isBackendConfigured) return;

    const productsQuery = query(collection(db, "products"), where("status", "==", "active"));
    const unsubProducts = onSnapshot(
      productsQuery,
      (snap) => {
        setLiveProducts(snap.docs.length > 0 ? snap.docs.map((d) => toStoreProduct(d.id, d.data())) : null);
        setProductsLoaded(true);
      },
      () => {
        setLiveProducts(null);
        setProductsLoaded(true);
      }
    );
    const unsubCategories = onSnapshot(
      collection(db, "categories"),
      (snap) => {
        // Sorted client-side (not a Firestore orderBy("order")) so a
        // category somehow missing its order field is never silently
        // dropped from the query results — Firestore excludes documents
        // that lack an orderBy'd field entirely, which would be worse than
        // just sorting it to the end. This is also the actual fix for
        // categories rendering in an arbitrary/inconsistent order on the
        // storefront: the admin's drag-to-reorder (CategoryList.tsx)
        // already saved an `order` field, but nothing here used to read it.
        const sorted = snap.docs
          .map((d) => toStoreCategory(d.id, d.data()))
          .sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER));
        setLiveCategories(sorted.length > 0 ? sorted : null);
      },
      () => setLiveCategories(null)
    );

    return () => {
      unsubProducts();
      unsubCategories();
    };
  }, []);

  const value = useMemo<CatalogContextValue>(() => {
    const allProducts = liveProducts ?? PRODUCTS;
    // Inactive categories (or ones under an inactive parent) never reach
    // the storefront; products in them stay reachable by direct link.
    const allCategories = liveCategories ? visibleCategories(liveCategories) : CATEGORIES;
    return {
      products: filterSellable(allProducts),
      allProducts,
      categories: childrenOf(allCategories, null),
      allCategories,
      loading: !productsLoaded,
    };
  }, [liveProducts, liveCategories, productsLoaded]);

  return <CatalogContext.Provider value={value}>{children}</CatalogContext.Provider>;
}

export function useCatalog() {
  return useContext(CatalogContext);
}
