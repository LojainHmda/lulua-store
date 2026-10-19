import JsBarcode from "jsbarcode";
import { useEffect, useState } from "react";

// Renders an arbitrary alphanumeric value to a scannable CODE128 barcode PNG
// (data URL), off-screen. null if it can't be drawn. Used directly where the
// image is needed right away (a POS receipt printed straight after a sale).
export function barcodeDataUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const canvas = document.createElement("canvas");
  try {
    JsBarcode(canvas, value, {
      format: "CODE128",
      width: 2,
      height: 90,
      displayValue: true,
      fontSize: 14,
      margin: 12,
    });
    return canvas.toDataURL("image/png");
  } catch {
    // Should not happen — CODE128 accepts effectively any input we ever
    // pass it (a slug or an admin-typed sku) — but fail quietly to the
    // existing "generating..." placeholder rather than crash the modal.
    return null;
  }
}

// Same, as a hook — mirrors Catchy's useBarcodeImage. CODE128 (unlike
// UPC/EAN) accepts arbitrary-length alphanumeric input, which is required
// since the encoded value is often a product slug, not a numeric UPC.
export function useBarcodeImage(value: string | null | undefined): string | null {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    setDataUrl(barcodeDataUrl(value));
  }, [value]);

  return dataUrl;
}
