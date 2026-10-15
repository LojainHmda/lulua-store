import { describe, expect, it } from "vitest";
import { DEFAULT_DELIVERY_ZONES, resolveDeliveryFee } from "../../src/data/deliveryZones";
import type { DeliveryZone } from "../../src/admin/types";

const THRESHOLD = 500;

function zone(overrides: Partial<Pick<DeliveryZone, "active" | "fee">> = {}): Pick<DeliveryZone, "active" | "fee"> {
  return { active: true, fee: 20, ...overrides };
}

describe("resolveDeliveryFee", () => {
  it("charges the zone's fee when the subtotal is below the free-shipping threshold", () => {
    expect(resolveDeliveryFee(zone({ fee: 20 }), 100, THRESHOLD)).toBe(20);
  });

  it("zeroes the fee once the subtotal meets the free-shipping threshold exactly", () => {
    expect(resolveDeliveryFee(zone({ fee: 20 }), THRESHOLD, THRESHOLD)).toBe(0);
  });

  it("zeroes the fee once the subtotal exceeds the free-shipping threshold", () => {
    expect(resolveDeliveryFee(zone({ fee: 70 }), THRESHOLD + 1, THRESHOLD)).toBe(0);
  });

  it("still applies the threshold even when no zone is selected yet", () => {
    expect(resolveDeliveryFee(undefined, THRESHOLD, THRESHOLD)).toBe(0);
  });

  it("rejects (null) a missing zone below the threshold -- caller must not fall back to any rate", () => {
    expect(resolveDeliveryFee(undefined, 100, THRESHOLD)).toBeNull();
  });

  it("rejects an inactive zone below the threshold", () => {
    expect(resolveDeliveryFee(zone({ active: false }), 100, THRESHOLD)).toBeNull();
  });

  it("rejects a zone with a negative fee", () => {
    expect(resolveDeliveryFee(zone({ fee: -5 }), 100, THRESHOLD)).toBeNull();
  });

  it("rejects a zone with a non-numeric fee", () => {
    expect(resolveDeliveryFee(zone({ fee: Number.NaN }), 100, THRESHOLD)).toBeNull();
  });

  it("rejects a zone with a non-finite fee", () => {
    expect(resolveDeliveryFee(zone({ fee: Infinity }), 100, THRESHOLD)).toBeNull();
  });

  it("accepts a zero fee as a genuinely free zone, distinct from null/rejection", () => {
    expect(resolveDeliveryFee(zone({ fee: 0 }), 100, THRESHOLD)).toBe(0);
  });

  it("never applies free shipping when the threshold itself is 0 and subtotal is 0 -- 0 >= 0 is still a match", () => {
    expect(resolveDeliveryFee(zone({ fee: 20 }), 0, 0)).toBe(0);
  });
});

describe("DEFAULT_DELIVERY_ZONES (the old Sisley system's real, verified fees)", () => {
  it("has exactly 14 zones", () => {
    expect(DEFAULT_DELIVERY_ZONES).toHaveLength(14);
  });

  it("marks every zone active", () => {
    expect(DEFAULT_DELIVERY_ZONES.every((z) => z.active)).toBe(true);
  });

  it("has a unique, stable id for every zone", () => {
    const ids = DEFAULT_DELIVERY_ZONES.map((z) => z.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has a unique sortOrder for every zone", () => {
    const orders = DEFAULT_DELIVERY_ZONES.map((z) => z.sortOrder);
    expect(new Set(orders).size).toBe(orders.length);
  });

  it("matches the exact fees extracted from the old Sisley admin panel", () => {
    const feesByArabicName = Object.fromEntries(DEFAULT_DELIVERY_ZONES.map((z) => [z.nameAr, z.fee]));
    expect(feesByArabicName).toEqual({
      "الداخل 48": 70,
      "طوباس": 20,
      "نابلس": 20,
      "رام الله والبيرة": 20,
      "سلفيت": 20,
      "طولكرم": 20,
      "قلقيلية": 20,
      "القدس داخل": 30,
      "اريحا": 20,
      "الخليل": 20,
      "جنين": 20,
      "بيت لحم": 20,
      "القدس أبو غوش": 45,
      "ضواحي القدس ضفة": 20,
    });
  });
});
