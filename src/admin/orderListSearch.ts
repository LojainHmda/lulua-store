import { normalizePhoneDigits } from "./nonDeliveryMatch";
import type { AdminOrder } from "./types";

// OrderList.tsx's own list-filter search predicate. Deliberately separate
// from src/components/admin/orderSearch.ts's buildOrderSearchBlob()/
// matchesSearch() (used by the global ⌘K admin search and
// GlobalOrdersSidebarPanel) -- that system has different token-based,
// bilingual-synonym-aware semantics suited to those broader lookup
// surfaces, and adopting it here would change this page's existing
// order#/name/email matching behavior along with it. This keeps the list
// page's existing simple "does any of these fields contain what was typed"
// behavior exactly as it was, only adding phone as a new matchable field.
//
// Phone is matched separately from the text fields, digit-only (via the
// project's existing normalizePhoneDigits(), also used by the non-delivery
// fuzzy-match warning) so a search like "0501234567" finds a phone stored
// as "+972-50-123-4567" or "(050) 123-4567" regardless of formatting --
// but never lets a plain word search accidentally match a phone number
// (a word query normalizes to an empty digit string and so never
// contributes a phone match), and never lets a phone search accidentally
// match order#/name/email (checked as a fully separate condition, not
// merged into the same substring check).
// Plain substring match on normalized digits, PLUS one specific, common
// real-world case a bare substring check would otherwise miss: a phone
// typed/stored in local format ("0501234567") vs. international format
// ("+972-50-123-4567") -- the country code *replaces* the leading 0 rather
// than prefixing the full local number, so "972501234567".includes("0501234567")
// is false even though they're the same number. Stripping a single leading
// zero from the query (only) before the fallback check resolves that
// specific mismatch without pulling in phoneNumbersLikelyMatch()'s
// suffix-window identity comparison, which requires both sides to already
// be near-complete numbers -- unsuited to an incremental, few-digits-so-far
// search box.
function phoneContainsQuery(storedPhone: string | undefined, queryDigits: string): boolean {
  if (!queryDigits) return false;
  const stored = normalizePhoneDigits(storedPhone);
  if (stored.includes(queryDigits)) return true;
  const queryNoLeadingZero = queryDigits.replace(/^0/, "");
  return queryNoLeadingZero !== queryDigits && stored.includes(queryNoLeadingZero);
}

export function orderMatchesListSearch(
  order: Pick<AdminOrder, "orderNumber" | "customerName" | "customerEmail" | "customerPhone">,
  query: string
): boolean {
  const q = query.trim().toLowerCase();
  const qDigits = normalizePhoneDigits(query);
  if (!q && !qDigits) return true;
  const matchesText =
    !!q &&
    (order.orderNumber.toLowerCase().includes(q) ||
      order.customerName.toLowerCase().includes(q) ||
      (order.customerEmail ?? "").toLowerCase().includes(q));
  const matchesPhone = phoneContainsQuery(order.customerPhone, qDigits);
  return matchesText || matchesPhone;
}
