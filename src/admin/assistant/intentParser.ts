// Deterministic bilingual intent recognizer for the Sisely Assistant. NO
// external NLP/AI service, no fuzzy ML matching -- plain keyword/phrase
// containment over normalizeSearchText()-normalized text (the exact same
// normalization already used by the admin's own search, see
// src/components/admin/orderSearch.ts), tried through a FIXED, ordered
// list of recognizers. The intent set is closed (AssistantIntentKind) --
// anything that matches no recognizer is "unsupported", never guessed.
//
// Keyword phrases below are written in natural Arabic/English spelling and
// normalized at match time via the same normalizeSearchText() call used on
// the query -- never hand-normalized ahead of time -- so a keyword and the
// query it's compared against always go through byte-for-byte identical
// normalization (NFKC, case-fold, diacritic/alef/teh-marbuta unification,
// punctuation collapse). See orderSearch.ts's own comment for exactly what
// that normalization does.
import { normalizeSearchText } from "../../components/admin/orderSearch";
import type { OrderStatus } from "../types";
import type { AssistantIntent, AssistantIntentKind } from "./types";
import type { AssistantPeriodKey } from "./dateRange";

function norm(s: string): string {
  return normalizeSearchText(s);
}

function containsAny(haystack: string, phrases: string[]): boolean {
  return phrases.some((p) => haystack.includes(norm(p)));
}

// ---- Period recognition --------------------------------------------------
// Checked most-specific-first so "last 7 days" doesn't get short-circuited
// by a bare "today" match appearing to overlap it, etc.

const PERIOD_PHRASES: { key: AssistantPeriodKey; phrases: string[] }[] = [
  { key: "last_7_days", phrases: ["last 7 days", "past 7 days", "آخر 7 أيام", "اخر 7 ايام", "آخر سبعة أيام", "اخر سبع ايام"] },
  { key: "last_30_days", phrases: ["last 30 days", "past 30 days", "آخر 30 يوم", "اخر 30 يوم", "آخر ثلاثين يوم"] },
  { key: "last_month", phrases: ["last month", "الشهر الماضي", "الشهر اللي فات", "الشهر السابق"] },
  { key: "this_month", phrases: ["this month", "هذا الشهر", "الشهر الحالي", "الشهر"] },
  { key: "last_week", phrases: ["last week", "الأسبوع الماضي", "الاسبوع الماضي", "الأسبوع اللي فات", "الاسبوع اللي فات"] },
  { key: "this_week", phrases: ["this week", "هذا الأسبوع", "هذا الاسبوع", "الأسبوع الحالي", "الأسبوع", "الاسبوع"] },
  { key: "yesterday", phrases: ["yesterday", "مبارح", "امبارح", "أمس", "امس"] },
  { key: "today", phrases: ["today", "اليوم", "النهاردة"] },
];

export function extractPeriod(rawQuery: string): AssistantPeriodKey | null {
  const found = findPeriodsInTextOrder(rawQuery);
  return found[0] ?? null;
}

// Finds every mentioned period and returns them in the order they actually
// appear in the text (by earliest match index), NOT in PERIOD_PHRASES'
// definition order -- needed so "اليوم مقارنة بمبارح" ("today vs
// yesterday") reports period=today, comparePeriod=yesterday rather than
// whichever key happens to be listed first above.
function findPeriodsInTextOrder(rawQuery: string): AssistantPeriodKey[] {
  const q = norm(rawQuery);
  const found: { key: AssistantPeriodKey; index: number }[] = [];
  for (const { key, phrases } of PERIOD_PHRASES) {
    let bestIndex = -1;
    for (const phrase of phrases) {
      const idx = q.indexOf(norm(phrase));
      if (idx >= 0 && (bestIndex === -1 || idx < bestIndex)) bestIndex = idx;
    }
    if (bestIndex >= 0) found.push({ key, index: bestIndex });
  }
  found.sort((a, b) => a.index - b.index);
  return found.map((f) => f.key);
}

// ---- Status recognition --------------------------------------------------
// Reuses the exact same status wording already established as the app's
// bilingual synonym set (src/components/admin/orderSearch.ts's
// STATUS_LABELS, which itself already includes both the current Phase-3
// emoji-labeled wording and the prior wording) -- not re-typed here by
// hand, so a rename of a status label only ever needs updating in one
// place.
import { STATUS_LABELS } from "../../components/admin/orderSearch";

// Picks the LONGEST matching phrase across every status, not the first
// status checked in object-key order -- "being prepared" (processing) and
// "prepared" (ready) both legitimately appear as synonyms and one is a
// substring of a sentence containing the other; the longer, more specific
// match is the correct one whenever both are present.
function extractStatus(rawQuery: string): OrderStatus | null {
  const q = norm(rawQuery);
  let best: { status: OrderStatus; length: number } | null = null;
  for (const status of Object.keys(STATUS_LABELS) as OrderStatus[]) {
    for (const phrase of STATUS_LABELS[status]) {
      const normalized = norm(phrase);
      if (normalized && q.includes(normalized) && (!best || normalized.length > best.length)) {
        best = { status, length: normalized.length };
      }
    }
  }
  return best?.status ?? null;
}

// ---- Order-number extraction ---------------------------------------------
// Deliberately operates on the RAW (non-normalized) text, not the
// normalized blob -- normalizeSearchText() collapses "-" to a space, which
// would still work for the digit-run fallback below but would destroy an
// explicit "SIS-XXXX" token's contiguity, so that check runs first and
// runs on the original string.

// Returns the fragment plus whether it was an explicit "SIS-..." token
// (strong enough evidence on its own, no extra context word needed) versus
// a bare digit run (needs an order-context phrase alongside it -- see
// callers -- to avoid misfiring on a phone number or a plain quantity).
function extractOrderFragment(rawQuery: string): { fragment: string; explicit: boolean } | null {
  const sisMatch = rawQuery.match(/SIS-[A-Z0-9]+/i);
  if (sisMatch) return { fragment: sisMatch[0].toUpperCase(), explicit: true };
  const digitMatch = rawQuery.match(/\d{3,}/);
  return digitMatch ? { fragment: digitMatch[0], explicit: false } : null;
}

// Deliberately does NOT include the bare word "order(s)"/"طلب(ات)" --
// that's shared vocabulary with customer_history ("how many orders does
// Sara have") and order_count ("how many orders today"), so treating it as
// order-LOOKUP context on its own would misclassify those. These phrases
// specifically indicate "one particular order" (singular, or an explicit
// "#"/number marker).
// NOTE: normalizeSearchText() strips punctuation entirely (collapses any
// run of non-letter/non-number characters to a single space) -- a phrase
// like "order #" would silently normalize down to bare "order", which is
// exactly the over-promiscuous match this list exists to avoid. Every
// phrase here is chosen to stay specific to "one particular order" even
// after that normalization.
const ORDER_CONTEXT_PHRASES = [
  "order number", "status of order", "what happened to order", "what's the status of order",
  "طلبية", "الطلبية", "وضع طلب", "وضع الطلبية", "وين وصل", "وصلت الطلبية",
];

// ---- Customer-lookup recognition -----------------------------------------
// "طلبات فلانة"/"طلبية فلانة" ("so-and-so's orders") is a genuine, common
// Arabic phrasing where "فلانة" is just a placeholder for any name -- the
// trigger is the possessive-orders PHRASE itself, with whatever follows it
// captured as the raw customer-identifying text (further resolved --
// safely, never by name alone -- in entityResolution.ts).

const CUSTOMER_TRIGGER_PHRASES = [
  "customer history", "customer's orders", "customers orders", "order history for", "orders for",
  "how many orders does", "how much has", "spent",
  "طلبات", "طلبية", "تاريخ طلبات", "كم طلب عند", "شو وضع طلبات", "شو صار في طلب",
];

const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;

function extractCustomerQuery(rawQuery: string): string | null {
  const emailMatch = rawQuery.match(EMAIL_RE);
  if (emailMatch) return emailMatch[0];
  const digits = rawQuery.replace(/\D/g, "");
  if (digits.length >= 7) return digits;
  // Fall back to whatever free text follows a trigger phrase -- a name-ish
  // fragment, deliberately NOT resolved here (see entityResolution.ts,
  // which will ask for an email/phone instead of guessing).
  const q = norm(rawQuery);
  for (const phrase of CUSTOMER_TRIGGER_PHRASES) {
    const idx = q.indexOf(norm(phrase));
    if (idx >= 0) {
      const rest = q.slice(idx + norm(phrase).length).trim();
      if (rest) return rest;
    }
  }
  return null;
}

// ---- Top-N recognition ----------------------------------------------------
// A "most/top/best" marker word ANYWHERE in the question, combined with the
// relevant noun ANYWHERE in the question -- deliberately word-order
// independent, since both "أكثر منتج انباع" (marker-then-noun) and "شو
// المنتج اللي باع أكثر" (noun-then-marker) are equally natural phrasings.

const MOST_MARKER_PHRASES = ["أكثر", "اكثر", "أكتر", "اكتر", "أفضل", "افضل", "أعلى", "اعلى", "best", "top", "most", "highest"];
const PRODUCT_NOUN_PHRASES = ["منتج", "المنتج", "product"];
const CATEGORY_NOUN_PHRASES = ["تصنيف", "التصنيف", "فئة", "الفئة", "category"];
const COLOR_NOUN_PHRASES = ["لون", "اللون", "color", "colour"];
const SIZE_NOUN_PHRASES = ["قياس", "القياس", "مقاس", "المقاس", "size"];

function hasMostMarker(q: string): boolean {
  return containsAny(q, MOST_MARKER_PHRASES);
}

function extractTopN(rawQuery: string): number {
  const match = rawQuery.match(/\btop\s*(\d+)\b|\bأفضل\s*(\d+)|\bأكثر\s*(\d+)/i);
  const n = match ? Number(match[1] ?? match[2] ?? match[3]) : NaN;
  return Number.isFinite(n) && n > 0 && n <= 20 ? n : 5;
}

// ---- Units-sold / zone / stock phrase tables ------------------------------

const UNITS_SOLD_PHRASES = ["how many items", "how many units", "units sold", "items sold", "pieces sold", "كم قطعة", "كم وحدة", "قطعة انباعت", "وحدة انباعت"];
// A named-zone question is recognized as "a zone-context word (orders/
// sales/طلبات/مبيعات) PLUS an 'in <place>'/'في <مكان>' trailing fragment"
// (see extractZoneFragmentGuess) rather than one fixed phrase -- so "how
// many orders ARE in Nablus" matches just as well as "orders in Nablus".
const ZONE_AGGREGATE_PHRASES = ["which delivery zone", "which zone", "أي منطقة", "اي منطقة"];
const ZONE_ORDER_CONTEXT_WORDS = ["orders", "order count", "طلبات", "طلب"];
const ZONE_SALES_CONTEXT_WORDS = ["sales", "revenue", "مبيعات"];
const OUT_OF_STOCK_PHRASES = ["out of stock", "sold out", "stock is zero", "خلص", "خلصت", "نفذ", "نفذت", "مخزونها صفر", "المنتجات اللي خلصت"];
const LOW_STOCK_PHRASES = ["low stock", "low in stock", "running low", "مخزون قليل", "مخزونها قليل", "قارب على النفاد"];

const COMPARISON_PHRASES = ["compare", "vs", "versus", "compared to", "قارن", "قارنلي", "مقارنة", "مقابل"];
// Colloquial "X or Y?" comparison marker, distinct from the plain "compare"
// verb -- e.g. "اليوم ولا مبارح؟" ("today or yesterday?"). A plain
// substring check, deliberately not a \b-bounded regex: JS regex word
// boundaries are defined in terms of ASCII \w and do not behave reliably
// around Arabic script.
const COLLOQUIAL_OR_PHRASE = "ولا";

const DAILY_SUMMARY_PHRASES = [
  "today's summary", "daily summary", "what's happening today", "whats happening today", "give me today's summary", "how's today",
  "شو عندي اليوم", "شو وضع اليوم", "ملخص اليوم", "كيف اليوم", "اعطيني ملخص اليوم",
];

const SALES_PHRASES = ["sales", "sell", "sold", "revenue", "how much did we sell", "مبيعات", "بعنا", "بعت"];
const ORDER_COUNT_PHRASES = ["how many orders", "order count", "number of orders", "كم طلب", "عدد الطلبات"];

const UNSUPPORTED_PHRASES = [
  "why", "predict", "forecast", "strategy", "marketing strategy", "what should i do", "who will buy",
  "ليش", "لماذا", "توقع", "استراتيجية", "شو لازم اعمل", "ايش لازم اعمل", "مين رح يشتري",
];

/**
 * Recognizes one of a fixed, closed set of intents from a raw user
 * question. Deterministic, synchronous, no I/O. Ambiguity/entity
 * resolution happens downstream (entityResolution.ts/operations.ts) --
 * this layer only ever decides WHICH operation to run and extracts the
 * raw text fragments that operation needs, never resolves them to a
 * specific record.
 */
export function parseIntent(rawQuery: string): AssistantIntent {
  const q = norm(rawQuery);
  if (!q) return { kind: "unsupported" };

  // 1) Explicit "this is outside V1" markers win immediately, even if the
  // sentence also happens to contain a word like "sales" -- e.g. "why are
  // sales down" must not become a sales_summary answer to a different
  // question than the one actually asked.
  if (containsAny(q, UNSUPPORTED_PHRASES)) return { kind: "unsupported" };

  // 2) Order lookup -- an explicit "SIS-..." token is strong enough
  // evidence by itself; a bare digit run additionally needs an
  // order-context phrase (see extractOrderFragment's own comment for why
  // bare "order(s)" doesn't count as that context).
  const orderMatch = extractOrderFragment(rawQuery);
  if (orderMatch && (orderMatch.explicit || containsAny(q, ORDER_CONTEXT_PHRASES))) {
    return { kind: "order_lookup", orderFragment: orderMatch.fragment };
  }

  // 3) Customer history -- checked before generic status/sales phrases so
  // "طلبات سارة" isn't mistaken for a bare order_count question just
  // because "طلبات" also appears in ORDER_COUNT_PHRASES-adjacent wording.
  if (containsAny(q, CUSTOMER_TRIGGER_PHRASES)) {
    const customerQuery = extractCustomerQuery(rawQuery);
    if (customerQuery) return { kind: "customer_history", customerQuery };
  }

  // 4) Comparison -- two periods, or one period + an explicit compare
  // marker (the second period defaults to the immediately preceding
  // equivalent period -- see dateRange.ts's precedingPeriod()). Periods are
  // returned in the order they appear in the TEXT, not in table-definition
  // order, so "today vs yesterday" reports period=today first.
  const hasCompareMarker = containsAny(q, COMPARISON_PHRASES) || q.includes(norm(COLLOQUIAL_OR_PHRASE));
  if (hasCompareMarker) {
    const periodsInOrder = findPeriodsInTextOrder(rawQuery);
    if (periodsInOrder.length >= 2) {
      return { kind: "comparison", period: periodsInOrder[0], comparePeriod: periodsInOrder[1] };
    }
    if (periodsInOrder.length === 1) {
      return { kind: "comparison", period: periodsInOrder[0] };
    }
  }

  // 5) Top-N product/category/color/size -- a "most/top/best" marker plus
  // the relevant noun, anywhere in the question (word-order independent).
  if (hasMostMarker(q)) {
    const period = extractPeriod(rawQuery) ?? undefined;
    const topN = extractTopN(rawQuery);
    if (containsAny(q, PRODUCT_NOUN_PHRASES)) return { kind: "top_product", period, topN };
    if (containsAny(q, CATEGORY_NOUN_PHRASES)) return { kind: "top_category", period, topN };
    if (containsAny(q, COLOR_NOUN_PHRASES)) return { kind: "top_color", period, topN };
    if (containsAny(q, SIZE_NOUN_PHRASES)) return { kind: "top_size", period, topN };
    if (containsAny(q, ZONE_AGGREGATE_PHRASES)) {
      return containsAny(q, ZONE_SALES_CONTEXT_WORDS) ? { kind: "zone_sales" } : { kind: "zone_orders" };
    }
  }

  // 6) Units sold.
  if (containsAny(q, UNITS_SOLD_PHRASES)) return { kind: "units_sold", period: extractPeriod(rawQuery) ?? undefined };

  // 7) Delivery zone questions -- a specific named zone. The fragment is
  // only ever taken from the RAW query text (not resolved to a canonical
  // zone here); matching against the real denormalized zone names happens
  // in operations.ts via filterOrdersByZoneFragment(), which safely
  // returns "no match" for a typo'd/unknown place name rather than
  // guessing.
  {
    const zoneFragment = extractZoneFragmentGuess(rawQuery);
    if (zoneFragment && (containsAny(q, ZONE_ORDER_CONTEXT_WORDS) || containsAny(q, ZONE_SALES_CONTEXT_WORDS))) {
      return containsAny(q, ZONE_SALES_CONTEXT_WORDS) ? { kind: "zone_sales", zoneFragment } : { kind: "zone_orders", zoneFragment };
    }
  }

  // 8) Stock questions.
  if (containsAny(q, OUT_OF_STOCK_PHRASES)) return { kind: "out_of_stock" };
  if (containsAny(q, LOW_STOCK_PHRASES)) return { kind: "low_stock" };

  // 9) Daily summary -- checked before generic sales/status wording, since
  // "شو عندي اليوم" doesn't contain any of the more specific triggers above.
  if (containsAny(q, DAILY_SUMMARY_PHRASES)) return { kind: "daily_summary" };

  // 10) Status count -- a specific status word present.
  const status = extractStatus(rawQuery);
  if (status && (containsAny(q, ORDER_COUNT_PHRASES) || q.includes(norm("كم")) || containsAny(q, ["how many"]))) {
    return { kind: "status_count", status, period: extractPeriod(rawQuery) ?? undefined };
  }

  // 11) Plain order count (no specific status named).
  if (containsAny(q, ORDER_COUNT_PHRASES)) {
    return { kind: "order_count", period: extractPeriod(rawQuery) ?? undefined };
  }

  // 12) Generic sales.
  if (containsAny(q, SALES_PHRASES)) {
    return { kind: "sales_summary", period: extractPeriod(rawQuery) ?? undefined };
  }

  return { kind: "unsupported" };
}

function extractZoneFragmentGuess(rawQuery: string): string | null {
  // Takes whatever follows an "in"/"في" preposition as the zone-name
  // guess -- deliberately loose; the actual match/no-match decision is
  // made later against real denormalized zone names, never here. Trailing
  // punctuation (a question mark, a period, an Arabic "؟") is stripped
  // first so it doesn't get pulled into the captured fragment.
  const cleaned = rawQuery.replace(/[?.!،؟]+\s*$/g, "").trim();
  const m = cleaned.match(/\bin\s+([a-zA-Z؀-ۿ ]+)$/i) || cleaned.match(/في\s+([a-zA-Z؀-ۿ ]+)$/);
  return m ? m[1].trim() : null;
}

export type { AssistantIntent, AssistantIntentKind };
