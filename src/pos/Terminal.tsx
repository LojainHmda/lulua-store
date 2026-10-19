import { collection, doc, onSnapshot, query, where } from "../db/firestore";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAdminAuth } from "../admin/AdminAuthContext";
import AdminIcon from "../admin/components/AdminIcons";
import { ConfirmDialog, Modal } from "../admin/components/Modal";
import { resolveImageSrc } from "../admin/imageSrc";
import { logActivity } from "../admin/logActivity";
import { normalizeProduct, totalStock } from "../admin/productVariants";
import { matchProductFromScan } from "../admin/scanProductMatch";
import type { AdminCategory, AdminProduct, Branch, BranchStockDoc, HeldSale, PaymentMethod, PosDiscountPolicyDoc, RegisterSession } from "../admin/types";
import { useLanguage } from "../context/LanguageContext";
import { subtreeSlugs, visibleCategories } from "../data/categoryTree";
import { localizedName } from "../data/localize";
import { isSellable, resolveSellability } from "../data/sellability";
import { subscribeBranchStock, withBranchStock } from "../firebase/branchStock";
import { branchesApi, categoriesApi } from "../firebase/collections";
import { db } from "../firebase/config";
import { MAX_CHECKOUT_LINES, placeOrder, PlaceOrderError, PromotionsChangedError } from "../firebase/orderTransaction";
import { posStoreLine, ReceiptPreview } from "../receipts/ReceiptPreview";
import type { ReceiptData } from "../receipts/renderReceipt";
import { CameraScannerModal } from "./CameraScannerModal";
import { CategoryRail, tintStyle, useCategoryColors, useSubtreeCounts } from "./CategoryBrowser";
import { resolveCategoryIcon } from "../components/ui/CategoryIcons";
import { ProductPicker, type PickedLine } from "./ProductPicker";
import { useBarcodeScanner } from "./useBarcodeScanner";
import { useOffline } from "./offline/OfflineContext";
import { pendingQtyByCell } from "./offline/offlineStore";
import { formatPrice } from "../utils/currency";
import { NumberInput, type NumericValue } from "../components/ui/NumberInput";
import { barcodeDataUrl } from "../hooks/useBarcodeImage";
import { discountNote, manualDiscount, POS_DISCOUNT_POLICY_DEFAULTS, type ManualDiscountMode } from "../admin/posDiscounts";
import { subscribeSingletonDoc } from "../firebase/firestore";
import { discardHeldSale, HeldSaleError, heldSaleExpired, holdSale, resumeHeldSale, subscribeHeldSales } from "../firebase/heldSales";
import { applyPromotions, promotionHints, toPromotionDef, type PromotionDef } from "../data/promotions";

type CartLine = PickedLine & { key: string };

// Remembered per device: a till that habitually rings big baskets keeps the
// sale panel wide.
const SALE_EXPANDED_KEY = "lulua-pos-sale-expanded";
const CART_KEY_PREFIX = "lulua-pos-cart:";

function lineKey(productId: string, variantId: string, size: string): string {
  return `${productId}::${variantId}::${size}`;
}

// Quick-tender amounts for a cash sale: the exact total plus the next few
// "round" amounts a customer is likely to hand over.
function quickCashAmounts(total: number): number[] {
  const out = new Set<number>([Math.round(total * 100) / 100]);
  for (const step of [10, 20, 50, 100, 200]) {
    const v = Math.ceil(total / step) * step;
    if (v > total) out.add(v);
    if (out.size >= 5) break;
  }
  return [...out].sort((a, b) => a - b);
}

export default function Terminal({ session, onSessionUpdate }: { session: RegisterSession; onSessionUpdate: () => void }) {
  const { profile, hasRole } = useAdminAuth();
  const [products, setProducts] = useState<AdminProduct[]>([]);
  const [categories, setCategories] = useState<AdminCategory[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchStock, setBranchStock] = useState<Map<string, BranchStockDoc>>(new Map());
  const [search, setSearch] = useState("");
  // Category rail selection: the doc id of the category whose products are
  // listed (everything under it), null = all products.
  const [categoryId, setCategoryId] = useState<string | null>(null);
  // The unfinished sale survives switching to Returns / Today's sales and
  // back (this screen unmounts) and a page refresh: kept per shift in this
  // tab's sessionStorage. Prices/stock are re-checked when the sale completes.
  const cartKey = `${CART_KEY_PREFIX}${session.id}`;
  const [cart, setCart] = useState<CartLine[]>(() => {
    try {
      const saved = JSON.parse(window.sessionStorage.getItem(cartKey) ?? "[]");
      return Array.isArray(saved) ? (saved as CartLine[]) : [];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    try {
      if (cart.length > 0) window.sessionStorage.setItem(cartKey, JSON.stringify(cart));
      else window.sessionStorage.removeItem(cartKey);
    } catch {
      // Storage unavailable: the cart just isn't kept across screens.
    }
  }, [cart, cartKey]);
  const [pickerProduct, setPickerProduct] = useState<AdminProduct | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scanMessage, setScanMessage] = useState<string | null>(null);
  const [discountInput, setDiscountInput] = useState<NumericValue>(null);
  // Manual discount entered as a percentage of the sale or a ₪ amount.
  const [discountMode, setDiscountMode] = useState<ManualDiscountMode>("percent");
  const [discountPolicy, setDiscountPolicy] = useState<PosDiscountPolicyDoc>(POS_DISCOUNT_POLICY_DEFAULTS);
  const [paying, setPaying] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("cash");
  const [cashTendered, setCashTendered] = useState<NumericValue>(null);
  const [splitCard, setSplitCard] = useState<NumericValue>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{ orderNumber: string; data: ReceiptData; paid: number; change: number; offline?: boolean } | null>(null);
  const [printBlocked, setPrintBlocked] = useState(false);
  const [cartOpen, setCartOpen] = useState(false);
  const [saleExpanded, setSaleExpanded] = useState(() => {
    try {
      return window.localStorage.getItem(SALE_EXPANDED_KEY) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(SALE_EXPANDED_KEY, saleExpanded ? "1" : "0");
    } catch {
      // Storage unavailable: the choice just isn't remembered.
    }
  }, [saleExpanded]);

  // Full-screen sale: the sale takes over the whole till area (under the
  // header) -- for reviewing a big basket with the customer. Session-only,
  // never remembered: the till should always come back with its products.
  const [saleFull, setSaleFull] = useState(false);
  useEffect(() => {
    if (!saleFull || paying) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setSaleFull(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saleFull, paying]);
  // Esc backs out of the payment dialog (but not mid-submit).
  useEffect(() => {
    if (!paying || submitting) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setPaying(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paying, submitting]);
  // One-row line layout (stepper inline) whenever the panel is wide.
  const wideRows = saleExpanded || saleFull;
  // Keeps content at a readable width while the panel spans the screen.
  const fullPad = saleFull ? "md:px-[max(0.75rem,calc((100%-56rem)/2))]" : "";
  const [discountOpen, setDiscountOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const { lang, t } = useLanguage();

  // A session opened on a branch register sells from that branch's stock.
  // (A session from before branches existed keeps selling online stock.)
  const branchId = session.branchId;
  // Manual discounts: owner/admin without limit; a cashier up to the
  // configured % of the sale (settings/posDiscounts; 0 = not allowed). The
  // rules enforce the same limit on the sale itself.
  useEffect(() => subscribeSingletonDoc<PosDiscountPolicyDoc>("settings", "posDiscounts", (d) => setDiscountPolicy({ ...POS_DISCOUNT_POLICY_DEFAULTS, ...d })), []);

  // Automatic promotions (Admin → Discounts → Promotions), live. The clock
  // ticks each minute so a promotion starts/ends on an open till too.
  const [promotions, setPromotions] = useState<PromotionDef[]>([]);
  const [promoClock, setPromoClock] = useState(() => Date.now());
  useEffect(() => {
    const unsub = onSnapshot(
      query(collection(db, "promotions"), where("active", "==", true)),
      (snap) => setPromotions(snap.docs.map((d) => toPromotionDef(d.id, d.data()))),
      () => setPromotions([])
    );
    const timer = setInterval(() => setPromoClock(Date.now()), 60_000);
    return () => {
      unsub();
      clearInterval(timer);
    };
  }, []);
  const maxDiscountPercent = hasRole(["owner", "admin"]) ? 100 : discountPolicy.cashierMaxPercent;
  const canDiscount = maxDiscountPercent > 0;

  useEffect(() => {
    const unsub = onSnapshot(query(collection(db, "products"), where("status", "==", "active")), (snap) => {
      setProducts(snap.docs.map((d) => normalizeProduct({ id: d.id, ...d.data() } as AdminProduct)));
    });
    return unsub;
  }, []);

  useEffect(() => {
    branchesApi.list().then(setBranches).catch(() => setBranches([]));
    // Live, so an admin's category edits (new, renamed, reordered,
    // deactivated) reach an open till without a reload.
    return categoriesApi.subscribe(setCategories);
  }, []);

  // Only active categories (under active parents) are offered at the till.
  const tillCategories = useMemo(() => visibleCategories(categories), [categories]);
  // The product grid always lists products: those under the selected
  // category (all of them when none is selected), narrowed by any search.
  const categorySlugs = useMemo(() => (categoryId ? subtreeSlugs(tillCategories, categoryId) : null), [tillCategories, categoryId]);

  // A category that gets deactivated/deleted while selected sends the till
  // back to all products rather than leaving an empty, unexplained grid.
  useEffect(() => {
    if (categoryId && !tillCategories.some((c) => c.id === categoryId)) setCategoryId(null);
  }, [tillCategories, categoryId]);

  useEffect(() => {
    if (!branchId) return;
    return subscribeBranchStock(branchId, setBranchStock);
  }, [branchId]);

  // Products as this till sees them: with this branch's own counts.
  // Offline sales not sent yet already took their units: the till shows the
  // branch stock minus those, so it never sells the same units twice.
  const { online, markOffline, addPending, sales: offlineSales } = useOffline();
  const pendingByCell = useMemo(() => pendingQtyByCell(offlineSales, branchId), [offlineSales, branchId]);
  const tillProducts = useMemo(
    () =>
      branchId
        ? products.map((p) => {
            const withStock = withBranchStock(p, branchStock.get(p.id));
            if (pendingByCell.size === 0) return withStock;
            return {
              ...withStock,
              colorVariants: withStock.colorVariants.map((v) => ({
                ...v,
                sizeStock: v.sizeStock.map((s) => (s.qty === null ? s : { ...s, qty: s.qty - (pendingByCell.get(`${p.id}::${v.id}::${s.size}`) ?? 0) })),
              })),
            };
          })
        : products,
    [products, branchStock, branchId, pendingByCell]
  );

  // The one sellability rule (src/data/sellability.ts), shared with the
  // storefront and the admin "Unsellable Products" page. On a branch till,
  // a product that is merely out of stock HERE stays listed (dimmed) so the
  // cashier can still open it and see which other branch has it; anything
  // unsellable for another reason (inactive, incomplete, too many variants)
  // is left out entirely, same as before.
  const listedProducts = useMemo(
    () =>
      branchId
        ? tillProducts.filter((p) => resolveSellability(p).reasons.every((r) => r.code === "out_of_stock"))
        : tillProducts.filter(isSellable),
    [tillProducts, branchId]
  );

  // Listed products per category slug, for the counts on category tiles.
  const categoryCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of listedProducts) m.set(p.category, (m.get(p.category) ?? 0) + 1);
    return m;
  }, [listedProducts]);
  const subtreeCounts = useSubtreeCounts(tillCategories, categoryCounts);
  const categoryColors = useCategoryColors(tillCategories);
  const categoryBySlug = useMemo(() => new Map(tillCategories.map((c) => [c.slug, c])), [tillCategories]);

  // Category + search first; the stock filter (branch tills only) is applied
  // on top, so each filter chip can show how many products it would list.
  const searched = useMemo(() => {
    const q = search.trim().toLowerCase();
    return listedProducts.filter((p) => {
      if (categorySlugs && !categorySlugs.has(p.category)) return false;
      if (
        q &&
        !p.name.toLowerCase().includes(q) &&
        !p.nameAr?.toLowerCase().includes(q) &&
        !p.sku?.toLowerCase().includes(q) &&
        !p.slug.toLowerCase().includes(q)
      )
        return false;
      return true;
    });
  }, [listedProducts, search, categorySlugs]);

  // Every product is listed; at a branch till, items with none here go last
  // (still shown, faded with a "none here" badge, so the cashier can check
  // other branches).
  const filtered = useMemo(
    () => (branchId ? [...searched].sort((a, b) => Number(totalStock(a) <= 0) - Number(totalStock(b) <= 0)) : searched),
    [searched, branchId]
  );

  // Live stock for one cart line at this till (branch count, or online
  // count on a pre-branch session). null = unknown.
  function stockFor(productId: string, variantId: string, size: string): number | null {
    const p = tillProducts.find((x) => x.id === productId);
    const s = p?.colorVariants.find((v) => v.id === variantId)?.sizeStock.find((x) => x.size === size);
    return s ? s.qty : 0;
  }

  function flash(message: string) {
    setScanMessage(message);
    setTimeout(() => setScanMessage(null), 3000);
  }

  // The picker can hand over several color/size lines at once. Each merges
  // into an existing cart line for the same cell (capped at this till's
  // stock); a brand-new line beyond the per-sale line cap is skipped with a
  // message rather than silently dropped.
  function addToCart(lines: PickedLine[]) {
    let next = [...cart];
    let message: string | null = null;
    for (const line of lines) {
      const key = lineKey(line.productId, line.variantId, line.size);
      const existing = next.find((l) => l.key === key);
      if (!existing && next.length >= MAX_CHECKOUT_LINES) {
        message = t("pos.branch.maxLines").replace("{max}", String(MAX_CHECKOUT_LINES));
        continue;
      }
      const available = stockFor(line.productId, line.variantId, line.size);
      const wanted = (existing?.qty ?? 0) + line.qty;
      const qty = available === null ? wanted : Math.min(wanted, available);
      if (available !== null && wanted > available) message = t("pos.branch.onlyLeft").replace("{qty}", String(available));
      next = existing ? next.map((l) => (l.key === key ? { ...l, qty } : l)) : [...next, { ...line, qty, key }];
    }
    if (message) flash(message);
    setCart(next);
    setPickerProduct(null);
    searchRef.current?.focus();
  }

  // Same merge semantics as addToCart's duplicate branch, so a stepper bump
  // and a re-pick of the same line behave identically. Stepping the last unit
  // off a line removes it outright — same outcome as the × button. Stepping
  // up stops at what this till actually has.
  function changeQty(key: string, delta: number) {
    const line = cart.find((l) => l.key === key);
    if (!line) return;
    const available = stockFor(line.productId, line.variantId, line.size);
    if (delta > 0 && available !== null && line.qty + delta > available) {
      flash(t("pos.branch.onlyLeft").replace("{qty}", String(available)));
      return;
    }
    setCart((prev) => prev.flatMap((l) => (l.key === key ? (l.qty + delta > 0 ? [{ ...l, qty: l.qty + delta }] : []) : [l])));
  }

  function handleScan(code: string) {
    setScannerOpen(false);
    const product = matchProductFromScan(tillProducts, code);
    if (!product) {
      flash(t("pos.terminal.noProductMatched"));
      return;
    }
    // A scan of a hidden (unsellable) product must never open the picker.
    // Saying so plainly (without showing the product) is more useful to the
    // cashier than a misleading "no product matched".
    if (!listedProducts.some((p) => p.id === product.id)) {
      flash(t("pos.terminal.productUnavailable"));
      return;
    }
    setPickerProduct(product);
  }

  useBarcodeScanner(handleScan);

  const subtotal = useMemo(() => cart.reduce((sum, l) => sum + l.price * l.qty, 0), [cart]);
  // Promotions first (shared calculator), then the manual discount on what's left.
  const promo = useMemo(
    () =>
      applyPromotions(
        cart.map((l) => ({ key: l.key, productId: l.productId, category: products.find((p) => p.id === l.productId)?.category ?? "", price: l.price, qty: l.qty })),
        promotions,
        { branchId, now: promoClock }
      ),
    [cart, products, promotions, branchId, promoClock]
  );
  const promoTotal = promo.total;
  // "Add 1 more to get 1 free": multi-item deals the cart is short of.
  const promoHints = useMemo(
    () =>
      promotionHints(
        cart.map((l) => ({ key: l.key, productId: l.productId, category: products.find((p) => p.id === l.productId)?.category ?? "", price: l.price, qty: l.qty })),
        promotions,
        { branchId, now: promoClock },
        promo
      ),
    [cart, products, promotions, branchId, promoClock, promo]
  );
  const hintText = (h: (typeof promoHints)[number]) =>
    h.type === "bundle"
      ? t("pos.promo.hintBundle").replace("{name}", h.promotionName).replace("{need}", String(h.need))
      : (h.percent >= 100 ? t("pos.promo.hintFree") : t("pos.promo.hintOff").replace("{p}", String(h.percent)))
          .replace("{name}", h.promotionName)
          .replace("{need}", String(h.need))
          .replace("{free}", String(h.free));
  const manual = manualDiscount(Math.round((subtotal - promoTotal) * 100) / 100, discountMode, canDiscount ? discountInput : null, maxDiscountPercent);
  const discount = manual.amount;
  const discountLabelNote = discount > 0 ? discountNote(discountMode, discountInput) : "";
  const total = Math.round((subtotal - promoTotal - discount) * 100) / 100;
  const tendered = cashTendered ?? 0;
  useEffect(() => {
    setCashTendered(null);
    setSplitCard(null);
  }, [discount, promoTotal]);
  const splitCardAmount = splitCard ?? 0;
  const splitCashAmount = Math.max(0, total - splitCardAmount);
  // The `max` attribute on the card input is only a browser hint — typing or
  // pasting past it is allowed — so the split legs get validated here instead:
  // the card leg can't be negative or exceed the total, and cash + card has to
  // land on the total (tolerance absorbs float noise from price × qty).
  const splitBalanced =
    splitCardAmount >= 0 && splitCardAmount <= total + 0.005 && Math.abs(splitCashAmount + splitCardAmount - total) < 0.01;
  // What the customer handed over, and what goes back to them. Card and
  // split are always exact (the card leg covers the balance).
  const paid = paymentMethod === "cash" ? tendered : total;
  const change = Math.max(0, paid - total);
  const canComplete =
    !submitting && cart.length > 0 && !manual.error && (paymentMethod === "cash" ? cashTendered !== null && tendered >= total : paymentMethod === "split" ? splitBalanced : true);

  function resetSale() {
    saleIdRef.current = null;
    setCart([]);
    setDiscountInput(null);
    setDiscountMode("percent");
    setPaying(false);
    setPaymentMethod("cash");
    setCashTendered(null);
    setSplitCard(null);
    setError(null);
    setReceipt(null);
    setPrintBlocked(false);
    setCartOpen(false);
    setDiscountOpen(false);
    setSaleFull(false);
    setTimeout(() => searchRef.current?.focus(), 0);
  }

  // Clear cart: one unit goes straight away; two or more ask first (a mis-tap
  // on a big basket is costly). Only the unfinished sale is touched -- no
  // stock or sale record exists yet -- and the clear is logged.
  const [confirmClear, setConfirmClear] = useState(false);

  // ---- Hold / park ------------------------------------------------------------
  // The branch's held sales (any till of the branch can resume them).
  const [heldSales, setHeldSales] = useState<HeldSale[]>([]);
  useEffect(() => (branchId ? subscribeHeldSales(db, branchId, setHeldSales) : undefined), [branchId]);
  const [holding, setHolding] = useState(false);
  const [heldListOpen, setHeldListOpen] = useState(false);
  const [discardTarget, setDiscardTarget] = useState<HeldSale | null>(null);
  // What changed on a resumed sale (prices, stock, removed items).
  const [resumeNotes, setResumeNotes] = useState<{ ref: string; notes: string[] } | null>(null);
  const [heldError, setHeldError] = useState<string | null>(null);
  const actorName = profile?.posLink ? session.cashierName : (profile?.displayName ?? session.cashierName);

  async function holdCurrentSale(): Promise<boolean> {
    if (!profile || cart.length === 0) return false;
    setHolding(true);
    setHeldError(null);
    try {
      const held = await holdSale(
        db,
        session,
        { uid: profile.id, name: actorName },
        {
          lines: cart.map((l) => ({ productId: l.productId, variantId: l.variantId, size: l.size, qty: l.qty, name: l.name, color: l.color, price: l.price, imageId: l.imageId, imageUrl: l.imageUrl })),
          discountMode,
          discountValue: discountInput,
        }
      );
      void logActivity({ id: profile.id, email: profile.email, displayName: actorName }, "pos.saleHeld", held.ref, `${held.itemCount} · ${formatPrice(held.subtotal)}`);
      resetSale();
      flash(t("pos.hold.heldAs").replace("{ref}", held.ref));
      return true;
    } catch {
      setHeldError(t("pos.hold.failed"));
      flash(t("pos.hold.failed"));
      return false;
    } finally {
      setHolding(false);
    }
  }

  function heldErrorText(err: unknown): string {
    if (err instanceof HeldSaleError) {
      if (err.code === "taken") return t("pos.hold.taken").replace("{name}", err.by ?? "—");
      return t(`pos.hold.${err.code}`);
    }
    return t("pos.hold.failed");
  }

  async function resumeHeld(h: HeldSale) {
    if (!profile) return;
    // A sale already going on this till is held first (never overwritten),
    // then the chosen one opens -- no extra question.
    if (cart.length > 0 && !(await holdCurrentSale())) return;
    await resumeHeldNow(h);
  }

  async function resumeHeldNow(h: HeldSale) {
    if (!profile) return;
    setHeldError(null);
    try {
      const got = await resumeHeldSale(db, h.id, session, { uid: profile.id, name: actorName });
      // Today's prices and this till's stock, not the ones from when it was held.
      const notes: string[] = [];
      const next: CartLine[] = [];
      for (const l of got.lines) {
        const product = listedProducts.find((p) => p.id === l.productId);
        const variant = product?.colorVariants.find((v) => v.id === l.variantId);
        const cell = variant?.sizeStock.find((x) => x.size === l.size);
        if (!product || !variant || !cell) {
          notes.push(t("pos.hold.noteRemoved").replace("{name}", `${l.name} (${l.color} · ${l.size})`));
          continue;
        }
        const available = stockFor(l.productId, l.variantId, l.size);
        const qty = available === null ? l.qty : Math.min(l.qty, available);
        if (qty <= 0) {
          notes.push(t("pos.hold.noteOutOfStock").replace("{name}", `${l.name} (${l.color} · ${l.size})`));
          continue;
        }
        if (qty < l.qty) notes.push(t("pos.hold.noteQty").replace("{name}", l.name).replace("{qty}", String(qty)).replace("{was}", String(l.qty)));
        if (Math.abs(product.price - l.price) > 0.005)
          notes.push(t("pos.hold.notePrice").replace("{name}", l.name).replace("{was}", formatPrice(l.price)).replace("{now}", formatPrice(product.price)));
        next.push({ ...l, price: product.price, qty, key: lineKey(l.productId, l.variantId, l.size) });
      }
      setCart(next);
      if (canDiscount && got.discountValue) {
        setDiscountMode(got.discountMode ?? "percent");
        setDiscountInput(got.discountValue);
        setDiscountOpen(true);
      }
      setHeldListOpen(false);
      void logActivity({ id: profile.id, email: profile.email, displayName: actorName }, "pos.saleResumed", got.ref, `${got.cashierName} · ${got.registerName ?? ""}`);
      if (notes.length > 0) setResumeNotes({ ref: got.ref, notes });
      else flash(t("pos.hold.resumed").replace("{ref}", got.ref));
    } catch (err) {
      setHeldError(heldErrorText(err));
    }
  }

  // Used right after holding the current sale: the cart is empty by then,
  // even if this render still sees the old one.
  async function discardHeld(h: HeldSale) {
    if (!profile) return;
    setDiscardTarget(null);
    try {
      await discardHeldSale(db, h.id, { uid: profile.id, name: actorName });
      void logActivity({ id: profile.id, email: profile.email, displayName: actorName }, "pos.heldSaleDiscarded", h.ref, `${h.itemCount} · ${formatPrice(h.subtotal)}`);
    } catch (err) {
      setHeldError(heldErrorText(err));
    }
  }
  function requestClearCart() {
    if (cart.length === 0 || paying || submitting) return;
    if (cart.reduce((n, l) => n + l.qty, 0) >= 2) setConfirmClear(true);
    else clearCart();
  }
  function clearCart() {
    const units = cart.reduce((n, l) => n + l.qty, 0);
    if (units > 0 && profile) {
      const name = profile.posLink ? session.cashierName : profile.displayName;
      void logActivity(
        { id: profile.id, email: profile.email, displayName: name },
        "pos.cartCleared",
        `${session.branchCode ?? ""} · ${session.registerName ?? ""}`,
        `${units} · ${formatPrice(total)}`
      );
    }
    setConfirmClear(false);
    resetSale();
  }

  // The id/number this sale will have -- chosen once per sale, so a retry or
  // an offline sale sent later can never be recorded twice.
  const saleIdRef = useRef<{ id: string; number: string } | null>(null);
  function saleIdentity() {
    if (!saleIdRef.current) saleIdRef.current = { id: doc(collection(db, "orders")).id, number: `SIS-${Date.now().toString(36).toUpperCase()}` };
    return saleIdRef.current;
  }

  function receiptFor(orderNumber: string, total: number, cashAmount: number, cardAmount: number, isOffline: boolean): ReceiptData {
    return {
      // The sale number as a barcode, so the receipt can be scanned back in
      // for a return (Returns screen).
      orderBarcodeDataUrl: barcodeDataUrl(orderNumber) ?? undefined,
      orderNumber,
      createdAt: new Date(),
      customerName: "Walk-in customer",
      lines: cart.map((l) => ({ name: l.name, color: l.color, size: l.size, qty: l.qty, price: l.price })),
      subtotal,
      discount,
      discountNote: discount > 0 ? [t("pos.discount.manual"), discountLabelNote].filter(Boolean).join(" ") : undefined,
      promotions: promo.applied.map((a) => ({ name: a.name, amount: a.amount })),
      shipping: 0,
      total,
      source: "pos",
      paymentMethod,
      cashAmount,
      cardAmount,
      storeLine: posStoreLine({ branchName: session.branchName, registerName: session.registerName, cashierName: session.cashierName || profile?.displayName }),
      offline: isOffline || undefined,
    };
  }

  // No connection: the sale is kept on this device (with the id it will
  // have) and sent automatically when the till is back online.
  async function completeOffline(cashAmount: number, cardAmount: number) {
    const { id, number } = saleIdentity();
    const data = receiptFor(number, total, cashAmount, cardAmount, true);
    await addPending({
      id,
      orderNumber: number,
      sessionId: session.id,
      branchId: session.branchId ?? "",
      registerId: session.registerId ?? "",
      registerName: session.registerName,
      cashierUid: profile?.id ?? "",
      cashierName: session.cashierName,
      createdAt: Date.now(),
      input: {
        lines: cart.map((l) => ({ productId: l.productId, variantId: l.variantId, size: l.size, qty: l.qty })),
        discount,
        discountPercent: discount > 0 && discountMode === "percent" ? (discountInput ?? undefined) : undefined,
        expectedPromoDiscount: promoTotal,
        paymentMethod,
        cashAmount,
        cardAmount,
        linePrices: Object.fromEntries(cart.map((l) => [l.key, l.price])),
      },
      total,
      itemCount: cart.reduce((n, l) => n + l.qty, 0),
      receipt: { ...data, createdAt: data.createdAt.getTime() },
      status: "pending",
      attempts: 0,
    });
    setReceipt({ orderNumber: number, paid, change, data, offline: true });
  }

  async function completeSale() {
    if (!canComplete) return;
    setSubmitting(true);
    setError(null);
    const cashAmount = paymentMethod === "cash" ? total : paymentMethod === "split" ? splitCashAmount : 0;
    const cardAmount = paymentMethod === "card" ? total : paymentMethod === "split" ? splitCardAmount : 0;
    if (!online) {
      try {
        await completeOffline(cashAmount, cardAmount);
      } catch {
        setError(t("pos.offline.saveFailed"));
      } finally {
        setSubmitting(false);
      }
      return;
    }
    try {
      const { id: orderId, number: orderNumber } = saleIdentity();
      const result = await placeOrder({
        orderId,
        orderNumber,
        lines: cart.map((l) => ({ productId: l.productId, variantId: l.variantId, size: l.size, qty: l.qty })),
        customerName: "Walk-in customer",
        customerEmail: "",
        source: "pos",
        status: "completed",
        discount,
        discountPercent: discount > 0 && discountMode === "percent" ? (discountInput ?? undefined) : undefined,
        expectedPromoDiscount: promoTotal,
        paymentMethod,
        cashAmount,
        cardAmount,
        registerSessionId: session.id,
      });
      if (profile && discount > 0) {
        const name = profile.posLink ? session.cashierName : profile.displayName;
        void logActivity(
          { id: profile.id, email: profile.email, displayName: name },
          "pos.discountApplied",
          `#${result.orderNumber}`,
          `-${formatPrice(discount)}${discountLabelNote ? ` (${discountLabelNote})` : ""} · ${formatPrice(subtotal)}`
        );
      }
      // Phase A section 14: supplemental activity-log entry for the sale --
      // the order document's own cashierUid/cashierEmail/cashierName
      // (written inside placeOrder()'s transaction) remain the source of
      // truth regardless of whether this best-effort log write succeeds.
      if (profile) void logActivity(profile, "pos.saleCompleted", `#${result.orderNumber}`);
      setReceipt({ orderNumber: result.orderNumber, paid, change, data: receiptFor(result.orderNumber, result.total, cashAmount, cardAmount, false) });
      onSessionUpdate();
    } catch (err) {
      // The connection dropped mid-sale: keep it on the device. If the server
      // did get it, sending it again finds it (same id) and records nothing new.
      if ((err as { code?: string })?.code === "unavailable") {
        markOffline();
        try {
          await completeOffline(cashAmount, cardAmount);
        } catch {
          setError(t("pos.offline.saveFailed"));
        }
      } else {
        setError(err instanceof PromotionsChangedError ? t("pos.promo.changed") : err instanceof PlaceOrderError ? err.message : t("pos.terminal.saleFailed"));
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (receipt) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-5 overflow-y-auto p-8 text-center">
        <h2 className="font-display text-3xl font-bold text-ink">{t("pos.terminal.saleComplete")}</h2>
        {receipt.offline && (
          <p className="max-w-md rounded-lg bg-sand px-3 py-2 text-sm font-semibold text-wine-dark">{t("pos.offline.savedOnDevice").replace("{ref}", receipt.orderNumber)}</p>
        )}
        <div className="grid w-full max-w-md grid-cols-3 gap-2">
          <div className="rounded-xl bg-paper p-3 shadow-soft">
            <p className="text-xs font-semibold uppercase text-ink-faint">{t("admin.orders.colTotal")}</p>
            <p className="font-display text-lg font-bold text-ink">{formatPrice(receipt.data.total)}</p>
          </div>
          <div className="rounded-xl bg-paper p-3 shadow-soft">
            <p className="text-xs font-semibold uppercase text-ink-faint">{t("pos.branch.paid")}</p>
            <p className="font-display text-lg font-bold text-ink">{formatPrice(receipt.paid)}</p>
          </div>
          <div className="rounded-xl bg-wine p-3 text-on-accent shadow-soft">
            <p className="text-xs font-semibold uppercase opacity-80">{t("pos.terminal.changeDue")}</p>
            <p className="font-display text-lg font-bold">{formatPrice(receipt.change)}</p>
          </div>
        </div>
        <ReceiptPreview data={receipt.data} lang={lang} orderNumber={receipt.orderNumber} onPopupBlocked={() => setPrintBlocked(true)} />
        {printBlocked && (
          <p className="max-w-sm rounded-lg bg-wine-light px-3 py-2 text-sm font-semibold text-wine">{t("pos.terminal.printPopupBlocked")}</p>
        )}
        <button autoFocus onClick={resetSale} className="mt-2 rounded-full bg-wine px-8 py-3.5 text-base font-semibold text-on-accent hover:bg-wine-dark">
          {t("pos.terminal.newSale")}
        </button>
      </div>
    );
  }

  const itemCount = cart.reduce((sum, l) => sum + l.qty, 0);

  return (
    <div className="relative flex h-full">
      {/* Three columns from md up: category rail | search + products | sale
          panel (below). The rail spans the column's full height; on phones
          it stacks as a chip strip between the search and the products. */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden border-e border-line md:grid md:grid-cols-[auto_minmax(0,1fr)] md:grid-rows-[auto_auto_minmax(0,1fr)]">
        <div className="flex items-center gap-2 border-b border-line px-3 py-2.5 md:col-start-2 md:row-start-1">
          <div className="relative flex-1">
            <AdminIcon name="search" className="pointer-events-none absolute start-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
            <input
              ref={searchRef}
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                // Enter on a search that narrows to exactly one product opens it.
                if (e.key === "Enter" && filtered.length === 1) setPickerProduct(filtered[0]);
                if (e.key === "Escape") setSearch("");
              }}
              placeholder={t("pos.branch.searchPlaceholder")}
              className="w-full rounded-full border border-line bg-paper py-2 pe-4 ps-10 text-sm outline-none focus:border-wine"
            />
          </div>
          <button
            onClick={() => setScannerOpen(true)}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line text-ink hover:bg-cream-dim"
            aria-label={t("pos.terminal.scanQrCode")}
          >
            <AdminIcon name="barcode" className="h-5 w-5" />
          </button>
          {/* The branch's sales on hold. */}
          <button
            disabled={!online}
            title={online ? undefined : t("pos.offline.onlineOnly")}
            onClick={() => {
              setHeldError(null);
              setHeldListOpen(true);
            }}
            className={`flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm font-semibold ${
              heldSales.length > 0 ? "border-wine/50 bg-wine-light text-wine-dark" : "border-line text-ink-soft hover:bg-cream-dim"
            }`}
          >
            <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden><rect x="5" y="4" width="3.5" height="12" rx="1" /><rect x="11.5" y="4" width="3.5" height="12" rx="1" /></svg>
            <span className="hidden sm:inline">{t("pos.hold.heldSales")}</span>
            {heldSales.length > 0 && <span className="rounded-full bg-wine px-1.5 text-xs font-bold text-on-accent">{heldSales.length}</span>}
          </button>
        </div>
        {scanMessage && <p className="bg-sand px-4 py-2 text-center text-sm font-semibold text-wine-dark md:col-start-2 md:row-start-2">{scanMessage}</p>}
        <div className="md:col-start-1 md:row-span-3 md:row-start-1 md:flex md:min-h-0">
          <CategoryRail
            categories={tillCategories}
            selectedId={categoryId}
            subtreeCounts={subtreeCounts}
            totalCount={listedProducts.length}
            onSelect={setCategoryId}
          />
        </div>
        {/* Columns follow the space actually left beside the rail and the
            sale panel, not the viewport, so cards never get squeezed. */}
        <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))] gap-2 overflow-y-auto p-3 pb-24 sm:grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] sm:gap-2.5 md:col-start-2 md:row-start-3 md:pb-3 xl:grid-cols-[repeat(auto-fill,minmax(9rem,1fr))]">
          {filtered.map((p) => {
            const here = totalStock(p);
            const outHere = !!branchId && here <= 0;
            return (
              <button
                key={p.id}
                onClick={() => setPickerProduct(p)}
                className={`flex flex-col gap-1 rounded-xl border border-line bg-paper p-1.5 text-start transition-[border-color,box-shadow,transform] hover:border-wine hover:shadow-soft active:scale-[0.98] ${outHere ? "opacity-50" : ""}`}
              >
                <div className="relative aspect-square overflow-hidden rounded-lg bg-cream-dim">
                  {resolveImageSrc(p.colorVariants[0] ?? {}) ? (
                    <img src={resolveImageSrc(p.colorVariants[0] ?? {})} alt={localizedName(p.name, p.nameAr, lang)} className="h-full w-full object-cover" />
                  ) : (
                    // No photo: the product's category icon, in that category's color.
                    (() => {
                      const Icon = resolveCategoryIcon(categoryBySlug.get(p.category)?.icon);
                      return (
                        <div className="flex h-full w-full items-center justify-center">
                          <span className="flex h-14 w-14 items-center justify-center rounded-2xl" style={tintStyle(categoryColors.get(p.category) ?? "#a855f7")}>
                            <Icon className="h-8 w-8" />
                          </span>
                        </div>
                      );
                    })()
                  )}
                  {/* Only flag what needs attention: low or none left here. */}
                  {branchId && here <= 3 && (
                    <span
                      className={`absolute end-1 top-1 rounded-full px-1.5 py-px text-[10px] font-bold ${outHere ? "bg-paper/90 text-ink-faint" : "bg-sand text-wine-dark"}`}
                    >
                      {outHere ? t("pos.branch.outHere") : t("pos.branch.lowLeft").replace("{qty}", String(here))}
                    </span>
                  )}
                </div>
                <p className="line-clamp-2 px-0.5 text-xs font-semibold leading-snug text-ink sm:text-[13px]">{localizedName(p.name, p.nameAr, lang)}</p>
                <p className="mt-auto px-0.5 text-xs font-bold text-wine sm:text-sm">{formatPrice(p.price)}</p>
              </button>
            );
          })}
          {filtered.length === 0 && (
            <div className="col-span-full flex flex-col items-center gap-2 py-12 text-center text-sm text-ink-faint">
              {t("admin.orderDetail.noProductsFound")}
              {categoryId && (
                <button
                  onClick={() => setCategoryId(null)}
                  className="mt-1 rounded-full border border-line px-4 py-2 text-sm font-semibold text-ink hover:border-wine hover:text-wine"
                >
                  {t("pos.categories.showAll")}
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <div
        className={`${cartOpen ? "flex" : "hidden"} fixed inset-0 z-40 flex-col bg-paper md:flex ${
          saleFull
            ? "md:absolute md:inset-0 md:z-30 md:w-auto"
            : `transition-[width] duration-200 md:static md:z-auto md:shrink-0 ${saleExpanded ? "md:w-[26rem] lg:w-[34rem] xl:w-[40rem]" : "md:w-72 lg:w-80"}`
        }`}
      >
        <div className={`flex items-center justify-between gap-2 border-b border-line px-3 py-2.5 ${fullPad}`}>
          <div className="flex min-w-0 items-center gap-2">
            <button
              onClick={() => setCartOpen(false)}
              aria-label={t("pos.terminal.closeCart")}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-wine hover:bg-cream-dim md:hidden"
            >
              <svg className="h-5 w-5 rtl:-scale-x-100" viewBox="0 0 20 20" fill="none">
                <path d="M12.5 4l-6 6 6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <h2 className="whitespace-nowrap font-display text-base font-bold text-ink">{t("pos.terminal.currentSale")}</h2>
            {itemCount > 0 && <span className="rounded-full bg-cream-dim px-2 py-0.5 text-xs font-bold text-ink-soft">{itemCount}</span>}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {/* Hold: put this sale aside and serve the next customer. */}
            {cart.length > 0 && !paying && online && (
              <button
                // One tap: the sale goes straight to Held sales.
                disabled={holding}
                onClick={() => void holdCurrentSale()}
                aria-label={t("pos.hold.hold")}
                title={t("pos.hold.hold")}
                className="flex h-8 w-8 items-center justify-center rounded-full text-wine hover:bg-wine-light disabled:opacity-40"
              >
                <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden><rect x="5" y="4" width="3.5" height="12" rx="1" /><rect x="11.5" y="4" width="3.5" height="12" rx="1" /></svg>
              </button>
            )}
            {/* Clear cart: an icon beside the panel's own icons, in the sale's
                wine colour so it reads as an action on the sale, not the panel. */}
            {cart.length > 0 && !paying && (
              <button
                onClick={requestClearCart}
                aria-label={t("pos.terminal.clearCart")}
                title={t("pos.terminal.clearCart")}
                className="flex h-8 w-8 items-center justify-center rounded-full text-wine hover:bg-wine-light"
              >
                <AdminIcon name="trash" className="h-4 w-4" />
              </button>
            )}
            {/* Desktop only -- on phones the sale is already full-screen. */}
            {!saleFull && (
              <button
                onClick={() => setSaleExpanded((v) => !v)}
                aria-pressed={saleExpanded}
                aria-label={saleExpanded ? t("pos.branch.collapseSale") : t("pos.branch.expandSale")}
                title={saleExpanded ? t("pos.branch.collapseSale") : t("pos.branch.expandSale")}
                className="hidden h-8 w-8 items-center justify-center rounded-full text-ink-soft hover:bg-cream-dim hover:text-wine md:flex"
              >
                {/* Arrows pointing out of the panel (expand) or back in (collapse);
                    mirrored for RTL, where the panel sits on the left. */}
                <svg className="h-4 w-4 rtl:-scale-x-100" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  {saleExpanded ? <path d="M8 5l5 5-5 5M3 5l5 5-5 5" /> : <path d="M12 5l-5 5 5 5M17 5l-5 5 5 5" />}
                </svg>
              </button>
            )}
            <button
              onClick={() => setSaleFull((v) => !v)}
              aria-pressed={saleFull}
              aria-label={saleFull ? t("pos.branch.exitFullSale") : t("pos.branch.fullSale")}
              title={saleFull ? `${t("pos.branch.exitFullSale")} (Esc)` : t("pos.branch.fullSale")}
              className="hidden h-8 w-8 items-center justify-center rounded-full text-ink-soft hover:bg-cream-dim hover:text-wine md:flex"
            >
              {/* Corners out = enter full screen; corners in = exit. */}
              <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                {saleFull ? (
                  <path d="M7 3v4H3M13 3v4h4M7 17v-4H3M13 17v-4h4" />
                ) : (
                  <path d="M3 7V3h4M17 7V3h-4M3 13v4h4M17 13v4h-4" />
                )}
              </svg>
            </button>
          </div>
        </div>

        <div className={`flex-1 overflow-y-auto px-3 py-1 ${fullPad}`}>
          {cart.length === 0 ? (
            <p className="py-12 text-center text-sm text-ink-faint">{t("pos.terminal.emptyCart")}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line">
              {cart.map((l) => {
                const available = stockFor(l.productId, l.variantId, l.size);
                const atMax = available !== null && l.qty >= available;
                const stepBtn = "flex h-7 w-7 items-center justify-center text-sm font-bold leading-none text-ink hover:bg-cream-dim disabled:opacity-40";
                // Compact row: name, unit price and color/size tag | stepper |
                // line total. "−" at 1 removes the line.
                return (
                  <li key={l.key} className="flex items-center gap-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-bold text-ink">{l.name}</p>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                        <span className="text-xs text-ink-faint">
                          {formatPrice(l.price)} / {t("pos.terminal.perPiece")}
                        </span>
                        <span className="rounded-full bg-wine-light px-2 py-0.5 text-[10px] font-semibold leading-none text-wine">
                          {[l.color, l.size].filter(Boolean).join(" · ")}
                        </span>
                      </div>
                      {promo.lines[l.key] && (
                        <span className="mt-1 inline-flex max-w-full items-center gap-1 truncate rounded bg-olive-light px-1.5 py-px text-[10px] font-bold text-olive">
                          <AdminIcon name="tag" className="h-3 w-3 shrink-0" />
                          {promo.lines[l.key].promotionName} -{formatPrice(promo.lines[l.key].discount)}
                        </span>
                      )}
                    </div>
                    <div className="flex shrink-0 flex-col items-center">
                      <div dir="ltr" className="flex items-center overflow-hidden rounded-md border border-line bg-paper">
                        <button disabled={paying} onClick={() => changeQty(l.key, -1)} aria-label={t("pos.terminal.decreaseQty")} className={stepBtn}>
                          −
                        </button>
                        <span className="flex h-7 w-8 items-center justify-center border-x border-line text-sm font-semibold text-ink">{l.qty}</span>
                        <button disabled={paying || atMax} onClick={() => changeQty(l.key, 1)} aria-label={t("pos.terminal.increaseQty")} className={stepBtn}>
                          +
                        </button>
                      </div>
                      {atMax && <span className="mt-0.5 text-[10px] font-semibold text-wine">{t("pos.branch.maxStock")}</span>}
                    </div>
                    <span className={`shrink-0 text-end text-sm font-bold text-ink ${wideRows ? "w-24" : "w-20"}`}>
                      {promo.lines[l.key] ? (
                        <>
                          <span className="block text-[11px] font-normal text-ink-faint line-through">{formatPrice(l.price * l.qty)}</span>
                          {formatPrice(l.price * l.qty - promo.lines[l.key].discount)}
                        </>
                      ) : (
                        formatPrice(l.price * l.qty)
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {cart.length > 0 && (
          <div className={`border-t border-line p-3 ${fullPad}`}>
                <div className="mb-3 flex flex-col gap-0.5 text-sm">
                  <div className="flex justify-between text-ink-soft">
                    <span>{t("admin.orderDetail.subtotal")}</span>
                    <span>{formatPrice(subtotal)}</span>
                  </div>
                  {promoHints.map((h) => (
                    <p key={h.promotionId} className="my-0.5 flex items-center gap-1.5 rounded-md border border-dashed border-olive/50 bg-olive-light px-2 py-1 text-xs font-semibold text-olive">
                      <AdminIcon name="tag" className="h-3.5 w-3.5 shrink-0" />
                      {hintText(h)}
                    </p>
                  ))}
                  {promo.applied.map((a) => (
                    <div key={a.id} className="flex justify-between text-olive">
                      <span className="truncate">
                        {t("pos.promo.label")}: {a.name}
                      </span>
                      <span className="shrink-0">-{formatPrice(a.amount)}</span>
                    </div>
                  ))}
                  {discount > 0 && (
                    <div className="flex justify-between text-ink-soft">
                      <span>
                        {t("pos.terminal.discountLabel")} <span className="text-xs text-ink-faint">({[t("pos.discount.manual"), discountLabelNote].filter(Boolean).join(" ")})</span>
                      </span>
                      <span>-{formatPrice(discount)}</span>
                    </div>
                  )}
                  <div className="flex justify-between font-display text-xl font-bold text-ink">
                    <span>{t("admin.orders.colTotal")}</span>
                    <span>{formatPrice(total)}</span>
                  </div>
                </div>
                <button
                  onClick={() => setPaying(true)}
                  className="w-full rounded-full bg-wine py-3 text-base font-semibold text-on-accent hover:bg-wine-dark"
                >
                  {t("pos.terminal.charge")} {formatPrice(total)}
                </button>
          </div>
        )}
      </div>

      {/* Taking payment happens in a dialog over the till, not in the sale panel. */}
      {paying && cart.length > 0 && (
        <div
          className="fixed inset-0 z-[150] flex items-center justify-center bg-ink/40 p-4 backdrop-blur-[2px]"
          onClick={() => !submitting && setPaying(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="max-h-full w-full max-w-md overflow-y-auto rounded-2xl bg-paper p-5 shadow-lift"
            onClick={(e) => e.stopPropagation()}
          >
              <div className="flex flex-col gap-3">
                {/* Amount due: subtotal, the manual discount (added/edited right
                    here, within this user's limit), total. */}
                <div className="rounded-xl border border-line p-3 text-sm">
                  <div className="flex justify-between text-ink-soft">
                    <span>{t("admin.orderDetail.subtotal")}</span>
                    <span>{formatPrice(subtotal)}</span>
                  </div>
                  {promo.applied.map((a) => (
                    <div key={a.id} className="flex justify-between text-olive">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="shrink-0 rounded bg-olive-light px-1.5 py-px text-[10px] font-bold uppercase">{t("pos.promo.label")}</span>
                        <span className="truncate">{a.name}</span>
                      </span>
                      <span className="shrink-0">-{formatPrice(a.amount)}</span>
                    </div>
                  ))}
                  {promoHints.map((h) => (
                    <p key={h.promotionId} className="mt-1 flex items-center gap-1.5 rounded-md border border-dashed border-olive/50 bg-olive-light px-2 py-1 text-xs font-semibold text-olive">
                      <AdminIcon name="tag" className="h-3.5 w-3.5 shrink-0" />
                      {hintText(h)}
                    </p>
                  ))}
                  {canDiscount && !discountOpen && discount === 0 && !manual.error && (
                    <button onClick={() => setDiscountOpen(true)} className="mt-1 text-sm font-semibold text-wine hover:underline">
                      + {t("pos.branch.addDiscount")}
                    </button>
                  )}
                  {canDiscount && (discountOpen || discount > 0 || !!manual.error) && (
                    <div className="mt-2 flex flex-col gap-1.5 rounded-lg bg-cream-dim/60 p-2">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-ink">{t("pos.terminal.discountLabel")}</span>
                        <span className="rounded bg-paper px-1.5 py-px text-[10px] font-semibold uppercase text-ink-soft">{t("pos.discount.manual")}</span>
                        <div className="ms-auto flex overflow-hidden rounded-md border border-line bg-paper text-xs font-semibold">
                          {(["percent", "amount"] as ManualDiscountMode[]).map((m) => (
                            <button
                              key={m}
                              onClick={() => {
                                setDiscountMode(m);
                                setDiscountInput(null);
                              }}
                              className={`px-2.5 py-1 ${discountMode === m ? "bg-wine text-on-accent" : "text-ink-soft"}`}
                            >
                              {m === "percent" ? "%" : "₪"}
                            </button>
                          ))}
                        </div>
                        <NumberInput
                          min={0}
                          nullable
                          autoFocus
                          value={discountInput}
                          onChange={setDiscountInput}
                          placeholder="0"
                          className="w-20 rounded-md border border-line bg-paper px-2 py-1 text-end outline-none focus:border-wine"
                        />
                        <button
                          onClick={() => {
                            setDiscountInput(null);
                            setDiscountOpen(false);
                          }}
                          aria-label={t("pos.discount.remove")}
                          title={t("pos.discount.remove")}
                          className="flex h-6 w-6 items-center justify-center rounded-full text-ink-faint hover:bg-paper hover:text-wine"
                        >
                          ×
                        </button>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {[5, 10, 15, 20]
                          .filter((pct) => pct <= maxDiscountPercent)
                          .map((pct) => (
                            <button
                              key={pct}
                              onClick={() => {
                                setDiscountMode("percent");
                                setDiscountInput(pct);
                              }}
                              className={`rounded-md border px-2 py-0.5 text-xs font-semibold ${
                                discountMode === "percent" && discountInput === pct ? "border-wine bg-wine-light text-wine-dark" : "border-line bg-paper text-ink-soft hover:border-wine"
                              }`}
                            >
                              {pct}%
                            </button>
                          ))}
                        {maxDiscountPercent < 100 && (
                          <span className="ms-auto text-[11px] text-ink-faint">
                            {t("pos.discount.max").replace("{pct}", String(maxDiscountPercent)).replace("{amount}", formatPrice(manual.maxAmount))}
                          </span>
                        )}
                      </div>
                      {manual.error && (
                        <p className="text-xs font-semibold text-wine">
                          {t(`pos.discount.error.${manual.error}`).replace("{pct}", String(maxDiscountPercent)).replace("{amount}", formatPrice(manual.maxAmount))}
                        </p>
                      )}
                    </div>
                  )}
                  {discount > 0 && (
                    <div className="mt-1 flex justify-between text-ink-soft">
                      <span>
                        {t("pos.terminal.discountLabel")} {discountLabelNote && <span className="text-xs text-ink-faint">({discountLabelNote})</span>}
                      </span>
                      <span>-{formatPrice(discount)}</span>
                    </div>
                  )}
                  <div className="mt-1 flex justify-between border-t border-line pt-1 font-display text-lg font-bold text-ink">
                    <span>{t("admin.orders.colTotal")}</span>
                    <span>{formatPrice(total)}</span>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2">
                  {(["cash", "card", "split"] as PaymentMethod[]).map((m) => (
                    <button
                      key={m}
                      onClick={() => setPaymentMethod(m)}
                      className={`rounded-lg border-2 px-2 py-2 text-sm font-semibold ${
                        paymentMethod === m ? "border-wine bg-wine-light text-wine-dark" : "border-line text-ink-soft"
                      }`}
                    >
                      {t(`pos.terminal.payment.${m}`)}
                    </button>
                  ))}
                </div>

                {paymentMethod === "cash" && (
                  <div className="flex flex-col gap-2 text-sm">
                    <span className="font-semibold text-ink">{t("pos.terminal.cashTendered")}</span>
                    <NumberInput
                      min={0}
                      nullable
                      value={cashTendered}
                      onChange={setCashTendered}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void completeSale();
                      }}
                      className="rounded-lg border border-line px-3 py-2.5 text-lg outline-none focus:border-wine"
                      autoFocus
                    />
                    <div className="flex flex-wrap gap-1.5">
                      {quickCashAmounts(total).map((amount, i) => (
                        <button
                          key={amount}
                          onClick={() => setCashTendered(amount)}
                          className={`rounded-lg border px-3 py-2 text-sm font-semibold ${
                            cashTendered === amount ? "border-wine bg-wine-light text-wine-dark" : "border-line text-ink hover:border-wine"
                          }`}
                        >
                          {i === 0 ? t("pos.branch.exact") : formatPrice(amount)}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {paymentMethod === "split" && (
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="font-semibold text-ink">{t("pos.terminal.cardAmount")}</span>
                    <NumberInput
                      min={0}
                      max={total}
                      nullable
                      value={splitCard}
                      onChange={setSplitCard}
                      className="rounded-lg border border-line px-3 py-2.5 text-lg outline-none focus:border-wine"
                      autoFocus
                    />
                    <span className="text-xs text-ink-faint">
                      {t("pos.terminal.cash")}: {formatPrice(splitCashAmount)} · {t("pos.terminal.card")}: {formatPrice(splitCardAmount)}
                    </span>
                    {!splitBalanced && (
                      <span className="text-xs font-semibold text-wine">
                        {t("pos.terminal.splitMismatch")} {formatPrice(total)}
                      </span>
                    )}
                  </label>
                )}

                {/* Total / paid / change, always visible while taking payment. */}
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-lg bg-cream-dim p-2">
                    <p className="text-[11px] font-semibold uppercase text-ink-faint">{t("admin.orders.colTotal")}</p>
                    <p className="font-display text-base font-bold text-ink">{formatPrice(total)}</p>
                  </div>
                  <div className="rounded-lg bg-cream-dim p-2">
                    <p className="text-[11px] font-semibold uppercase text-ink-faint">{t("pos.branch.paid")}</p>
                    <p className="font-display text-base font-bold text-ink">{formatPrice(paid)}</p>
                  </div>
                  <div className={`rounded-lg p-2 ${paymentMethod === "cash" && cashTendered !== null && tendered < total ? "bg-wine-light" : "bg-wine text-on-accent"}`}>
                    <p className="text-[11px] font-semibold uppercase opacity-80">
                      {paymentMethod === "cash" && cashTendered !== null && tendered < total ? t("pos.terminal.stillNeed") : t("pos.terminal.changeDue")}
                    </p>
                    <p className="font-display text-base font-bold">
                      {formatPrice(paymentMethod === "cash" && cashTendered !== null && tendered < total ? total - tendered : change)}
                    </p>
                  </div>
                </div>

                {error && <p className="rounded-lg bg-wine-light px-3 py-2 text-sm font-semibold text-wine">{error}</p>}

                <div className="flex gap-2">
                  <button onClick={() => setPaying(false)} className="flex-1 rounded-full border border-line py-3.5 text-sm font-semibold text-ink hover:bg-cream-dim">
                    {t("pos.terminal.backButton")}
                  </button>
                  <button
                    onClick={() => void completeSale()}
                    disabled={!canComplete}
                    className="flex-[2] rounded-full bg-wine py-3.5 text-base font-semibold text-on-accent hover:bg-wine-dark disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {submitting ? t("pos.terminal.completing") : t("pos.terminal.completeSale")}
                  </button>
                </div>
              </div>
          </div>
        </div>
      )}

      {cart.length > 0 && !cartOpen && (
        <button
          onClick={() => setCartOpen(true)}
          className="fixed inset-x-4 bottom-4 z-30 flex items-center justify-between rounded-full bg-wine px-5 py-3.5 text-on-accent shadow-lift md:hidden"
        >
          <span className="flex items-center gap-2 text-sm font-semibold">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-on-accent/20 text-xs font-bold">{itemCount}</span>
            {t("pos.terminal.viewCart")}
          </span>
          <span className="text-sm font-bold">{formatPrice(total)}</span>
        </button>
      )}

      {pickerProduct && (
        <ProductPicker
          product={tillProducts.find((p) => p.id === pickerProduct.id) ?? pickerProduct}
          branchId={branchId}
          branches={branches}
          onAdd={addToCart}
          onClose={() => setPickerProduct(null)}
        />
      )}
      {scannerOpen && <CameraScannerModal onScan={handleScan} onClose={() => setScannerOpen(false)} />}
      {/* The branch's held sales. */}
      <Modal open={heldListOpen} onClose={() => setHeldListOpen(false)} title={`${t("pos.hold.heldSales")} · ${session.branchCode ?? session.branchName ?? ""}`} width="lg">
        <div className="flex flex-col gap-2 text-sm">
          {heldError && <p className="rounded-lg bg-wine-light px-3 py-2 font-semibold text-wine">{heldError}</p>}
          {heldSales.length === 0 ? (
            <p className="py-8 text-center text-ink-faint">{t("pos.hold.none")}</p>
          ) : (
            <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line">
              {heldSales.map((h) => {
                const expired = heldSaleExpired(h);
                const at = (h.createdAt as { toDate?: () => Date } | undefined)?.toDate?.();
                return (
                  <li key={h.id} className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 ${expired ? "opacity-70" : ""}`}>
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs font-bold text-wine">{h.ref}</span>
                        <span className="text-xs text-ink-faint">
                          {at?.toLocaleTimeString(lang === "ar" ? "ar" : "en-US", { hour: "2-digit", minute: "2-digit" })} · {h.registerName} · {h.cashierName}
                        </span>
                        {expired && <span className="rounded bg-sand px-1.5 py-px text-[10px] font-bold uppercase text-wine-dark">{t("pos.hold.expiredTag")}</span>}
                      </p>
                      <p className="truncate text-ink">
                        {h.customerName && <b className="me-1.5">{h.customerName}</b>}
                        <span className="text-ink-soft">{h.lines.map((l) => `${l.name} ×${l.qty}`).join(", ")}</span>
                      </p>
                      {h.note && <p className="truncate text-xs text-ink-faint">{h.note}</p>}
                    </div>
                    <span className="shrink-0 font-bold text-ink">{formatPrice(h.subtotal)}</span>
                    <div className="flex shrink-0 gap-1.5">
                      <button
                        onClick={() => setDiscardTarget(h)}
                        className="rounded-full border border-line px-3 py-1.5 text-xs font-semibold text-ink-soft hover:border-wine hover:text-wine"
                      >
                        {t("pos.hold.discard")}
                      </button>
                      {!expired && (
                        <button onClick={() => void resumeHeld(h)} className="rounded-full bg-wine px-3.5 py-1.5 text-xs font-semibold text-on-accent hover:bg-wine-dark">
                          {t("pos.hold.resume")}
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="text-xs text-ink-faint">{t("pos.hold.listHint")}</p>
        </div>
      </Modal>

      {/* What changed on the resumed sale. */}
      <Modal open={!!resumeNotes} onClose={() => setResumeNotes(null)} title={t("pos.hold.changedTitle").replace("{ref}", resumeNotes?.ref ?? "")} width="sm">
        {resumeNotes && (
          <div className="flex flex-col gap-3 text-sm">
            <ul className="list-disc ps-5 text-ink">
              {resumeNotes.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
            <button autoFocus onClick={() => setResumeNotes(null)} className="self-end rounded-full bg-wine px-5 py-2 font-semibold text-on-accent hover:bg-wine-dark">
              {t("admin.common.confirm")}
            </button>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={!!discardTarget}
        onClose={() => setDiscardTarget(null)}
        onConfirm={() => discardTarget && void discardHeld(discardTarget)}
        danger
        title={t("pos.hold.discardTitle")}
        body={t("pos.hold.discardBody").replace("{ref}", discardTarget?.ref ?? "").replace("{total}", formatPrice(discardTarget?.subtotal ?? 0))}
        confirmLabel={t("pos.hold.discard")}
      />

      <ConfirmDialog
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        onConfirm={clearCart}
        danger
        title={t("pos.terminal.clearCartTitle")}
        body={t("pos.terminal.clearCartBody").replace("{count}", String(itemCount)).replace("{total}", formatPrice(total))}
        confirmLabel={t("pos.terminal.clearCart")}
      />
    </div>
  );
}
