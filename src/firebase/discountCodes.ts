import { doc, increment, limit, serverTimestamp, updateDoc, where } from "firebase/firestore";
import { discountsApi } from "./collections";
import { db } from "./config";
import type { AdminDiscount } from "../admin/types";

export class DiscountCodeError extends Error {}

export interface AppliedDiscount {
  id: string;
  code: string;
  amount: number;
}

// Looks up a code the customer typed in and validates it's actually usable
// right now (exists, active, not expired, under its usage limit, subtotal
// meets its minimum) — this is a plain client-side check, not part of the
// checkout transaction itself. Firestore rules independently enforce
// `discount <= subtotal` on the order write regardless (see firestore.rules
// orders/{id}), so this function's job is honest UX, not the last line of
// defense — see discounts/{id}'s rule comment for the accepted tradeoff.
export async function lookupDiscountCode(rawCode: string, subtotal: number): Promise<AppliedDiscount> {
  const code = rawCode.trim().toUpperCase();
  if (!code) throw new DiscountCodeError("Enter a discount code.");

  const matches = await discountsApi.list([where("code", "==", code), where("active", "==", true), limit(1)]);
  const discount = matches[0] as AdminDiscount | undefined;
  if (!discount) throw new DiscountCodeError("That code isn't valid.");

  if (discount.expiresAt) {
    const expires = new Date(discount.expiresAt + "T23:59:59");
    if (expires.getTime() < Date.now()) throw new DiscountCodeError("That code has expired.");
  }
  if (discount.usageLimit != null && discount.usageCount >= discount.usageLimit) {
    throw new DiscountCodeError("That code has already been fully redeemed.");
  }
  if (discount.minSubtotal != null && subtotal < discount.minSubtotal) {
    throw new DiscountCodeError(`This code needs a bag of at least ${discount.minSubtotal} to apply.`);
  }

  const amount = discount.type === "percent" ? subtotal * (discount.value / 100) : discount.value;
  return { id: discount.id, code: discount.code, amount: Math.min(amount, subtotal) };
}

// Fired as a separate, standalone write AFTER a successful checkout — never
// folded into the checkout transaction (see firestore.rules' discounts
// update rule comment for why). Best-effort: a failure here just means the
// usage counter under-counts by one, never something worth blocking or
// retrying the customer over.
export function recordDiscountUsage(discountId: string): void {
  updateDoc(doc(db, "discounts", discountId), { usageCount: increment(1), updatedAt: serverTimestamp() }).catch(() => {});
}
