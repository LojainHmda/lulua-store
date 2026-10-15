import { exceedsCheckoutSafeLimit } from "../admin/productVariants";
import type { ColorVariant, Product } from "../types";

// The stock helpers below only ever read sizeStock, so they accept anything
// carrying it — this lets src/data/sellability.ts reuse them for the admin
// and POS product types too, without a second copy of the stock rules.
type StockedVariant = Pick<ColorVariant, "sizeStock">;

export function getPrimaryVariant(product: Product): ColorVariant | undefined {
  return product.colorVariants[0];
}

export function getVariant(product: Product, variantId: string | undefined): ColorVariant | undefined {
  if (!variantId) return getPrimaryVariant(product);
  return product.colorVariants.find((v) => v.id === variantId) ?? getPrimaryVariant(product);
}

// null = this size isn't offered at all (no matching entry) — genuinely 0,
// not "unknown." A present entry with qty: null is the unknown case, and
// is returned as null here too so callers can't accidentally treat it as
// a real number.
export function getVariantStockFor(variant: StockedVariant | undefined, size: string): number | null {
  const entry = variant?.sizeStock.find((s) => s.size === size);
  return entry ? entry.qty : 0;
}

// THE single source of truth for "can a customer buy this size right now,"
// used identically by the product page, the product grid, and (via
// validateCartAvailability below) the cart/checkout. A size is purchasable
// only if it has a real, positive, confirmed quantity — qty: null (never
// confirmed), qty <= 0 (confirmed empty), and a missing sizeStock entry
// entirely all collapse to the same "not available" answer here. That
// three-way distinction matters to admin inventory screens (see
// hasUnknownStock() in admin/productVariants.ts) but is deliberately NOT
// surfaced to shoppers — from a customer's seat "we don't know" and
// "there are none" both mean the same actionable thing: you can't buy it.
export function isSizeAvailable(variant: StockedVariant | undefined, size: string): boolean {
  const qty = getVariantStockFor(variant, size);
  return qty !== null && qty > 0;
}

// Every size this product is offered in that's actually purchasable for the
// given color, in the product's own declared size order. Driven by
// product.sizes (not variant.sizeStock) so a size declared on the product
// but structurally missing from this variant's own stock array is also
// correctly treated as unavailable rather than silently falling through.
export function getAvailableSizesFor(sizes: string[], variant: StockedVariant | undefined): string[] {
  return sizes.filter((s) => isSizeAvailable(variant, s));
}

// Every size purchasable in AT LEAST ONE of the product's colors, in the
// product's own declared size order and deduplicated (product.sizes is
// iterated once, so each size can appear at most once in the result). This
// is the product-grid card's "which sizes does this product come in"
// informational signal — reuses isSizeAvailable per (variant, size) pair,
// same as getAvailableSizesFor, just OR'd across every color instead of
// scoped to one. Never used for adding to cart: that always needs one
// specific, customer-chosen color+size, which is what getAvailableSizesFor
// (scoped to a single variant) already exists for.
export function getAvailableSizesForProduct(product: Product): string[] {
  return product.sizes.filter((s) => product.colorVariants.some((v) => isSizeAvailable(v, s)));
}

// True when NONE of the product's declared sizes are purchasable in this
// color — the "this color is sold out" state the product page needs to
// show plainly instead of leaving a dead Add to Bag button up.
export function isVariantSoldOut(sizes: string[], variant: StockedVariant | undefined): boolean {
  if (!variant) return true;
  return getAvailableSizesFor(sizes, variant).length === 0;
}

// True only when EVERY color this product comes in is sold out — the
// product-grid-level signal (a stronger claim than isVariantSoldOut, which
// is scoped to one color). A product with stock in even one color is not
// "sold out" for this purpose, even if its default/first-listed color is.
export function isProductSoldOut(product: Product): boolean {
  return product.colorVariants.every((v) => isVariantSoldOut(product.sizes, v));
}

// A safe floor: sums only confirmed quantities, never guesses for unknown
// sizes. Real stock is always >= this number, never less.
export function getTotalStock(product: Product): number {
  return product.colorVariants.reduce((sum, v) => sum + v.sizeStock.reduce((s, x) => s + (x.qty ?? 0), 0), 0);
}

// Structural shape only, so this accepts a CartContext CartLine without
// importing it (CartContext itself imports getVariant from this module —
// importing CartLine back here would create a circular import).
export interface CartAvailabilityLine {
  key: string;
  productId: string;
  variantId: string;
  size: string;
  qty: number;
}

export type CartLineIssue =
  | { type: "product_unavailable" }
  | { type: "checkout_unsafe" }
  | { type: "variant_unavailable" }
  | { type: "size_unavailable" }
  | { type: "out_of_stock" }
  | { type: "insufficient_stock"; available: number };

export interface CartAvailabilityResult {
  ok: boolean;
  issues: Map<string, CartLineIssue>;
}

// Re-checks every cart line against the live product catalog right before
// checkout is committed. This mirrors the exact eligibility rules the
// checkout transaction itself enforces (product exists/active, variant
// exists, size exists, qty not null/0, qty >= requested — see
// firebase/orderTransaction.ts's placeOrder()) plus the storefront's
// checkout-safety gate (exceedsCheckoutSafeLimit) that the transaction does
// NOT check — without this, a cart holding one of those products would
// reach submit and only ever surface as a raw Firestore permission error.
//
// This is a UX safeguard only, not a security boundary: `products` is
// living, so a line that passes here can still be rejected a few seconds
// later by the transaction/Firestore rules if stock moves again in that
// window — placeOrder() remains the sole authority and handles that on its
// own. Nothing here reserves stock, decrements anything, or talks to
// Firestore directly; it only compares against whatever product list the
// caller already has (in practice CatalogContext's live onSnapshot data).
//
// Returns/quarantine needs no special case: a quarantined unit was already
// decremented from sizeStock.qty at the moment of its original sale (see
// the Returns Shelf's returnsTransaction.ts) and is only ever added back
// once resolved as sellable, so the ordinary qty check below already
// excludes it — there is no separate "quarantined" flag to look for.
export function validateCartAvailability(lines: CartAvailabilityLine[], products: Product[]): CartAvailabilityResult {
  const issues = new Map<string, CartLineIssue>();

  for (const line of lines) {
    const product = products.find((p) => p.id === line.productId);
    if (!product) {
      issues.set(line.key, { type: "product_unavailable" });
      continue;
    }
    if (exceedsCheckoutSafeLimit(product)) {
      issues.set(line.key, { type: "checkout_unsafe" });
      continue;
    }
    // Exact match only — unlike getVariant()'s display-oriented fallback to
    // the primary variant, validation must never silently check a
    // different color than the one actually in the customer's bag.
    const variant = product.colorVariants.find((v) => v.id === line.variantId);
    if (!variant) {
      issues.set(line.key, { type: "variant_unavailable" });
      continue;
    }
    const stockEntry = variant.sizeStock.find((s) => s.size === line.size);
    if (!stockEntry) {
      issues.set(line.key, { type: "size_unavailable" });
      continue;
    }
    // qty: null (never confirmed) reads as sold out to the customer, same
    // precedent as getSoldOutSizes() above.
    if (stockEntry.qty === null || stockEntry.qty <= 0) {
      issues.set(line.key, { type: "out_of_stock" });
      continue;
    }
    if (stockEntry.qty < line.qty) {
      issues.set(line.key, { type: "insufficient_stock", available: stockEntry.qty });
    }
  }

  return { ok: issues.size === 0, issues };
}
