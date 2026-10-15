import { describe, expect, it } from "vitest";
import {
  buildCreateOrderPayload,
  deriveNumericReferenceId,
  DELIVERY_FEE_ON_CUSTOMER,
  DELIVERY_FEE_ON_SENDER,
  DELIVERY_ORDER_TYPE_ID,
  DELIVERY_ZONE_TO_UNITED_AREA,
  type DeliveryOrderInputOrder,
} from "../../src/admin/deliveryOrderMapping";
import type { OrderLine, PaymentMethod } from "../../src/admin/types";

function line(overrides: Partial<OrderLine> = {}): OrderLine {
  return { productId: "p1", variantId: "v1", name: "Blue Dress", qty: 1, price: 100, size: "M", color: "Blue", ...overrides };
}

function order(overrides: Partial<DeliveryOrderInputOrder> = {}): DeliveryOrderInputOrder {
  return {
    orderNumber: "SIS-100",
    customerName: "Jane Doe",
    customerPhone: "0599000000",
    shippingAddress: "Ramallah, test street",
    deliveryZoneId: "ramallah-albireh",
    deliveryZoneName: "Ramallah & Al-Bireh",
    notes: "leave at the door",
    total: 150,
    paymentMethod: undefined,
    lines: [line()],
    ...overrides,
  };
}

describe("buildCreateOrderPayload -- confirmed-source fields", () => {
  it("builds a complete payload when every field has a real source", () => {
    const result = buildCreateOrderPayload(order());
    expect(result.missing).toEqual([]);
    expect(result.payload).not.toBeNull();
  });

  it("never invents a value for customer_name when it's blank/whitespace-only", () => {
    const result = buildCreateOrderPayload(order({ customerName: "   " }));
    expect(result.payload).toBeNull();
    expect(result.missing).toContain("customer_name");
  });

  it("never invents a value for customer_mobile when order.customerPhone is unset", () => {
    const result = buildCreateOrderPayload(order({ customerPhone: undefined }));
    expect(result.payload).toBeNull();
    expect(result.missing).toContain("customer_mobile");
  });

  it("never invents a value for customer_address when order.shippingAddress is unset", () => {
    const result = buildCreateOrderPayload(order({ shippingAddress: undefined }));
    expect(result.payload).toBeNull();
    expect(result.missing).toContain("customer_address");
  });

  // The most realistic MISSING case: deliveryZoneId is only ever set for
  // web-checkout orders (per AdminOrder's own doc comment) -- absent on
  // every POS/manual order.
  it("reports customer_area as missing for a POS/manual order with no deliveryZoneId, rather than sending an empty/guessed value", () => {
    const result = buildCreateOrderPayload(order({ deliveryZoneId: undefined }));
    expect(result.payload).toBeNull();
    expect(result.missing).toContain("customer_area");
  });

  it("reports customer_area as missing for a zone id with no entry in the mapping table, rather than sending an empty/guessed value", () => {
    const result = buildCreateOrderPayload(order({ deliveryZoneId: "some-future-zone-not-yet-mapped" }));
    expect(result.payload).toBeNull();
    expect(result.missing).toContain("customer_area");
  });

  it("reports every missing field at once, not just the first one found", () => {
    const result = buildCreateOrderPayload(order({ customerPhone: undefined, shippingAddress: undefined, deliveryZoneId: undefined }));
    expect(result.payload).toBeNull();
    expect(result.missing.sort()).toEqual(["customer_address", "customer_area", "customer_mobile"]);
  });

  it("maps customer_name/customer_mobile/customer_address directly from the order", () => {
    const result = buildCreateOrderPayload(order());
    expect(result.payload?.customer_name).toBe("Jane Doe");
    expect(result.payload?.customer_mobile).toBe("0599000000");
    expect(result.payload?.customer_address).toBe("Ramallah, test street");
  });

  // 2026-09-30 architecture change: the browser never holds the real United
  // login/password at all (the Apps Script proxy injects them server-side
  // -- see deliveryOrder.ts/deliveryOrderConfig.ts). The payload this
  // module builds must never carry those fields, even accidentally.
  it("never includes login/password/db in the built payload", () => {
    const result = buildCreateOrderPayload(order());
    expect(result.payload).not.toHaveProperty("login");
    expect(result.payload).not.toHaveProperty("password");
    expect(result.payload).not.toHaveProperty("db");
  });

  // CONFIRMED LIVE 2026-09-30 against the real United test account:
  // customer_area/customer_sub_area must be United's own numeric area/
  // sub-area ids (from get_areas/get_sub_areas), never Sisely's free-text
  // zone name -- the old behavior (sending deliveryZoneName as-is) was
  // proven to fail against the real API.
  it("maps customer_area/customer_sub_area to United's real numeric area/sub-area ids, not Sisely's free-text zone name", () => {
    const result = buildCreateOrderPayload(order({ deliveryZoneId: "ramallah-albireh" }));
    const expected = DELIVERY_ZONE_TO_UNITED_AREA["ramallah-albireh"];
    expect(result.payload?.customer_area).toBe(expected.areaId);
    expect(result.payload?.customer_sub_area).toBe(expected.subAreaId);
    expect(result.payload?.customer_area).not.toBe("Ramallah & Al-Bireh");
  });

  it("covers every one of Sisely's current delivery zones with a real mapping entry", () => {
    const zoneIds = ["inside-48", "tubas", "nablus", "ramallah-albireh", "salfit", "tulkarm", "qalqilya", "jerusalem-inner", "jericho", "hebron", "jenin", "bethlehem", "jerusalem-abu-ghosh", "jerusalem-suburbs-wb"];
    for (const zoneId of zoneIds) {
      const result = buildCreateOrderPayload(order({ deliveryZoneId: zoneId }));
      expect(result.payload, `zone ${zoneId} should have a mapping`).not.toBeNull();
      expect(result.payload?.customer_area).toMatch(/^\d+$/);
      expect(result.payload?.customer_sub_area).toMatch(/^\d+$/);
    }
  });

  it("flags medium-confidence (Jerusalem-area) zone mappings as areaMappingConfidence: 'medium', not silently high", () => {
    const result = buildCreateOrderPayload(order({ deliveryZoneId: "jerusalem-inner" }));
    expect(result.areaMappingConfidence).toBe("medium");
  });

  it("reports high confidence for an exact-name-match zone", () => {
    const result = buildCreateOrderPayload(order({ deliveryZoneId: "nablus" }));
    expect(result.areaMappingConfidence).toBe("high");
  });
});

describe("deriveNumericReferenceId -- CONFIRMED LIVE 2026-09-30: United rejects a non-numeric reference_id", () => {
  it("produces a numeric-only string", () => {
    expect(deriveNumericReferenceId("SIS-100")).toMatch(/^\d+$/);
  });

  it("produces a string within United's confirmed 2-20 digit requirement", () => {
    const id = deriveNumericReferenceId("SIS-ABCDEFGH12345");
    expect(id.length).toBeGreaterThanOrEqual(2);
    expect(id.length).toBeLessThanOrEqual(20);
  });

  it("is deterministic -- the same orderNumber always derives the same reference_id (required for safe retry after a network failure)", () => {
    expect(deriveNumericReferenceId("SIS-XYZ789")).toBe(deriveNumericReferenceId("SIS-XYZ789"));
  });

  it("produces different ids for different order numbers", () => {
    expect(deriveNumericReferenceId("SIS-AAA111")).not.toBe(deriveNumericReferenceId("SIS-BBB222"));
  });
});

describe("buildCreateOrderPayload -- reference_id (duplicate-prevention field)", () => {
  it("sends a derived NUMERIC reference_id, never the raw (non-numeric) orderNumber", () => {
    const result = buildCreateOrderPayload(order({ orderNumber: "SIS-999" }));
    expect(result.payload?.reference_id).toBe(deriveNumericReferenceId("SIS-999"));
    expect(result.payload?.reference_id).toMatch(/^\d+$/);
  });

  it("the same order always produces the same reference_id across repeated calls (idempotent retry safety)", () => {
    const o = order({ orderNumber: "SIS-777" });
    const first = buildCreateOrderPayload(o).payload?.reference_id;
    const second = buildCreateOrderPayload(o).payload?.reference_id;
    expect(first).toBe(second);
  });
});

describe("buildCreateOrderPayload -- best-effort/flagged fields", () => {
  it("uses order.total for cost", () => {
    const result = buildCreateOrderPayload(order({ total: 275 }));
    expect(result.payload?.cost).toBe(275);
  });

  it("uses the configured order_type_id/delivery_fee constants, not a value derived from the order", () => {
    const result = buildCreateOrderPayload(order());
    expect(result.payload?.order_type_id).toBe(DELIVERY_ORDER_TYPE_ID);
    expect(result.payload?.delivery_fee_on_customer).toBe(DELIVERY_FEE_ON_CUSTOMER);
    expect(result.payload?.delivery_fee_on_sender).toBe(DELIVERY_FEE_ON_SENDER);
  });

  it("defaults paid to false when paymentMethod is unset (the normal case for a web order)", () => {
    const result = buildCreateOrderPayload(order({ paymentMethod: undefined }));
    expect(result.payload?.paid).toBe(false);
  });

  it("maps a POS cash sale's paymentMethod to paid:false", () => {
    const result = buildCreateOrderPayload(order({ paymentMethod: "cash" as PaymentMethod }));
    expect(result.payload?.paid).toBe(false);
  });

  it("maps a POS card/split sale's paymentMethod to paid:true", () => {
    expect(buildCreateOrderPayload(order({ paymentMethod: "card" as PaymentMethod })).payload?.paid).toBe(true);
    expect(buildCreateOrderPayload(order({ paymentMethod: "split" as PaymentMethod })).payload?.paid).toBe(true);
  });

  it("maps order.notes to note, trimmed, defaulting to an empty string when unset", () => {
    expect(buildCreateOrderPayload(order({ notes: "  fragile  " })).payload?.note).toBe("fragile");
    expect(buildCreateOrderPayload(order({ notes: undefined })).payload?.note).toBe("");
  });

  it("summarizes every order line into product_note as readable text, never dropping a line", () => {
    const result = buildCreateOrderPayload(
      order({ lines: [line({ name: "Blue Dress", qty: 2, color: "Blue", size: "M" }), line({ name: "Red Shoes", qty: 1, color: "Red", size: "40" })] })
    );
    expect(result.payload?.product_note).toBe("2x Blue Dress (Blue, M); 1x Red Shoes (Red, 40)");
  });

  it("does not mutate the input order", () => {
    const input = order();
    const copy = JSON.parse(JSON.stringify(input));
    buildCreateOrderPayload(input);
    expect(input).toEqual(copy);
  });
});
