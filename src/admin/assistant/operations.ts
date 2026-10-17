// Data + Calculation layers (D and E in the Input -> Intent -> Entity ->
// Data -> Calculation -> Answer pipeline). Every function here performs
// EXACTLY the Firestore reads its own question needs -- see each
// function's own comment for the exact bound -- then hands the result to
// the pure calculators in salesCalculations.ts/aggregations.ts. Nothing
// here ever writes to Firestore (read-only, matching Order Detail/Customer
// Detail's own owner/admin boundary -- enforced by the route gate around
// the panel, not re-implemented here).
import { limit, orderBy, where } from "../../db/firestore";
import { categoriesApi, deliveryZonesApi, ordersApi, productsApi, returnsApi } from "../../firebase/collections";
import { getSingletonDoc } from "../../firebase/firestore";
import { normalizeSearchText } from "../../components/admin/orderSearch";
import {
  aggregateByZone,
  filterOrdersByZoneFragment,
  topCategories,
  topColors,
  topProducts,
  topSizes,
} from "./aggregations";
import { precedingPeriod, resolvePeriod, type AssistantDateRange, type AssistantPeriodKey } from "./dateRange";
import { classifyCustomerIdentifier, phoneQueryVariants, resolveOrderByFragment } from "./entityResolution";
import { normalizePhoneDigits, phoneNumbersLikelyMatch } from "../nonDeliveryMatch";
import { summarizeCustomerHistory } from "../customerHistory";
import { isLinePrepared } from "../orderPreparation";
import { normalizeProduct, totalStock, hasUnknownStock } from "../productVariants";
import {
  computeConfirmedSalesTotals,
  computeSalesTotals,
  computeStatusBreakdown,
  countByStatus,
  compareSales,
  totalUnitsSold,
} from "./salesCalculations";
import type { AdminOrder, AdminProduct, AdminReturn, NotificationPrefsDoc, OrderStatus } from "../types";
import type { AssistantAnswer, AssistantIntent, CustomerLookupResult } from "./types";

// ---- Safety limits ----------------------------------------------------------
// See the discovery audit's Firestore-cost section: the app has NO existing
// composite index on orders beyond (customerId, createdAt), so every query
// here stays a SINGLE-FIELD filter (createdAt range, OR status, OR
// customerEmail/Phone -- never two different fields combined with an
// orderBy) specifically to avoid requiring a new one. Each limit below is a
// safety cap, not an expected result size -- if a fetch returns exactly the
// cap, the answer is marked `truncated` and the formatter states that
// honestly rather than presenting a capped read as complete.
const PERIOD_ORDERS_LIMIT = 2000;
const STATUS_ONLY_LIMIT = 1000;
const ORDER_LOOKUP_SCAN_LIMIT = 500; // matches Dashboard.tsx's own "most recent 500" precedent
const CUSTOMER_ORDERS_LIMIT = 500;
const LOW_STOCK_DEFAULT_THRESHOLD = 3; // matches lowStockNotify.ts's own DEFAULT_PREFS fallback exactly -- not a new number

// Default period for a "current operational state" question (no period
// named) -- "today" matches how sales_summary/order_count/status_count/
// daily_summary are naturally read ("how am I doing right now").
const DEFAULT_SNAPSHOT_PERIOD: AssistantPeriodKey = "today";
// Default period for a ranking/aggregation question (no period named) --
// "this_month" is a more meaningful window for "best-selling product" than
// a single day, and staying a real calendar month (not "all time") keeps
// the read bounded -- see the module comment above.
const DEFAULT_RANKING_PERIOD: AssistantPeriodKey = "this_month";

async function fetchOrdersForRange(range: AssistantDateRange): Promise<{ orders: AdminOrder[]; truncated: boolean }> {
  const orders = await ordersApi.list([
    where("createdAt", ">=", range.start),
    where("createdAt", "<", range.end),
    orderBy("createdAt", "desc"),
    limit(PERIOD_ORDERS_LIMIT),
  ]);
  return { orders, truncated: orders.length >= PERIOD_ORDERS_LIMIT };
}

async function fetchOrdersByStatusOnly(status: OrderStatus): Promise<{ orders: AdminOrder[]; truncated: boolean }> {
  const orders = await ordersApi.list([where("status", "==", status), limit(STATUS_ONLY_LIMIT)]);
  return { orders, truncated: orders.length >= STATUS_ONLY_LIMIT };
}

// ---- sales_summary / order_count / status_count / daily_summary ------------

export async function runSalesSummary(intent: AssistantIntent): Promise<AssistantAnswer> {
  const range = resolvePeriod(intent.period ?? DEFAULT_SNAPSHOT_PERIOD);
  const { orders, truncated } = await fetchOrdersForRange(range);
  const totals = computeSalesTotals(orders);
  const confirmed = computeConfirmedSalesTotals(orders);
  return {
    kind: "sales_summary",
    range,
    truncated,
    messageKey: "admin.assistant.answer.salesSummary",
    data: { totals, confirmed },
  };
}

export async function runOrderCount(intent: AssistantIntent): Promise<AssistantAnswer> {
  const range = resolvePeriod(intent.period ?? DEFAULT_SNAPSHOT_PERIOD);
  const { orders, truncated } = await fetchOrdersForRange(range);
  const totals = computeSalesTotals(orders);
  return { kind: "order_count", range, truncated, messageKey: "admin.assistant.answer.orderCount", data: { orderCount: totals.orderCount } };
}

export async function runStatusCount(intent: AssistantIntent): Promise<AssistantAnswer> {
  const status = intent.status!;
  if (intent.period) {
    const range = resolvePeriod(intent.period);
    const { orders, truncated } = await fetchOrdersForRange(range);
    return {
      kind: "status_count",
      range,
      truncated,
      messageKey: "admin.assistant.answer.statusCount",
      data: { status, count: countByStatus(orders, status) },
    };
  }
  // No period named -- "how many orders are pending" naturally means "right
  // now", a snapshot of current status, not scoped to today. Single-field
  // equality query, no date range, no composite index needed.
  const { orders, truncated } = await fetchOrdersByStatusOnly(status);
  return { kind: "status_count", truncated, messageKey: "admin.assistant.answer.statusCountAllTime", data: { status, count: orders.length } };
}

export async function runDailySummary(intent: AssistantIntent): Promise<AssistantAnswer> {
  const range = resolvePeriod(intent.period ?? "today");
  const { orders, truncated } = await fetchOrdersForRange(range);
  const totals = computeSalesTotals(orders);
  const breakdown = computeStatusBreakdown(orders);
  return { kind: "daily_summary", range, truncated, messageKey: "admin.assistant.answer.dailySummary", data: { totals, breakdown } };
}

export async function runComparison(intent: AssistantIntent): Promise<AssistantAnswer> {
  const rangeA = resolvePeriod(intent.period ?? DEFAULT_SNAPSHOT_PERIOD);
  const rangeB = intent.comparePeriod ? resolvePeriod(intent.comparePeriod) : precedingPeriod(rangeA);
  const [a, b] = await Promise.all([fetchOrdersForRange(rangeA), fetchOrdersForRange(rangeB)]);
  const comparison = compareSales(a.orders, b.orders);
  return {
    kind: "comparison",
    truncated: a.truncated || b.truncated,
    messageKey: "admin.assistant.answer.comparison",
    data: { rangeA, rangeB, comparison },
  };
}

// ---- order_lookup ------------------------------------------------------------
// Firestore has no substring query, so a fragment lookup can only ever
// search an already-bounded, most-recent slice -- exactly the same
// tradeoff GlobalOrdersSidebarPanel.tsx already accepts (its own
// MAX_ORDERS). An order older than this window genuinely isn't found here;
// the answer says so explicitly rather than claiming "does not exist".

export async function runOrderLookup(intent: AssistantIntent): Promise<AssistantAnswer> {
  const fragment = intent.orderFragment ?? "";
  const recent = await ordersApi.list([orderBy("createdAt", "desc"), limit(ORDER_LOOKUP_SCAN_LIMIT)]);
  const resolved = resolveOrderByFragment(recent, fragment);
  if (resolved.kind === "not_found") {
    return { kind: "not_found", messageKey: "admin.assistant.answer.orderNotFound", data: { fragment, scanned: recent.length } };
  }
  if (resolved.kind === "ambiguous") {
    return {
      kind: "clarification",
      messageKey: "admin.assistant.answer.orderAmbiguous",
      clarificationOptions: resolved.candidates.map((o) => o.orderNumber),
      data: { candidates: resolved.candidates },
    };
  }
  if (resolved.kind !== "resolved") {
    // resolveOrderByFragment never actually produces this (it only ever
    // returns not_found/ambiguous/resolved), but ResolvedEntity<T> is a
    // shared, wider type -- handled explicitly rather than asserted away.
    return { kind: "not_found", messageKey: "admin.assistant.answer.orderNotFound", data: { fragment, scanned: recent.length } };
  }
  const order = resolved.value;
  const preparedCount = order.lines.filter((l: AdminOrder["lines"][number]) => isLinePrepared(order.preparedLines, l)).length;
  return {
    kind: "order_lookup",
    messageKey: "admin.assistant.answer.orderLookup",
    data: {
      order,
      itemCount: order.lines.length,
      preparedCount,
      totalLines: order.lines.length,
    },
  };
}

// ---- customer_history ---------------------------------------------------------
// Mirrors OrderCustomerHistory.tsx's OWN guest-matching strategy exactly:
// narrow, single-field exact-match queries on customerEmail/customerPhone
// (never a customer-collection scan), then summarizeCustomerHistory() --
// the same existing, trusted function -- does the actual calculation. A
// bare name never reaches this function at all (see
// entityResolution.classifyCustomerIdentifier); this only ever runs once
// an email or a phone has been extracted.

async function fetchOrdersByEmail(email: string): Promise<AdminOrder[]> {
  return ordersApi.list([where("customerEmail", "==", email), limit(CUSTOMER_ORDERS_LIMIT)]);
}

async function fetchOrdersByPhone(digits: string): Promise<AdminOrder[]> {
  const variants = phoneQueryVariants(digits);
  const results = await Promise.all(variants.map((v) => ordersApi.list([where("customerPhone", "==", v), limit(CUSTOMER_ORDERS_LIMIT)])));
  const byId = new Map<string, AdminOrder>();
  for (const list of results) {
    for (const o of list) {
      // Re-validated with the same tolerant comparison the rest of the app
      // already trusts, rather than blindly accepting every exact-string
      // variant hit.
      if (phoneNumbersLikelyMatch(o.customerPhone, digits)) byId.set(o.id, o);
    }
  }
  return [...byId.values()];
}

// A verified profile exists only when every matched order shares the SAME
// real (non-anonymous) customerId -- mirrors OrderCustomerHistory.tsx's own
// historyHasProfile logic. Pure (no Firestore) so it's directly
// unit-testable: a guest's orders (no customerId at all, or two DIFFERENT
// guest checkouts that happen to share an email/phone) must never be
// treated as one verified identity.
export function resolveSingleCustomerId(orders: Pick<AdminOrder, "customerId">[]): string | null {
  const customerIds = new Set(orders.map((o) => o.customerId).filter(Boolean));
  return customerIds.size === 1 ? [...customerIds][0]! : null;
}

export async function resolveCustomerLookup(customerQuery: string): Promise<{ kind: "insufficient" } | { kind: "not_found" } | { kind: "resolved"; result: CustomerLookupResult }> {
  const identifier = classifyCustomerIdentifier(customerQuery);
  if (identifier.kind === "insufficient") return { kind: "insufficient" };

  const orders = identifier.kind === "email" ? await fetchOrdersByEmail(identifier.value) : await fetchOrdersByPhone(identifier.value);
  if (orders.length === 0) return { kind: "not_found" };

  // Returns are only fetched for a verified profile -- a guest's returns
  // can never be reliably linked, same reasoning as customerHistory.ts's
  // own comment on this.
  const singleCustomerId = resolveSingleCustomerId(orders);
  let returns: AdminReturn[] | null = null;
  if (singleCustomerId) {
    returns = await returnsApi.list([where("customerId", "==", singleCustomerId)]);
  }

  return {
    kind: "resolved",
    result: { orders, returns, isGuestMatch: !singleCustomerId, customerName: orders[0].customerName },
  };
}

export async function runCustomerHistory(intent: AssistantIntent): Promise<AssistantAnswer> {
  const query = intent.customerQuery ?? "";
  const identifier = classifyCustomerIdentifier(query);
  if (identifier.kind === "insufficient") {
    return { kind: "clarification", messageKey: "admin.assistant.answer.customerNeedsIdentifier" };
  }
  const lookup = await resolveCustomerLookup(query);
  if (lookup.kind === "insufficient") return { kind: "clarification", messageKey: "admin.assistant.answer.customerNeedsIdentifier" };
  if (lookup.kind === "not_found") return { kind: "not_found", messageKey: "admin.assistant.answer.customerNotFound" };

  const summary = summarizeCustomerHistory(lookup.result.orders, lookup.result.returns);
  return {
    kind: "customer_history",
    messageKey: "admin.assistant.answer.customerHistory",
    data: { summary, customerName: lookup.result.customerName, isGuestMatch: lookup.result.isGuestMatch, orders: lookup.result.orders },
  };
}

// ---- top_product / top_category / top_color / top_size / units_sold --------

export async function runTopProduct(intent: AssistantIntent): Promise<AssistantAnswer> {
  const range = resolvePeriod(intent.period ?? DEFAULT_RANKING_PERIOD);
  const { orders, truncated } = await fetchOrdersForRange(range);
  const result = topProducts(orders, intent.topN ?? 5);
  return { kind: "top_product", range, truncated, messageKey: "admin.assistant.answer.topProduct", data: { result } };
}

// Category requires a join against `products` -- fetched ONLY for the
// distinct productIds actually referenced by the bounded order set (never
// the whole catalog). Each is a single-document `.get()` (cheapest
// possible read unit, same per-document cost as a batched `in` query would
// be, without that query's 30-item chunking complexity).
async function fetchProductsByIds(ids: string[]): Promise<Map<string, AdminProduct>> {
  const unique = [...new Set(ids)];
  const fetched = await Promise.all(unique.map((id) => productsApi.get(id)));
  const map = new Map<string, AdminProduct>();
  fetched.forEach((p, i) => {
    if (p) map.set(unique[i], normalizeProduct(p));
  });
  return map;
}

export async function runTopCategory(intent: AssistantIntent): Promise<AssistantAnswer> {
  const range = resolvePeriod(intent.period ?? DEFAULT_RANKING_PERIOD);
  const { orders, truncated } = await fetchOrdersForRange(range);
  const productIds = orders.flatMap((o) => o.lines.map((l) => l.productId));
  const [productById, categories] = await Promise.all([fetchProductsByIds(productIds), categoriesApi.list()]);
  const { result, unknownQty } = topCategories(orders, productById, intent.topN ?? 5);
  // `CategoryAggregate.category` is the slug (AdminProduct.category), not a
  // display name -- the categories collection is small and bounded (same
  // class of read as deliveryZonesApi), so this joins slug -> display name
  // for the formatter. A slug with no matching category doc (deleted since
  // the sale) falls back to the raw slug rather than erroring.
  const categoryLabels: Record<string, { name: string; nameAr?: string }> = {};
  for (const c of categories) categoryLabels[c.slug] = { name: c.name, nameAr: c.nameAr };
  return { kind: "top_category", range, truncated, messageKey: "admin.assistant.answer.topCategory", data: { result, unknownQty, categoryLabels } };
}

export async function runTopColor(intent: AssistantIntent): Promise<AssistantAnswer> {
  const range = resolvePeriod(intent.period ?? DEFAULT_RANKING_PERIOD);
  const { orders, truncated } = await fetchOrdersForRange(range);
  const { result, unknownQty } = topColors(orders, intent.topN ?? 5);
  return { kind: "top_color", range, truncated, messageKey: "admin.assistant.answer.topColor", data: { result, unknownQty } };
}

export async function runTopSize(intent: AssistantIntent): Promise<AssistantAnswer> {
  const range = resolvePeriod(intent.period ?? DEFAULT_RANKING_PERIOD);
  const { orders, truncated } = await fetchOrdersForRange(range);
  const { result, unknownQty } = topSizes(orders, intent.topN ?? 5);
  return { kind: "top_size", range, truncated, messageKey: "admin.assistant.answer.topSize", data: { result, unknownQty } };
}

export async function runUnitsSold(intent: AssistantIntent): Promise<AssistantAnswer> {
  const range = resolvePeriod(intent.period ?? DEFAULT_RANKING_PERIOD);
  const { orders, truncated } = await fetchOrdersForRange(range);
  return { kind: "units_sold", range, truncated, messageKey: "admin.assistant.answer.unitsSold", data: { units: totalUnitsSold(orders) } };
}

// ---- zone_orders / zone_sales -----------------------------------------------
// Uses ONLY the denormalized deliveryZoneName/NameAr already on each
// already-fetched order -- no separate deliveryZones collection read for
// the aggregate-all case. For a specific named zone with zero matches in
// the period, a small (14-document) deliveryZones read distinguishes "a
// real zone, no orders this period" (a true, reportable zero) from "not a
// recognized zone name" (never silently reported as zero).

export async function runZoneOrders(intent: AssistantIntent): Promise<AssistantAnswer> {
  return runZone(intent, "zone_orders");
}
export async function runZoneSales(intent: AssistantIntent): Promise<AssistantAnswer> {
  return runZone(intent, "zone_sales");
}

// Pure: given an already-fetched zones list (small, ~14 documents) and a
// free-text fragment, decides whether the fragment names a REAL zone --
// used only to distinguish "a real zone, genuinely zero orders this
// period" from "not a recognized zone name at all" (never silently
// reported as a zero-orders answer for a typo'd/nonexistent zone).
export function isRecognizedZoneName(zones: { name: string; nameAr: string }[], fragment: string): boolean {
  const needle = normalizeSearchText(fragment);
  if (!needle) return false;
  return zones.some((z) => normalizeSearchText(z.name).includes(needle) || normalizeSearchText(z.nameAr).includes(needle));
}

async function runZone(intent: AssistantIntent, kind: "zone_orders" | "zone_sales"): Promise<AssistantAnswer> {
  const range = resolvePeriod(intent.period ?? DEFAULT_RANKING_PERIOD);
  const { orders, truncated } = await fetchOrdersForRange(range);

  if (intent.zoneFragment) {
    const matched = filterOrdersByZoneFragment(orders, intent.zoneFragment);
    if (matched.length === 0) {
      const zones = await deliveryZonesApi.list();
      if (!isRecognizedZoneName(zones, intent.zoneFragment)) {
        return { kind: "not_found", messageKey: "admin.assistant.answer.zoneNotFound", data: { fragment: intent.zoneFragment } };
      }
    }
    const totals = computeSalesTotals(matched);
    return {
      kind,
      range,
      truncated,
      messageKey: kind === "zone_sales" ? "admin.assistant.answer.zoneSalesSpecific" : "admin.assistant.answer.zoneOrdersSpecific",
      data: { zoneFragment: intent.zoneFragment, orderCount: matched.length, sales: totals.totalSales },
    };
  }

  const { items, unknownCount } = aggregateByZone(orders);
  const sorted = [...items].sort((a, b) => (kind === "zone_sales" ? b.sales - a.sales : b.orderCount - a.orderCount));
  return {
    kind,
    range,
    truncated,
    messageKey: kind === "zone_sales" ? "admin.assistant.answer.zoneSalesTop" : "admin.assistant.answer.zoneOrdersTop",
    data: { items: sorted.slice(0, 5), unknownCount },
  };
}

// ---- out_of_stock / low_stock -------------------------------------------------
// A full `products` read -- the SAME existing, already-accepted pattern
// Dashboard.tsx/Inventory.tsx already use (the catalog is a small, bounded
// collection, unlike orders). Never touches stockMovements or any
// write-capable API.

// Pure filters, unit-testable directly against plain AdminProduct fixtures
// -- no Firestore needed. A product with any unknown-qty size slot is
// excluded from BOTH lists rather than guessed either way: `qty: null`
// must never be silently treated as 0 (out of stock) or as "plenty" (not
// low), see productVariants.ts's own totalStock()/hasUnknownStock() split.
export function filterOutOfStock(products: AdminProduct[]): AdminProduct[] {
  return products.filter((p) => p.status === "active" && !hasUnknownStock(p) && totalStock(p) === 0);
}

export function filterLowStock(products: AdminProduct[], threshold: number): AdminProduct[] {
  return products.filter((p) => p.status === "active" && !hasUnknownStock(p) && totalStock(p) > 0 && totalStock(p) <= threshold);
}

export async function runOutOfStock(): Promise<AssistantAnswer> {
  const products = (await productsApi.list()).map(normalizeProduct);
  return { kind: "out_of_stock", messageKey: "admin.assistant.answer.outOfStock", data: { items: filterOutOfStock(products) } };
}

export async function runLowStock(): Promise<AssistantAnswer> {
  // Reuses the ONE genuinely configurable, admin-set threshold that exists
  // anywhere in the codebase (settings/notifications' lowStockThreshold,
  // Notifications.tsx) -- never a newly invented magic number. Falls back
  // to 3 only because that's the SAME default lowStockNotify.ts itself
  // already falls back to when the doc doesn't exist yet.
  const prefs = (await getSingletonDoc<NotificationPrefsDoc>("settings", "notifications")) ?? {
    lowStockAlerts: true,
    lowStockThreshold: LOW_STOCK_DEFAULT_THRESHOLD,
    newOrderAlerts: true,
    newReviewAlerts: true,
  };
  const threshold = prefs.lowStockThreshold ?? LOW_STOCK_DEFAULT_THRESHOLD;
  const products = (await productsApi.list()).map(normalizeProduct);
  return { kind: "low_stock", messageKey: "admin.assistant.answer.lowStock", data: { items: filterLowStock(products, threshold), threshold } };
}

// Re-exported so callers don't need to know normalizePhoneDigits lives in a
// different module -- kept minimal, only what the panel actually needs.
export { normalizePhoneDigits };
