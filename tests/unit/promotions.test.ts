import { describe, expect, it } from "vitest";
import { applyPromotions, isPromotionLive, promotionHints, toPromotionDef, type PromoLine, type PromotionDef } from "../../src/data/promotions";

const NOW = Date.parse("2026-10-18T12:00:00Z");
const dress = (qty = 1, price = 100): PromoLine => ({ key: "dress::w::S", productId: "dress", category: "dresses", price, qty });
const scarf = (qty = 1, price = 50): PromoLine => ({ key: "scarf::r::One", productId: "scarf", category: "accessories", price, qty });
const promo = (p: Partial<PromotionDef>): PromotionDef => ({ id: "p1", name: "Promo", active: true, type: "percent", scope: "products", value: 10, productIds: ["dress"], ...p });
const run = (lines: PromoLine[], promos: PromotionDef[], branchId = "b1") => applyPromotions(lines, promos, { branchId, now: NOW });

describe("promotion types", () => {
  it("percent off products", () => {
    const r = run([dress(2), scarf()], [promo({ value: 20 })]);
    expect(r.lines["dress::w::S"].discount).toBe(40);
    expect(r.lines["scarf::r::One"]).toBeUndefined();
    expect(r.total).toBe(40);
  });

  it("fixed amount off each unit, never more than the price", () => {
    expect(run([dress(3)], [promo({ type: "amount", value: 30 })]).total).toBe(90);
    expect(run([scarf(1)], [promo({ type: "amount", value: 80, productIds: ["scarf"] })]).total).toBe(50);
  });

  it("buy 2 get 1 free: the cheapest unit of each group", () => {
    const r = run([dress(2, 100), scarf(1, 50)], [promo({ type: "buy_x_get_y", buyQty: 2, getQty: 1, getPercent: 100, scope: "categories", categorySlugs: ["dresses", "accessories"] })]);
    expect(r.lines["scarf::r::One"].discount).toBe(50);
    expect(r.total).toBe(50);
    // Only full groups count.
    expect(run([dress(2)], [promo({ type: "buy_x_get_y", buyQty: 2, getQty: 1 })]).total).toBe(0);
    // Second item at 50%.
    expect(run([dress(2)], [promo({ type: "buy_x_get_y", buyQty: 1, getQty: 1, getPercent: 50 })]).total).toBe(50);
  });

  it("bundle: any 3 for 200 (most expensive first), saving shared by price", () => {
    const r = run([dress(2, 100), scarf(2, 50)], [promo({ type: "bundle", bundleQty: 3, value: 200, scope: "categories", categorySlugs: ["dresses", "accessories"] })]);
    // Group = 100 + 100 + 50 = 250 -> 200: saving 50 (one scarf left over).
    expect(r.total).toBe(50);
    expect(r.lines["dress::w::S"].discount + r.lines["scarf::r::One"].discount).toBe(50);
  });

  it("whole-sale percent / amount with a minimum", () => {
    expect(run([dress(1), scarf(1)], [promo({ scope: "sale", value: 10, productIds: undefined })]).total).toBe(15);
    expect(run([dress(1)], [promo({ scope: "sale", type: "amount", value: 30, minSubtotal: 200 })]).total).toBe(0);
    expect(run([dress(2)], [promo({ scope: "sale", type: "amount", value: 30, minSubtotal: 200 })]).sale?.discount).toBe(30);
  });
});

describe("combining", () => {
  it("one item promotion per line: the biggest saving wins", () => {
    const r = run([dress(1)], [promo({ id: "a", value: 10 }), promo({ id: "b", value: 25, scope: "categories", productIds: undefined, categorySlugs: ["dresses"] })]);
    expect(r.lines["dress::w::S"]).toMatchObject({ promotionId: "b", discount: 25 });
    expect(r.applied.map((a) => a.id)).toEqual(["b"]);
  });

  it("a whole-sale promotion comes after item promotions, on what's left", () => {
    const r = run([dress(1), scarf(1)], [promo({ id: "item", value: 20 }), promo({ id: "sale", scope: "sale", value: 10 })]);
    // 150 - 20 = 130 -> 10% = 13
    expect(r.sale?.discount).toBe(13);
    expect(r.total).toBe(33);
  });

  it("dropping promotions that saved nothing never changes the result (what the server re-checks)", () => {
    const all = [promo({ id: "a", value: 10 }), promo({ id: "z", value: 50, productIds: ["other"] }), promo({ id: "s", scope: "sale", value: 5 })];
    const full = run([dress(2), scarf(1)], all);
    const cited = all.filter((p) => full.applied.some((a) => a.id === p.id));
    expect(run([dress(2), scarf(1)], cited)).toEqual(full);
  });
});

describe("when a promotion is live", () => {
  it("respects active, dates and branches", () => {
    expect(isPromotionLive(promo({ active: false }), "b1", NOW)).toBe(false);
    expect(isPromotionLive(promo({ startsAt: NOW + 1 }), "b1", NOW)).toBe(false);
    expect(isPromotionLive(promo({ endsAt: NOW - 1 }), "b1", NOW)).toBe(false);
    expect(isPromotionLive(promo({ branchIds: ["b2"] }), "b1", NOW)).toBe(false);
    expect(isPromotionLive(promo({ branchIds: [] }), "b1", NOW)).toBe(true);
    expect(run([dress(1)], [promo({ branchIds: ["b2"] })], "b1").total).toBe(0);
  });

  it("reads stored documents (server {$ts} and app Timestamps)", () => {
    const d = toPromotionDef("x", { name: "N", active: true, type: "percent", scope: "sale", value: 5, startsAt: { $ts: "2026-10-01T00:00:00.000Z" }, endsAt: { toMillis: () => 5 } });
    expect(d.startsAt).toBe(Date.parse("2026-10-01T00:00:00.000Z"));
    expect(d.endsAt).toBe(5);
  });
});

describe("almost-there hints", () => {
  const b2g1 = promo({ type: "buy_x_get_y", buyQty: 2, getQty: 1, getPercent: 100 });
  it("2 units on a buy-2-get-1: add 1 more to get 1 free (nothing applied yet)", () => {
    expect(run([dress(2)], [b2g1]).total).toBe(0);
    expect(promotionHints([dress(2)], [b2g1], { branchId: "b1", now: NOW })).toEqual([
      { promotionId: "p1", promotionName: "Promo", type: "buy_x_get_y", need: 1, free: 1, percent: 100 },
    ]);
  });
  it("no hint once the group is complete; a hint again for the next group", () => {
    expect(promotionHints([dress(3)], [b2g1], { branchId: "b1", now: NOW })).toEqual([]);
    expect(promotionHints([dress(4)], [b2g1], { branchId: "b1", now: NOW })[0].need).toBe(2);
  });
  it("bundles, and nothing for ended promotions", () => {
    expect(promotionHints([dress(1)], [promo({ type: "bundle", bundleQty: 3, value: 200 })], { branchId: "b1", now: NOW })[0]).toMatchObject({ type: "bundle", need: 2 });
    expect(promotionHints([dress(2)], [{ ...b2g1, endsAt: NOW - 1 }], { branchId: "b1", now: NOW })).toEqual([]);
  });
});
