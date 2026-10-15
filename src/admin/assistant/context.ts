// Tiny, deterministic, IN-MEMORY-ONLY follow-up context -- no database, no
// persistence, reset on refresh (explicitly acceptable for V1, see the
// implementation brief). The actual mutable state lives in the panel
// component's own React state (a plain object matching AssistantContext);
// everything here is pure so it's fully unit-testable without any UI.
//
// Only handles the two concrete patterns actually asked for: "and
// yesterday?" (same question, new period) and "and orders?" (switch from
// sales to order count, same period) -- deliberately not a general
// conversational memory system. If the follow-up itself is ambiguous (a
// bare period with no prior intent to reuse, for instance), this returns
// "unsupported" rather than guessing.
import { extractPeriod, parseIntent } from "./intentParser";
import type { AssistantIntent, AssistantIntentKind } from "./types";
import type { AssistantPeriodKey } from "./dateRange";

export interface AssistantContext {
  lastIntentKind: AssistantIntentKind | null;
  lastPeriod: AssistantPeriodKey | null;
}

export const EMPTY_CONTEXT: AssistantContext = { lastIntentKind: null, lastPeriod: null };

// Intent kinds a bare "and <period>?" follow-up is safe to re-run with a
// new period -- i.e. ones whose entire meaning is "a metric over a period."
// Deliberately excludes order_lookup/customer_history/out_of_stock/
// low_stock/comparison/unsupported, none of which a bare period follow-up
// could unambiguously apply to.
const PERIOD_REPEATABLE_INTENTS: readonly AssistantIntentKind[] = [
  "sales_summary",
  "order_count",
  "status_count",
  "top_product",
  "top_category",
  "top_color",
  "top_size",
  "units_sold",
  "zone_orders",
  "zone_sales",
  "daily_summary",
];

const BARE_ORDERS_WORDS = ["orders", "order count", "طلبات", "طلب"];
const BARE_SALES_WORDS = ["sales", "revenue", "مبيعات"];

function normContains(q: string, phrases: string[]): boolean {
  // Local, tiny re-implementation-free reuse: intentParser exports nothing
  // for this exact check, so this mirrors its own containsAny() shape using
  // the same normalizeSearchText the whole module already depends on --
  // importing parseIntent below pulls that normalization in transitively,
  // this just needs the one substring check.
  return phrases.some((p) => q.includes(p));
}

/**
 * Given the RAW query and the intent the plain parser already produced,
 * returns a possibly-reinterpreted intent using prior context -- only ever
 * called when `baseIntent.kind === "unsupported"`, since a directly
 * recognized intent never needs context. Returns `baseIntent` unchanged
 * (still "unsupported") if no follow-up pattern applies.
 */
export function resolveFollowUp(rawQuery: string, baseIntent: AssistantIntent, context: AssistantContext): AssistantIntent {
  if (baseIntent.kind !== "unsupported") return baseIntent;
  if (!context.lastIntentKind) return baseIntent;

  const period = extractPeriod(rawQuery);
  const normalized = rawQuery.toLowerCase();

  // "and orders?" -- explicit switch to order_count, reusing the last period.
  if (normContains(normalized, BARE_ORDERS_WORDS) && !normContains(normalized, BARE_SALES_WORDS)) {
    return { kind: "order_count", period: context.lastPeriod ?? undefined };
  }

  // "and yesterday?" -- same question, new period, only when the last
  // intent is one a period substitution actually makes sense for.
  if (period && PERIOD_REPEATABLE_INTENTS.includes(context.lastIntentKind)) {
    return { kind: context.lastIntentKind, period } as AssistantIntent;
  }

  return baseIntent;
}

/** Parses a query with follow-up context applied on top of the plain parser. */
export function parseIntentWithContext(rawQuery: string, context: AssistantContext): AssistantIntent {
  const base = parseIntent(rawQuery);
  return resolveFollowUp(rawQuery, base, context);
}

/** Derives the next context after a successfully answered (non-error, non-unsupported) intent. */
export function updateContext(intent: AssistantIntent): AssistantContext {
  if (intent.kind === "unsupported") return EMPTY_CONTEXT;
  return { lastIntentKind: intent.kind, lastPeriod: intent.period ?? null };
}
