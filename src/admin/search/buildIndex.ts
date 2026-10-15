import { normalizeSearchText, buildOrderSearchBlob, type ProductLookup, type CategoryLookup } from "../../components/admin/orderSearch";
import { normalizePhoneDigits, phoneNumbersLikelyMatch } from "../nonDeliveryMatch";
import { resolveProductImageSrc } from "../imageSrc";
import { localizedName } from "../../data/localize";
import { totalStock, hasUnknownStock } from "../productVariants";
import { formatPrice } from "../../utils/currency";
import type { Lang } from "../../context/LanguageContext";
import type { AdminCustomer, AdminOrder, AdminProduct, OrderStatus } from "../types";

export type SearchEntryType = "product" | "order" | "customer" | "page";
export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info";

// One shared shape every entity type is reduced to, so the ranking function
// and the result row only ever need to know about ONE thing, not four.
// Everything here is computed once when the index is built (see
// build*Entries below), never per keystroke — matching/ranking at search
// time only ever does cheap string comparisons against these precomputed
// fields.
export interface SearchEntry {
  id: string;
  type: SearchEntryType;
  title: string;
  subtitle?: string;
  amountLabel?: string;
  href: string;
  icon: string;
  thumbnail?: string;
  avatarText?: string;
  badgeLabel?: string;
  badgeTone?: BadgeTone;
  timestamp: number;
  // --- matching data (all pre-normalized) ---
  // Candidates checked for an EXACT or PREFIX match against the query's
  // normalizeSearchText() form. Order number lives here AND in `blob`
  // (partial/substring search on an order number is expected); SKU lives
  // ONLY here, deliberately excluded from `blob` — see buildProductEntries.
  identifierMatches: string[];
  // Candidates checked for an EXACT or PREFIX match — the entity's own
  // "name" fields (product name/nameAr, customer name, order's customer
  // name). Weaker priority than identifierMatches, stronger than a plain
  // token/substring hit.
  titleMatches: string[];
  // Raw (not normalized) phone numbers, compared via nonDeliveryMatch.ts's
  // own digit-normalization + suffix-match logic — phone needs its own
  // comparison, not text normalization.
  phones: string[];
  // Full normalized searchable text for the token/substring fallback tiers.
  blob: string;
}

function toMillis(value: unknown): number {
  const ts = value as { toDate?: () => Date } | undefined;
  return ts?.toDate ? ts.toDate().getTime() : 0;
}

const ORDER_STATUS_TONE: Record<OrderStatus, BadgeTone> = {
  pending: "neutral",
  processing: "warning",
  ready: "success",
  shipped: "info",
  delivered: "success",
  completed: "success",
  cancelled: "danger",
  refunded: "danger",
};

export function buildProductEntries(
  products: AdminProduct[],
  categoryLookup: Map<string, CategoryLookup>,
  lang: Lang,
  t: (key: string) => string
): SearchEntry[] {
  return products.map((p) => {
    const category = categoryLookup.get(p.category);
    const categoryName = category ? localizedName(category.name, category.nameAr, lang) : undefined;
    const stockLabel = hasUnknownStock(p) ? t("admin.search.stockUnknown") : `${totalStock(p)} ${t("admin.search.inStock")}`;
    const colorNames = p.colorVariants.flatMap((v) => [v.colorName, v.colorNameAr ?? ""]);
    const sizes = p.colorVariants.flatMap((v) => v.sizeStock.map((s) => s.size));
    return {
      id: `product:${p.id}`,
      type: "product",
      title: localizedName(p.name, p.nameAr, lang),
      subtitle: [formatPrice(p.price), stockLabel, categoryName].filter(Boolean).join(" · "),
      href: `/admin/products/${p.id}`,
      icon: "shirt",
      thumbnail: resolveProductImageSrc(p) || undefined,
      timestamp: toMillis(p.createdAt),
      // sku is deliberately NOT included in `blob` — barcodes/SKUs must
      // only ever match exactly or by prefix, never by generic substring.
      identifierMatches: [normalizeSearchText(p.sku)].filter(Boolean),
      titleMatches: [normalizeSearchText(p.name), normalizeSearchText(p.nameAr)].filter(Boolean),
      phones: [],
      blob: normalizeSearchText([p.name, p.nameAr, p.category, categoryName, ...colorNames, ...sizes].filter(Boolean).join(" ")),
    };
  });
}

export function buildOrderEntries(
  orders: AdminOrder[],
  productLookup: Map<string, ProductLookup>,
  categoryLookup: Map<string, CategoryLookup>,
  t: (key: string) => string
): SearchEntry[] {
  return orders.map((o) => ({
    id: `order:${o.id}`,
    type: "order",
    title: `#${o.orderNumber}`,
    subtitle: o.customerName,
    amountLabel: formatPrice(o.total),
    href: `/admin/orders/${o.id}`,
    icon: o.source === "pos" ? "grid" : "bag",
    badgeLabel: t(`admin.orderStatus.${o.status}`),
    badgeTone: ORDER_STATUS_TONE[o.status],
    timestamp: toMillis(o.createdAt),
    identifierMatches: [normalizeSearchText(o.orderNumber)].filter(Boolean),
    titleMatches: [normalizeSearchText(o.customerName)].filter(Boolean),
    phones: [o.customerPhone].filter((v): v is string => !!v),
    // Reuses the exact same blob orderSearch.ts already builds for
    // GlobalOrdersSidebarPanel — order number, customer name/email/phone,
    // address, notes, line items, bilingual status/source labels.
    blob: buildOrderSearchBlob(o, productLookup, categoryLookup),
  }));
}

export function buildCustomerEntries(customers: AdminCustomer[], t: (key: string) => string): SearchEntry[] {
  return customers.map((c) => ({
    id: `customer:${c.id}`,
    type: "customer",
    title: c.name,
    subtitle: [c.phone, c.email].filter(Boolean).join(" · "),
    // Already on the doc — no extra read needed for this.
    amountLabel: c.ordersCount > 0 ? t("admin.search.ordersCount").replace("{n}", String(c.ordersCount)) : undefined,
    href: `/admin/customers/${c.id}`,
    icon: "users",
    avatarText: c.name.slice(0, 1).toUpperCase(),
    timestamp: toMillis(c.createdAt),
    identifierMatches: [],
    titleMatches: [normalizeSearchText(c.name)].filter(Boolean),
    phones: [c.phone].filter((v): v is string => !!v),
    blob: normalizeSearchText([c.name, c.email, c.phone ?? "", ...(c.tags ?? [])].filter(Boolean).join(" ")),
  }));
}

// --- Ranking -----------------------------------------------------------
// Deterministic tiers, highest first. No ML, no external relevance
// service — just "how strong a signal did this query give," checked in a
// fixed, explainable order:
//   1. Exact match on a strong identifier (SKU/barcode, order number,
//      or a confident phone-number match)
//   2. Exact match on the entity's primary name/title field
//   3. Prefix match on an identifier or the title field, or a partial
//      (short) phone-digit match
//   4. Every search word present somewhere (any order)
//   5. At least one search word present
// Ties within the same tier break by recency (newer first).
const TIER_IDENTIFIER_EXACT = 6;
const TIER_TITLE_EXACT = 5;
const TIER_PREFIX = 4;
const TIER_ALL_TOKENS = 3;
const TIER_PARTIAL_TOKENS = 2;

// Below this many digits a phone-number query is too short to mean
// anything as a search signal — same floor used for the identifier tier
// via phoneNumbersLikelyMatch's own MIN_PHONE_DIGITS; a shorter floor here
// is fine since a prefix/contains hit is a weaker claim than an exact one.
const MIN_PHONE_DIGITS_FOR_PARTIAL = 3;

function scoreEntry(entry: SearchEntry, normQuery: string, tokens: string[], digitQuery: string): number | null {
  if (normQuery) {
    if (entry.identifierMatches.includes(normQuery)) return TIER_IDENTIFIER_EXACT;
  }
  if (digitQuery.length >= 3 && entry.phones.some((p) => phoneNumbersLikelyMatch(p, digitQuery))) {
    return TIER_IDENTIFIER_EXACT;
  }
  if (normQuery && entry.titleMatches.includes(normQuery)) return TIER_TITLE_EXACT;
  if (normQuery) {
    if (entry.identifierMatches.some((v) => v.startsWith(normQuery))) return TIER_PREFIX;
    if (entry.titleMatches.some((v) => v.startsWith(normQuery))) return TIER_PREFIX;
  }
  if (digitQuery.length >= MIN_PHONE_DIGITS_FOR_PARTIAL && entry.phones.some((p) => normalizePhoneDigits(p).includes(digitQuery))) {
    return TIER_PREFIX;
  }
  if (tokens.length > 0) {
    const matched = tokens.filter((tok) => entry.blob.includes(tok)).length;
    if (matched === tokens.length) return TIER_ALL_TOKENS;
    if (matched > 0) return TIER_PARTIAL_TOKENS;
  }
  return null;
}

export interface RankedResult {
  items: SearchEntry[];
  total: number;
}

// Only treat the query as a phone-number search when it actually LOOKS
// like one (digits plus common phone punctuation only) — otherwise a query
// like "zzzzznonexistentqueryxyz123" would have its trailing "123"
// stripped out by normalizePhoneDigits() and get matched against any
// order/customer whose phone happens to contain "123" anywhere, which is
// a false positive, not a real phone search.
const PHONE_LIKE_RE = /^[\d\s\-+()]+$/;

// Filters + sorts one entity group for a query. Cheap enough (plain string
// ops over, realistically, a few hundred entries) to re-run on every
// keystroke with no debounce needed — the expensive part (building `entry`
// itself) already happened once when the index was built, not here.
export function matchAndRank(entries: SearchEntry[], rawQuery: string, limit: number): RankedResult {
  const normQuery = normalizeSearchText(rawQuery);
  const tokens = normQuery.split(" ").filter(Boolean);
  const trimmedQuery = rawQuery.trim();
  const digitQuery = trimmedQuery && PHONE_LIKE_RE.test(trimmedQuery) ? normalizePhoneDigits(trimmedQuery) : "";
  if (!normQuery && !digitQuery) return { items: [], total: 0 };

  const scored: { entry: SearchEntry; tier: number }[] = [];
  for (const entry of entries) {
    const tier = scoreEntry(entry, normQuery, tokens, digitQuery);
    if (tier !== null) scored.push({ entry, tier });
  }
  scored.sort((a, b) => b.tier - a.tier || b.entry.timestamp - a.entry.timestamp);
  return { items: scored.slice(0, limit).map((s) => s.entry), total: scored.length };
}
