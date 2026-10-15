// The single public entry point for the Sisely Assistant -- the UI panel
// only ever calls answerAssistantQuery(). Wires together every layer built
// so far: B) intent recognition + follow-up context (intentParser.ts/
// context.ts), D+E) data + calculation (operations.ts), leaving F) answer
// formatting to answerFormatter.ts (kept separate since it needs the
// viewer's current language, which this module has no reason to know).
import { parseIntentWithContext, updateContext, type AssistantContext } from "./context";
import {
  runComparison,
  runCustomerHistory,
  runDailySummary,
  runLowStock,
  runOrderCount,
  runOrderLookup,
  runOutOfStock,
  runSalesSummary,
  runStatusCount,
  runTopCategory,
  runTopColor,
  runTopProduct,
  runTopSize,
  runUnitsSold,
  runZoneOrders,
  runZoneSales,
} from "./operations";
import type { AssistantAnswer, AssistantIntent } from "./types";

export { EMPTY_CONTEXT } from "./context";
export type { AssistantContext } from "./context";

async function dispatch(intent: AssistantIntent): Promise<AssistantAnswer> {
  switch (intent.kind) {
    case "sales_summary":
      return runSalesSummary(intent);
    case "order_count":
      return runOrderCount(intent);
    case "status_count":
      return runStatusCount(intent);
    case "order_lookup":
      return runOrderLookup(intent);
    case "customer_history":
      return runCustomerHistory(intent);
    case "top_product":
      return runTopProduct(intent);
    case "top_category":
      return runTopCategory(intent);
    case "top_color":
      return runTopColor(intent);
    case "top_size":
      return runTopSize(intent);
    case "units_sold":
      return runUnitsSold(intent);
    case "zone_orders":
      return runZoneOrders(intent);
    case "zone_sales":
      return runZoneSales(intent);
    case "out_of_stock":
      return runOutOfStock();
    case "low_stock":
      return runLowStock();
    case "comparison":
      return runComparison(intent);
    case "daily_summary":
      return runDailySummary(intent);
    case "unsupported":
      return { kind: "unsupported", messageKey: "admin.assistant.answer.unsupported" };
  }
}

export interface AssistantQueryResult {
  answer: AssistantAnswer;
  nextContext: AssistantContext;
}

// One-shot reads only (no realtime listeners -- see the Firestore-cost
// section of the brief); a read failure (offline, permission edge case,
// etc.) becomes a distinct `error` answer, never confused with a
// legitimate zero-result answer, and never left as an unhandled rejection
// for the panel to deal with.
export async function answerAssistantQuery(rawQuery: string, context: AssistantContext): Promise<AssistantQueryResult> {
  const trimmed = rawQuery.trim();
  if (!trimmed) {
    return { answer: { kind: "unsupported", messageKey: "admin.assistant.answer.unsupported" }, nextContext: context };
  }

  const intent = parseIntentWithContext(trimmed, context);
  try {
    const answer = await dispatch(intent);
    return { answer, nextContext: updateContext(intent) };
  } catch (err) {
    console.error("[assistant] query failed:", err);
    return { answer: { kind: "error", messageKey: "admin.assistant.answer.error" }, nextContext: context };
  }
}
