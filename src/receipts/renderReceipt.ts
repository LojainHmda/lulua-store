import logoSrc from "../assets/logo.svg";
import { formatPrice } from "../utils/currency";

export interface ReceiptLine {
  name: string;
  color: string;
  size: string;
  qty: number;
  price: number;
  // Pre-resolved, ready-to-load URL (see resolveImageSrc in admin/imageSrc.ts)
  // — this module stays decoupled from how a product's image is actually
  // sourced (Storage URL vs. Unsplash id), it just draws whatever it's given.
  imageSrc?: string;
  // The product's existing barcode/SKU value (see admin/productBarcode.ts's
  // productBarcodeValue() — sku override or, more commonly, the product's
  // own slug) — resolved by the caller, since this module has no product
  // data of its own. Absent when the caller has none to offer (the
  // customer-facing storefront receipt) or the product has since been
  // deleted; the SKU line is simply omitted in that case, never a fabricated
  // placeholder value.
  sku?: string;
}

export interface ReceiptData {
  // Pre-rendered PNG data URLs, supplied by the caller -- this module never
  // generates a barcode or QR code itself (see the module-level comment
  // above buildOrderQrTargetUrl() for why: generating them here would pull
  // the jsbarcode/qrcode libraries into every consumer's bundle, including
  // the customer-facing storefront, which never needs either code). Both
  // are effectively admin-only in practice today: InvoiceModal.tsx builds
  // them (reusing useBarcodeImage.ts and the same QRCode.toDataURL() call
  // QrLabelModal.tsx already makes) and passes them through
  // orderToReceiptData(); the storefront's own OrderConfirmation.tsx/
  // AccountOrderDetail.tsx simply don't supply either, and this entire
  // section of the document is omitted for them, not left blank.
  orderBarcodeDataUrl?: string;
  orderQrDataUrl?: string;
  orderNumber: string;
  createdAt: Date;
  customerName: string;
  customerEmail?: string;
  customerPhone?: string;
  shippingAddress?: string;
  // Denormalized delivery zone name (see orderTransaction.ts) -- absent on
  // any order placed before this feature existed or on a POS sale (POS is
  // always zero-shipping and never assigns a zone), in which case this line
  // is simply omitted rather than showing a blank/placeholder value.
  deliveryZoneName?: string;
  deliveryZoneNameAr?: string;
  lines: ReceiptLine[];
  subtotal: number;
  discount?: number;
  shipping: number;
  total: number;
  source?: "web" | "pos";
  paymentMethod?: "cash" | "card" | "split";
  cashAmount?: number;
  cardAmount?: number;
  // POS only: "Branch · Register · Cashier" line under the order number.
  // Omitted entirely (no blank row) when absent -- web invoices never set it.
  storeLine?: string;
  // A refund receipt for an in-store return: orderNumber is then the return
  // number, line prices are what each line refunded, total is the refund and
  // the payment rows say how it was paid back. refundOf = the original
  // sale's number (absent for a return without a receipt).
  isRefund?: boolean;
  refundOf?: string;
  // Shown after "Discount", e.g. "manual 10%".
  discountNote?: string;
  // Made while the till was offline (printed under the store line).
  offline?: boolean;
  // Automatic promotions applied (POS), each with what it took off. `discount`
  // is then only the manual part.
  promotions?: { name: string; amount: number }[];
}

const PALETTE = {
  paper: "#fffefc",
  ink: "#1c1a17",
  inkSoft: "#6f6a62",
  inkFaint: "#a49d92",
  line: "#e4ddd0",
  wine: "#6e1e36",
};

const LABELS = {
  en: {
    receipt: "Receipt",
    invoice: "Invoice",
    order: "Order",
    date: "Date",
    billTo: "Bill to",
    item: "Item",
    price: "Price",
    subtotal: "Subtotal",
    discount: "Discount",
    shipping: "Shipping",
    total: "Total",
    payment: "Payment",
    cash: "Cash",
    card: "Card",
    split: "Split",
    sku: "SKU",
    refundReceipt: "Refund receipt",
    returnNo: "Return",
    originalSale: "Original sale",
    refundTotal: "Refund total",
    refundMethod: "Refunded to",
    offlineSale: "Offline sale — recorded when the till reconnected",
    thankYou: "Thank you for shopping with لؤلؤة.",
    dir: "ltr" as const,
    font: "'Archivo', 'Inter', sans-serif",
    fontBody: "'Inter', sans-serif",
  },
  ar: {
    receipt: "إيصال",
    invoice: "فاتورة",
    order: "الطلب",
    date: "التاريخ",
    billTo: "الفاتورة إلى",
    item: "المنتج",
    price: "السعر",
    subtotal: "المجموع الفرعي",
    discount: "الخصم",
    shipping: "الشحن",
    total: "الإجمالي",
    payment: "الدفع",
    cash: "نقداً",
    card: "بطاقة",
    split: "مختلط",
    sku: "رمز المنتج",
    refundReceipt: "إيصال استرجاع",
    returnNo: "مرتجع",
    originalSale: "البيع الأصلي",
    refundTotal: "إجمالي المسترد",
    refundMethod: "طريقة الاسترداد",
    offlineSale: "بيع دون اتصال — يُسجَّل عند عودة الاتصال",
    thankYou: "شكراً لتسوقك من لؤلؤة.",
    dir: "rtl" as const,
    font: "'Cairo', 'Tajawal', sans-serif",
    fontBody: "'Tajawal', 'Cairo', sans-serif",
  },
};

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // Every product thumbnail is cross-origin (Firebase Storage or Unsplash)
    // — without this, drawing it to the canvas taints it and toDataURL()
    // (download/print/preview all use it) throws instead of just that one
    // thumbnail failing. Harmless no-op for the same-origin logo below.
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function money(n: number): string {
  return formatPrice(n);
}

// Points at the ADMIN order page, not any customer-facing route -- the
// storefront's own order-confirmation/account pages only work from the
// exact browser session/account that placed the order (see
// OrderConfirmation.tsx's own comment on this), so they can't reliably be
// reached from a scan later, e.g. a phone camera scanning a printed slip
// pulled out of a package on a different device entirely. The admin page
// requires an authenticated owner/admin session to resolve into anything —
// the same "electronic copy" concept the old system's packing slip used,
// just gated behind a real login instead of a bare public URL. No customer
// PII is encoded: only Sisley's own internal Firestore document id, which
// is meaningless without that admin session.
//
// Lives here (rather than inline in InvoiceModal.tsx, its only caller) so
// it stays a plain, unit-tested pure function -- `origin` is passed in
// rather than read from window.location.origin internally, precisely so it
// needs no browser global to test. This module never calls it itself:
// generating the actual QR image is InvoiceModal.tsx's job (see
// ReceiptData.orderQrDataUrl's own comment for why the generation has to
// happen there, not here).
export function buildOrderQrTargetUrl(origin: string, orderId: string): string {
  return `${origin}/admin/orders/${orderId}`;
}

// Draws a small rounded-square product thumbnail at (x, y), falling back to
// a plain neutral square — same clip path either way — when there's no
// image, or it fails to load (broken URL, offline, CORS-blocked host).
// Never throws: a missing/broken product photo must never break the receipt.
async function drawThumbnail(ctx: CanvasRenderingContext2D, src: string | undefined, x: number, y: number, size: number) {
  const radius = 6;
  ctx.save();
  try {
    ctx.beginPath();
    ctx.roundRect(x, y, size, size, radius);
    ctx.clip();
    if (src) {
      const img = await loadImage(src);
      const coverScale = Math.max(size / img.width, size / img.height);
      const dw = img.width * coverScale;
      const dh = img.height * coverScale;
      ctx.drawImage(img, x + (size - dw) / 2, y + (size - dh) / 2, dw, dh);
    } else {
      ctx.fillStyle = PALETTE.line;
      ctx.fillRect(x, y, size, size);
    }
  } catch {
    ctx.fillStyle = PALETTE.line;
    ctx.fillRect(x, y, size, size);
  } finally {
    ctx.restore();
  }
}

export async function renderReceiptCanvas(data: ReceiptData, lang: "en" | "ar"): Promise<HTMLCanvasElement> {
  const t = LABELS[lang];
  const rtl = t.dir === "rtl";
  const width = 640;
  const padding = 40;
  // +16 over the original 64: room for a third, SKU line per item (added
  // below) -- reserved for every line regardless of whether that specific
  // line actually has a SKU, so the per-item height stays constant and
  // doesn't require a second, variable-height layout pass.
  const rowHeight = 80;
  const thumbSize = 44;
  const thumbGap = 14;
  const headerHeight = 150;
  const zoneLine = lang === "ar" && data.deliveryZoneNameAr ? data.deliveryZoneNameAr : data.deliveryZoneName;
  const metaHeight = 90 + (zoneLine ? 16 : 0);
  // Order barcode + QR row -- entirely omitted (zero height, not a blank
  // gap) when the caller supplied neither, which is always true for the
  // customer-facing storefront receipt today (see ReceiptData's own
  // comment on why generation is admin-only).
  const hasCodes = !!data.orderBarcodeDataUrl || !!data.orderQrDataUrl;
  const codesHeight = hasCodes ? 90 : 0;
  const tableHeaderHeight = 30;
  const paymentRows = data.paymentMethod ? (data.paymentMethod === "split" ? 3 : 1) : 0;
  const totalsHeight = 130 + paymentRows * 26 + (data.promotions?.length ?? 0) * 20;
  const footerHeight = 70;
  const storeLineHeight = (data.storeLine ? 20 : 0) + (data.isRefund && data.refundOf ? 20 : 0) + (data.offline ? 20 : 0);
  const height = headerHeight + storeLineHeight + metaHeight + codesHeight + tableHeaderHeight + data.lines.length * rowHeight + totalsHeight + footerHeight;

  const canvas = document.createElement("canvas");
  const scale = 2; // crisper output for download/print
  canvas.width = width * scale;
  canvas.height = height * scale;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(scale, scale);
  ctx.direction = t.dir;

  // Background
  ctx.fillStyle = PALETTE.paper;
  ctx.fillRect(0, 0, width, height);

  const leftEdge = rtl ? width - padding : padding;
  const rightEdge = rtl ? padding : width - padding;
  const startAlign: CanvasTextAlign = rtl ? "right" : "left";
  const endAlign: CanvasTextAlign = rtl ? "left" : "right";

  let y = padding;

  // Logo
  try {
    const logo = await loadImage(logoSrc);
    const logoH = 34;
    const logoW = (logo.width / logo.height) * logoH;
    ctx.drawImage(logo, rtl ? width - padding - logoW : padding, y, logoW, logoH);
  } catch {
    ctx.fillStyle = PALETTE.wine;
    ctx.font = `700 24px ${t.font}`;
    ctx.textAlign = startAlign;
    ctx.fillText("لؤلؤة", leftEdge, y + 24);
  }
  y += 60;

  ctx.fillStyle = PALETTE.ink;
  ctx.font = `700 22px ${t.font}`;
  ctx.textAlign = startAlign;
  ctx.fillText(data.isRefund ? t.refundReceipt : data.source === "pos" ? t.receipt : t.invoice, leftEdge, y);
  y += 30;

  ctx.fillStyle = PALETTE.inkSoft;
  ctx.font = `400 13px ${t.fontBody}`;
  ctx.fillText(`${data.isRefund ? t.returnNo : t.order} #${data.orderNumber}`, leftEdge, y);
  ctx.textAlign = endAlign;
  ctx.fillText(`${t.date}: ${data.createdAt.toLocaleDateString(lang === "ar" ? "ar" : "en-US", { year: "numeric", month: "short", day: "numeric" })}`, rightEdge, y);
  if (data.storeLine) {
    y += 20;
    ctx.textAlign = startAlign;
    ctx.fillText(data.storeLine, leftEdge, y);
  }
  if (data.isRefund && data.refundOf) {
    y += 20;
    ctx.textAlign = startAlign;
    ctx.fillText(`${t.originalSale} #${data.refundOf}`, leftEdge, y);
  }
  if (data.offline) {
    y += 20;
    ctx.textAlign = startAlign;
    ctx.fillText(t.offlineSale, leftEdge, y);
  }
  y += 30;

  ctx.strokeStyle = PALETTE.line;
  ctx.beginPath();
  ctx.moveTo(padding, y);
  ctx.lineTo(width - padding, y);
  ctx.stroke();
  y += 26;

  // Order barcode + QR -- both already-rendered PNGs by the time they reach
  // here (see ReceiptData's own comment on orderBarcodeDataUrl/
  // orderQrDataUrl for why this module never generates either itself).
  // Mirrors the per-line thumbnail's own "never let one missing/broken
  // image break the rest of the document" discipline.
  if (hasCodes) {
    const codesTop = y;
    const gap = 16;
    const qrSize = 64;
    const contentLeft = Math.min(leftEdge, rightEdge);
    const contentRight = Math.max(leftEdge, rightEdge);
    const hasQr = !!data.orderQrDataUrl;

    if (data.orderQrDataUrl) {
      // QR sits at the "start" edge (right side for RTL, left for LTR),
      // same start/end convention the line-item thumbnail below already
      // uses for its own image placement.
      const qrX = rtl ? contentRight - qrSize : contentLeft;
      try {
        const qrImg = await loadImage(data.orderQrDataUrl);
        ctx.drawImage(qrImg, qrX, codesTop, qrSize, qrSize);
      } catch {
        // Leave the space blank rather than a broken image -- never worth
        // failing the whole document over a QR that didn't load back.
      }
    }

    const barcodeAreaLeft = hasQr ? (rtl ? contentLeft : contentLeft + qrSize + gap) : contentLeft;
    const barcodeAreaRight = hasQr ? (rtl ? contentRight - qrSize - gap : contentRight) : contentRight;
    const barcodeMaxW = barcodeAreaRight - barcodeAreaLeft;
    if (data.orderBarcodeDataUrl) {
      try {
        const bcImg = await loadImage(data.orderBarcodeDataUrl);
        const scale = Math.min(barcodeMaxW / bcImg.width, qrSize / bcImg.height, 1);
        const dw = bcImg.width * scale;
        const dh = bcImg.height * scale;
        // Hugs the QR when both are present (visually one grouped unit);
        // otherwise centered across the full content width.
        const bx = hasQr ? (rtl ? barcodeAreaRight - dw : barcodeAreaLeft) : barcodeAreaLeft + (barcodeMaxW - dw) / 2;
        ctx.drawImage(bcImg, bx, codesTop + (qrSize - dh) / 2, dw, dh);
      } catch {
        // Same reasoning -- a failed barcode image never blocks the receipt.
      }
    }
    y += codesHeight;
  }

  // Bill to
  ctx.textAlign = startAlign;
  ctx.fillStyle = PALETTE.inkFaint;
  ctx.font = `600 11px ${t.fontBody}`;
  ctx.fillText(t.billTo.toUpperCase(), leftEdge, y);
  y += 20;
  ctx.fillStyle = PALETTE.ink;
  ctx.font = `600 14px ${t.fontBody}`;
  ctx.fillText(data.customerName || "—", leftEdge, y);
  y += 18;
  ctx.fillStyle = PALETTE.inkSoft;
  ctx.font = `400 12px ${t.fontBody}`;
  const contactLine = [data.customerEmail, data.customerPhone].filter(Boolean).join(" · ");
  if (contactLine) {
    ctx.fillText(contactLine, leftEdge, y);
    y += 16;
  }
  if (data.shippingAddress) {
    ctx.fillText(data.shippingAddress, leftEdge, y);
    y += 16;
  }
  if (zoneLine) {
    ctx.fillText(zoneLine, leftEdge, y);
    y += 16;
  }
  y += 14;

  ctx.strokeStyle = PALETTE.line;
  ctx.beginPath();
  ctx.moveTo(padding, y);
  ctx.lineTo(width - padding, y);
  ctx.stroke();
  y += 24;

  // Table header
  ctx.fillStyle = PALETTE.inkFaint;
  ctx.font = `600 11px ${t.fontBody}`;
  ctx.textAlign = startAlign;
  ctx.fillText(t.item.toUpperCase(), leftEdge, y);
  ctx.textAlign = endAlign;
  ctx.fillText(t.price.toUpperCase(), rightEdge, y);
  y += 22;

  // Line items — each gets a small product thumbnail on the start side
  // (rounded square, cover-cropped), with the name/detail text shifted
  // inward to make room for it. Price stays pinned to the far edge,
  // unaffected by the thumbnail.
  for (const line of data.lines) {
    const thumbX = rtl ? width - padding - thumbSize : padding;
    const thumbY = y - 14 + (rowHeight - thumbSize) / 2;
    await drawThumbnail(ctx, line.imageSrc, thumbX, thumbY, thumbSize);

    const textStart = rtl ? leftEdge - thumbSize - thumbGap : leftEdge + thumbSize + thumbGap;

    ctx.textAlign = startAlign;
    ctx.fillStyle = PALETTE.ink;
    ctx.font = `600 14px ${t.fontBody}`;
    ctx.fillText(line.name, textStart, y);
    ctx.textAlign = endAlign;
    ctx.font = `600 14px ${t.fontBody}`;
    ctx.fillText(money(line.price * line.qty), rightEdge, y);
    y += 18;
    ctx.textAlign = startAlign;
    ctx.fillStyle = PALETTE.inkFaint;
    ctx.font = `400 12px ${t.fontBody}`;
    ctx.fillText(`${line.color} · ${line.size} · ×${line.qty}`, textStart, y);
    y += 16;
    if (line.sku) {
      // SKU values (a slug or an admin-entered override) are Latin
      // text/digits/hyphens -- rendered with direction forced to ltr so
      // canvas's bidi text shaping never reorders/mirrors it inside an
      // Arabic-language receipt. textAlign is left/right (not start/end),
      // which canvas always treats as an absolute anchor regardless of
      // direction, so this keeps the exact same anchor point (textStart) the
      // line above it uses -- only the internal character shaping changes.
      ctx.direction = "ltr";
      ctx.textAlign = startAlign;
      ctx.fillText(`${t.sku}: ${line.sku}`, textStart, y);
      ctx.direction = t.dir;
    }
    y += rowHeight - 18 - 16;
  }

  ctx.strokeStyle = PALETTE.line;
  ctx.beginPath();
  ctx.moveTo(padding, y);
  ctx.lineTo(width - padding, y);
  ctx.stroke();
  y += 26;

  function totalsRow(label: string, value: string, bold = false) {
    ctx.textAlign = startAlign;
    ctx.fillStyle = bold ? PALETTE.ink : PALETTE.inkSoft;
    ctx.font = `${bold ? 700 : 400} ${bold ? 16 : 13}px ${t.fontBody}`;
    ctx.fillText(label, leftEdge, y);
    ctx.textAlign = endAlign;
    ctx.fillText(value, rightEdge, y);
    y += bold ? 26 : 20;
  }

  totalsRow(t.subtotal, money(data.subtotal));
  for (const promo of data.promotions ?? []) totalsRow(promo.name, `-${money(promo.amount)}`);
  if (data.discount) totalsRow(data.discountNote ? `${t.discount} (${data.discountNote})` : t.discount, `-${money(data.discount)}`);
  if (!data.isRefund) totalsRow(t.shipping, data.shipping === 0 ? "—" : money(data.shipping));
  y += 6;
  totalsRow(data.isRefund ? t.refundTotal : t.total, money(data.total), true);

  if (data.paymentMethod) {
    y += 8;
    const methodLabel = { cash: t.cash, card: t.card, split: t.split }[data.paymentMethod];
    totalsRow(data.isRefund ? t.refundMethod : t.payment, methodLabel);
    // Cash/card amounts are the portion of the total allocated to each
    // method, not the physical bill tendered (which this app never
    // records) — only worth showing when split, where the breakdown
    // itself is the useful part; for a plain cash/card sale it would
    // just repeat the total already shown above.
    if (data.paymentMethod === "split") {
      if (data.cashAmount) totalsRow(t.cash, money(data.cashAmount));
      if (data.cardAmount) totalsRow(t.card, money(data.cardAmount));
    }
  }

  y += 30;
  ctx.strokeStyle = PALETTE.line;
  ctx.beginPath();
  ctx.moveTo(padding, y);
  ctx.lineTo(width - padding, y);
  ctx.stroke();
  y += 30;

  ctx.textAlign = "center";
  ctx.fillStyle = PALETTE.wine;
  ctx.font = `600 13px ${t.font}`;
  ctx.fillText(t.thankYou, width / 2, y);

  return canvas;
}

export function downloadCanvas(canvas: HTMLCanvasElement, filename: string) {
  const a = document.createElement("a");
  a.href = canvas.toDataURL("image/png");
  a.download = filename;
  a.click();
}

const POPUP_BLOCKED_MESSAGE = "Please allow pop-ups for this site to print the receipt.";

// Returns false when the print window couldn't be opened — almost always a
// popup blocker. Callers that can render UI should pass onPopupBlocked to
// surface it in-app; without one this falls back to alert() so the Print
// button can never look like a dead button to the cashier.
export function printCanvas(canvas: HTMLCanvasElement, title: string, onPopupBlocked?: () => void): boolean {
  const dataUrl = canvas.toDataURL("image/png");
  const win = window.open("", "_blank", "width=480,height=720");
  if (!win) {
    if (onPopupBlocked) onPopupBlocked();
    else window.alert(POPUP_BLOCKED_MESSAGE);
    return false;
  }
  win.document.write(`
    <html>
      <head><title>${title}</title></head>
      <body style="margin:0; display:flex; justify-content:center; padding:24px;">
        <img src="${dataUrl}" style="width:100%; max-width:480px;" />
        <script>window.onload = () => { window.print(); };</script>
      </body>
    </html>
  `);
  win.document.close();
  return true;
}
