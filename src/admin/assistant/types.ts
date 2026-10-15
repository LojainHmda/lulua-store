// Shared types for the Sisely Assistant (V1). Kept separate from
// src/admin/types.ts deliberately -- these are assistant-pipeline shapes
// (intents, answers), not Firestore document shapes, and mixing the two
// would blur "what's actually stored" with "what the assistant computed."
import type { AdminOrder, AdminReturn, OrderStatus } from "../types";
import type { AssistantDateRange, AssistantPeriodKey } from "./dateRange";

// The CLOSED set of things V1 can do -- see intentParser.ts. Deliberately
// small; "unsupported" and "ambiguous" are first-class outcomes, not
// failure states to work around.
export type AssistantIntentKind =
  | "sales_summary"
  | "order_count"
  | "status_count"
  | "order_lookup"
  | "customer_history"
  | "top_product"
  | "top_category"
  | "top_color"
  | "top_size"
  | "units_sold"
  | "zone_orders"
  | "zone_sales"
  | "out_of_stock"
  | "low_stock"
  | "comparison"
  | "daily_summary"
  | "unsupported";

export interface AssistantIntent {
  kind: AssistantIntentKind;
  /** The period the question resolved to, when relevant (defaults applied by the parser, e.g. "today"). */
  period?: AssistantPeriodKey;
  /** For comparison: the second period being compared against `period`. */
  comparePeriod?: AssistantPeriodKey;
  /** For status_count. */
  status?: OrderStatus;
  /** For order_lookup: the raw digit/alnum fragment extracted from the question. */
  orderFragment?: string;
  /** For customer_history: whatever identifying text/email/phone was extracted. */
  customerQuery?: string;
  /** For top_product/top_category/top_color/top_size: how many results were asked for (defaults to 5). */
  topN?: number;
  /** For zone_orders/zone_sales: a specific zone name fragment, if the question named one (absent = aggregate all zones). */
  zoneFragment?: string;
}

// A resolved, unambiguous single customer/order/product to act on, OR an
// explicit "needs clarification" state -- entity resolution must never
// silently pick one of several candidates (see entityResolution.ts).
export type ResolvedEntity<T> =
  | { kind: "resolved"; value: T }
  | { kind: "ambiguous"; candidates: T[] }
  | { kind: "not_found" }
  | { kind: "insufficient_identifier" }; // e.g. a bare name with no email/phone/order#

// The result of the Data + Calculation layers, before formatting -- always
// carries enough structure that the formatter never has to invent a
// number, and always states what it actually covered.
export interface AssistantAnswer {
  kind: AssistantIntentKind | "clarification" | "not_found" | "error";
  /** Machine-readable payload the formatter renders from -- shape depends on `kind`. */
  data?: unknown;
  /** The exact range the answer covers, when relevant, for the "state the period used" requirement. */
  range?: AssistantDateRange;
  /** True if the underlying read was capped and might not cover the full requested range -- see operations.ts's safety limits. */
  truncated?: boolean;
  /** Translation key(s) plus params the formatter uses to build the final sentence. Kept here (not a raw string) so the panel can re-render on a language switch without re-querying. */
  messageKey: string;
  messageParams?: Record<string, string>;
  /** For clarification answers: candidate labels to show as quick choices. */
  clarificationOptions?: string[];
}

// Orders + returns needed for a customer-history answer -- mirrors exactly
// what summarizeCustomerHistory() (src/admin/customerHistory.ts) already
// expects, so the assistant never reimplements that calculation.
export interface CustomerLookupResult {
  orders: AdminOrder[];
  returns: AdminReturn[] | null;
  isGuestMatch: boolean;
  customerName: string;
}
