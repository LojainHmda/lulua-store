import type { DeliveryZone, ShippingSettingsDoc } from "../admin/types";

// Single source of truth for the settings/shipping figures used when that
// doc hasn't been written yet -- mirrors the exact "shared client + server"
// reasoning shippingDefaults.ts (now retired) established: both the
// checkout transaction and the admin Settings form read this same fallback,
// so they can never silently disagree about what an unconfigured project
// charges.
export const SHIPPING_DEFAULTS: ShippingSettingsDoc = {
  freeShippingThreshold: 500,
  returnWindowDays: 30,
};

// The old Sisley system's real, live-configured delivery cities/regions and
// fees (verified directly from its admin panel, see the delivery-fee audit
// -- NOT invented, estimated, or rounded). Used both to seed the real
// deliveryZones collection once and as the canonical reference list for
// tests. `id` values are new, stable, human-readable slugs (the old system
// had no equivalent stable id, only the Arabic display name) chosen so a
// future admin editing `name`/`nameAr` never has to worry about breaking
// existing orders' `deliveryZoneId` references.
export const DEFAULT_DELIVERY_ZONES: Omit<DeliveryZone, "createdAt" | "updatedAt">[] = [
  { id: "inside-48", name: "Inside 48", nameAr: "الداخل 48", fee: 70, active: true, sortOrder: 0 },
  { id: "tubas", name: "Tubas", nameAr: "طوباس", fee: 20, active: true, sortOrder: 1 },
  { id: "nablus", name: "Nablus", nameAr: "نابلس", fee: 20, active: true, sortOrder: 2 },
  { id: "ramallah-albireh", name: "Ramallah & Al-Bireh", nameAr: "رام الله والبيرة", fee: 20, active: true, sortOrder: 3 },
  { id: "salfit", name: "Salfit", nameAr: "سلفيت", fee: 20, active: true, sortOrder: 4 },
  { id: "tulkarm", name: "Tulkarm", nameAr: "طولكرم", fee: 20, active: true, sortOrder: 5 },
  { id: "qalqilya", name: "Qalqilya", nameAr: "قلقيلية", fee: 20, active: true, sortOrder: 6 },
  { id: "jerusalem-inner", name: "Jerusalem - Inner", nameAr: "القدس داخل", fee: 30, active: true, sortOrder: 7 },
  { id: "jericho", name: "Jericho", nameAr: "اريحا", fee: 20, active: true, sortOrder: 8 },
  { id: "hebron", name: "Hebron", nameAr: "الخليل", fee: 20, active: true, sortOrder: 9 },
  { id: "jenin", name: "Jenin", nameAr: "جنين", fee: 20, active: true, sortOrder: 10 },
  { id: "bethlehem", name: "Bethlehem", nameAr: "بيت لحم", fee: 20, active: true, sortOrder: 11 },
  { id: "jerusalem-abu-ghosh", name: "Jerusalem - Abu Ghosh", nameAr: "القدس أبو غوش", fee: 45, active: true, sortOrder: 12 },
  { id: "jerusalem-suburbs-wb", name: "Jerusalem Suburbs (West Bank side)", nameAr: "ضواحي القدس ضفة", fee: 20, active: true, sortOrder: 13 },
];

// Pure -- no Firestore reads. Both orderTransaction.ts (inside the checkout
// transaction, after reading the zone doc live) and Checkout.tsx (for the
// live price preview, after fetching the same zone client-side) call this
// so the two can never disagree about what a given zone+subtotal charges.
// Returns null when the fee genuinely cannot be determined (missing zone,
// inactive zone, or a corrupt/non-numeric fee) -- the caller must treat
// that as "reject, do not fall back to any other rate," never as 0.
export function resolveDeliveryFee(
  zone: Pick<DeliveryZone, "active" | "fee"> | undefined,
  subtotal: number,
  freeShippingThreshold: number
): number | null {
  if (subtotal >= freeShippingThreshold) return 0;
  if (!zone || zone.active !== true) return null;
  if (typeof zone.fee !== "number" || !Number.isFinite(zone.fee) || zone.fee < 0) return null;
  return zone.fee;
}
