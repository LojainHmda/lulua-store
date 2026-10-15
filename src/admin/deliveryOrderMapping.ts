import type { AdminOrder, OrderLine } from "./types";

// Pure helper only — no Firestore access, no network access — mirroring the
// style of returnsHelpers.ts / orderStatusCounts.ts. Builds the request body
// for the delivery company's (Olivery, serving client "UnitedExp")
// `create_order` API from an existing Sisely order. The actual HTTP call
// lives in src/firebase/deliveryOrder.ts, which is the only caller of this
// module.
//
// ---------------------------------------------------------------------------
// SOURCE OF TRUTH (2026-09-30 update). The delivery company's own Postman
// documentation (https://documenter.getpostman.com/view/38773349/2sB3Wnv1sn)
// gives only one example request per endpoint, no field descriptions, and
// no saved response examples anywhere in the collection. Everything below
// marked "CONFIRMED LIVE" was verified against the real United TEST account
// (test orders + get_areas/get_sub_areas/order lookups — see
// migration/united-integration-2026-09-30/ for the raw, credential-redacted
// request/response artifacts). Real, load-bearing findings from that pass:
//   - The request must be sent as HTTP POST, even for endpoints the docs
//     label "GET" (get_areas/get_sub_areas) — a plain GET is rejected.
//   - `customer_area` alone is NOT enough. create_order requires BOTH a
//     top-level area id (from get_areas) AND a `customer_sub_area` id (from
//     get_sub_areas) — a field that appears in NEITHER the docs' example
//     request NOR any endpoint description. Omitting it fails with
//     "Field Receiver Sub Area is required."
//   - `customer_area`/`customer_sub_area` want the NUMERIC id from
//     get_areas/get_sub_areas, not a free-text name (the docs' own example,
//     `"customer_area": "المحافظات"`, does not correspond to any real area
//     and would fail).
//   - `reference_id` must be 2–20 DIGITS, numeric only. A real value like
//     Sisely's own `orderNumber` ("SIS-LX3F9A2B") is rejected outright:
//     "must be within 2 and 20 digits."
//   - On success, the response is
//     `{ code: 200, success: true, message: "Success Add", id: <number>,
//        Sequence: "UE...", Reference: "<echoed reference_id>",
//        "Delivery cost": <number> }`
//     — `id` is United's own numeric order id; `Sequence` (capitalized) is
//     the separate tracking/label number; "Delivery cost" is a
//     United-computed shipping fee, DISTINCT from the `cost` field sent in
//     the request (which is the COD amount to collect — confirmed via the
//     `/order` lookup endpoint, which echoes it back as
//     `money_collection_cost`).
//   - On failure: `{ code: <not 200>, fail: true, message: "..." }`.
//   - `order_type_id: "1"` was confirmed to mean "عادي" (Normal/Regular)
//     via the `/order` lookup endpoint.
// Every field below still belongs to one of three buckets, stated per field:
//   (a) CONFIRMED SOURCE — Sisely already has the exact data this field
//       needs, with no real ambiguity about which value to send.
//   (b) BEST-EFFORT / FLAGGED — Sisely has *a* value, sent anyway, but not
//       100% confirmed to be exactly what the field wants.
//   (c) MISSING — no Sisely data source exists at all. Never defaulted or
//       faked; if any (c)-bucket field would be required, the order is
//       reported as unable to build a request rather than sent incomplete.
// ---------------------------------------------------------------------------

// (c)-bucket business configuration -- there is no Sisely equivalent for
// ANY of these; they describe Sisely's own agreement/account with
// Olivery/UnitedExp, not anything about a specific order.
// CONFIRMED LIVE against the real United test account (2026-09-30):
// order_type_id="1" really does exist and maps to "عادي" (Normal).
export const DELIVERY_ORDER_TYPE_ID = "1";
export const DELIVERY_FEE_ON_CUSTOMER = false;
export const DELIVERY_FEE_ON_SENDER = false;

// Exact shape of the delivery company's create_order request body, per its
// own Postman example PLUS the real, undocumented `customer_sub_area`
// field discovered by live testing (2026-09-30) -- see the module comment
// above. Deliberately excludes `login`/`password`/`db`: since the
// 2026-09-30 Cloud Run proxy architecture (see deliveryOrder.ts /
// deliveryOrderConfig.ts), this app no longer holds the real United
// credentials at all -- the proxy injects them server-side from Secret
// Manager. Sending them from here would be both impossible (this
// app has no valid values for them) and pointless (the proxy ignores
// anything the caller sends for these fields, by design -- see Code.gs).
export interface CreateOrderParams {
  customer_address: string;
  customer_mobile: string;
  customer_area: string;
  customer_sub_area: string;
  customer_name: string;
  reference_id: string;
  cost: number;
  order_type_id: string;
  note: string;
  paid: boolean;
  delivery_fee_on_customer: boolean;
  delivery_fee_on_sender: boolean;
  product_note: string;
}

export type MissingDeliveryOrderField =
  | "customer_name"
  | "customer_mobile"
  | "customer_address"
  | "customer_area";

export interface DeliveryOrderPayloadResult {
  payload: CreateOrderParams | null;
  missing: MissingDeliveryOrderField[];
  // Non-blocking: set when the area mapping used is real but not a
  // guaranteed-exact match (see DELIVERY_ZONE_TO_UNITED_AREA below) -- the
  // order still builds and sends, but a human should double-check these
  // specific zones with United before trusting them blindly.
  areaMappingConfidence?: "high" | "medium";
}

export type DeliveryOrderInputOrder = Pick<
  AdminOrder,
  "orderNumber" | "customerName" | "customerPhone" | "shippingAddress" | "deliveryZoneName" | "deliveryZoneId" | "notes" | "total" | "paymentMethod" | "lines"
>;

// ---------------------------------------------------------------------------
// Sisely delivery zone -> United area/sub-area mapping.
//
// Built 2026-09-30 by cross-referencing Sisely's real 14 zones (see
// src/data/deliveryZones.ts's DEFAULT_DELIVERY_ZONES) against United's real,
// live get_areas (47 areas) and get_sub_areas responses from the test
// account (migration/united-integration-2026-09-30/get_areas-response.json,
// get_sub_areas-response.json). Sub-area chosen per zone is the sub-area
// whose own name exactly matches (or, for Qalqilya, most closely represents
// "the city center" of) the matched top-level area -- a reasonable default
// covering the city/region as a whole, not a specific neighborhood.
//
// "high" confidence = Sisely's zone name and United's area name match
// exactly (or are the same place under an unambiguous naming difference,
// e.g. "اريحا" both sides). "medium" = a real area exists and is the best
// available match, but the wording differs enough (all 4 are Jerusalem-area
// zones, where United's own area list has several overlapping "Jerusalem-
// ish" entries -- ضواحي القدس / القدس / مناطق القدس / ابو غوش-suburb
// variants) that a human familiar with United's actual delivery coverage
// should confirm before relying on it for real shipments.
export const DELIVERY_ZONE_TO_UNITED_AREA: Record<string, { areaId: string; areaName: string; subAreaId: string; subAreaName: string; confidence: "high" | "medium" }> = {
  "tubas": { areaId: "229", areaName: "طوباس", subAreaId: "7242", subAreaName: "طوباس", confidence: "high" },
  "nablus": { areaId: "227", areaName: "نابلس", subAreaId: "5850", subAreaName: "نابلس", confidence: "high" },
  "ramallah-albireh": { areaId: "231", areaName: "رام الله والبيرة", subAreaId: "6964", subAreaName: "رام الله والبيرة", confidence: "high" },
  "salfit": { areaId: "225", areaName: "سلفيت", subAreaId: "7246", subAreaName: "سلفيت", confidence: "high" },
  "tulkarm": { areaId: "228", areaName: "طولكرم", subAreaId: "5892", subAreaName: "طولكرم", confidence: "high" },
  "qalqilya": { areaId: "226", areaName: "قلقيلية", subAreaId: "5670", subAreaName: "مدينة قلقيلية", confidence: "high" },
  "jericho": { areaId: "224", areaName: "اريحا", subAreaId: "7263", subAreaName: "اريحا", confidence: "high" },
  "hebron": { areaId: "222", areaName: "الخليل", subAreaId: "6865", subAreaName: "الخليل", confidence: "high" },
  "jenin": { areaId: "230", areaName: "جنين", subAreaId: "6793", subAreaName: "جنين", confidence: "high" },
  "bethlehem": { areaId: "223", areaName: "بيت لحم", subAreaId: "6931", subAreaName: "بيت لحم", confidence: "high" },
  // MEDIUM CONFIDENCE -- Jerusalem-area zones. United's own area list has no
  // single obvious match for any of these four; best available real areas
  // picked, needs human confirmation with United before trusting blindly.
  "inside-48": { areaId: "219", areaName: "الداخل", subAreaId: "7258", subAreaName: "الداخل", confidence: "medium" },
  "jerusalem-inner": { areaId: "238", areaName: "القدس", subAreaId: "7254", subAreaName: "القدس", confidence: "medium" },
  "jerusalem-abu-ghosh": { areaId: "237", areaName: "ابو غوش", subAreaId: "6329", subAreaName: "ابو غوش", confidence: "medium" },
  "jerusalem-suburbs-wb": { areaId: "221", areaName: "ضواحي القدس", subAreaId: "6898", subAreaName: "ضواحي القدس", confidence: "medium" },
};

// One line per product line, e.g. "2x Blue Dress (Blue, M)" -- a compact,
// human-readable summary. There is no structured line-items field in this
// API at all (only this one free-text note), so anything beyond plain text
// would be silently dropped by the delivery company's system regardless.
function summarizeLinesForProductNote(lines: OrderLine[]): string {
  return lines.map((l) => `${l.qty}x ${l.name} (${l.color}, ${l.size})`).join("; ");
}

// CONFIRMED LIVE (2026-09-30): reference_id must be 2-20 numeric digits
// only. Derived deterministically from orderNumber (a simple 32-bit FNV-1a
// hash, formatted as a fixed 10-digit decimal string) so the SAME order
// always produces the SAME reference_id on every call/retry -- required for
// safe idempotency: a retry after a network failure (where United may have
// actually received and created the first attempt) must never generate a
// different reference_id, or a human reconciling orders against United's
// dashboard would have no way to tell two attempts were the same order.
export function deriveNumericReferenceId(orderNumber: string): string {
  let hash = 0x811c9dc5; // FNV-1a 32-bit offset basis
  for (let i = 0; i < orderNumber.length; i++) {
    hash ^= orderNumber.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0; // FNV prime, keep unsigned 32-bit
  }
  return String(hash).padStart(10, "0").slice(0, 10); // always exactly 10 digits, within the confirmed 2-20 range
}

// Builds the create_order request body for one Sisely order. Never invents
// a placeholder for a field with no real source -- see `missing` above.
export function buildCreateOrderPayload(order: DeliveryOrderInputOrder): DeliveryOrderPayloadResult {
  const missing: MissingDeliveryOrderField[] = [];

  // (a) CONFIRMED SOURCE -- direct fields, no ambiguity about which Sisely
  // value they mean.
  const customerName = order.customerName?.trim();
  if (!customerName) missing.push("customer_name");

  const customerMobile = order.customerPhone?.trim();
  if (!customerMobile) missing.push("customer_mobile");

  const customerAddress = order.shippingAddress?.trim();
  if (!customerAddress) missing.push("customer_address");

  // (a) CONFIRMED SOURCE, via the real mapping table above -- was (b)/(c)
  // before the 2026-09-30 live-testing pass (Sisely had only a free-text
  // zone name with no confirmed target format at all). order.deliveryZoneId
  // is set ONLY for web-checkout orders (never POS, never a manual/off-site
  // order -- see AdminOrder's own comment in types.ts), so it's genuinely
  // absent, not just low-confidence, on a large share of orders -- and any
  // zone not yet in DELIVERY_ZONE_TO_UNITED_AREA (there should be none,
  // since it covers all 14 current zones, but a future zone could be added
  // without updating this table) is treated as MISSING rather than guessed.
  const zoneMapping = order.deliveryZoneId ? DELIVERY_ZONE_TO_UNITED_AREA[order.deliveryZoneId] : undefined;
  if (!order.deliveryZoneId || !zoneMapping) missing.push("customer_area");

  if (missing.length > 0) return { payload: null, missing };

  return {
    missing: [],
    areaMappingConfidence: zoneMapping!.confidence,
    payload: {
      customer_address: customerAddress!,
      customer_mobile: customerMobile!,
      customer_area: zoneMapping!.areaId,
      customer_sub_area: zoneMapping!.subAreaId,
      customer_name: customerName!,
      reference_id: deriveNumericReferenceId(order.orderNumber),
      // CONFIRMED LIVE (2026-09-30, via the /order lookup endpoint): `cost`
      // is echoed back as `money_collection_cost` -- the COD amount to
      // collect from the customer. order.total (Sisely's own final charged
      // amount) is the correct value.
      cost: order.total,
      order_type_id: DELIVERY_ORDER_TYPE_ID,
      note: order.notes?.trim() ?? "",
      // order.paymentMethod is explicitly POS-only in this codebase (never
      // set for a web checkout, which is the actual source of the orders
      // this integration is for). With no signal at all for a web order,
      // this defaults to `false` (not yet paid / cash-on-delivery) rather
      // than `true` -- if this default is wrong, the failure mode is "courier
      // is told to still collect payment that was in fact already taken,"
      // which is the safer direction to be wrong in than the reverse
      // ("courier is told not to collect money that's actually still owed").
      paid: order.paymentMethod ? order.paymentMethod !== "cash" : false,
      delivery_fee_on_customer: DELIVERY_FEE_ON_CUSTOMER,
      delivery_fee_on_sender: DELIVERY_FEE_ON_SENDER,
      product_note: summarizeLinesForProductNote(order.lines),
    },
  };
}
