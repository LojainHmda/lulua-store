import JsBarcode from "jsbarcode";
import { useEffect, useState } from "react";

// Renders an arbitrary alphanumeric value to a scannable CODE128 barcode PNG
// (data URL), off-screen — mirrors Catchy's useBarcodeImage. CODE128 (unlike
// UPC/EAN) accepts arbitrary-length alphanumeric input, which is required
// since the encoded value is often a product slug, not a numeric UPC.
export function useBarcodeImage(value: string | null | undefined): string | null {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!value) {
      setDataUrl(null);
      return;
    }
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
      setDataUrl(canvas.toDataURL("image/png"));
    } catch {
      // Should not happen — CODE128 accepts effectively any input we ever
      // pass it (a slug or an admin-typed sku) — but fail quietly to the
      // existing "generating..." placeholder rather than crash the modal.
      setDataUrl(null);
    }
  }, [value]);

  return dataUrl;
}
