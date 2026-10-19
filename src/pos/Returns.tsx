import { useEffect, useMemo, useRef, useState } from "react";
import { collection, doc } from "../db/firestore";
import { useAdminAuth } from "../admin/AdminAuthContext";
import AdminIcon from "../admin/components/AdminIcons";
import { Modal } from "../admin/components/Modal";
import { logActivity } from "../admin/logActivity";
import {
  cardRefundable,
  defaultRefundSplit,
  isSaleNumber,
  isWithinReturnWindow,
  MAX_RETURN_LINES,
  newReturnNumber,
  posReturnLineKey,
  refundForUnits,
  returnDeadline,
  returnSearchSince,
  saleLineRemaining,
  SEARCH_DAYS_WITHOUT_WINDOW,
  round2,
  saleLineNets,
} from "../admin/posReturns";
import { RETURN_REASON_LABEL_KEY } from "../admin/returnsHelpers";
import { matchProductFromScan } from "../admin/scanProductMatch";
import { resolveImageSrc } from "../admin/imageSrc";
import type { AdminCategory, AdminOrder, AdminProduct, PosRefundMethod, PosReturn, RegisterSession, ReturnReason } from "../admin/types";
import { resolveCategoryIcon } from "../components/ui/CategoryIcons";
import { NumberInput, type NumericValue } from "../components/ui/NumberInput";
import { useLanguage } from "../context/LanguageContext";
import { subtreeSlugs, visibleCategories } from "../data/categoryTree";
import { localizedName } from "../data/localize";
import { categoriesApi } from "../firebase/collections";
import { db } from "../firebase/config";
import {
  listReturnableSales,
  findSaleByNumber,
  listReturnLookupProducts,
  listReturnsForSale,
  loadReturnedQty,
  loadReturnPolicy,
  PosReturnError,
  processPosReturn,
  tsDate,
  type ReturnPolicy,
} from "../firebase/posReturn";
import { sessionExpectedCash } from "../firebase/registerSession";
import { barcodeDataUrl } from "../hooks/useBarcodeImage";
import { posReturnToReceiptData, ReceiptPreview } from "../receipts/ReceiptPreview";
import { formatPrice } from "../utils/currency";
import { CameraScannerModal } from "./CameraScannerModal";
import { CategoryRail, tintStyle, useCategoryColors, useSubtreeCounts } from "./CategoryBrowser";
import { useBarcodeScanner } from "./useBarcodeScanner";
import { useOffline } from "./offline/OfflineContext";

// Reasons a customer brings an in-store purchase back (the online-only
// fulfillment/shipping reasons don't apply at a till).
const REASONS: ReturnReason[] = ["changed_mind", "wrong_size", "wrong_color", "defective", "other"];
// Per-line cap for a return without a receipt (there is no sale to cap it).
const NO_RECEIPT_MAX_QTY = 20;
// Error codes whose numbers are money amounts.
const MONEY_PARAMS = new Set(["total", "cash", "card"]);

interface Sale {
  order: AdminOrder;
  returned: Map<string, number>;
  prior: PosReturn[];
}

// Selection for one line: units being returned, and whether they go back
// into stock (false = damaged, kept out).
interface Pick {
  qty: number;
  restock: boolean;
}

// One colour/size of a tapped product in the return picker: units still
// returnable, and the sales they can come from (preferred first).
interface PickerCell {
  key: string;
  variantId: string;
  color: string;
  size: string;
  remaining: number;
  sources: { order: AdminOrder; returned: Map<string, number>; left: number }[];
}

interface NoReceiptLine extends Pick {
  productId: string;
  variantId: string;
  size: string;
}

// Money going out of the till, shown negative (0 stays 0).
function neg(amount: number): string {
  return amount > 0 ? `-${formatPrice(amount)}` : formatPrice(0);
}

function fmtDateTime(d: Date | null, lang: string): string {
  return d ? d.toLocaleString(lang === "ar" ? "ar" : "en-US", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
}

// The till's Returns screen: find the original sale (receipt number typed or
// scanned, or from the item itself), pick what comes back, choose how the
// money goes back, confirm, print the refund receipt.
export default function Returns({ session, onSessionUpdate }: { session: RegisterSession; onSessionUpdate: () => void }) {
  const { t, lang } = useLanguage();
  const { profile } = useAdminAuth();
  const [policy, setPolicy] = useState<ReturnPolicy | null>(null);
  const [products, setProducts] = useState<AdminProduct[]>([]);
  const [categories, setCategories] = useState<AdminCategory[]>([]);
  // Every branch's POS sales still inside the return period (null = loading).
  const [returnable, setReturnable] = useState<AdminOrder[] | null>(null);
  const [reloadSales, setReloadSales] = useState(0);
  // Category rail selection (same rail as the till); null = all products.
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [sale, setSale] = useState<Sale | null>(null);
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [noReceipt, setNoReceipt] = useState<NoReceiptLine[] | null>(null);
  // The sale's line table is shown only when opened from a receipt (or via
  // "Sale details"); picking items from the grid keeps the grid on screen.
  const [saleView, setSaleView] = useState(false);
  // Size/colour picker for a tapped product (like the till's), with the
  // units still returnable per colour/size and the sales they come from.
  const [picker, setPicker] = useState<{ product: AdminProduct; cells: PickerCell[] | null; variantId: string; key: string | null; qty: number } | null>(null);
  const [chooser, setChooser] = useState<{ product: AdminProduct; variantId: string } | null>(null);
  const [reason, setReason] = useState<ReturnReason>("changed_mind");
  const [note, setNote] = useState("");
  const [method, setMethod] = useState<PosRefundMethod>("cash");
  const [splitCard, setSplitCard] = useState<NumericValue>(null);
  const [reviewing, setReviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<PosReturn | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [printBlocked, setPrintBlocked] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // One id per reviewed return, reused if the cashier presses Confirm again
  // after a failure, so a refund that did go through is never paid twice.
  const attempt = useRef<{ returnId: string; returnNumber: string } | null>(null);

  useEffect(() => {
    loadReturnPolicy(db)
      .then(setPolicy)
      .catch(() => setPolicy(null));
    listReturnLookupProducts(db)
      .then(setProducts)
      .catch(() => setProducts([]));
    return categoriesApi.subscribe(setCategories);
  }, []);

  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const windowDays = policy?.policy.windowDays ?? 0;

  // Reloaded after every completed return (a sale returned in full drops out).
  useEffect(() => {
    if (!policy) return;
    let live = true;
    setReturnable(null);
    listReturnableSales(db, returnSearchSince(policy.policy.windowDays))
      .then((list) => live && setReturnable(list))
      .catch(() => live && setReturnable([]));
    return () => {
      live = false;
    };
  }, [policy, reloadSales]);
  const nonReturnable = (productId: string) => {
    const p = productById.get(productId);
    return !!p && !!policy?.nonReturnableSlugs.has(p.category);
  };
  const cellExists = (productId: string, variantId: string, size: string) =>
    !!productById.get(productId)?.colorVariants.find((v) => v.id === variantId)?.sizeStock.some((s) => s.size === size);

  function flash(message: string) {
    setNotice(message);
  }

  function resetAll() {
    setSale(null);
    setPicks({});
    setNoReceipt(null);
    setSaleView(false);
    setPicker(null);
    setChooser(null);
    setReason("changed_mind");
    setNote("");
    setMethod("cash");
    setSplitCard(null);
    setReviewing(false);
    setError(null);
    setDone(null);
    setReloadSales((n) => n + 1);
    setNotice(null);
    setPrintBlocked(false);
    setQ("");
    attempt.current = null;
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  async function openSale(number: string) {
    setBusy(true);
    setNotice(null);
    try {
      const order = await findSaleByNumber(db, number);
      if (!order) return flash(t("pos.returns.saleNotFound").replace("{number}", number.trim().toUpperCase()));
      if (order.source !== "pos") return flash(t("pos.returns.err.notPosSale"));
      const [returned, prior] = await Promise.all([loadReturnedQty(db, order), listReturnsForSale(db, order.id)]);
      setSale({ order, returned, prior });
      setSaleView(true);
      setNoReceipt(null);
      setPicker(null);
      setChooser(null);
      setPicks({});
      setMethod(order.paymentMethod === "card" ? "card" : order.paymentMethod === "split" ? "split" : "cash");
      setSplitCard(null);
      setQ("");
    } catch {
      flash(t("pos.returns.err.failed"));
    } finally {
      setBusy(false);
    }
  }

  async function openProduct(product: AdminProduct) {
    setQ("");
    setNotice(null);
    // On the sale's line table, a scan picks that item on the sale.
    if (sale && saleView) {
      const lines = sale.order.lines.filter((l) => l.productId === product.id);
      const open = lines.filter((l) => remainingFor(l) > (picks[posReturnLineKey(l.productId, l.variantId, l.size)]?.qty ?? 0));
      if (lines.length === 0) return flash(t("pos.returns.notOnSale"));
      if (open.length === 1) return bump(posReturnLineKey(open[0].productId, open[0].variantId, open[0].size), 1, remainingFor(open[0]));
      return flash(open.length === 0 ? t("pos.returns.allReturned") : t("pos.returns.pickVariant"));
    }
    if (noReceipt) {
      setChooser({ product, variantId: product.colorVariants[0]?.id ?? "" });
      return;
    }
    void openPicker(product);
  }

  // Like tapping a product on the till: pick colour/size and quantity, and
  // it goes into the return. The units come from a real sale -- the one
  // already on this return, else this branch's newest, else any branch's
  // newest that still has that colour/size to return.
  async function openPicker(product: AdminProduct) {
    if (nonReturnable(product.id)) return flash(t("pos.returns.err.notReturnable").replace("{name}", localizedName(product.name, product.nameAr, lang)));
    setPicker({ product, cells: null, variantId: "", key: null, qty: 1 });
    try {
      const candidates = sale
        ? [sale.order]
        : (returnable ?? [])
            .filter((o) => o.lines.some((l) => l.productId === product.id))
            .sort(
              (a, b) =>
                Number(b.branchId === session.branchId) - Number(a.branchId === session.branchId) ||
                (tsDate(b.createdAt)?.getTime() ?? 0) - (tsDate(a.createdAt)?.getTime() ?? 0)
            );
      const loaded = await Promise.all(
        candidates.map(async (order) => ({ order, returned: sale && order.id === sale.order.id ? sale.returned : await loadReturnedQty(db, order) }))
      );
      const cells = new Map<string, PickerCell>();
      for (const { order, returned } of loaded) {
        for (const l of order.lines.filter((x) => x.productId === product.id)) {
          const key = posReturnLineKey(l.productId, l.variantId, l.size);
          const inThisReturn = sale && order.id === sale.order.id ? (picks[key]?.qty ?? 0) : 0;
          const left = l.qty - (returned.get(key) ?? 0) - inThisReturn;
          if (left <= 0) continue;
          const cell = cells.get(key) ?? { key, variantId: l.variantId, color: l.color, size: l.size, remaining: 0, sources: [] };
          cell.remaining += left;
          cell.sources.push({ order, returned, left });
          cells.set(key, cell);
        }
      }
      const list = [...cells.values()];
      setPicker((prev) =>
        prev && prev.product.id === product.id ? { ...prev, cells: list, variantId: list[0]?.variantId ?? "", key: list.length === 1 ? list[0].key : null } : prev
      );
    } catch {
      setPicker(null);
      flash(t("pos.returns.err.failed"));
    }
  }

  function addFromPicker() {
    const cell = picker?.cells?.find((c) => c.key === picker.key);
    if (!picker || !cell) return;
    const src = cell.sources[0];
    const qty = Math.min(picker.qty, src.left);
    if (picker.qty > src.left) flash(t("pos.returns.otherReceipts").replace("{qty}", String(src.left)));
    const max = (picks[cell.key]?.qty ?? 0) + src.left;
    if (!sale || sale.order.id !== src.order.id) {
      // First item of this return: it is now a return of that sale.
      const order = src.order;
      setSale({ order, returned: src.returned, prior: [] });
      setPicks({ [cell.key]: { qty, restock: true } });
      setMethod(order.paymentMethod === "card" ? "card" : order.paymentMethod === "split" ? "split" : "cash");
      setSplitCard(null);
      listReturnsForSale(db, order.id)
        .then((prior) => setSale((cur) => (cur && cur.order.id === order.id ? { ...cur, prior } : cur)))
        .catch(() => {});
    } else {
      bump(cell.key, qty, max);
    }
    setPicker(null);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function handleCode(raw: string) {
    setScannerOpen(false);
    const code = raw.trim();
    if (!code || busy) return;
    if (isSaleNumber(code)) return void openSale(code);
    const product = matchProductFromScan(products, code);
    if (product) return void openProduct(product);
    flash(t("pos.returns.nothingMatched"));
  }

  useBarcodeScanner(handleCode);

  const textMatch = (p: AdminProduct, s: string) =>
    p.name.toLowerCase().includes(s) || !!p.nameAr?.toLowerCase().includes(s) || !!p.sku?.toLowerCase().includes(s) || p.slug.includes(s);

  // With a sale open, typing an item name lists matches to pick on the sale.
  const searchHits = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!saleView || s.length < 2 || isSaleNumber(s)) return [];
    return products.filter((p) => textMatch(p, s)).slice(0, 8);
  }, [q, products, saleView]);

  // --- Product grid (same layout as the till) ------------------------------------
  // Tapping a product starts its return exactly like scanning it. Archived
  // items can't be tapped here but are still found by scan/search.
  const railCategories = useMemo(() => visibleCategories(categories), [categories]);
  // Only items that were sold (at any branch) within the return period and
  // can still come back. Without a receipt any active product can.
  // Per item, not per sale: an item already returned in full drops out even
  // when other items on the same receipt can still come back.
  const soldIds = useMemo(
    () => new Set((returnable ?? []).flatMap((o) => o.lines.filter((l) => saleLineRemaining(o, l) > 0).map((l) => l.productId))),
    [returnable]
  );
  const gridAll = useMemo(
    () =>
      noReceipt
        ? products.filter((p) => p.status === "active")
        : sale
          ? products.filter((p) => sale.order.lines.some((l) => l.productId === p.id && remainingFor(l) > 0))
          : products.filter((p) => soldIds.has(p.id)),
    [products, soldIds, noReceipt, sale]
  );
  const categorySlugs = useMemo(() => (categoryId ? subtreeSlugs(railCategories, categoryId) : null), [railCategories, categoryId]);
  const gridProducts = useMemo(() => {
    const s = q.trim().toLowerCase();
    return gridAll.filter((p) => (!categorySlugs || categorySlugs.has(p.category)) && (!s || isSaleNumber(s) || textMatch(p, s)));
  }, [gridAll, categorySlugs, q]);
  const categoryCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of gridAll) m.set(p.category, (m.get(p.category) ?? 0) + 1);
    return m;
  }, [gridAll]);
  const subtreeCounts = useSubtreeCounts(railCategories, categoryCounts);
  const categoryColors = useCategoryColors(railCategories);
  const categoryBySlug = useMemo(() => new Map(railCategories.map((c) => [c.slug, c])), [railCategories]);
  useEffect(() => {
    if (categoryId && !railCategories.some((c) => c.id === categoryId)) setCategoryId(null);
  }, [railCategories, categoryId]);

  // --- Sale mode ---------------------------------------------------------
  const nets = useMemo(() => (sale ? saleLineNets(sale.order) : []), [sale]);
  const saleDate = sale ? tsDate(sale.order.createdAt) : null;
  const saleOpen = !!sale && sale.order.status !== "cancelled" && isWithinReturnWindow(saleDate, windowDays);
  function remainingFor(l: { productId: string; variantId: string; size: string; qty: number }): number {
    return Math.max(0, l.qty - (sale?.returned.get(posReturnLineKey(l.productId, l.variantId, l.size)) ?? 0));
  }
  function bump(key: string, delta: number, max: number) {
    setPicks((prev) => {
      const cur = prev[key] ?? { qty: 0, restock: true };
      const qty = Math.max(0, Math.min(max, cur.qty + delta));
      const next = { ...prev };
      if (qty === 0) delete next[key];
      else next[key] = { ...cur, qty };
      return next;
    });
  }

  // --- What's being returned, with refunds -----------------------------------
  const lines = useMemo(() => {
    if (sale) {
      return sale.order.lines.flatMap((l, i) => {
        const key = posReturnLineKey(l.productId, l.variantId, l.size);
        const pick = picks[key];
        if (!pick) return [];
        const before = sale.returned.get(key) ?? 0;
        const canRestock = cellExists(l.productId, l.variantId, l.size);
        return [
          {
            key,
            productId: l.productId,
            variantId: l.variantId,
            size: l.size,
            name: l.name,
            color: l.color,
            qty: pick.qty,
            max: Math.max(0, l.qty - before),
            canRestock,
            restock: pick.restock && canRestock,
            refund: refundForUnits(nets[i], l.qty, before, pick.qty),
          },
        ];
      });
    }
    return (noReceipt ?? []).flatMap((l) => {
      const p = productById.get(l.productId);
      const v = p?.colorVariants.find((x) => x.id === l.variantId);
      if (!p || !v) return [];
      return [
        {
          key: posReturnLineKey(l.productId, l.variantId, l.size),
          productId: l.productId,
          variantId: l.variantId,
          size: l.size,
          name: localizedName(p.name, p.nameAr, lang),
          color: v.colorName,
          qty: l.qty,
          max: NO_RECEIPT_MAX_QTY,
          canRestock: true,
          restock: l.restock,
          refund: round2(p.price * l.qty),
        },
      ];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sale, picks, nets, noReceipt, productById, lang]);

  // The return panel's own controls: work the same whether the lines come
  // from a sale or were picked without a receipt.
  function adjustLine(key: string, delta: number) {
    if (sale) {
      const l = sale.order.lines.find((x) => posReturnLineKey(x.productId, x.variantId, x.size) === key);
      if (l) bump(key, delta, remainingFor(l));
      return;
    }
    setNoReceipt((prev) =>
      (prev ?? []).flatMap((x) => {
        if (posReturnLineKey(x.productId, x.variantId, x.size) !== key) return [x];
        const qty = Math.min(NO_RECEIPT_MAX_QTY, x.qty + delta);
        return qty > 0 ? [{ ...x, qty }] : [];
      })
    );
  }
  function setLineRestock(key: string, restock: boolean) {
    if (sale) setPicks((p) => (p[key] ? { ...p, [key]: { ...p[key], restock } } : p));
    else setNoReceipt((prev) => (prev ?? []).map((x) => (posReturnLineKey(x.productId, x.variantId, x.size) === key ? { ...x, restock } : x)));
  }
  function clearLines() {
    if (sale) {
      setPicks({});
      setSale(null);
      setSaleView(false);
    }
    else setNoReceipt((prev) => (prev ? [] : prev));
  }
  function addNoReceiptLine(product: AdminProduct, variantId: string, size: string) {
    const key = posReturnLineKey(product.id, variantId, size);
    setNoReceipt((prev) => {
      const list = prev ?? [];
      const hit = list.find((x) => posReturnLineKey(x.productId, x.variantId, x.size) === key);
      if (hit) return list.map((x) => (x === hit ? { ...x, qty: Math.min(NO_RECEIPT_MAX_QTY, x.qty + 1) } : x));
      if (list.length >= MAX_RETURN_LINES) {
        flash(t("pos.returns.err.tooManyLines").replace("{max}", String(MAX_RETURN_LINES)));
        return list;
      }
      return [...list, { productId: product.id, variantId, size, qty: 1, restock: true }];
    });
    setChooser(null);
  }
  // The product grid (with its categories) shows until a sale is opened.
  const showGrid = !saleView;

  const refundTotal = round2(lines.reduce((s, l) => s + l.refund, 0));
  const itemCount = lines.reduce((s, l) => s + l.qty, 0);
  const cardCap = sale ? cardRefundable(sale.order) : Infinity;
  const drawerCash = sessionExpectedCash(session);
  const suggested = defaultRefundSplit(sale?.order ?? null, refundTotal);
  const cardAmount = round2(method === "cash" ? 0 : method === "card" ? refundTotal : Math.min(splitCard ?? suggested.card, refundTotal));
  const cashAmount = round2(refundTotal - cardAmount);
  const problems: string[] = [];
  if (cardAmount > cardCap + 0.005) problems.push(t("pos.returns.cardOverCap").replace("{max}", formatPrice(cardCap)));
  if (cashAmount > drawerCash + 0.005) problems.push(t("pos.returns.err.drawerShort").replace("{cash}", formatPrice(drawerCash)));
  if (method === "split" && !(cardAmount > 0 && cashAmount > 0)) problems.push(t("pos.returns.splitBoth"));
  // Refunds need the server (stock, sale and shift move together).
  const { online } = useOffline();
  const canReview = lines.length > 0 && !submitting && (!sale || saleOpen) && online;

  function errorText(err: unknown): string {
    if (err instanceof PosReturnError) {
      let msg = t(`pos.returns.err.${err.code}`);
      for (const [k, v] of Object.entries(err.params)) msg = msg.replace(`{${k}}`, typeof v === "number" && MONEY_PARAMS.has(k) ? formatPrice(v) : String(v));
      if (err.code === "cardTooHigh") msg = t("pos.returns.cardOverCap").replace("{max}", formatPrice(Number(err.params.max)));
      return msg;
    }
    const code = (err as { code?: string })?.code;
    return code === "permission-denied" ? t("pos.returns.err.denied") : t("pos.returns.err.failed");
  }

  function startReview() {
    if (!canReview) return;
    attempt.current = { returnId: doc(collection(db, "posReturns")).id, returnNumber: newReturnNumber() };
    setError(null);
    setReviewing(true);
  }

  async function confirm() {
    if (!profile || !attempt.current || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const pol = policy ?? (await loadReturnPolicy(db));
      const res = await processPosReturn(
        db,
        {
          ...attempt.current,
          sessionId: session.id,
          orderId: sale?.order.id,
          lines: lines.map((l) => ({ productId: l.productId, variantId: l.variantId, size: l.size, qty: l.qty, restock: l.restock })),
          cardRefund: cardAmount,
          expectedRefundTotal: refundTotal,
          reason,
          note,
        },
        { uid: profile.id },
        pol
      );
      const name = profile.posLink ? session.cashierName : profile.displayName;
      if (!res.alreadyProcessed) {
        void logActivity(
          { id: profile.id, email: profile.email, displayName: name },
          "pos.returnCompleted",
          `#${res.record.returnNumber}`,
          `${formatPrice(res.record.refundTotal)} · ${t(`pos.terminal.payment.${res.record.refundMethod}`)}${res.record.orderNumber ? ` · #${res.record.orderNumber}` : ""}`
        );
      }
      setReviewing(false);
      setDone(res.record);
      onSessionUpdate();
    } catch (err) {
      setError(errorText(err));
      // The figures may have moved under us (another till, a stale screen):
      // refresh the sale so the next review starts from the truth.
      if (sale && err instanceof PosReturnError && ["overReturn", "amountChanged", "cardTooHigh"].includes(err.code)) {
        try {
          const order = await findSaleByNumber(db, sale.order.orderNumber);
          if (order) setSale({ order, returned: await loadReturnedQty(db, order), prior: await listReturnsForSale(db, order.id) });
        } catch {
          // Keep the screen as it is; the message below still explains.
        }
        setPicks({});
        setReviewing(false);
        flash(errorText(err));
      }
    } finally {
      setSubmitting(false);
    }
  }

  // --- Done: refund receipt -------------------------------------------------
  if (done) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 overflow-y-auto p-6 text-center">
        <h2 className="font-display text-2xl font-bold text-ink">{t("pos.returns.complete")}</h2>
        <div className="grid w-full max-w-md grid-cols-3 gap-2">
          {[
            [t("pos.returns.refundTotal"), done.refundTotal],
            [t("pos.returns.cashBack"), done.cashRefund],
            [t("pos.returns.toCard"), done.cardRefund],
          ].map(([label, value], i) => (
            <div key={String(label)} className={`rounded-xl p-3 shadow-soft ${i === 1 ? "bg-wine text-on-accent" : "bg-paper"}`}>
              <p className={`text-[11px] font-semibold uppercase ${i === 1 ? "opacity-80" : "text-ink-faint"}`}>{label}</p>
              <p className="font-display text-lg font-bold">{formatPrice(Number(value))}</p>
            </div>
          ))}
        </div>
        <ReceiptPreview
          data={posReturnToReceiptData(done, barcodeDataUrl(done.returnNumber))}
          lang={lang}
          orderNumber={done.returnNumber}
          onPopupBlocked={() => setPrintBlocked(true)}
        />
        {printBlocked && <p className="max-w-sm rounded-lg bg-wine-light px-3 py-2 text-sm font-semibold text-wine">{t("pos.terminal.printPopupBlocked")}</p>}
        <button autoFocus onClick={resetAll} className="rounded-full bg-wine px-8 py-3 text-sm font-semibold text-on-accent hover:bg-wine-dark">
          {t("pos.returns.newReturn")}
        </button>
      </div>
    );
  }

  const th = "px-2 py-1.5 text-start text-[11px] font-semibold uppercase text-ink-faint";
  const stepBtn = "flex h-7 w-7 items-center justify-center text-sm font-bold text-ink hover:bg-cream-dim disabled:opacity-40";
  const deadline = saleDate ? returnDeadline(saleDate, windowDays) : null;

  return (
    <div className="flex h-full flex-col md:flex-row">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden border-line md:border-e">
        {/* Find: receipt number (typed or scanned) or an item. */}
        <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
          <div className="relative flex-1">
            <AdminIcon name="search" className="pointer-events-none absolute start-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
            <input
              ref={inputRef}
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const one = saleView ? searchHits : showGrid && !isSaleNumber(q) ? gridProducts : [];
                  if (one.length === 1) void openProduct(one[0]);
                  else handleCode(q);
                }
                if (e.key === "Escape") setQ("");
              }}
              placeholder={t("pos.returns.searchPlaceholder")}
              className="w-full rounded-full border border-line bg-paper py-2 pe-4 ps-10 text-sm outline-none focus:border-wine"
            />
          </div>
          <button
            onClick={() => setScannerOpen(true)}
            aria-label={t("pos.terminal.scanQrCode")}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line text-ink hover:bg-cream-dim"
          >
            <AdminIcon name="barcode" className="h-5 w-5" />
          </button>
          {saleView ? (
            <button onClick={() => setSaleView(false)} className="flex shrink-0 items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-sm font-semibold text-ink hover:border-wine hover:text-wine">
              <svg className="h-4 w-4 rtl:-scale-x-100" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12.5 4l-6 6 6 6" />
              </svg>
              {t("pos.returns.backToProducts")}
            </button>
          ) : (
            (noReceipt || sale) && (
              <button onClick={resetAll} className="shrink-0 rounded-full border border-line px-3 py-1.5 text-sm font-semibold text-ink-soft hover:text-wine">
                {t("pos.returns.startOver")}
              </button>
            )
          )}
        </div>
        {notice && <p className="bg-sand px-4 py-2 text-center text-sm font-semibold text-wine-dark">{notice}</p>}

        {showGrid ? (
          <div className="flex min-h-0 flex-1 flex-col md:flex-row">
            <div className="md:flex md:min-h-0">
              <CategoryRail categories={railCategories} selectedId={categoryId} subtreeCounts={subtreeCounts} totalCount={gridAll.length} onSelect={setCategoryId} />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {/* One compact line: how returns work here, or the no-receipt mode. */}
              {noReceipt ? (
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-sand px-3 py-2 text-xs font-semibold text-wine-dark">
                  <span>{t("pos.returns.noReceiptNote")}</span>
                </div>
              ) : (
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-paper px-3 py-2 text-xs text-ink-soft">
                  <span>
                    {t("pos.returns.intro")}{" "}
                    <span className="text-ink-faint">
                      {windowDays > 0 ? t("pos.returns.windowNote").replace("{days}", String(windowDays)) : t("pos.returns.noWindowNote")}
                    </span>
                  </span>
                  {policy?.policy.allowNoReceipt && (
                    <button onClick={() => setNoReceipt([])} className="shrink-0 rounded-full border border-line px-3 py-1 font-semibold text-ink hover:border-wine hover:text-wine">
                      {t("pos.returns.noReceipt")}
                    </button>
                  )}
                </div>
              )}
              {busy && <p className="py-2 text-center text-sm text-ink-faint">{t("pos.returns.searching")}</p>}
              {sale && (
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border-2 border-wine/40 bg-paper px-3 py-2 text-xs text-ink-soft">
                  <span>
                    {t("pos.returns.itemsOfSale").replace("{number}", sale.order.orderNumber)}{" "}
                    <span className="text-ink-faint">· {sale.order.branchId === session.branchId ? t("pos.returns.thisBranch") : (sale.order.branchName ?? "")}</span>
                  </span>
                  <button onClick={() => setSaleView(true)} className="shrink-0 rounded-full border border-line px-3 py-1 font-semibold text-ink hover:border-wine hover:text-wine">
                    {t("pos.returns.saleDetails")}
                  </button>
                </div>
              )}
              <div className="grid auto-rows-min grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))] gap-2 sm:grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] sm:gap-2.5 xl:grid-cols-[repeat(auto-fill,minmax(9rem,1fr))]">
                {gridProducts.map((p) => {
                  const img = resolveImageSrc(p.colorVariants[0] ?? {});
                  const blocked = nonReturnable(p.id);
                  return (
                    <button
                      key={p.id}
                      onClick={() => void openProduct(p)}
                      className={`flex flex-col gap-1 rounded-xl border border-line bg-paper p-1.5 text-start transition-[border-color,box-shadow,transform] hover:border-wine hover:shadow-soft active:scale-[0.98] ${blocked ? "opacity-50" : ""}`}
                    >
                      <div className="relative aspect-square overflow-hidden rounded-lg bg-cream-dim">
                        {img ? (
                          <img src={img} alt={localizedName(p.name, p.nameAr, lang)} className="h-full w-full object-cover" />
                        ) : (
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
                        {blocked && (
                          <span className="absolute end-1 top-1 rounded-full bg-paper/90 px-1.5 py-px text-[10px] font-bold text-wine">{t("pos.returns.notReturnable")}</span>
                        )}
                      </div>
                      <p className="line-clamp-2 px-0.5 text-xs font-semibold leading-snug text-ink sm:text-[13px]">{localizedName(p.name, p.nameAr, lang)}</p>
                      <p className="mt-auto px-0.5 text-xs font-bold text-wine sm:text-sm">{formatPrice(p.price)}</p>
                    </button>
                  );
                })}
                {gridProducts.length === 0 && (
                  <p className="col-span-full py-12 text-center text-sm text-ink-faint">
                    {returnable === null
                      ? t("pos.returns.searching")
                      : gridAll.length === 0
                        ? t("pos.returns.noReturnableSales").replace("{days}", String(windowDays > 0 ? windowDays : SEARCH_DAYS_WITHOUT_WINDOW))
                        : t("admin.orderDetail.noProductsFound")}
                  </p>
                )}
              </div>
            </div>
          </div>
        ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {searchHits.length > 0 && (
            <ul className="mb-3 divide-y divide-line overflow-hidden rounded-xl border border-line bg-paper">
              {searchHits.map((p) => (
                <li key={p.id}>
                  <button onClick={() => void openProduct(p)} className="flex w-full items-center justify-between gap-3 px-3 py-2 text-start text-sm hover:bg-cream-dim">
                    <span className="font-semibold text-ink">{localizedName(p.name, p.nameAr, lang)}</span>
                    <span className="text-xs text-ink-faint">{formatPrice(p.price)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {busy && <p className="py-6 text-center text-sm text-ink-faint">{t("pos.returns.searching")}</p>}

          {/* The original sale, line by line. */}
          {sale && (
            <section className="flex flex-col gap-3">
              <div className="rounded-xl border border-line bg-paper p-3 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-mono text-sm font-bold text-wine">{sale.order.orderNumber}</span>
                  <span className="text-ink-soft">{fmtDateTime(saleDate, lang)}</span>
                </div>
                <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs text-ink-soft sm:grid-cols-4">
                  <span>
                    {t("pos.branch.branch")}: <b className="text-ink">{sale.order.branchName ?? "—"}</b>
                  </span>
                  <span>
                    {t("pos.branch.register")}: <b className="text-ink">{sale.order.registerName ?? "—"}</b>
                  </span>
                  <span>
                    {t("pos.branch.cashier")}: <b className="text-ink">{sale.order.cashierName ?? "—"}</b>
                  </span>
                  <span>
                    {t("pos.branch.payment")}:{" "}
                    <b className="text-ink">
                      {sale.order.paymentMethod ? t(`pos.terminal.payment.${sale.order.paymentMethod}`) : "—"}
                      {sale.order.paymentMethod === "split" && ` (${formatPrice(sale.order.cashAmount ?? 0)} + ${formatPrice(sale.order.cardAmount ?? 0)})`}
                    </b>
                  </span>
                  <span>
                    {t("admin.orders.colTotal")}: <b className="text-ink">{formatPrice(sale.order.total)}</b>
                    {(sale.order.discount ?? 0) > 0 && <span className="text-ink-faint"> (-{formatPrice(sale.order.discount ?? 0)})</span>}
                  </span>
                  <span>
                    {t("pos.returns.refundedSoFar")}: <b className="text-ink">{formatPrice(sale.order.refundedTotal ?? 0)}</b>
                  </span>
                  <span className="col-span-2">
                    {t("pos.returns.returnBy")}:{" "}
                    <b className="text-ink">
                      {deadline ? deadline.toLocaleDateString(lang === "ar" ? "ar" : "en-US", { day: "numeric", month: "short", year: "numeric" }) : t("pos.returns.noLimit")}
                    </b>
                  </span>
                </div>
                {sale.order.status === "cancelled" ? (
                  <p className="mt-2 rounded-lg bg-wine-light px-3 py-1.5 text-xs font-semibold text-wine">{t("pos.returns.err.saleCancelled")}</p>
                ) : (
                  !saleOpen && <p className="mt-2 rounded-lg bg-wine-light px-3 py-1.5 text-xs font-semibold text-wine">{t("pos.returns.err.windowExpired").replace("{days}", String(windowDays))}</p>
                )}
              </div>

              <div className="overflow-x-auto rounded-xl border border-line bg-paper">
                <table className="w-full text-sm">
                  <thead className="bg-cream-dim">
                    <tr>
                      <th className={th}>{t("pos.returns.item")}</th>
                      <th className={`${th} !text-end`}>{t("pos.returns.paidEach")}</th>
                      <th className={`${th} !text-center`}>{t("pos.returns.soldReturned")}</th>
                      <th className={`${th} !text-center`}>{t("pos.returns.returnQty")}</th>
                      <th className={th}>{t("pos.returns.condition")}</th>
                      <th className={`${th} !text-end`}>{t("pos.returns.refund")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {sale.order.lines.map((l, i) => {
                      const key = posReturnLineKey(l.productId, l.variantId, l.size);
                      const left = remainingFor(l);
                      const pick = picks[key];
                      const blocked = nonReturnable(l.productId);
                      const canRestock = cellExists(l.productId, l.variantId, l.size);
                      const disabled = !saleOpen || blocked || left === 0;
                      return (
                        <tr key={key} className={disabled ? "opacity-60" : ""}>
                          <td className="px-2 py-1.5">
                            <p className="font-semibold text-ink">{l.name}</p>
                            <p className="text-xs text-ink-faint">
                              {l.color} · {l.size}
                              {blocked && <span className="ms-1.5 rounded bg-wine-light px-1.5 py-px font-semibold text-wine">{t("pos.returns.notReturnable")}</span>}
                            </p>
                          </td>
                          <td className="px-2 py-1.5 text-end text-ink-soft">{formatPrice(round2(nets[i] / l.qty))}</td>
                          <td className="px-2 py-1.5 text-center text-ink-soft">
                            {l.qty} / {l.qty - left}
                          </td>
                          <td className="px-2 py-1.5">
                            <div dir="ltr" className="mx-auto flex w-fit items-center overflow-hidden rounded-md border border-line">
                              <button disabled={disabled || !pick} onClick={() => bump(key, -1, left)} className={stepBtn} aria-label={t("pos.terminal.decreaseQty")}>
                                −
                              </button>
                              <span className="flex h-7 w-8 items-center justify-center border-x border-line text-sm font-semibold">{pick?.qty ?? 0}</span>
                              <button disabled={disabled || (pick?.qty ?? 0) >= left} onClick={() => bump(key, 1, left)} className={stepBtn} aria-label={t("pos.terminal.increaseQty")}>
                                +
                              </button>
                            </div>
                          </td>
                          <td className="px-2 py-1.5">
                            {pick && (
                              <ConditionToggle
                                restock={pick.restock && canRestock}
                                canRestock={canRestock}
                                onChange={(restock) => setPicks((p) => ({ ...p, [key]: { ...p[key], restock } }))}
                              />
                            )}
                          </td>
                          <td className="px-2 py-1.5 text-end font-semibold text-ink">{pick ? formatPrice(refundForUnits(nets[i], l.qty, l.qty - left, pick.qty)) : "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {sale.prior.length > 0 && (
                <div className="rounded-xl border border-line bg-paper p-3">
                  <h4 className="mb-1 text-xs font-bold uppercase text-ink-faint">{t("pos.returns.previousReturns")}</h4>
                  <ul className="text-xs text-ink-soft">
                    {sale.prior.map((r) => (
                      <li key={r.id} className="flex justify-between gap-2 py-0.5">
                        <span>
                          <span className="font-mono text-ink">{r.returnNumber}</span> · {fmtDateTime(tsDate(r.createdAt), lang)} · {r.branchName ?? r.branchCode} · {t("pos.branch.items")}: {r.itemCount}
                        </span>
                        <span className="font-semibold text-ink">-{formatPrice(r.refundTotal)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}

        </div>
        )}
      </div>

      {/* The return, shaped like the till's sale panel -- every amount is
          money going OUT, so it is shown negative. */}
      <aside className="flex shrink-0 flex-col border-t border-line bg-paper md:w-72 md:border-t-0 lg:w-80">
        <div className="flex items-center justify-between border-b border-line px-3 py-2.5">
          <div className="flex items-center gap-2">
            <h2 className="font-display text-base font-bold text-ink">{t("pos.returns.thisReturn")}</h2>
            {itemCount > 0 && <span className="rounded-full bg-cream-dim px-2 py-0.5 text-xs font-bold text-ink-soft">{itemCount}</span>}
          </div>
          {lines.length > 0 && (
            <button onClick={clearLines} className="rounded-md px-2 py-1 text-sm font-semibold text-ink-faint hover:text-wine">
              {t("admin.common.clear")}
            </button>
          )}
        </div>
        {sale && (
          <p className="border-b border-line bg-cream-dim/60 px-3 py-1.5 text-xs text-ink-soft">
            {t("pos.returns.againstSale").replace("{number}", sale.order.orderNumber)}
          </p>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-1">
          {lines.length === 0 ? (
            <p className="py-12 text-center text-sm text-ink-faint">{t("pos.returns.nothingSelected")}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line">
              {lines.map((l) => (
                <li key={l.key} className="flex flex-col gap-1.5 py-2.5">
                  <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-bold text-ink">{l.name}</p>
                      <span className="mt-0.5 inline-block rounded-full bg-wine-light px-2 py-0.5 text-[10px] font-semibold leading-none text-wine">
                        {[l.color, l.size].filter(Boolean).join(" · ")}
                      </span>
                    </div>
                    <div dir="ltr" className="flex shrink-0 items-center overflow-hidden rounded-md border border-line bg-paper">
                      <button onClick={() => adjustLine(l.key, -1)} aria-label={t("pos.terminal.decreaseQty")} className={stepBtn}>
                        −
                      </button>
                      <span className="flex h-7 w-8 items-center justify-center border-x border-line text-sm font-semibold text-ink">{l.qty}</span>
                      <button disabled={l.qty >= l.max} onClick={() => adjustLine(l.key, 1)} aria-label={t("pos.terminal.increaseQty")} className={stepBtn}>
                        +
                      </button>
                    </div>
                    <span className="w-20 shrink-0 text-end text-sm font-bold text-wine">-{formatPrice(l.refund)}</span>
                  </div>
                  <div className="self-start">
                    <ConditionToggle restock={l.restock} canRestock={l.canRestock} onChange={(restock) => setLineRestock(l.key, restock)} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
        {/* Like the till's sale panel: only the total and the button; how the
            money goes back is chosen in the dialog. */}
        <div className="flex flex-col gap-2 border-t border-line p-3 text-sm">
          <div className="flex justify-between font-display text-xl font-bold text-wine">
            <span>{t("pos.returns.refundTotal")}</span>
            <span>{neg(refundTotal)}</span>
          </div>
          <button
            onClick={startReview}
            disabled={!canReview}
            className="w-full rounded-full bg-wine py-3 text-base font-semibold text-on-accent hover:bg-wine-dark disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t("pos.returns.refundButton")}{refundTotal > 0 && ` ${neg(refundTotal)}`}
          </button>
        </div>
      </aside>

      {/* Taking the refund: reason, how the money goes back, confirm -- the
          same dialog shape as the till's payment. */}
      <Modal open={reviewing} onClose={() => !submitting && setReviewing(false)} title={t("pos.returns.confirmTitle")} width="md">
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-ink-soft">
            {sale ? t("pos.returns.againstSale").replace("{number}", sale.order.orderNumber) : t("pos.returns.noReceipt")} · {session.branchName} · {session.registerName}
          </p>
          <table className="w-full">
            <tbody className="divide-y divide-line">
              {lines.map((l) => (
                <tr key={l.key}>
                  <td className="py-1">
                    <b className="text-ink">{l.name}</b> <span className="text-xs text-ink-faint">{l.color} · {l.size} ×{l.qty}</span>
                    <span className="block text-xs text-ink-faint">{l.restock ? t("pos.returns.backToStockAt").replace("{branch}", session.branchName ?? "") : t("pos.returns.damagedNoStock")}</span>
                  </td>
                  <td className="py-1 text-end font-semibold">{formatPrice(l.refund)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-0.5">
              <span className="text-xs font-semibold text-ink-soft">{t("pos.returns.reason")}</span>
              <select value={reason} onChange={(e) => setReason(e.target.value as ReturnReason)} className="rounded-lg border border-line bg-paper px-2 py-1.5 outline-none focus:border-wine">
                {REASONS.map((r) => (
                  <option key={r} value={r}>
                    {t(RETURN_REASON_LABEL_KEY[r])}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-xs font-semibold text-ink-soft">{t("pos.returns.note")}</span>
              <input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} className="rounded-lg border border-line bg-paper px-2 py-1.5 outline-none focus:border-wine" />
            </label>
          </div>
          <div>
            <span className="text-xs font-semibold text-ink-soft">{t("pos.returns.refundMethod")}</span>
            <div className="mt-0.5 grid grid-cols-3 gap-1.5">
              {(["cash", "card", "split"] as PosRefundMethod[]).map((m) => (
                <button
                  key={m}
                  onClick={() => {
                    setMethod(m);
                    setSplitCard(null);
                  }}
                  className={`rounded-lg border-2 px-2 py-1.5 text-sm font-semibold ${method === m ? "border-wine bg-wine-light text-wine-dark" : "border-line text-ink-soft"}`}
                >
                  {t(`pos.terminal.payment.${m}`)}
                </button>
              ))}
            </div>
            {method === "split" && (
              <label className="mt-1.5 flex items-center justify-between gap-2">
                <span className="text-xs text-ink-soft">{t("pos.returns.cardPart")}</span>
                <NumberInput
                  min={0}
                  max={refundTotal}
                  nullable
                  value={splitCard ?? suggested.card}
                  onChange={setSplitCard}
                  className="w-28 rounded-lg border border-line px-2 py-1 text-end outline-none focus:border-wine"
                />
              </label>
            )}
            <p className="mt-1 text-[11px] text-ink-faint">
              {t("pos.returns.drawerHas").replace("{cash}", formatPrice(drawerCash))}
              {sale && ` · ${t("pos.returns.cardRefundable").replace("{max}", formatPrice(cardCap))}`}
            </p>
          </div>
          {/* Total / cash back / to card, always visible while refunding. */}
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-lg bg-cream-dim p-2">
              <p className="text-[11px] font-semibold uppercase text-ink-faint">{t("pos.returns.refundTotal")}</p>
              <p className="font-display text-base font-bold text-ink">{neg(refundTotal)}</p>
            </div>
            <div className="rounded-lg bg-wine p-2 text-on-accent">
              <p className="text-[11px] font-semibold uppercase opacity-80">{t("pos.returns.cashBack")}</p>
              <p className="font-display text-base font-bold">{neg(cashAmount)}</p>
            </div>
            <div className="rounded-lg bg-cream-dim p-2">
              <p className="text-[11px] font-semibold uppercase text-ink-faint">{t("pos.returns.toCard")}</p>
              <p className="font-display text-base font-bold text-ink">{neg(cardAmount)}</p>
            </div>
          </div>
          {problems.map((pr) => (
            <p key={pr} className="rounded-lg bg-wine-light px-2.5 py-1.5 text-xs font-semibold text-wine">
              {pr}
            </p>
          ))}
          {error && <p className="rounded-lg bg-wine-light px-3 py-2 font-semibold text-wine">{error}</p>}
          <div className="flex gap-2">
            <button disabled={submitting} onClick={() => setReviewing(false)} className="flex-1 rounded-full border border-line py-3 font-semibold text-ink hover:bg-cream-dim disabled:opacity-40">
              {t("pos.terminal.backButton")}
            </button>
            <button
              disabled={submitting || problems.length > 0}
              onClick={() => void confirm()}
              className="flex-[2] rounded-full bg-wine py-3 text-base font-semibold text-on-accent hover:bg-wine-dark disabled:cursor-not-allowed disabled:opacity-40"
            >
              {submitting ? t("pos.returns.processing") : t("pos.returns.confirm").replace("{amount}", formatPrice(refundTotal))}
            </button>
          </div>
        </div>
      </Modal>

      {/* Tapped product: colour/size and quantity, like the till's picker. */}
      <Modal open={!!picker} onClose={() => setPicker(null)} title={picker ? localizedName(picker.product.name, picker.product.nameAr, lang) : ""} width="sm">
        {picker &&
          (() => {
            const cells = picker.cells;
            if (cells === null) return <p className="py-6 text-center text-sm text-ink-faint">{t("pos.returns.searching")}</p>;
            if (cells.length === 0)
              return (
                <div className="flex flex-col gap-3 text-sm">
                  <p className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-ink-faint">
                    {sale ? t("pos.returns.allReturned") : t("pos.returns.noSalesWithItem")}
                  </p>
                  {!sale && policy?.policy.allowNoReceipt && (
                    <button
                      onClick={() => {
                        setNoReceipt([]);
                        setChooser({ product: picker.product, variantId: picker.product.colorVariants[0]?.id ?? "" });
                        setPicker(null);
                      }}
                      className="self-start rounded-full border border-line px-4 py-2 font-semibold text-ink hover:border-wine hover:text-wine"
                    >
                      {t("pos.returns.returnWithoutReceipt")}
                    </button>
                  )}
                </div>
              );
            const variants = [...new Map(cells.map((c) => [c.variantId, c.color])).entries()];
            const selected = cells.find((c) => c.key === picker.key);
            const src = selected?.sources[0];
            return (
              <div className="flex flex-col gap-3 text-sm">
                {variants.length > 1 && (
                  <div className="flex flex-wrap gap-1.5">
                    {variants.map(([id, color]) => (
                      <button
                        key={id}
                        onClick={() => setPicker({ ...picker, variantId: id, key: null, qty: 1 })}
                        className={`rounded-md border px-2.5 py-1 text-xs font-semibold ${picker.variantId === id ? "border-wine bg-wine-light text-wine-dark" : "border-line text-ink-soft"}`}
                      >
                        {color}
                      </button>
                    ))}
                  </div>
                )}
                <div>
                  <p className="mb-1.5 font-semibold text-ink">{t("pos.returns.pickSize")}</p>
                  <div className="flex flex-wrap gap-2">
                    {cells
                      .filter((c) => c.variantId === picker.variantId)
                      .map((c) => (
                        <button
                          key={c.key}
                          onClick={() => setPicker({ ...picker, key: c.key, qty: 1 })}
                          className={`flex min-w-14 flex-col items-center rounded-lg border-2 px-3 py-1.5 ${picker.key === c.key ? "border-wine bg-wine-light" : "border-line hover:border-wine/50"}`}
                        >
                          <span className="font-bold text-ink">{c.size}</span>
                          <span className="text-[11px] text-ink-faint">{t("pos.returns.canReturn").replace("{qty}", String(c.remaining))}</span>
                        </button>
                      ))}
                  </div>
                </div>
                {selected && src && (
                  <>
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-ink">{t("pos.returns.returnQty")}</span>
                      <div dir="ltr" className="flex items-center overflow-hidden rounded-md border border-line">
                        <button disabled={picker.qty <= 1} onClick={() => setPicker({ ...picker, qty: picker.qty - 1 })} className={stepBtn}>
                          −
                        </button>
                        <span className="flex h-7 w-8 items-center justify-center border-x border-line font-semibold">{picker.qty}</span>
                        <button disabled={picker.qty >= src.left} onClick={() => setPicker({ ...picker, qty: picker.qty + 1 })} className={stepBtn}>
                          +
                        </button>
                      </div>
                    </div>
                    <p className="rounded-lg bg-cream-dim px-2.5 py-1.5 text-xs text-ink-soft">
                      {t("pos.returns.fromSale")} <b className="font-mono text-wine">{src.order.orderNumber}</b> · {fmtDateTime(tsDate(src.order.createdAt), lang)} ·{" "}
                      {src.order.branchId === session.branchId ? t("pos.returns.thisBranch") : (src.order.branchName ?? "")}
                    </p>
                  </>
                )}
                <div className="flex justify-end gap-2">
                  <button onClick={() => setPicker(null)} className="rounded-full px-5 py-2.5 font-semibold text-ink-soft hover:bg-cream-dim">
                    {t("admin.common.cancel")}
                  </button>
                  <button
                    disabled={!selected}
                    onClick={addFromPicker}
                    className="rounded-full bg-wine px-5 py-2.5 font-semibold text-on-accent hover:bg-wine-dark disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {t("pos.returns.addToReturn")}
                  </button>
                </div>
              </div>
            );
          })()}
      </Modal>

      {/* No receipt: pick the color and size of the item coming back. */}
      <Modal open={!!chooser} onClose={() => setChooser(null)} title={chooser ? localizedName(chooser.product.name, chooser.product.nameAr, lang) : ""} width="sm">
        {chooser && (
          <div className="flex flex-col gap-3 text-sm">
            <p className="text-ink-soft">
              {t("pos.returns.noReceiptShort")} · <b className="text-ink">{formatPrice(chooser.product.price)}</b>
            </p>
            {nonReturnable(chooser.product.id) ? (
              <p className="rounded-lg bg-wine-light px-3 py-2 font-semibold text-wine">{t("pos.returns.notReturnable")}</p>
            ) : (
              <>
                <div className="flex flex-wrap gap-1.5">
                  {chooser.product.colorVariants.map((v) => (
                    <button
                      key={v.id}
                      onClick={() => setChooser({ ...chooser, variantId: v.id })}
                      className={`rounded-md border px-2.5 py-1 text-xs font-semibold ${chooser.variantId === v.id ? "border-wine bg-wine-light text-wine-dark" : "border-line text-ink-soft"}`}
                    >
                      {v.colorName}
                    </button>
                  ))}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {chooser.product.colorVariants
                    .find((v) => v.id === chooser.variantId)
                    ?.sizeStock.map((st) => (
                      <button
                        key={st.size}
                        onClick={() => addNoReceiptLine(chooser.product, chooser.variantId, st.size)}
                        className="min-w-12 rounded-lg border border-line px-3 py-2 text-sm font-semibold text-ink hover:border-wine hover:text-wine"
                      >
                        {st.size}
                      </button>
                    ))}
                </div>
              </>
            )}
          </div>
        )}
      </Modal>

      {scannerOpen && <CameraScannerModal onScan={handleCode} onClose={() => setScannerOpen(false)} />}
    </div>
  );
}

function ConditionToggle({ restock, canRestock, onChange }: { restock: boolean; canRestock: boolean; onChange: (restock: boolean) => void }) {
  const { t } = useLanguage();
  const btn = (on: boolean) => `px-2 py-1 text-[11px] font-semibold ${on ? "bg-wine text-on-accent" : "text-ink-soft hover:text-ink"}`;
  return (
    <div className="inline-flex overflow-hidden rounded-md border border-line" title={canRestock ? undefined : t("pos.returns.cannotRestockHint")}>
      <button disabled={!canRestock} onClick={() => onChange(true)} className={`${btn(restock)} disabled:opacity-40`}>
        {t("pos.returns.resellable")}
      </button>
      <button onClick={() => onChange(false)} className={btn(!restock)}>
        {t("pos.returns.damaged")}
      </button>
    </div>
  );
}
