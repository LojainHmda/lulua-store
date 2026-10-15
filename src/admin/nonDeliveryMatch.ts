import { normalizeSearchText } from "../components/admin/orderSearch";
import type { AdminOrder } from "./types";

// Mirrors checkoutValidation.ts's MIN_PHONE_DIGITS — below this length a
// phone number is too short to be a meaningful signal either way.
const MIN_PHONE_DIGITS = 7;
// How many trailing digits are compared once both sides clear the minimum
// above — long enough to be a strong signal, short enough to tolerate a
// country code / leading 0 being present on one side and not the other
// (e.g. "+972-50-123-4567" vs "050-123-4567" vs "0501234567" all share the
// same trailing 9 digits: "501234567").
const PHONE_MATCH_SUFFIX_LEN = 9;

export function normalizePhoneDigits(phone: string | undefined | null): string {
  return (phone ?? "").replace(/\D/g, "");
}

// Compares the longest common trailing-digit run (capped at
// PHONE_MATCH_SUFFIX_LEN) between two phone numbers. Deliberately a
// suffix comparison, not a prefix one — the part that varies between
// formats is the country code / leading zero at the START of the number.
export function phoneNumbersLikelyMatch(a: string | undefined | null, b: string | undefined | null): boolean {
  const da = normalizePhoneDigits(a);
  const db = normalizePhoneDigits(b);
  if (da.length < MIN_PHONE_DIGITS || db.length < MIN_PHONE_DIGITS) return false;
  const len = Math.min(da.length, db.length, PHONE_MATCH_SUFFIX_LEN);
  if (len < MIN_PHONE_DIGITS) return false;
  return da.slice(-len) === db.slice(-len);
}

// Deliberately an exact match on the full normalized name, not a
// substring/token match — a "contains" match on a common first name
// (e.g. "Ali") would false-positive against every other "Ali ___" in the
// store, which is exactly the "excessive false positives" this feature
// must avoid. normalizeSearchText already case-folds and unifies Arabic
// letter-shape variants, so real formatting differences still match.
export function nonDeliveryNameMatches(a: string | undefined | null, b: string | undefined | null): boolean {
  const na = normalizeSearchText(a ?? undefined);
  const nb = normalizeSearchText(b ?? undefined);
  if (na.length < 3 || nb.length < 3) return false;
  return na === nb;
}

export interface NonDeliveryMatch {
  order: AdminOrder;
  matchType: "phone" | "name";
}

// candidates should already be pre-filtered to nonDeliveryFlagged === true
// (see OrderList.tsx) — this function only does the name/phone comparison,
// phone first since it's the stronger signal per the product requirement.
export function findNonDeliveryMatches(candidates: AdminOrder[], name: string, phone: string): NonDeliveryMatch[] {
  const matches: NonDeliveryMatch[] = [];
  for (const order of candidates) {
    if (phoneNumbersLikelyMatch(order.customerPhone, phone)) {
      matches.push({ order, matchType: "phone" });
    } else if (nonDeliveryNameMatches(order.customerName, name)) {
      matches.push({ order, matchType: "name" });
    }
  }
  return matches;
}
