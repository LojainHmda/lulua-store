import type { PosDiscountPolicyDoc } from "./types";

// Manual (cashier-entered) discounts at the till -- the one place the amount
// and its limit are worked out. The security rules re-check the limit
// (services/api/src/rules, isValidStaffOrderBranch) from settings/posDiscounts.

// Must match POS_DISCOUNT_DEFAULT_MAX_PERCENT in the rules.
export const POS_DISCOUNT_POLICY_DEFAULTS: PosDiscountPolicyDoc = { cashierMaxPercent: 10 };

export type ManualDiscountMode = "percent" | "amount";

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface ManualDiscount {
  // What comes off the sale (0 when nothing valid is entered).
  amount: number;
  // Set when the entered value can't be applied; the sale can't complete.
  error: "overLimit" | "overTotal" | "negative" | null;
  // The largest amount this user may give on this subtotal.
  maxAmount: number;
}

// `maxPercent` = the user's limit (100 for owner/admin).
export function manualDiscount(subtotal: number, mode: ManualDiscountMode, value: number | null, maxPercent: number): ManualDiscount {
  const maxAmount = round2((subtotal * Math.max(0, Math.min(100, maxPercent))) / 100);
  if (value === null || value === 0) return { amount: 0, error: null, maxAmount };
  if (value < 0) return { amount: 0, error: "negative", maxAmount };
  const amount = mode === "percent" ? round2((subtotal * value) / 100) : round2(value);
  if (amount > subtotal + 0.005) return { amount: 0, error: "overTotal", maxAmount };
  if (amount > maxAmount + 0.005) return { amount: 0, error: "overLimit", maxAmount };
  return { amount, error: null, maxAmount };
}

// Short label for receipts/reports: "10%" for a percent discount, else "".
export function discountNote(mode: ManualDiscountMode, value: number | null): string {
  return mode === "percent" && value ? `${value}%` : "";
}
