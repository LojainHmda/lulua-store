// Layer F: turns an AssistantAnswer (already-computed data + a message
// key) into the final displayed sentence. This is the ONLY place that
// touches translation keys/formatPrice() for the assistant -- every number
// shown here was already computed by salesCalculations.ts/aggregations.ts/
// customerHistory.ts; this module never calculates anything, only formats.
// Kept separate from operations.ts specifically because formatting needs
// the viewer's current language, and re-running it on a language switch
// must never re-trigger a Firestore read.
import { formatPrice } from "../../utils/currency";
import type { Lang } from "../../i18n/translations";
import type { CustomerHistorySummary } from "../customerHistory";
import type { CategoryAggregate, ColorAggregate, ProductAggregate, SizeAggregate, TopResult, ZoneAggregate } from "./aggregations";
import { periodLabelKey, type AssistantDateRange } from "./dateRange";
import type { ComparisonResult, SalesTotals, StatusBreakdown } from "./salesCalculations";
import type { AssistantAnswer } from "./types";
import type { AdminOrder, AdminProduct, OrderStatus } from "../types";

type T = (key: string) => string;

function tr(t: T, key: string, params?: Record<string, string>): string {
  let s = t(key);
  if (params) {
    for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(v);
  }
  return s;
}

function periodLabel(t: T, range?: AssistantDateRange): string {
  if (!range) return "";
  return t(periodLabelKey(range.key));
}

function statusLabel(t: T, status: OrderStatus): string {
  return t(`admin.assistant.status.${status}`);
}

function na(t: T): string {
  return t("admin.assistant.notAvailable");
}

function toDate(value: unknown): Date | null {
  if (!value) return null;
  const asTimestamp = value as { toDate?: () => Date };
  const d = typeof asTimestamp.toDate === "function" ? asTimestamp.toDate() : new Date(value as string | number);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatDate(value: unknown): string {
  const d = toDate(value);
  return d ? d.toLocaleDateString() : "—";
}

function zoneDisplayName(order: Pick<AdminOrder, "deliveryZoneName" | "deliveryZoneNameAr">, lang: Lang, t: T): string {
  if (lang === "ar" && order.deliveryZoneNameAr) return order.deliveryZoneNameAr;
  if (order.deliveryZoneName) return order.deliveryZoneName;
  return t("admin.assistant.noZone");
}

function truncationSuffix(t: T, truncated?: boolean): string {
  return truncated ? ` ${t("admin.assistant.truncatedNote")}` : "";
}

function formatSalesSummary(t: T, data: { totals: SalesTotals; confirmed: SalesTotals }, range?: AssistantDateRange, truncated?: boolean): string {
  const period = periodLabel(t, range);
  if (data.totals.orderCount === 0) {
    return tr(t, "admin.assistant.answer.salesSummaryEmpty", { period }) + truncationSuffix(t, truncated);
  }
  const main = tr(t, "admin.assistant.answer.salesSummary", {
    period,
    sales: formatPrice(data.totals.totalSales),
    count: String(data.totals.orderCount),
    avg: data.totals.averageOrderValue !== null ? formatPrice(data.totals.averageOrderValue) : na(t),
  });
  const confirmedSuffix =
    data.confirmed.orderCount > 0
      ? tr(t, "admin.assistant.answer.salesSummaryConfirmed", {
          confirmedSales: formatPrice(data.confirmed.totalSales),
          confirmedCount: String(data.confirmed.orderCount),
        })
      : "";
  return main + confirmedSuffix + truncationSuffix(t, truncated);
}

function formatDailySummary(t: T, data: { totals: SalesTotals; breakdown: StatusBreakdown }, range?: AssistantDateRange, truncated?: boolean): string {
  const period = periodLabel(t, range);
  const header =
    data.totals.orderCount === 0
      ? tr(t, "admin.assistant.answer.salesSummaryEmpty", { period })
      : tr(t, "admin.assistant.answer.dailySummaryHeader", { period, sales: formatPrice(data.totals.totalSales), count: String(data.totals.orderCount) });
  const breakdown = tr(t, "admin.assistant.answer.dailySummaryBreakdown", {
    pending: String(data.breakdown.pending),
    processing: String(data.breakdown.processing),
    ready: String(data.breakdown.ready),
    shipped: String(data.breakdown.shipped),
    delivered: String(data.breakdown.delivered),
    cancelled: String(data.breakdown.cancelled),
  });
  return `${header} ${breakdown}` + truncationSuffix(t, truncated);
}

function formatComparison(t: T, data: { rangeA: AssistantDateRange; rangeB: AssistantDateRange; comparison: ComparisonResult }, truncated?: boolean): string {
  const { rangeA, rangeB, comparison } = data;
  const line = tr(t, "admin.assistant.answer.comparisonLine", {
    period: periodLabel(t, rangeA),
    sales: formatPrice(comparison.a.totalSales),
    count: String(comparison.a.orderCount),
  });
  const lineB = tr(t, "admin.assistant.answer.comparisonLine", {
    period: periodLabel(t, rangeB),
    sales: formatPrice(comparison.b.totalSales),
    count: String(comparison.b.orderCount),
  });
  const percent = comparison.salesPercentChange !== null ? `${(comparison.salesPercentChange * 100).toFixed(1)}%` : na(t);
  const diff = tr(t, "admin.assistant.answer.comparisonDiff", {
    diff: formatPrice(comparison.salesDifference),
    percent,
    orderDiff: String(comparison.orderCountDifference),
  });
  return `${line} ${lineB} ${diff}` + truncationSuffix(t, truncated);
}

function formatOrderLookup(t: T, lang: Lang, data: { order: AdminOrder; itemCount: number; preparedCount: number; totalLines: number }): string {
  const { order } = data;
  return tr(t, "admin.assistant.answer.orderLookup", {
    orderNumber: order.orderNumber,
    customerName: order.customerName,
    status: statusLabel(t, order.status),
    total: formatPrice(order.total),
    itemCount: String(data.itemCount),
    zone: zoneDisplayName(order, lang, t),
    prepared: String(data.preparedCount),
    totalLines: String(data.totalLines),
    date: formatDate(order.createdAt),
  });
}

function formatCustomerHistory(t: T, data: { summary: CustomerHistorySummary; customerName: string; isGuestMatch: boolean }): string {
  const { summary } = data;
  const prefix = data.isGuestMatch ? t("admin.assistant.answer.customerHistoryGuestPrefix") : "";
  const base = tr(t, "admin.assistant.answer.customerHistory", {
    customerName: data.customerName,
    totalOrders: String(summary.totalOrders),
    successfulCount: String(summary.successfulCount),
    successfulSpend: formatPrice(summary.successfulSpend),
    cancelledCount: String(summary.cancelledCount),
  });
  const returnedSuffix =
    summary.returnedOrderCount !== null && summary.returnedOrderCount > 0
      ? tr(t, "admin.assistant.answer.customerHistoryReturned", { returnedOrderCount: String(summary.returnedOrderCount) })
      : "";
  return prefix + base + returnedSuffix;
}

function formatTopList<TItem>(
  t: T,
  range: AssistantDateRange | undefined,
  truncated: boolean | undefined,
  result: TopResult<TItem>,
  opts: {
    emptyKey: string;
    headerKey: string;
    lineKey: string;
    lineParams: (item: TItem, rank: number) => Record<string, string>;
    unknownQty?: number;
    unknownKey?: string;
  }
): string {
  const period = periodLabel(t, range);
  if (result.items.length === 0) {
    return tr(t, opts.emptyKey, { period }) + truncationSuffix(t, truncated);
  }
  const header = tr(t, opts.headerKey, { period });
  const lines = result.items.map((item, i) => tr(t, opts.lineKey, opts.lineParams(item, i + 1))).join(" ");
  const tieNote = result.tiedForFirst ? t("admin.assistant.answer.topTiedNote") : "";
  const unknownNote = opts.unknownKey && opts.unknownQty ? tr(t, opts.unknownKey, { unknownQty: String(opts.unknownQty) }) : "";
  return `${header} ${lines}${tieNote}${unknownNote}` + truncationSuffix(t, truncated);
}

function formatStockList(t: T, items: AdminProduct[], opts: { emptyKey: string; headerKey: string; moreKey: string }, extraParams: Record<string, string> = {}): string {
  if (items.length === 0) return tr(t, opts.emptyKey, extraParams);
  const MAX_NAMES = 10;
  const shown = items.slice(0, MAX_NAMES).map((p) => p.name);
  const header = tr(t, opts.headerKey, { count: String(items.length), ...extraParams });
  const list = shown.join(t("admin.assistant.listSeparator"));
  const more = items.length > MAX_NAMES ? tr(t, opts.moreKey, { n: String(items.length - MAX_NAMES) }) : "";
  return `${header} ${list}${more}`;
}

export function formatAssistantAnswer(answer: AssistantAnswer, t: T, lang: Lang): string {
  const data = answer.data as Record<string, unknown> | undefined;

  switch (answer.kind) {
    case "unsupported":
      return t("admin.assistant.answer.unsupported");
    case "error":
      return t("admin.assistant.answer.error");
    case "not_found":
      return tr(t, answer.messageKey, (answer.messageParams ?? toStringParams(data)) as Record<string, string>);
    case "clarification":
      return t(answer.messageKey);
    case "sales_summary":
      return formatSalesSummary(t, data as { totals: SalesTotals; confirmed: SalesTotals }, answer.range, answer.truncated);
    case "order_count":
      return tr(t, "admin.assistant.answer.orderCount", { period: periodLabel(t, answer.range), count: String((data as { orderCount: number }).orderCount) }) + truncationSuffix(t, answer.truncated);
    case "status_count": {
      const d = data as { status: OrderStatus; count: number };
      const key = answer.range ? "admin.assistant.answer.statusCount" : "admin.assistant.answer.statusCountAllTime";
      return tr(t, key, { period: periodLabel(t, answer.range), status: statusLabel(t, d.status), count: String(d.count) }) + truncationSuffix(t, answer.truncated);
    }
    case "daily_summary":
      return formatDailySummary(t, data as { totals: SalesTotals; breakdown: StatusBreakdown }, answer.range, answer.truncated);
    case "comparison":
      return formatComparison(t, data as { rangeA: AssistantDateRange; rangeB: AssistantDateRange; comparison: ComparisonResult }, answer.truncated);
    case "order_lookup":
      return formatOrderLookup(t, lang, data as { order: AdminOrder; itemCount: number; preparedCount: number; totalLines: number });
    case "customer_history":
      return formatCustomerHistory(t, data as { summary: CustomerHistorySummary; customerName: string; isGuestMatch: boolean });
    case "top_product":
      return formatTopList(t, answer.range, answer.truncated, (data as { result: TopResult<ProductAggregate> }).result, {
        emptyKey: "admin.assistant.answer.topProductEmpty",
        headerKey: "admin.assistant.answer.topProductHeader",
        lineKey: "admin.assistant.answer.topItemLineWithRevenue",
        lineParams: (item, rank) => ({ rank: String(rank), name: item.name, qty: String(item.qty), revenue: formatPrice(item.revenue) }),
      });
    case "top_category": {
      const d = data as { result: TopResult<CategoryAggregate>; unknownQty: number; categoryLabels: Record<string, { name: string; nameAr?: string }> };
      return formatTopList(t, answer.range, answer.truncated, d.result, {
        emptyKey: "admin.assistant.answer.topCategoryEmpty",
        headerKey: "admin.assistant.answer.topCategoryHeader",
        lineKey: "admin.assistant.answer.topItemLineWithRevenue",
        lineParams: (item, rank) => {
          const label = d.categoryLabels[item.category];
          const name = (lang === "ar" ? label?.nameAr : label?.name) ?? label?.name ?? item.category;
          return { rank: String(rank), name, qty: String(item.qty), revenue: formatPrice(item.revenue) };
        },
        unknownQty: d.unknownQty,
        unknownKey: "admin.assistant.answer.topCategoryUnknownNote",
      });
    }
    case "top_color": {
      const d = data as { result: TopResult<ColorAggregate>; unknownQty: number };
      return formatTopList(t, answer.range, answer.truncated, d.result, {
        emptyKey: "admin.assistant.answer.topColorEmpty",
        headerKey: "admin.assistant.answer.topColorHeader",
        lineKey: "admin.assistant.answer.topItemLine",
        lineParams: (item, rank) => ({ rank: String(rank), name: item.color, qty: String(item.qty) }),
        unknownQty: d.unknownQty,
        unknownKey: "admin.assistant.answer.topColorUnknownNote",
      });
    }
    case "top_size": {
      const d = data as { result: TopResult<SizeAggregate>; unknownQty: number };
      return formatTopList(t, answer.range, answer.truncated, d.result, {
        emptyKey: "admin.assistant.answer.topSizeEmpty",
        headerKey: "admin.assistant.answer.topSizeHeader",
        lineKey: "admin.assistant.answer.topItemLine",
        lineParams: (item, rank) => ({ rank: String(rank), name: item.size, qty: String(item.qty) }),
        unknownQty: d.unknownQty,
        unknownKey: "admin.assistant.answer.topSizeUnknownNote",
      });
    }
    case "units_sold":
      return tr(t, "admin.assistant.answer.unitsSold", { period: periodLabel(t, answer.range), units: String((data as { units: number }).units) }) + truncationSuffix(t, answer.truncated);
    case "zone_orders":
    case "zone_sales": {
      if (data && "zoneFragment" in data) {
        const d = data as { zoneFragment: string; orderCount: number; sales: number };
        const key = answer.kind === "zone_sales" ? "admin.assistant.answer.zoneSalesSpecific" : "admin.assistant.answer.zoneOrdersSpecific";
        return (
          tr(t, key, { period: periodLabel(t, answer.range), zone: d.zoneFragment, count: String(d.orderCount), sales: formatPrice(d.sales) }) +
          truncationSuffix(t, answer.truncated)
        );
      }
      const d = data as { items: ZoneAggregate[]; unknownCount: number };
      const period = periodLabel(t, answer.range);
      if (d.items.length === 0 && d.unknownCount === 0) {
        return tr(t, "admin.assistant.answer.zoneEmptyTop", { period }) + truncationSuffix(t, answer.truncated);
      }
      const headerKey = answer.kind === "zone_sales" ? "admin.assistant.answer.zoneSalesTopHeader" : "admin.assistant.answer.zoneOrdersTopHeader";
      const lineKey = answer.kind === "zone_sales" ? "admin.assistant.answer.zoneSalesTopLine" : "admin.assistant.answer.zoneOrdersTopLine";
      const header = tr(t, headerKey, { period });
      const lines = d.items
        .map((z, i) => {
          const name = lang === "ar" && z.nameAr ? z.nameAr : z.name;
          return tr(t, lineKey, { rank: String(i + 1), zone: name, count: String(z.orderCount), sales: formatPrice(z.sales) });
        })
        .join(" ");
      const unknownNote = d.unknownCount > 0 ? tr(t, "admin.assistant.answer.zoneUnknownNote", { unknownCount: String(d.unknownCount) }) : "";
      return `${header} ${lines}${unknownNote}` + truncationSuffix(t, answer.truncated);
    }
    case "out_of_stock":
      return formatStockList(t, (data as { items: AdminProduct[] }).items, {
        emptyKey: "admin.assistant.answer.outOfStockEmpty",
        headerKey: "admin.assistant.answer.outOfStockHeader",
        moreKey: "admin.assistant.answer.stockListMore",
      });
    case "low_stock": {
      const d = data as { items: AdminProduct[]; threshold: number };
      return formatStockList(
        t,
        d.items,
        { emptyKey: "admin.assistant.answer.lowStockEmpty", headerKey: "admin.assistant.answer.lowStockHeader", moreKey: "admin.assistant.answer.stockListMore" },
        { threshold: String(d.threshold) }
      );
    }
    default:
      return t("admin.assistant.answer.unsupported");
  }
}

function toStringParams(data: Record<string, unknown> | undefined): Record<string, string> {
  if (!data) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === "string" || typeof v === "number") out[k] = String(v);
  }
  return out;
}
