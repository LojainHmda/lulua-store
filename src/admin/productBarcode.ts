import type { AdminProduct } from "./types";

// Mirrors Catchy's productBarcodeValue(): an admin-entered manual override
// (reusing the existing optional `sku` field) or, when none is set, the
// product's own unique slug. Never separately generated or stored — every
// product has a valid, unique barcode value the instant it exists, with no
// migration ever required. Every one of the 221 existing products has an
// empty sku today, so this resolves to their slug automatically.
export function productBarcodeValue(product: Pick<AdminProduct, "sku" | "slug">): string {
  const manual = product.sku?.trim();
  return manual ? manual : product.slug;
}
