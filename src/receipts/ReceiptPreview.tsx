import { useEffect, useRef, useState } from "react";
import type { AdminOrder, PosReturn } from "../admin/types";
import { useLanguage } from "../context/LanguageContext";
import { unsplash } from "../utils/unsplash";
import { downloadCanvas, printCanvas, renderReceiptCanvas, type ReceiptData } from "./renderReceipt";

function toDate(value: unknown): Date {
  const ts = value as { toDate?: () => Date } | undefined;
  return ts?.toDate ? ts.toDate() : new Date();
}

// A local equivalent of admin/imageSrc.ts's resolveImageSrc() — this module
// is reachable from the customer-facing storefront (OrderConfirmation,
// account order history), which is deliberately kept free of anything under
// src/admin/ so shoppers who never visit /admin never fetch that bundle
// (see the same reasoning in firebase/config.ts for Auth/Storage).
function resolveLineImageSrc(item: { imageUrl?: string; imageId?: string }, width: number): string {
  if (item.imageUrl) return item.imageUrl;
  if (item.imageId) return unsplash(item.imageId, width, { w: 1, h: 1 });
  return "";
}

// `skuByProductId`/`orderBarcodeDataUrl`/`orderQrDataUrl` are all optional
// and supplied by the caller rather than computed inside this function --
// this module must stay free of any src/admin/ import AND of the
// jsbarcode/qrcode libraries, so the customer-facing storefront bundle
// (OrderConfirmation, AccountOrderDetail) never pulls any of them in.
// InvoiceModal.tsx (admin-only) is the one caller that builds all three
// today; the storefront callers simply omit them, and the printed
// document's SKU line and barcode/QR section don't render for them at all
// -- the correct behavior, since all three are internal/staff-facing
// details, not something a customer's own receipt needs.
// "Branch · Register · Cashier" for a branch POS sale; undefined otherwise
// (web/manual orders, and POS sales made before branches existed).
export function posStoreLine(o: { branchName?: string; registerName?: string; cashierName?: string }): string | undefined {
  if (!o.branchName) return undefined;
  return [o.branchName, o.registerName, o.cashierName].filter(Boolean).join(" · ");
}

export function orderToReceiptData(
  order: AdminOrder,
  skuByProductId?: Record<string, string>,
  orderBarcodeDataUrl?: string | null,
  orderQrDataUrl?: string | null
): ReceiptData {
  return {
    orderBarcodeDataUrl: orderBarcodeDataUrl ?? undefined,
    orderQrDataUrl: orderQrDataUrl ?? undefined,
    orderNumber: order.orderNumber,
    createdAt: toDate(order.createdAt),
    customerName: order.customerName,
    customerEmail: order.customerEmail || undefined,
    customerPhone: order.customerPhone,
    shippingAddress: order.shippingAddress,
    deliveryZoneName: order.deliveryZoneName,
    deliveryZoneNameAr: order.deliveryZoneNameAr,
    lines: order.lines.map((l) => ({
      name: l.name,
      color: l.color,
      size: l.size,
      qty: l.qty,
      price: l.price,
      imageSrc: resolveLineImageSrc(l, 120) || undefined,
      sku: skuByProductId?.[l.productId],
    })),
    subtotal: order.subtotal,
    // Promotions get their own rows; `discount` is then only the manual part.
    discount: order.promotions?.length ? (order.manualDiscount ?? 0) : order.discount,
    discountNote:
      order.discountSource === "manual" || order.discountSource === "mixed" ? ["manual", order.discountPercent ? `${order.discountPercent}%` : ""].filter(Boolean).join(" ") : undefined,
    promotions: order.promotions?.map((p) => ({ name: p.name, amount: p.amount })),
    shipping: order.shipping,
    total: order.total,
    source: order.source === "pos" ? "pos" : "web",
    paymentMethod: order.paymentMethod,
    cashAmount: order.cashAmount,
    cardAmount: order.cardAmount,
    storeLine: order.source === "pos" ? posStoreLine(order) : undefined,
  };
}

// Refund receipt for an in-store return (posReturn.ts). The barcode carries
// the return number, the way a sale receipt's carries the sale number.
export function posReturnToReceiptData(ret: PosReturn, barcodeDataUrl?: string | null): ReceiptData {
  return {
    orderBarcodeDataUrl: barcodeDataUrl ?? undefined,
    orderNumber: ret.returnNumber,
    createdAt: toDate(ret.createdAt),
    customerName: "Walk-in customer",
    lines: ret.lines.map((l) => ({ name: l.name, color: l.color, size: l.size, qty: l.qty, price: l.refund / l.qty })),
    subtotal: ret.refundTotal,
    shipping: 0,
    total: ret.refundTotal,
    source: "pos",
    paymentMethod: ret.refundMethod,
    cashAmount: ret.cashRefund,
    cardAmount: ret.cardRefund,
    storeLine: posStoreLine(ret),
    isRefund: true,
    refundOf: ret.orderNumber,
  };
}

export function ReceiptPreview({
  data,
  lang,
  orderNumber,
  onPopupBlocked,
}: {
  data: ReceiptData;
  lang: "en" | "ar";
  orderNumber: string;
  // Called when the print window is blocked, so the host screen can show the
  // failure inline. Omitted (e.g. from admin order detail) => alert() fallback.
  onPopupBlocked?: () => void;
}) {
  const { t } = useLanguage();
  const [imgSrc, setImgSrc] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setImgSrc(null);
    renderReceiptCanvas(data, lang).then((canvas) => {
      if (cancelled) return;
      canvasRef.current = canvas;
      setImgSrc(canvas.toDataURL("image/png"));
    });
    return () => {
      cancelled = true;
    };
  }, [data, lang]);

  const title = `${data.isRefund ? t("pos.returns.refundReceipt") : data.source === "pos" ? t("admin.receipt.receiptTitle") : t("admin.receipt.invoiceTitle")} ${orderNumber}`;

  return (
    <div className="flex flex-col items-center gap-4">
      {imgSrc ? (
        <img src={imgSrc} alt={title} className="max-h-[60vh] w-full max-w-sm rounded-lg border border-line object-contain" />
      ) : (
        <div className="flex h-64 w-full max-w-sm items-center justify-center rounded-lg border border-line">
          <span className="h-6 w-6 animate-spin rounded-full border-2 border-wine border-t-transparent" />
        </div>
      )}
      <div className="flex gap-2">
        <button
          disabled={!imgSrc}
          onClick={() => canvasRef.current && printCanvas(canvasRef.current, title, onPopupBlocked)}
          className="rounded-full border border-line px-5 py-2.5 text-sm font-semibold text-ink hover:bg-cream-dim disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t("admin.common.print")}
        </button>
        <button
          disabled={!imgSrc}
          onClick={() => canvasRef.current && downloadCanvas(canvasRef.current, `${orderNumber}.png`)}
          className="rounded-full bg-wine px-5 py-2.5 text-sm font-semibold text-on-accent hover:bg-wine-dark disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t("admin.common.download")}
        </button>
      </div>
    </div>
  );
}
