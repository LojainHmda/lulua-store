// Automatic promotions at the till -- the ONE calculator, shared by the POS
// (cart, payment popup, receipt), the sale transaction (placeOrder) and the
// server rules (which re-run it on the real prices before accepting a
// sale). Pure: no imports, no I/O, no clock -- callers pass `now`.
//
// Types:
//   percent      value% off each eligible unit (or off the sale, scope "sale")
//   amount       value ₪ off each eligible unit, capped at its price (or ₪ off the sale)
//   buy_x_get_y  buy buyQty, get getQty at getPercent% off (100 = free); the
//                cheapest units of each group are the discounted ones
//   bundle       any bundleQty eligible units for value ₪ (most expensive first)
//
// How promotions combine (documented, deterministic):
//   1. Item promotions (scope products/categories): each cart line gets at
//      most ONE. They're ranked by what each would save on its own (biggest
//      first, then id); each takes all its eligible lines not taken yet.
//   2. Then at most ONE whole-sale promotion (the biggest), on what's left
//      after item promotions, if that reaches its minimum.
//   3. A manual discount (cashier) comes on top, on the remaining total.

export type PromotionType = "percent" | "amount" | "buy_x_get_y" | "bundle";
export type PromotionScope = "products" | "categories" | "sale";

export interface PromotionDef {
  id: string;
  name: string;
  active: boolean;
  type: PromotionType;
  scope: PromotionScope;
  value: number;
  buyQty?: number;
  getQty?: number;
  getPercent?: number;
  bundleQty?: number;
  productIds?: string[];
  // Category slugs, sub-categories included (resolved when the promotion is saved).
  categorySlugs?: string[];
  minSubtotal?: number;
  // Empty/absent = every branch.
  branchIds?: string[];
  // Epoch ms; absent = no limit.
  startsAt?: number;
  endsAt?: number;
}

export interface PromoLine {
  key: string;
  productId: string;
  category: string;
  price: number;
  qty: number;
}

export interface PromoLineResult {
  discount: number;
  promotionId: string;
  promotionName: string;
}

export interface PromoResult {
  lines: Record<string, PromoLineResult>;
  sale: { promotionId: string; promotionName: string; discount: number } | null;
  // Every promotion that took something off, with how much.
  applied: { id: string; name: string; amount: number }[];
  total: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function isPromotionLive(p: PromotionDef, branchId: string | undefined, now: number): boolean {
  if (!p.active) return false;
  if (p.startsAt != null && now < p.startsAt) return false;
  if (p.endsAt != null && now > p.endsAt) return false;
  if (p.branchIds && p.branchIds.length > 0 && (!branchId || !p.branchIds.includes(branchId))) return false;
  return true;
}

function eligible(p: PromotionDef, l: PromoLine): boolean {
  if (p.scope === "products") return !!p.productIds?.includes(l.productId);
  if (p.scope === "categories") return !!p.categorySlugs?.includes(l.category);
  return false;
}

// What one item promotion takes off each of `lines` (all eligible).
function itemDiscounts(p: PromotionDef, lines: PromoLine[]): Map<string, number> {
  const out = new Map<string, number>();
  if (p.type === "percent") {
    const pct = Math.max(0, Math.min(100, p.value));
    for (const l of lines) out.set(l.key, r2((l.price * l.qty * pct) / 100));
    return out;
  }
  if (p.type === "amount") {
    for (const l of lines) out.set(l.key, r2(Math.min(Math.max(0, p.value), l.price) * l.qty));
    return out;
  }
  // Unit-based types: one entry per unit, most expensive first (ties by line key).
  const units = lines
    .flatMap((l) => Array.from({ length: l.qty }, () => ({ key: l.key, price: l.price })))
    .sort((a, b) => b.price - a.price || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const add = (key: string, v: number) => out.set(key, r2((out.get(key) ?? 0) + v));
  if (p.type === "buy_x_get_y") {
    const buy = Math.max(1, Math.floor(p.buyQty ?? 1));
    const get = Math.max(1, Math.floor(p.getQty ?? 1));
    const pct = Math.max(0, Math.min(100, p.getPercent ?? 100));
    const group = buy + get;
    for (let g = 0; g + group <= units.length; g += group) {
      // The last `get` units of each group are the cheapest in it.
      for (const u of units.slice(g + buy, g + group)) add(u.key, (u.price * pct) / 100);
    }
    return out;
  }
  // bundle: groups of bundleQty for `value` ₪; the saving is shared by price.
  const n = Math.max(2, Math.floor(p.bundleQty ?? 2));
  for (let g = 0; g + n <= units.length; g += n) {
    const chunk = units.slice(g, g + n);
    const sum = chunk.reduce((s, u) => s + u.price, 0);
    const saving = r2(sum - Math.max(0, p.value));
    if (saving <= 0) continue;
    let given = 0;
    chunk.forEach((u, i) => {
      const part = i === chunk.length - 1 ? r2(saving - given) : r2((saving * u.price) / sum);
      given = r2(given + part);
      add(u.key, part);
    });
  }
  return out;
}

function sumMap(m: Map<string, number>): number {
  let s = 0;
  for (const v of m.values()) s += v;
  return r2(s);
}

export function applyPromotions(lines: PromoLine[], promotions: PromotionDef[], ctx: { branchId?: string; now: number }): PromoResult {
  const live = promotions.filter((p) => isPromotionLive(p, ctx.branchId, ctx.now));
  const result: PromoResult = { lines: {}, sale: null, applied: [], total: 0 };

  // 1. Item promotions, biggest saving first.
  const items = live
    .filter((p) => p.scope !== "sale")
    .map((p) => ({ p, alone: sumMap(itemDiscounts(p, lines.filter((l) => eligible(p, l)))) }))
    .filter((x) => x.alone > 0)
    .sort((a, b) => b.alone - a.alone || (a.p.id < b.p.id ? -1 : 1));
  for (const { p } of items) {
    const pool = lines.filter((l) => eligible(p, l) && !result.lines[l.key]);
    const d = itemDiscounts(p, pool);
    const amount = sumMap(d);
    if (amount <= 0) continue;
    for (const l of pool) {
      // Never more than the line itself.
      const v = Math.min(d.get(l.key) ?? 0, r2(l.price * l.qty));
      result.lines[l.key] = { discount: r2(v), promotionId: p.id, promotionName: p.name };
    }
    result.applied.push({ id: p.id, name: p.name, amount });
  }
  const itemTotal = r2(Object.values(result.lines).reduce((s, l) => s + l.discount, 0));

  // 2. One whole-sale promotion on what's left.
  const base = r2(lines.reduce((s, l) => s + l.price * l.qty, 0) - itemTotal);
  let best: { p: PromotionDef; amount: number } | null = null;
  for (const p of live.filter((x) => x.scope === "sale")) {
    if (p.minSubtotal != null && base < p.minSubtotal) continue;
    const amount =
      p.type === "percent" ? r2((base * Math.max(0, Math.min(100, p.value))) / 100) : p.type === "amount" ? r2(Math.min(Math.max(0, p.value), base)) : 0;
    if (amount > 0 && (!best || amount > best.amount || (amount === best.amount && p.id < best.p.id))) best = { p, amount };
  }
  if (best) {
    result.sale = { promotionId: best.p.id, promotionName: best.p.name, discount: best.amount };
    result.applied.push({ id: best.p.id, name: best.p.name, amount: best.amount });
  }
  result.total = r2(itemTotal + (best?.amount ?? 0));
  return result;
}

// "Almost there" for multi-item deals (buy X get Y, bundles): live item
// promotions whose eligible units in the cart -- the ones no other
// promotion already took -- are short of a full group. `need` = units to
// add for the next group; `free` = units that group would get (buy X get Y).
export interface PromoHint {
  promotionId: string;
  promotionName: string;
  type: "buy_x_get_y" | "bundle";
  need: number;
  free: number;
  // buy X get Y: the % off those units (100 = free).
  percent: number;
}

export function promotionHints(lines: PromoLine[], promotions: PromotionDef[], ctx: { branchId?: string; now: number }, result?: PromoResult): PromoHint[] {
  const res = result ?? applyPromotions(lines, promotions, ctx);
  const hints: PromoHint[] = [];
  for (const p of promotions.filter((x) => isPromotionLive(x, ctx.branchId, ctx.now) && (x.type === "buy_x_get_y" || x.type === "bundle") && x.scope !== "sale")) {
    // Its own lines (if it applied) plus eligible lines nobody took.
    const pool = lines.filter((l) => eligible(p, l) && (!res.lines[l.key] || res.lines[l.key].promotionId === p.id));
    const units = pool.reduce((s, l) => s + l.qty, 0);
    if (units === 0) continue;
    const group = p.type === "buy_x_get_y" ? Math.max(1, Math.floor(p.buyQty ?? 1)) + Math.max(1, Math.floor(p.getQty ?? 1)) : Math.max(2, Math.floor(p.bundleQty ?? 2));
    const rest = units % group;
    if (rest === 0) continue;
    hints.push({ promotionId: p.id, promotionName: p.name, type: p.type === "bundle" ? "bundle" : "buy_x_get_y", need: group - rest, free: p.type === "buy_x_get_y" ? Math.max(1, Math.floor(p.getQty ?? 1)) : 0, percent: Math.max(0, Math.min(100, p.getPercent ?? 100)) });
  }
  return hints;
}

// A promotion document (as stored) -> the calculator's shape. Timestamps
// arrive as {$ts} on the server and as Timestamp objects in the app.
export function toPromotionDef(id: string, d: Record<string, unknown>): PromotionDef {
  const ms = (v: unknown): number | undefined => {
    if (v == null) return undefined;
    if (typeof v === "number") return v;
    const o = v as { toMillis?: () => number; $ts?: string };
    if (typeof o.toMillis === "function") return o.toMillis();
    if (typeof o.$ts === "string") return Date.parse(o.$ts);
    return undefined;
  };
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  return {
    id,
    name: typeof d.name === "string" ? d.name : "",
    active: d.active === true,
    type: d.type as PromotionType,
    scope: d.scope as PromotionScope,
    value: num(d.value) ?? 0,
    buyQty: num(d.buyQty),
    getQty: num(d.getQty),
    getPercent: num(d.getPercent),
    bundleQty: num(d.bundleQty),
    productIds: list(d.productIds),
    categorySlugs: list(d.categorySlugs),
    minSubtotal: num(d.minSubtotal),
    branchIds: list(d.branchIds),
    startsAt: ms(d.startsAt),
    endsAt: ms(d.endsAt),
  };
}
