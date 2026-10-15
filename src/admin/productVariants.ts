import type { AdminColorVariant, AdminProduct, StockVariant } from "./types";

// ============================================================================
// Firestore storage shape (colorvariants-map-migration-plan-2026-09-22).
//
// A raw product document on disk can currently be in any of THREE shapes,
// and every read path in the app must keep working, unedited, across all
// three during and after the migration:
//
//  (a) NEW FLAT shape (the target of this migration): `colorVariants` is a
//      MAP keyed by variantId, holding only per-color METADATA (no stock
//      nested inside); a separate top-level `stockByCell` MAP, keyed by
//      the composite string "<variantId>::<size>", holds every stock
//      cell for the whole product. This is what lets Firestore Security
//      Rules validate a checkout decrement in cost proportional to how
//      many cells the checkout actually claims, independent of the
//      product's total color/size count — see
//      migration/colorvariants-map-migration-plan-2026-09-22/spike2/
//      SPIKE-REPORT-2.md for the full feasibility proof and exact rule
//      design this schema was built to support.
//  (b) OLD ARRAY shape (today's live shape, pre-migration): `colorVariants`
//      is an ARRAY, each element already carrying its own nested
//      `sizeStock` array — exactly AdminColorVariant[] as this module
//      has always defined it.
//  (c) LEGACY shape (the oldest documents, pre-dating the multi-variant
//      model entirely): no `colorVariants` field at all (or an empty
//      one) — a single implicit color described by top-level
//      colorName/colorHex/imageId/gallery/stock fields.
//
// joinProductFields() below is the ONE place that reads any of these three
// shapes and hands back the SAME in-memory AdminColorVariant[] shape the
// rest of this app has always used (sizeStock nested per variant, sorted
// so index 0 is reliably "the primary/first-listed color") — every other
// module (sellability, stock ledger, low-stock notifications, every admin
// screen, the storefront) keeps working completely unchanged against that
// array, whatever the document's real on-disk shape is. splitProductFields()
// / toStockByCell() below are the write-side mirror: given the SAME
// familiar array (after whatever in-memory edit a write path already
// makes), they produce the two flat Firestore fields to write back.
// ============================================================================

// The METADATA-only per-variant shape stored under the NEW flat
// `colorVariants` map — every AdminColorVariant field except `id` (the map
// key already is the id) and `sizeStock` (lives in `stockByCell` instead).
export interface FlatVariantMeta {
  colorName: string;
  colorNameAr?: string;
  colorHex: string;
  imageId?: string;
  imageUrl?: string;
  gallery?: string[];
  order: number;
}

// One stock cell under the NEW flat `stockByCell` map, keyed by
// "<variantId>::<size>". Identical fields to StockVariant minus `size`
// itself (already encoded in the key).
export interface FlatStockCell {
  qty: number | null;
  qtyUnknown?: boolean;
}

function cellKey(variantId: string, size: string): string {
  return `${variantId}::${size}`;
}

// Firestore's checkout security rules validate a stock decrement by
// structurally comparing a product's claimed stock cells against the
// live document, in a CEL expression with a hard 1000-expression-per-
// request ceiling (no loops/recursion exist in the rules language). This
// function used to gate the storefront/POS/admin UI on the OLD array
// schema's real cost cliff (cost scaled with a product's TOTAL color/size
// count, regardless of how much of it a given checkout actually touched) —
// see git history / migration/checkout-safe-limit-investigation-2026-09-22/
// investigation-report.md for the full original investigation, and
// migration/colorvariants-map-migration-plan-2026-09-22/ for the two
// feasibility spikes that designed and proved the fix.
//
// The approved, spike-2-proven flat `stockByCell` design (see
// firestore.rules' isValidStockDecrement/stockDecreaseMatchesClaimFlat)
// validates a checkout's cost in proportion to how many cells THAT
// checkout claims (bounded by the existing, unchanged 8-line checkout
// cap), never to the product's total color/size count. That cliff is
// gone — there is no longer any product-size/color-count ceiling to warn
// about, for any product using the new schema. This function is kept
// (rather than deleted, and rather than every call site being touched) so
// every existing caller — the storefront's checkoutUnavailable gate, the
// admin Product Form's warning banner, the admin Product List's badge,
// resolveSellability's checkout_unsafe reason — keeps working unchanged;
// it simply now always resolves to "sellable"/"no warning" instead of
// "hidden"/"warned", which is the intended, approved outcome of the
// completed migration.
export function exceedsCheckoutSafeLimit(_product: { colorVariants: { sizeStock: unknown[] }[] }): boolean {
  return false;
}

// Reads a raw Firestore document (any of the three shapes documented
// above) and returns the array of colors this product actually has,
// sorted so index 0 is reliably "the primary/first-listed color" —
// preserved via the `order` field for the new flat shape, or via the
// document's own existing array position for an old array-shaped
// document (which has no `order` field yet; using its current position as
// a fallback keeps today's visible order exactly as it is, unedited,
// until/unless that document is later saved through a write path that
// assigns real `order` values).
export function joinProductFields(raw: Record<string, unknown>): AdminColorVariant[] {
  const rawColorVariants = raw.colorVariants;

  // (b) OLD ARRAY shape.
  if (Array.isArray(rawColorVariants) && rawColorVariants.length > 0) {
    return (rawColorVariants as AdminColorVariant[]).map((v, i) => ({ ...v, order: v.order ?? i }));
  }

  // (a) NEW FLAT shape: colorVariants is a non-empty, non-array object.
  if (rawColorVariants && typeof rawColorVariants === "object" && !Array.isArray(rawColorVariants) && Object.keys(rawColorVariants).length > 0) {
    const metaByVariant = rawColorVariants as Record<string, FlatVariantMeta>;
    const rawStockByCell = raw.stockByCell;
    const stockByCell = (rawStockByCell && typeof rawStockByCell === "object" ? rawStockByCell : {}) as Record<string, FlatStockCell>;

    const variants: AdminColorVariant[] = Object.entries(metaByVariant).map(([variantId, meta], i) => {
      const prefix = `${variantId}::`;
      const sizeStock: StockVariant[] = Object.entries(stockByCell)
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, cell]) => ({ size: key.slice(prefix.length), qty: cell.qty, qtyUnknown: cell.qtyUnknown }));

      return {
        id: variantId,
        colorName: meta.colorName ?? "",
        colorNameAr: meta.colorNameAr,
        colorHex: meta.colorHex ?? "#1c1a17",
        imageId: meta.imageId,
        imageUrl: meta.imageUrl,
        gallery: meta.gallery,
        order: meta.order ?? i,
        sizeStock,
      };
    });

    return variants.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
  }

  // (c) LEGACY shape — identical fold-in normalizeProduct() has always done.
  const legacy = raw as Partial<AdminProduct>;
  return [
    {
      id: "default",
      colorName: legacy.colorName ?? "",
      colorNameAr: legacy.colorNameAr,
      colorHex: legacy.colorHex ?? "#1c1a17",
      imageId: legacy.imageId,
      imageUrl: legacy.imageUrl,
      gallery: legacy.gallery,
      order: 0,
      sizeStock: legacy.stock ?? (Array.isArray(legacy.sizes) ? legacy.sizes.map((size) => ({ size, qty: 0 })) : []),
    },
  ];
}

// The write-side mirror of joinProductFields(): given the SAME familiar
// AdminColorVariant[] a write path has already computed (by editing a
// copy of whatever normalizeProduct()/joinProductFields() handed it —
// every existing write path's own in-memory logic is completely
// unchanged), produces the two flat Firestore fields to write back.
export function splitProductFields(variants: AdminColorVariant[]): { colorVariants: Record<string, FlatVariantMeta>; stockByCell: Record<string, FlatStockCell> } {
  const colorVariants: Record<string, FlatVariantMeta> = {};
  variants.forEach((v, i) => {
    colorVariants[v.id] = {
      colorName: v.colorName,
      colorNameAr: v.colorNameAr,
      colorHex: v.colorHex,
      imageId: v.imageId,
      imageUrl: v.imageUrl,
      gallery: v.gallery,
      order: v.order ?? i,
    };
  });
  return { colorVariants, stockByCell: toStockByCell(variants) };
}

// The stock-only half of splitProductFields() — for the many write paths
// (checkout/POS, admin order-line edits, cancellation restoration, return
// resolution, Inventory's manual edit) that only ever change quantities,
// never a color's metadata. Writing ONLY `stockByCell` from these paths
// (never touching `colorVariants` at all) is what lets the checkout path
// specifically satisfy firestore.rules' isValidStockDecrement flat-branch
// requirement that a customer/POS write touch `stockByCell` and nothing
// else — see SPIKE-REPORT-2.md section 1 ("colorVariants metadata is
// frozen during checkout by construction").
export function toStockByCell(variants: AdminColorVariant[]): Record<string, FlatStockCell> {
  const out: Record<string, FlatStockCell> = {};
  for (const v of variants) {
    for (const s of v.sizeStock) {
      out[cellKey(v.id, s.size)] = { qty: s.qty, qtyUnknown: s.qtyUnknown };
    }
  }
  return out;
}

// Folds a legacy/old-shaped document into today's normalized
// AdminColorVariant[] shape (via joinProductFields, see its own doc
// comment for the three shapes handled), so every admin/checkout/POS read
// path keeps working unedited across old array-shaped, new flat-shaped,
// and pre-colorVariants legacy documents alike. Every read path should
// call this before displaying/editing a product.
export function normalizeProduct(raw: AdminProduct): AdminProduct {
  return { ...raw, colorVariants: joinProductFields(raw as unknown as Record<string, unknown>) };
}

// existingIds guards against a genuine (if rare) collision: under the OLD
// array schema a colliding id only caused an ambiguous `.find()` (confusing
// but harmless, first match wins); under the NEW flat schema a colliding
// id would be silent data loss (a second variant's map entry overwriting
// the first's). Regenerates up to 20 times against the product's actual
// current sibling ids before falling back to a longer, still-random tail
// that cannot practically collide.
export function newVariantId(colorName: string, existingIds: string[] = []): string {
  const base = colorName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  const existing = new Set(existingIds);
  for (let attempt = 0; attempt < 20; attempt++) {
    const suffix = Math.random().toString(36).slice(2, 7);
    const candidate = base ? `${base}-${suffix}` : suffix;
    if (!existing.has(candidate)) return candidate;
  }
  return `${base || "color"}-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

export function emptyVariant(sizes: string[], existingIds: string[] = [], order = 0): AdminColorVariant {
  return {
    id: newVariantId("color", existingIds),
    colorName: "",
    colorHex: "#1c1a17",
    order,
    sizeStock: sizes.map((size) => ({ size, qty: 0 })),
  };
}

// Sums only KNOWN quantities — never guesses a number for an unknown size,
// so this is always a safe floor (real stock is >= this), never an
// overcount. Pair with hasUnknownStock()/countUnknownStock() before
// presenting this as if it were the complete total.
export function totalStock(product: AdminProduct): number {
  return product.colorVariants.reduce((sum, v) => sum + v.sizeStock.reduce((s, x) => s + (x.qty ?? 0), 0), 0);
}

export function hasUnknownStock(product: AdminProduct): boolean {
  return product.colorVariants.some((v) => v.sizeStock.some((s) => s.qty === null));
}

export function countUnknownStock(product: AdminProduct): number {
  return product.colorVariants.reduce((sum, v) => sum + v.sizeStock.filter((s) => s.qty === null).length, 0);
}

export function unionSizes(variants: AdminColorVariant[]): string[] {
  const set = new Set<string>();
  variants.forEach((v) => v.sizeStock.forEach((s) => set.add(s.size)));
  return [...set];
}

export function resizeVariantStock(variant: AdminColorVariant, sizes: string[]): StockVariant[] {
  return sizes.map((size) => variant.sizeStock.find((s) => s.size === size) ?? { size, qty: 0 });
}

// The size options the admin product forms offer. Apparel sizes are the
// original set; the numeric shoe sizes are the ones imported products
// already use (34-42), so those products can be created/edited too.
export const APPAREL_SIZES = ["XS", "S", "M", "L", "XL", "One Size"];
export const SHOE_SIZES = ["34", "35", "36", "37", "38", "39", "40", "41", "42"];
export const SIZE_OPTIONS = [...APPAREL_SIZES, ...SHOE_SIZES];

// Orders sizes as they appear in SIZE_OPTIONS; any size outside it keeps its
// original relative position after the known ones.
export function sortSizes(sizes: string[]): string[] {
  const rank = (s: string) => {
    const i = SIZE_OPTIONS.indexOf(s);
    return i === -1 ? SIZE_OPTIONS.length : i;
  };
  return sizes.map((s, i) => ({ s, i })).sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i).map((x) => x.s);
}

export function stockCellKey(variantId: string, size: string): string {
  return `${variantId}::${size}`;
}

// UI-display concern only -- never changes what gets saved. emptyVariant()
// above still seeds every new size at a real, confirmed qty: 0 (unchanged;
// resolveSellability's out_of_stock/anyUnconfirmed logic depends on that
// staying a real 0, not becoming null/"unconfirmed" -- a never-stocked
// brand-new product must still read as out_of_stock, not sellable).
//
// What DOES change: a freshly-added, never-touched size cell (one that
// didn't exist when this product was first loaded, and that the admin
// hasn't typed into yet this session) should LOOK empty rather than
// showing a "0" the admin has to delete first -- see the numeric-input UX
// fix report. This function is the single source of truth for that
// display decision, so ProductForm.tsx never has to reason about it inline.
//
// A cell stops qualifying the moment either the admin explicitly edits it
// (touchedCells, tracked regardless of what they typed -- including
// re-typing 0 on purpose) or it turns out to already have existed before
// this session (initialCellKeys) -- both cases must always show the real
// "0", per the three-state stock contract (null=unknown, 0=confirmed
// empty, N=confirmed count) this function must never blur.
export function shouldDisplayNewStockCellAsBlank(
  qty: number | null,
  variantId: string,
  size: string,
  initialCellKeys: ReadonlySet<string>,
  touchedCells: ReadonlySet<string>
): boolean {
  if (qty !== 0) return false; // only ever overrides a confirmed-0 display; null already displays blank on its own
  const key = stockCellKey(variantId, size);
  return !initialCellKeys.has(key) && !touchedCells.has(key);
}
