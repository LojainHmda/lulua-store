import { productBarcodeValue } from "./productBarcode";
import type { AdminProduct } from "./types";

// Shared by POS (Terminal.tsx) and the manual/off-site order flow
// (AddOrderItemModal.tsx) — extracted from Terminal.tsx so both scan
// entry points resolve a scanned code to a product the exact same way,
// rather than maintaining two copies of this matching logic.
//
// Two label formats reach this function:
//  - A QR label, which always encodes the product's storefront URL
//    (`/product/${slug}`) or a bare slug — resolved unconditionally by slug,
//    regardless of whether the product also has a barcode override.
//  - A printed CODE128 barcode label, which encodes productBarcodeValue()
//    (the product's manually-entered `sku`, or its slug when no sku is set)
//    — resolved by comparing the scanned text against that same derived
//    value, so a scan always matches whatever was actually printed. Slug
//    wins on a tie.
export function matchProductFromScan(products: AdminProduct[], scanned: string): AdminProduct | null {
  const raw = scanned.trim();
  let slug = raw;
  try {
    const url = new URL(scanned);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "product" && parts[1]) slug = parts[1];
  } catch {
    // not a URL — treat the raw scanned text as a slug or a barcode value
  }
  return products.find((p) => p.slug === slug) ?? products.find((p) => productBarcodeValue(p) === raw) ?? null;
}
