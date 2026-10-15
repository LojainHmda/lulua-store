// Pure entity-matching logic for the Sisely Assistant. Firestore reads that
// feed these live in operations.ts -- this module never touches Firestore,
// so every rule here is unit-testable without the emulator. Reuses the
// SAME trusted matching primitives the rest of the admin app already
// relies on (normalizeSearchText, normalizePhoneDigits,
// phoneNumbersLikelyMatch, matchProductFromScan) rather than inventing
// parallel ones -- see the module-level comments on each function for
// exactly which existing helper it wraps.
import { normalizeSearchText } from "../../components/admin/orderSearch";
import { normalizePhoneDigits } from "../nonDeliveryMatch";
import { matchProductFromScan } from "../scanProductMatch";
import type { AdminOrder, AdminProduct } from "../types";
import type { ResolvedEntity } from "./types";

// ---- Order number ---------------------------------------------------------
// Firestore has no substring/full-text query, so "does an order number
// contain this fragment" can only ever be checked against an
// ALREADY-FETCHED, bounded set of orders (see operations.ts's safety limit
// on that fetch) -- this function just does the actual comparison, exactly
// mirroring orderListSearch.ts's own `orderNumber.toLowerCase().includes(q)`
// convention (not reusing that function directly, since it also matches
// customer name/email/phone, which isn't wanted for a number-specific
// lookup).
export function matchOrdersByNumberFragment(orders: Pick<AdminOrder, "id" | "orderNumber">[], fragment: string): Pick<AdminOrder, "id" | "orderNumber">[] {
  const f = fragment.trim().toLowerCase();
  if (f.length < 3) return [];
  return orders.filter((o) => o.orderNumber.toLowerCase().includes(f));
}

export function resolveOrderByFragment<T extends { id: string; orderNumber: string }>(orders: T[], fragment: string): ResolvedEntity<T> {
  const matches = matchOrdersByNumberFragment(orders, fragment) as T[];
  if (matches.length === 0) return { kind: "not_found" };
  if (matches.length === 1) return { kind: "resolved", value: matches[0] };
  return { kind: "ambiguous", candidates: matches };
}

// ---- Customer identifier classification -----------------------------------
// Deliberately narrow: an email or a phone number (7+ digits, reusing
// normalizePhoneDigits exactly) resolve safely; anything else -- a bare
// name -- is explicitly "insufficient", never guessed. This is the one
// place V1's "never match a customer by name alone" rule is enforced
// structurally: there is no code path anywhere downstream that accepts a
// bare name and turns it into a customerId query.
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const MIN_PHONE_DIGITS = 7;

export type CustomerIdentifier = { kind: "email"; value: string } | { kind: "phone"; value: string } | { kind: "insufficient" };

export function classifyCustomerIdentifier(raw: string): CustomerIdentifier {
  const emailMatch = raw.match(EMAIL_RE);
  if (emailMatch) return { kind: "email", value: emailMatch[0].trim().toLowerCase() };
  const digits = normalizePhoneDigits(raw);
  if (digits.length >= MIN_PHONE_DIGITS) return { kind: "phone", value: digits };
  return { kind: "insufficient" };
}

// A small, bounded set of plausible stored-phone formats for a single
// exact-match Firestore `where("customerPhone","==",...)` query per
// variant -- covers the one real-world formatting ambiguity already
// documented elsewhere in this app (orderListSearch.ts's phoneContainsQuery,
// nonDeliveryMatch.ts's phoneNumbersLikelyMatch): a local number typed with
// a leading 0 vs. the same number stored with a country code that REPLACES
// that leading 0, plus the reverse direction. Kept intentionally small
// (never a full collection scan) -- results are still re-validated with
// phoneNumbersLikelyMatch() below before being trusted.
export function phoneQueryVariants(digits: string): string[] {
  const variants = new Set<string>([digits]);
  if (digits.startsWith("0")) variants.add(digits.slice(1));
  else variants.add(`0${digits}`);
  if (!digits.startsWith("972")) variants.add(`972${digits.replace(/^0/, "")}`);
  return [...variants];
}

// ---- Product matching -------------------------------------------------------
// Prefers, in order: (1) exact id, (2) exact SKU/barcode/slug via the
// existing matchProductFromScan()/productBarcodeValue() resolution chain
// (the same one POS/AddOrderItemModal/the Phase-3 preparation scanner
// already use), (3) a bounded textual match via normalizeSearchText against
// name/nameAr. Multiple equally-good textual matches are reported as
// ambiguous, never arbitrarily narrowed to one.
export function resolveProductByQuery(products: AdminProduct[], query: string): ResolvedEntity<AdminProduct> {
  const trimmed = query.trim();
  if (!trimmed) return { kind: "insufficient_identifier" };

  const byId = products.find((p) => p.id === trimmed);
  if (byId) return { kind: "resolved", value: byId };

  const byCode = matchProductFromScan(products, trimmed);
  if (byCode) return { kind: "resolved", value: byCode };

  const needle = normalizeSearchText(trimmed);
  if (!needle) return { kind: "insufficient_identifier" };
  const textMatches = products.filter((p) => {
    const en = normalizeSearchText(p.name);
    const ar = normalizeSearchText(p.nameAr ?? "");
    return en.includes(needle) || (ar && ar.includes(needle));
  });
  if (textMatches.length === 0) return { kind: "not_found" };
  if (textMatches.length === 1) return { kind: "resolved", value: textMatches[0] };
  return { kind: "ambiguous", candidates: textMatches };
}
