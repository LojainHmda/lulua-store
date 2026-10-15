import { exceedsCheckoutSafeLimit } from "../admin/productVariants";
import { isVariantSoldOut } from "./variants";

// THE single answer to "is this product sellable, and if not, why?" — used
// by the storefront catalog (CatalogContext), the POS terminal, and the admin
// "Unsellable Products" page, so all three always agree.
//
// It introduces no new availability state. Every condition below is an
// EXISTING rule the app already enforces somewhere; this module only names
// them once and turns "not sellable" from a per-screen greyed-out button
// into a single visibility decision:
//
//   inactive         product.status is not "active" (archived / draft). The
//                    storefront and POS Firestore queries already excluded
//                    these; the admin page lists them.
//   incomplete_data  no colors at all, or no size slots at all. Nothing can
//                    be picked, so nothing can be sold anywhere.
//   checkout_unsafe  exceedsCheckoutSafeLimit(): more colors/sizes than the
//                    checkout security rules can validate. Every purchase
//                    surface already refuses these (see productVariants.ts).
//   out_of_stock     every size slot holds a confirmed quantity of 0 (or
//                    less) — the same "confirmed zero" test POS used to grey
//                    out a tile (totalStock() === 0 && !hasUnknownStock()).
//
// Everything else stays visible, including states that look suspicious but
// that the existing rules deliberately do NOT treat as "cannot be sold":
//   - stock that was never counted (qty: null) with nothing confirmed in
//     stock: POS intentionally keeps these tappable so staff can see the
//     "?" state instead of mistaking it for sold out. Hiding them would be
//     a guess, so they are kept (reported as "stock_unconfirmed").
//   - real stock that exists only in sizes the product doesn't declare: the
//     storefront can't offer it but POS can, so the rules disagree; kept
//     (reported as "stock_outside_declared_sizes").
//   - price 0, missing images/description, etc.: no existing rule makes any
//     of these unsellable, so they are never used to hide a product.
//
// Pure functions only — nothing here reads or writes Firestore, and input
// products are never mutated. Visibility is always derived from current
// data, so a product reappears by itself the moment its condition clears.

export type UnsellableReasonCode = "inactive" | "incomplete_data" | "checkout_unsafe" | "out_of_stock";

export type UnsellableReason =
  | { code: "inactive"; status: string }
  | { code: "incomplete_data"; missing: "colors" | "sizes" }
  | { code: "checkout_unsafe"; colorCount: number; sizeSlots: number }
  | { code: "out_of_stock" };

// When several conditions apply, the employee sees the first of these as the
// primary reason (the rest are still returned in `reasons`). Explicit
// decisions come first, then structural problems (which make stock
// irrelevant until they're fixed), then stock.
export const UNSELLABLE_REASON_PRIORITY: readonly UnsellableReasonCode[] = ["inactive", "incomplete_data", "checkout_unsafe", "out_of_stock"];

export type StockAmbiguity = "stock_unconfirmed" | "stock_outside_declared_sizes";

// Structural input so the storefront Product (no status field), the admin
// AdminProduct and anything else carrying these fields all work unchanged.
export interface SellabilityInput {
  status?: string;
  sizes: string[];
  colorVariants: { sizeStock: { size: string; qty: number | null }[] }[];
}

export interface SellabilityResult {
  sellable: boolean;
  primaryReason: UnsellableReason | null;
  // Every applicable reason, in UNSELLABLE_REASON_PRIORITY order.
  reasons: UnsellableReason[];
  // Set only for a product that is kept visible even though its stock is
  // not clearly available — see the header comment. Always null otherwise.
  keptVisibleBecause: StockAmbiguity | null;
}

export function resolveSellability(product: SellabilityInput): SellabilityResult {
  const variants = product.colorVariants ?? [];

  let sizeSlots = 0;
  let anyPositive = false;
  let anyUnconfirmed = false;
  for (const variant of variants) {
    for (const slot of variant.sizeStock ?? []) {
      sizeSlots++;
      if (typeof slot.qty !== "number" || Number.isNaN(slot.qty)) anyUnconfirmed = true;
      else if (slot.qty > 0) anyPositive = true;
    }
  }

  const reasons: UnsellableReason[] = [];
  if (product.status !== undefined && product.status !== "active") {
    reasons.push({ code: "inactive", status: product.status });
  }
  if (variants.length === 0) reasons.push({ code: "incomplete_data", missing: "colors" });
  else if (sizeSlots === 0) reasons.push({ code: "incomplete_data", missing: "sizes" });
  if (exceedsCheckoutSafeLimit({ colorVariants: variants })) {
    reasons.push({ code: "checkout_unsafe", colorCount: variants.length, sizeSlots });
  }
  if (sizeSlots > 0 && !anyPositive && !anyUnconfirmed) reasons.push({ code: "out_of_stock" });

  let keptVisibleBecause: StockAmbiguity | null = null;
  if (reasons.length === 0 && sizeSlots > 0) {
    if (!anyPositive && anyUnconfirmed) keptVisibleBecause = "stock_unconfirmed";
    else if (anyPositive && variants.every((v) => isVariantSoldOut(product.sizes, v))) keptVisibleBecause = "stock_outside_declared_sizes";
  }

  return { sellable: reasons.length === 0, primaryReason: reasons[0] ?? null, reasons, keptVisibleBecause };
}

export function isSellable(product: SellabilityInput): boolean {
  return resolveSellability(product).sellable;
}

// Returns a new array; the products themselves are never touched.
export function filterSellable<T extends SellabilityInput>(products: readonly T[]): T[] {
  return products.filter(isSellable);
}

// ---- Human-readable reasons ------------------------------------------------
// Keys into src/i18n/translations.ts (admin.unsellable.*). The label is the
// short headline; the detail explains the actual business reason.

export function unsellableReasonLabelKey(code: UnsellableReasonCode): string {
  return `admin.unsellable.reason.${code}`;
}

export function unsellableReasonDetail(reason: UnsellableReason): { key: string; params: Record<string, string | number> } {
  switch (reason.code) {
    case "inactive":
      return {
        key: reason.status === "archived" ? "admin.unsellable.detail.inactiveArchived" : reason.status === "draft" ? "admin.unsellable.detail.inactiveDraft" : "admin.unsellable.detail.inactiveOther",
        params: { status: reason.status },
      };
    case "incomplete_data":
      return { key: reason.missing === "colors" ? "admin.unsellable.detail.incompleteColors" : "admin.unsellable.detail.incompleteSizes", params: {} };
    case "checkout_unsafe":
      return { key: "admin.unsellable.detail.checkoutUnsafe", params: { colors: reason.colorCount, slots: reason.sizeSlots } };
    case "out_of_stock":
      return { key: "admin.unsellable.detail.outOfStock", params: {} };
  }
}
