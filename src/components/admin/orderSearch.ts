import type { AdminCategory, AdminOrder, AdminProduct, OrderStatus, PaymentMethod } from "../../admin/types";

// Bilingual synonyms for the handful of enum-like fields, so typing either
// language's word for "pending"/"cash"/"in-store" etc. matches regardless
// of which language the dashboard is currently displaying in.
// Includes both the current display label and prior wording still worth
// matching (a search for the old word shouldn't suddenly find nothing).
// Exported so the Sisely Assistant's intent parser (src/admin/assistant/
// intentParser.ts) can recognize a status word in a natural-language
// question using this exact same bilingual table, instead of maintaining a
// second, separate status-label list that could drift out of sync with it.
export const STATUS_LABELS: Record<OrderStatus, string[]> = {
  pending: ["pending", "awaiting preparation", "بانتظار التجهيز", "قيد الانتظار"],
  // "being prepared" is deliberately its own, longer phrase distinct from
  // "prepared" alone (see `ready` below) -- "the order is being prepared"
  // (in progress) and "the order is prepared" (done) mean opposite things
  // in English despite sharing a substring; callers matching status words
  // should prefer the longest matching phrase across all statuses so this
  // one wins over ready's shorter "prepared" for a sentence containing
  // "being prepared" (see intentParser.ts's extractStatus).
  processing: ["processing", "preparing", "being prepared", "جاري التحضير", "قيد المعالجة"],
  ready: ["ready", "prepared", "تم التجهيز", "تم تجهيزه", "جاهز"],
  shipped: ["shipped", "out for delivery", "بالطريق للتسليم", "بالطريق", "تم الشحن"],
  delivered: ["delivered", "تم التسليم", "تم تسليمه", "تم التوصيل"],
  cancelled: ["cancelled", "canceled", "تم الإلغاء", "ملغي"],
  refunded: ["refunded", "returned", "تم الإرجاع", "مرتجع", "مسترد"],
  completed: ["completed", "مكتمل"],
};

const SOURCE_LABELS: Record<"web" | "pos", string[]> = {
  web: ["website", "online", "web", "الموقع الإلكتروني", "اونلاين", "أونلاين"],
  pos: ["in-store", "in store", "pos", "store", "المتجر", "الفرع"],
};

const PAYMENT_LABELS: Record<PaymentMethod, string[]> = {
  cash: ["cash", "نقدا", "نقداً"],
  card: ["card", "بطاقة"],
  split: ["split", "مقسم", "مقسّم"],
};

// Arabic diacritics (tashkeel), U+064B-U+065F plus U+0670 (superscript alef)
const ARABIC_DIACRITICS_RE = /[ً-ٰٟ]/g;
// Alef variants (madda/hamza-above/hamza-below) -> bare alef U+0627
const ALEF_VARIANTS_RE = /[آأإ]/g;
const ALEF = "ا";
// Alef maksura U+0649 -> yeh U+064A
const ALEF_MAKSURA_RE = /ى/g;
const YEH = "ي";
// Teh marbuta U+0629 -> heh U+0647
const TEH_MARBUTA_RE = /ة/g;
const HEH = "ه";

// Search-friendly text normalization: case-folds, strips Arabic diacritics
// and unifies common letter-shape variants (alef forms, alef maksura, teh
// marbuta) so e.g. the several ways to write the same name normalize the
// same way, and collapses every run of punctuation/whitespace to a single
// space so capitalization, extra spaces, and dashes ("SIS-ABC123" vs "sis
// abc123") never prevent a match.
export function normalizeSearchText(input: string | undefined | null): string {
  if (!input) return "";
  return input
    .normalize("NFKC")
    .toLowerCase()
    .replace(ARABIC_DIACRITICS_RE, "")
    .replace(ALEF_VARIANTS_RE, ALEF)
    .replace(ALEF_MAKSURA_RE, YEH)
    .replace(TEH_MARBUTA_RE, HEH)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export interface ProductLookup {
  name: string;
  nameAr?: string;
  category: string;
}
export interface CategoryLookup {
  name: string;
  nameAr?: string;
}

export function buildProductLookup(products: AdminProduct[]): Map<string, ProductLookup> {
  const map = new Map<string, ProductLookup>();
  for (const p of products) map.set(p.id, { name: p.name, nameAr: p.nameAr, category: p.category });
  return map;
}

export function buildCategoryLookup(categories: AdminCategory[]): Map<string, CategoryLookup> {
  const map = new Map<string, CategoryLookup>();
  for (const c of categories) map.set(c.slug, { name: c.name, nameAr: c.nameAr });
  return map;
}

// One normalized "everything about this order" blob, built once per order
// (not per keystroke) so typing stays instant even with hundreds of
// orders: product names (including the live Arabic name and category,
// looked up by id — the order line itself only ever stores the English
// name it was sold under), customer name/email/phone, shipping address
// (the only place a city shows up — there's no separate city field),
// notes, order number, and bilingual status/source/payment labels.
export function buildOrderSearchBlob(
  order: AdminOrder,
  productLookup: Map<string, ProductLookup>,
  categoryLookup: Map<string, CategoryLookup>
): string {
  const parts: string[] = [
    order.orderNumber,
    order.customerName,
    order.customerEmail ?? "",
    order.customerPhone ?? "",
    order.shippingAddress ?? "",
    order.notes ?? "",
    ...STATUS_LABELS[order.status],
    ...SOURCE_LABELS[order.source === "pos" ? "pos" : "web"],
  ];
  if (order.paymentMethod) parts.push(...PAYMENT_LABELS[order.paymentMethod]);
  for (const line of order.lines) {
    parts.push(line.name, line.color, line.size);
    const product = productLookup.get(line.productId);
    if (product) {
      parts.push(product.name, product.nameAr ?? "");
      const category = categoryLookup.get(product.category);
      if (category) parts.push(category.name, category.nameAr ?? "");
    }
  }
  return normalizeSearchText(parts.filter(Boolean).join(" "));
}

// Every whitespace-separated word in the query must appear *somewhere* in
// the blob (as a substring, not requiring a word boundary — "jean" must
// match "jeans") — order-independent, so "jean maria" finds Maria's order
// for jeans regardless of which field each word actually came from.
export function matchesSearch(blob: string, query: string): boolean {
  const tokens = normalizeSearchText(query).split(" ").filter(Boolean);
  if (tokens.length === 0) return true;
  return tokens.every((tok) => blob.includes(tok));
}
