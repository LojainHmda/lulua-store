// Live aggregations over already-fetched, already-date-bounded orders.
// Products/categories carry NO sales counters at all (confirmed by the
// discovery audit -- AdminProduct has no unitsSold/salesCount field, and
// the only per-product counters that exist, ProductStatsDoc/
// CategoryStatsDoc, track storefront views/quick-adds, not sales), so
// every figure here is computed fresh from OrderLine data, the same
// "recompute from live orders rather than trust a stale counter" principle
// customerHistory.ts already applies to customer.totalSpent. Pure
// functions only -- no Firestore reads (see operations.ts).
import { normalizeSearchText } from "../../components/admin/orderSearch";
import type { AdminOrder, AdminProduct } from "../types";
import { isIncludedInSales } from "./salesCalculations";

export interface ProductAggregate {
  productId: string;
  name: string;
  qty: number;
  revenue: number;
}

// Keyed by productId (not by line.name -- unlike Reports.tsx's own inline
// topProducts, which keys by name and would silently merge/split products
// that share or changed display names). One entry per distinct product
// that appears in an included order's lines.
export function aggregateByProduct(orders: AdminOrder[]): ProductAggregate[] {
  const map = new Map<string, ProductAggregate>();
  for (const order of orders) {
    if (!isIncludedInSales(order)) continue;
    for (const line of order.lines) {
      const existing = map.get(line.productId) ?? { productId: line.productId, name: line.name, qty: 0, revenue: 0 };
      existing.qty += line.qty;
      existing.revenue += line.price * line.qty;
      map.set(line.productId, existing);
    }
  }
  return [...map.values()];
}

export interface TopResult<T> {
  items: T[];
  /** True when the request was specifically for a single "the" winner (topN===1) and more than one item tied for first place -- the caller must present all of `items`, never arbitrarily pick one. */
  tiedForFirst: boolean;
}

function topByQty<T extends { qty: number }>(aggregate: T[], topN: number): TopResult<T> {
  if (aggregate.length === 0) return { items: [], tiedForFirst: false };
  const sorted = [...aggregate].sort((a, b) => b.qty - a.qty);
  if (topN === 1) {
    const topQty = sorted[0].qty;
    const tied = sorted.filter((a) => a.qty === topQty);
    return { items: tied, tiedForFirst: tied.length > 1 };
  }
  return { items: sorted.slice(0, topN), tiedForFirst: false };
}

export function topProducts(orders: AdminOrder[], topN = 5): TopResult<ProductAggregate> {
  return topByQty(aggregateByProduct(orders), topN);
}

export interface CategoryAggregate {
  category: string; // slug, as stored on AdminProduct.category
  qty: number;
  revenue: number;
}

// `category` lives on AdminProduct, not on OrderLine -- a join is
// required. `productById` is expected to be a narrow map covering ONLY the
// productIds that actually appear in `orders` (see operations.ts, which
// fetches exactly those products, never the whole catalog). A line whose
// product can no longer be found (deleted since the sale) is counted in
// `unknownQty`, never silently folded into some existing category.
export function aggregateByCategory(
  orders: AdminOrder[],
  productById: Map<string, Pick<AdminProduct, "category">>
): { items: CategoryAggregate[]; unknownQty: number } {
  const map = new Map<string, CategoryAggregate>();
  let unknownQty = 0;
  for (const order of orders) {
    if (!isIncludedInSales(order)) continue;
    for (const line of order.lines) {
      const product = productById.get(line.productId);
      if (!product) {
        unknownQty += line.qty;
        continue;
      }
      const existing = map.get(product.category) ?? { category: product.category, qty: 0, revenue: 0 };
      existing.qty += line.qty;
      existing.revenue += line.price * line.qty;
      map.set(product.category, existing);
    }
  }
  return { items: [...map.values()], unknownQty };
}

export function topCategories(
  orders: AdminOrder[],
  productById: Map<string, Pick<AdminProduct, "category">>,
  topN = 5
): { result: TopResult<CategoryAggregate>; unknownQty: number } {
  const { items, unknownQty } = aggregateByCategory(orders, productById);
  return { result: topByQty(items, topN), unknownQty };
}

export interface ColorAggregate {
  color: string;
  qty: number;
}

// color/size are already denormalized directly on OrderLine -- no product
// join needed at all, so these two are strictly cheaper than category.
export function aggregateByColor(orders: AdminOrder[]): { items: ColorAggregate[]; unknownQty: number } {
  const map = new Map<string, ColorAggregate>();
  let unknownQty = 0;
  for (const order of orders) {
    if (!isIncludedInSales(order)) continue;
    for (const line of order.lines) {
      const color = line.color?.trim();
      if (!color) {
        unknownQty += line.qty;
        continue;
      }
      const existing = map.get(color) ?? { color, qty: 0 };
      existing.qty += line.qty;
      map.set(color, existing);
    }
  }
  return { items: [...map.values()], unknownQty };
}

export function topColors(orders: AdminOrder[], topN = 5): { result: TopResult<ColorAggregate>; unknownQty: number } {
  const { items, unknownQty } = aggregateByColor(orders);
  return { result: topByQty(items, topN), unknownQty };
}

export interface SizeAggregate {
  size: string;
  qty: number;
}

// Sizes are preserved EXACTLY as stored (no normalization/case-folding) --
// "S"/"M"/"L" and a numeric size like "42" are different business sizes,
// not variants of the same one, and must never be silently merged.
export function aggregateBySize(orders: AdminOrder[]): { items: SizeAggregate[]; unknownQty: number } {
  const map = new Map<string, SizeAggregate>();
  let unknownQty = 0;
  for (const order of orders) {
    if (!isIncludedInSales(order)) continue;
    for (const line of order.lines) {
      const size = line.size?.trim();
      if (!size) {
        unknownQty += line.qty;
        continue;
      }
      const existing = map.get(size) ?? { size, qty: 0 };
      existing.qty += line.qty;
      map.set(size, existing);
    }
  }
  return { items: [...map.values()], unknownQty };
}

export function topSizes(orders: AdminOrder[], topN = 5): { result: TopResult<SizeAggregate>; unknownQty: number } {
  const { items, unknownQty } = aggregateBySize(orders);
  return { result: topByQty(items, topN), unknownQty };
}

export interface ZoneAggregate {
  /** deliveryZoneId when present, else the denormalized name (historical orders may have a name but predate ids being stable, though in practice both are always set together -- see types.ts). */
  zoneKey: string;
  name: string;
  nameAr?: string;
  orderCount: number;
  sales: number;
}

// Uses ONLY the denormalized deliveryZoneId/Name/NameAr already stored on
// each order -- no separate deliveryZones collection read, and no
// inference from shippingAddress free text (explicitly required: a
// historical order with no stored zone is "unknown", never guessed from
// its address string). `unknownCount` covers POS/manual orders (no zone
// concept at all) and any pre-delivery-zones-feature historical order.
export function aggregateByZone(orders: AdminOrder[]): { items: ZoneAggregate[]; unknownCount: number } {
  const map = new Map<string, ZoneAggregate>();
  let unknownCount = 0;
  for (const order of orders) {
    if (!isIncludedInSales(order)) continue;
    if (!order.deliveryZoneId && !order.deliveryZoneName) {
      unknownCount += 1;
      continue;
    }
    const key = order.deliveryZoneId ?? order.deliveryZoneName!;
    const existing = map.get(key) ?? {
      zoneKey: key,
      name: order.deliveryZoneName ?? key,
      nameAr: order.deliveryZoneNameAr,
      orderCount: 0,
      sales: 0,
    };
    existing.orderCount += 1;
    existing.sales += order.total;
    map.set(key, existing);
  }
  return { items: [...map.values()], unknownCount };
}

export function topZonesByOrders(orders: AdminOrder[], topN = 5): { result: TopResult<ZoneAggregate & { qty: number }>; unknownCount: number } {
  const { items, unknownCount } = aggregateByZone(orders);
  // Reuses topByQty's "qty" field convention by projecting orderCount onto
  // a `qty` alias rather than duplicating the tie-detection logic.
  const withQty = items.map((z) => ({ ...z, qty: z.orderCount }));
  return { result: topByQty(withQty, topN), unknownCount };
}

// Filters an already-fetched, already-date-bounded order list down to
// those whose denormalized zone name matches the given free-text fragment
// (e.g. "نابلس"/"Nablus") -- reuses normalizeSearchText so Arabic
// diacritics/letter-shape variants and case never prevent a match, exactly
// the same normalization every other bilingual search in this app already
// relies on. Matches against EITHER the English or Arabic stored name.
export function filterOrdersByZoneFragment(orders: AdminOrder[], fragment: string): AdminOrder[] {
  const needle = normalizeSearchText(fragment);
  if (!needle) return [];
  return orders.filter((o) => {
    const en = normalizeSearchText(o.deliveryZoneName ?? "");
    const ar = normalizeSearchText(o.deliveryZoneNameAr ?? "");
    return (en && en.includes(needle)) || (ar && ar.includes(needle));
  });
}
