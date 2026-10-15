import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { serverTimestamp } from "firebase/firestore";
import { ordersApi, productsApi } from "../../../firebase/collections";
import { AdminOrderEditError, updateOrderLines } from "../../../firebase/adminOrderEdit";
import { cancelOrderAndRestoreStock, OrderCancellationError } from "../../../firebase/orderCancellation";
import { createDeliveryOrder, DeliveryOrderError } from "../../../firebase/deliveryOrder";
import { getDeliveryProxyConfig } from "../../../firebase/deliveryOrderConfig";
import { OrderPreparationError, setOrderLinePrepared } from "../../../firebase/orderPreparation";
import { useLanguage } from "../../../context/LanguageContext";
import { localizedName } from "../../../data/localize";
import { useAdminAuth } from "../../AdminAuthContext";
import AdminIcon from "../../components/AdminIcons";
import { ConfirmDialog } from "../../components/Modal";
import { useToast } from "../../components/ToastContext";
import { AdminButton, AdminNumberInput, Badge, Card, PageHeader, PageLoading } from "../../components/ui";
import { logActivity } from "../../logActivity";
import { allLinesPrepared, deriveStatusAfterPreparationChange, isLinePrepared, reconcilePreparedLinesAfterEdit } from "../../orderPreparation";
import { productBarcodeValue } from "../../productBarcode";
import { normalizeProduct } from "../../productVariants";
import { returnLineKey, RETURNABLE_ORDER_STATUSES } from "../../returnsHelpers";
import { matchProductFromScan } from "../../scanProductMatch";
import type { AdminProduct, OrderLine, OrderStatus } from "../../types";
import { AddOrderItemModal, type AddedLine } from "./AddOrderItemModal";
import { formatPrice } from "../../../utils/currency";
import { InvoiceModal } from "./InvoiceModal";
import ProcessReturnModal from "../../components/ProcessReturnModal";
import ProductPhoto from "../../../components/ui/ProductPhoto";
import { useBarcodeScanner } from "../../../pos/useBarcodeScanner";
import { useOrder } from "./useOrder";

// The forward path an order moves along one approved step at a time.
// Cancelled/refunded are side exits handled by their own actions.
const STATUS_FLOW: OrderStatus[] = ["pending", "processing", "ready", "shipped", "delivered", "completed"];

// Matches OrderList.tsx's own STATUS_TONE exactly -- each file keeps its own
// local copy rather than a shared export, the established convention here.
const STATUS_TONE: Record<OrderStatus, "neutral" | "warning" | "info" | "success" | "danger"> = {
  pending: "neutral",
  processing: "warning",
  ready: "success",
  shipped: "info",
  delivered: "success",
  completed: "success",
  cancelled: "danger",
  refunded: "danger",
};

// Statuses where the item preparation checklist (confirm/reset) is
// meaningful to interact with -- the same window cancellation now uses (see
// orderCancellation.ts's own extended guard). Once an order has shipped or
// gone terminal, the buttons still show each line's persisted state but
// become read-only history rather than live controls.
const PREPARABLE_STATUSES: OrderStatus[] = ["pending", "processing", "ready"];

function linesEqual(a: OrderLine[], b: OrderLine[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((l, i) => l.productId === b[i].productId && l.variantId === b[i].variantId && l.size === b[i].size && l.qty === b[i].qty);
}

export default function OrderDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { t, lang } = useLanguage();
  const { profile, hasRole, firebaseUser } = useAdminAuth();
  const canWrite = hasRole(["owner", "admin"]);
  // Branch Stock Note is deliberately gated separately from canWrite --
  // owner/admin/editor/cashier can all create/edit/clear a line's note
  // (matches firestore.rules' isBranchNoteEditorOrAbove()), while every
  // other control on this page (status, line editing, cancellation, etc.)
  // remains canWrite (owner/admin) only, completely unaffected.
  const canEditBranchNote = hasRole(["owner", "admin", "editor", "cashier"]);
  const { order, setOrder, loading } = useOrder(id);
  const [draftLines, setDraftLines] = useState<OrderLine[]>([]);
  const [savingLines, setSavingLines] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  const [returnOpen, setReturnOpen] = useState(false);
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);
  const [sendingToDelivery, setSendingToDelivery] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [products, setProducts] = useState<AdminProduct[]>([]);
  // Keys (returnLineKey format) of lines with an in-flight confirm/reset
  // request -- disables just that line's two buttons for the duration, so a
  // double-click can't fire the transaction twice.
  const [pendingPrepKeys, setPendingPrepKeys] = useState<Set<string>>(new Set());
  // Set briefly when a barcode scan matches a product that's part of this
  // order, so the matching row can visually draw the employee's eye -- pure
  // focus aid, never auto-confirms anything (see handleScan below).
  const [scanHighlightKey, setScanHighlightKey] = useState<string | null>(null);
  // Branch Stock Note, per line item (returnLineKey-keyed, same shape as
  // preparedLines/preparedLineMeta). No separate "open editor" state at all
  // -- the icon IS the empty state and a small bordered box IS the has-a-
  // note state; editingNoteKey only tracks which single box currently has
  // focus (so its live-typed draft, not the last-saved value, is what's
  // shown while the user is actively editing it). This is the ONLY place
  // this note is created, edited, or displayed anywhere in the app -- see
  // AdminOrder.lineBranchStockNotes' own doc comment in types.ts for why the
  // old single per-order field was replaced.
  const [editingNoteKey, setEditingNoteKey] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  // Debounces the actual Firestore write while typing (auto-save, no Save
  // button) without spamming a write on every keystroke -- flushed
  // immediately on blur so nothing is lost if the employee clicks away
  // before the debounce would have fired. Only one input can hold focus at
  // a time, so a single shared timer ref is enough.
  const noteSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keyed on the order id only (not the whole `order` object) -- seeds
  // draftLines once when this order first loads. updateStatus()/saveLines()/
  // handleCancelOrder() all call setOrder() afterward with a new object
  // reference for the SAME order id; re-seeding draftLines from that would
  // silently discard any in-progress, unsaved item edits.
  useEffect(() => {
    if (order) setDraftLines(order.lines);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?.id]);

  // Live stock lookup for the qty max/hint on each editable line — the
  // server-side transaction guard already rejects an over-limit save
  // regardless; this is purely a client-side hint so the admin sees the
  // ceiling before hitting that error.
  useEffect(() => {
    productsApi.list().then((list) => setProducts(list.map(normalizeProduct)));
  }, []);

  function stockFor(line: OrderLine): number | null | undefined {
    const product = products.find((p) => p.id === line.productId);
    const variant = product?.colorVariants.find((v) => v.id === line.variantId);
    return variant?.sizeStock.find((s) => s.size === line.size)?.qty;
  }

  // The order line itself never stored a SKU (see OrderLine in types.ts —
  // deliberately not adding one now: the product's own barcode/SKU value is
  // looked up live via productId, same source POS/AddOrderItemModal's
  // scanner already treats as canonical, via the existing productBarcodeValue()
  // helper, which is why this is never actually empty for a real product —
  // it falls back to the product's slug when no manual SKU override was
  // ever entered (true for all 221 catalog products today). Only genuinely
  // missing when the product itself has since been deleted.
  function skuFor(line: OrderLine): string | undefined {
    const product = products.find((p) => p.id === line.productId);
    return product ? productBarcodeValue(product) : undefined;
  }

  // Precomputed once per products-load for InvoiceModal's printed document,
  // which needs the same lookup but has no live `products` state of its own.
  const skuByProductId = useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of products) map[p.id] = productBarcodeValue(p);
    return map;
  }, [products]);

  const isEditable = canWrite && (order?.status === "pending" || order?.status === "processing");
  // Cancellation's own eligibility window (see orderCancellation.ts) is
  // wider than item-editing's: "ready" orders can't have their items
  // touched anymore, but stock was never decremented by preparation, so
  // they're exactly as cancellable as a "processing" order.
  const isCancellable = canWrite && !!order && PREPARABLE_STATUSES.includes(order.status);
  const dirty = order ? !linesEqual(draftLines, order.lines) : false;
  const draftSubtotal = useMemo(() => draftLines.reduce((sum, l) => sum + l.price * l.qty, 0), [draftLines]);
  const draftTotal = order ? draftSubtotal + order.shipping : 0;

  async function updateStatus(status: OrderStatus, { allowReady = false } = {}) {
    if (!order || !profile) return;
    // Cancellation must always go through cancelOrderAndRestoreStock() (see
    // handleCancelOrder below) so the stock-restoration transaction can
    // never be bypassed by a bare status write -- the step buttons never
    // target it either; this is defense in depth.
    if (status === "cancelled") {
      toast.error(t("admin.orderDetail.cancelOrder.useDedicatedAction"));
      return;
    }
    // "Ready" (تم التجهيز) is derived automatically from the item
    // preparation checklist below (see orderPreparation.ts). The only manual
    // way back to it is stepping back from "shipped" (allowReady), when
    // every item was already confirmed.
    if (status === "ready" && !allowReady) {
      toast.error(t("admin.orderDetail.preparation.useChecklistAction"));
      return;
    }
    await ordersApi.update(order.id, {
      status,
      statusUpdatedByUid: profile.id,
      statusUpdatedByEmail: profile.email,
      statusUpdatedByName: profile.displayName || profile.email,
      statusUpdatedAt: serverTimestamp(),
    });
    setOrder({ ...order, status });
    await logActivity(profile, "order.statusUpdated", `#${order.orderNumber} → ${t(`admin.orderStatus.${status}`)}`);
    toast.success(t("admin.orderDetail.statusUpdated"));
  }

  // Step position on STATUS_FLOW (-1 for cancelled/refunded). "Ready" is
  // reached only through the item checklist, so there is no manual
  // processing → ready step, and ready → processing means un-checking an
  // item instead.
  const flowIndex = order ? STATUS_FLOW.indexOf(order.status) : -1;
  const nextStatus = flowIndex >= 0 && flowIndex < STATUS_FLOW.length - 1 ? STATUS_FLOW[flowIndex + 1] : null;
  const prevStatus = flowIndex > 0 ? STATUS_FLOW[flowIndex - 1] : null;
  const canAdvance = !!nextStatus && nextStatus !== "ready";
  const canGoBack = !!prevStatus && order?.status !== "ready";
  const [stepping, setStepping] = useState(false);

  async function stepStatus(target: OrderStatus) {
    setStepping(true);
    try {
      await updateStatus(target, { allowReady: target === "ready" });
    } finally {
      setStepping(false);
    }
  }

  async function handleCancelOrder() {
    if (!order || !profile) return;
    setCancelling(true);
    try {
      await cancelOrderAndRestoreStock(order.id, { uid: profile.id, email: profile.email, displayName: profile.displayName });
      const refreshed = await ordersApi.get(order.id);
      if (refreshed) {
        setOrder(refreshed);
        setDraftLines(refreshed.lines);
      }
      toast.success(t("admin.orderDetail.cancelOrder.cancelled"));
      setCancelConfirmOpen(false);
    } catch (err) {
      toast.error(err instanceof OrderCancellationError ? err.message : t("admin.orderDetail.cancelOrder.failed"));
    } finally {
      setCancelling(false);
    }
  }

  // Create Order integration with the delivery company (Olivery, serving
  // client "UnitedExp") -- see src/firebase/deliveryOrder.ts /
  // src/admin/deliveryOrderMapping.ts for the actual request-building and
  // duplicate-prevention logic. This handler is intentionally thin: an
  // explicit staff action (not an automatic side effect of the status
  // dropdown above), gated on the order already being "shipped" and not
  // already sent, so the existing status-change flow itself is completely
  // untouched by this feature.
  async function handleSendToDelivery() {
    if (!order || !profile || !firebaseUser) return;
    const proxyConfig = getDeliveryProxyConfig();
    if (!proxyConfig) {
      toast.error(t("admin.orderDetail.delivery.notConfigured"));
      return;
    }
    setSendingToDelivery(true);
    try {
      // A fresh token every send, not a cached one -- getIdToken() only
      // hits the network to actually refresh when the cached token is
      // close to expiry, so this is cheap on the common path.
      const idToken = await firebaseUser.getIdToken();
      await createDeliveryOrder(order.id, proxyConfig, idToken, { uid: profile.id, email: profile.email, displayName: profile.displayName });
      const refreshed = await ordersApi.get(order.id);
      if (refreshed) setOrder(refreshed);
      toast.success(t("admin.orderDetail.delivery.sent"));
    } catch (err) {
      toast.error(err instanceof DeliveryOrderError ? err.message : t("admin.orderDetail.delivery.failed"));
    } finally {
      setSendingToDelivery(false);
    }
  }

  function changeQty(i: number, qty: number) {
    setDraftLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, qty } : l)));
  }

  function removeLine(i: number) {
    setDraftLines((prev) => prev.filter((_, idx) => idx !== i));
  }

  function addLine(added: AddedLine) {
    setDraftLines((prev) => {
      const existingIdx = prev.findIndex((l) => l.productId === added.productId && l.variantId === added.variantId && l.size === added.size);
      if (existingIdx >= 0) {
        return prev.map((l, idx) => (idx === existingIdx ? { ...l, qty: l.qty + added.qty } : l));
      }
      return [...prev, { ...added }];
    });
  }

  async function saveLines() {
    if (!order || !profile) return;
    setSavingLines(true);
    try {
      await updateOrderLines(
        order.id,
        draftLines.map((l) => ({ productId: l.productId, variantId: l.variantId, size: l.size, qty: l.qty, note: l.note })),
        { uid: profile.id, email: profile.email, displayName: profile.displayName }
      );
      const refreshed = await ordersApi.get(order.id);
      if (refreshed) {
        // A web order's shipping can be recomputed by this very save (free
        // shipping threshold crossed either way — see adminOrderEdit.ts).
        // The Customer & Shipping page (a separate route/page now) always
        // fetches its own fresh copy of the order on mount, so there's no
        // stale shipping-cost field here to resync -- unlike before this
        // refactor, when that field lived on this same page's state.
        //
        // updateOrderLines() itself never reads or writes preparedLines (it
        // only touches lines/subtotal/shipping/total/stock), so a stale
        // confirmation for a line whose quantity just changed would
        // otherwise silently survive this edit, no longer representing "the
        // complete requested quantity" it was confirmed against. This is a
        // separate, non-transactional follow-up write -- deliberately not
        // folded into adminOrderEdit.ts's own transaction, which has no
        // reason to know preparation exists at all.
        const reconciled = reconcilePreparedLinesAfterEdit(order.preparedLines, order.lines, refreshed.lines);
        const nextStatus = deriveStatusAfterPreparationChange(refreshed.status, allLinesPrepared(refreshed.lines, reconciled));
        const preparationChanged =
          JSON.stringify(reconciled) !== JSON.stringify(refreshed.preparedLines ?? {}) || nextStatus !== refreshed.status;
        if (preparationChanged) {
          const statusChanged = nextStatus !== refreshed.status;
          await ordersApi.update(order.id, {
            preparedLines: reconciled,
            status: nextStatus,
            // Only stamped when this reconciliation actually moved the
            // order's status (e.g. an item-count change knocked it back
            // out of "ready") -- a preparedLines-only reconciliation with
            // no status change must never overwrite "who last changed the
            // status" with the name of whoever merely edited line items.
            ...(statusChanged
              ? {
                  statusUpdatedByUid: profile.id,
                  statusUpdatedByEmail: profile.email,
                  statusUpdatedByName: profile.displayName || profile.email,
                  statusUpdatedAt: serverTimestamp(),
                }
              : {}),
          });
        }
        setOrder({ ...refreshed, preparedLines: reconciled, status: nextStatus });
        setDraftLines(refreshed.lines);
      }
      await logActivity(profile, "order.itemsEdited", `#${order.orderNumber}`);
      toast.success(t("admin.orderDetail.itemsUpdated"));
    } catch (err) {
      toast.error(err instanceof AdminOrderEditError ? err.message : t("admin.orderDetail.itemsUpdateFailed"));
    } finally {
      setSavingLines(false);
    }
  }

  function discardLines() {
    if (order) setDraftLines(order.lines);
  }

  const canPrepare = canWrite && !!order && PREPARABLE_STATUSES.includes(order.status);

  // Confirms/resets exactly one order line's preparation state -- one
  // Firestore transaction (setOrderLinePrepared, firebase/orderPreparation.ts)
  // that reads the order fresh, updates preparedLines, and derives the
  // resulting status, all atomically, so two employees confirming different
  // lines on the same order at nearly the same moment can't leave status out
  // of sync with the real preparedLines map. Never touches stock or creates
  // a stock movement -- see that module's own comment.
  async function togglePrepared(line: OrderLine, prepared: boolean) {
    if (!order || !profile) return;
    const key = returnLineKey(line.productId, line.variantId, line.size);
    setPendingPrepKeys((prev) => new Set(prev).add(key));
    try {
      const result = await setOrderLinePrepared(order.id, line, prepared, { uid: profile.id, email: profile.email, displayName: profile.displayName });
      setOrder({ ...order, preparedLines: result.preparedLines, preparedLineMeta: result.preparedLineMeta, status: result.newStatus });
      const statusNote =
        result.previousStatus !== result.newStatus
          ? ` — ${t(`admin.orderStatus.${result.previousStatus}`)} → ${t(`admin.orderStatus.${result.newStatus}`)}`
          : "";
      await logActivity(
        profile,
        prepared ? "order.linePrepared" : "order.linePreparationReset",
        `#${order.orderNumber}`,
        `${line.name} (${line.color}, ${line.size})${statusNote}`
      );
    } catch (err) {
      toast.error(err instanceof OrderPreparationError ? err.message : t("admin.orderDetail.itemsUpdateFailed"));
    } finally {
      setPendingPrepKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }

  // Enters editing mode for this exact line's note box, seeding the live
  // draft from whatever is already saved for it -- never from another
  // line's value, since each line's note is fully independent
  // (order.lineBranchStockNotes, keyed by returnLineKey). Used both by the
  // empty-state icon's onClick (which mounts the box for the first time)
  // and by the box's own onFocus (clicking an existing note to edit it) --
  // one entry point, so both paths behave identically.
  function startEditingNote(line: OrderLine) {
    const key = returnLineKey(line.productId, line.variantId, line.size);
    setNoteDraft(order?.lineBranchStockNotes?.[key]?.note ?? "");
    setEditingNoteKey(key);
  }

  // Writes the merged map back -- same "read the in-memory order, write the
  // merged whole" shape this field has always used, just keyed per line.
  // Applies the new value to local state FIRST (synchronously, before the
  // network write resolves) so the box/icon swap never flickers back to the
  // empty icon for a moment while the write is still in flight -- exiting
  // editing mode (see handleNoteBlur below) immediately after this call
  // already sees the updated value. A no-op (no write at all) when the
  // trimmed value hasn't actually changed, which is the common case for a
  // blur that follows a debounce that already fired. Clearing the text
  // entirely REMOVES the map key outright (a real delete), rather than
  // leaving behind an empty-string entry.
  function commitLineNote(line: OrderLine, rawValue: string) {
    if (!order || !profile) return;
    const key = returnLineKey(line.productId, line.variantId, line.size);
    const trimmed = rawValue.trim();
    const current = order.lineBranchStockNotes ?? {};
    if ((current[key]?.note ?? "") === trimmed) return;

    const withoutKey = Object.fromEntries(Object.entries(current).filter(([k]) => k !== key));
    const optimisticEntry = { note: trimmed, updatedByUid: profile.id, updatedByEmail: profile.email, updatedByName: profile.displayName || profile.email, updatedAt: new Date() };
    const optimisticMap = trimmed === "" ? withoutKey : { ...withoutKey, [key]: optimisticEntry };
    setOrder({ ...order, lineBranchStockNotes: optimisticMap });

    const remoteMap = trimmed === "" ? withoutKey : { ...withoutKey, [key]: { ...optimisticEntry, updatedAt: serverTimestamp() } };
    ordersApi
      .update(order.id, { lineBranchStockNotes: remoteMap })
      .then(() => logActivity(profile, "order.lineBranchStockNoteUpdated", `#${order.orderNumber}`, `${line.name} (${line.color}, ${line.size})`))
      .catch(() => toast.error(t("admin.orderDetail.branchNote.saveFailed")));
  }

  function handleNoteChange(line: OrderLine, value: string) {
    setNoteDraft(value);
    if (noteSaveTimer.current) clearTimeout(noteSaveTimer.current);
    noteSaveTimer.current = setTimeout(() => commitLineNote(line, value), 600);
  }

  function handleNoteBlur(line: OrderLine) {
    if (noteSaveTimer.current) {
      clearTimeout(noteSaveTimer.current);
      noteSaveTimer.current = null;
    }
    commitLineNote(line, noteDraft);
    setEditingNoteKey(null);
  }

  // Reuses the exact same HID-scanner hook and product-level matcher POS/
  // AddOrderItemModal already use (src/pos/useBarcodeScanner.ts,
  // src/admin/scanProductMatch.ts) -- no second scanner architecture. A scan
  // only ever identifies which row to look at; it never auto-confirms a
  // line, since the barcode identifies the PRODUCT only, not the exact
  // color/size variant -- that still needs the employee's own eyes. Ignored
  // whenever a modal that itself reads keyboard input is open, and whenever
  // this order isn't in a preparable status.
  useBarcodeScanner((code) => {
    if (!canPrepare || addOpen || returnOpen || invoiceOpen || cancelConfirmOpen) return;
    const product = matchProductFromScan(products, code);
    if (!product) {
      toast.error(t("pos.terminal.noProductMatched"));
      return;
    }
    const match = draftLines.find((l) => l.productId === product.id);
    if (!match) {
      toast.error(t("admin.orderDetail.preparation.scanNotInOrder"));
      return;
    }
    const key = returnLineKey(match.productId, match.variantId, match.size);
    setScanHighlightKey(key);
    setTimeout(() => setScanHighlightKey((k) => (k === key ? null : k)), 3000);
  });

  if (loading) return <PageLoading />;
  if (!order) {
    return (
      <div className="text-center text-ink-soft">
        {t("admin.orderDetail.notFound")} <button onClick={() => navigate("/admin/orders")} className="font-semibold text-wine hover:underline">{t("admin.orderDetail.backToOrders")}</button>
      </div>
    );
  }

  return (
    <div className="pb-16">
      <PageHeader
        title={`${t("admin.orderDetail.orderHash")}${order.orderNumber}`}
        actions={
          // Left exactly as before this refactor -- PageHeader.tsx renders
          // this inside its own non-wrapping `shrink-0` container, which
          // structurally CANNOT be made to wrap from the outside no matter
          // what class is applied to content passed in here (confirmed live:
          // an earlier attempt at a wrap-capable wrapper here still rendered
          // as one unbroken row, since shrink-0 sizes the container to this
          // content's un-wrapped width before wrapping could ever trigger).
          // That's the known pre-existing mobile overflow -- left alone
          // rather than "fixed" by touching the shared component. The three
          // new navigation icons below are deliberately NOT added here, so
          // they can't add to it; see the next row for those.
          <>
            {canWrite && RETURNABLE_ORDER_STATUSES.includes(order.status) && (
              <AdminButton variant="secondary" onClick={() => setReturnOpen(true)}>
                {t("admin.returns.processReturn")}
              </AdminButton>
            )}
            {/* Only ever shown for pending/processing/ready -- shipped/
                delivered/completed orders can never be cancelled through
                this action, either here (button hidden) or server-side (see
                cancelOrderAndRestoreStock()'s own status guard). A shipped+
                order that needs its stock back must go through Process
                Return above, not this. */}
            {isCancellable && (
              <AdminButton variant="danger" onClick={() => setCancelConfirmOpen(true)}>
                {t("admin.orderDetail.cancelOrder.button")}
              </AdminButton>
            )}
            <AdminButton variant="secondary" onClick={() => setInvoiceOpen(true)}>
              {order.source === "pos" ? t("admin.orderDetail.printReceipt") : t("admin.orderDetail.printInvoice")}
            </AdminButton>
            <AdminButton variant="secondary" onClick={() => navigate("/admin/orders")}>
              {t("admin.orderDetail.backToOrders")}
            </AdminButton>
          </>
        }
      />

      {/* Customer & Shipping / Customer History / Internal Information now
          live on their own dedicated pages (see OrderCustomerShipping.tsx /
          OrderCustomerHistory.tsx / OrderInternalInfo.tsx) instead of
          permanently occupying a sidebar on this page -- these three
          icon-only buttons are the only way to reach them from here. This
          row is a plain sibling in normal flow (not nested inside
          PageHeader's own shrink-0 actions container above), so unlike that
          container it genuinely can wrap/reflow at narrow widths -- in
          practice three compact icon buttons simply fit on one line even at
          375px, so it never needs to. Icon-only, but each carries a real
          accessible name via aria-label/title, never just a bare icon. */}
      {/* Multi-branch POS: where this in-store sale was rung up. */}
      {order.source === "pos" && order.branchName && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm text-ink-soft">
          <AdminIcon name="map" className="h-4 w-4 text-ink-faint" />
          {order.branchCode && <span className="rounded-md bg-cream-dim px-2 py-0.5 font-mono text-xs font-bold text-wine">{order.branchCode}</span>}
          <span className="font-semibold text-ink">{order.branchName}</span>
          <span>· {order.registerName}</span>
          {order.cashierName && <span>· {order.cashierName}</span>}
          {order.paymentMethod && <span>· {t(`pos.terminal.payment.${order.paymentMethod}`)}</span>}
        </div>
      )}

      <div className="mb-6 flex flex-wrap items-center justify-end gap-2">
        <AdminButton
          variant="secondary"
          icon="users"
          aria-label={t("admin.orderDetail.customerAndShipping")}
          title={t("admin.orderDetail.customerAndShipping")}
          onClick={() => navigate(`/admin/orders/${order.id}/customer`)}
        />
        <AdminButton
          variant="secondary"
          icon="history"
          aria-label={t("admin.orderDetail.customerHistory.title")}
          title={t("admin.orderDetail.customerHistory.title")}
          onClick={() => navigate(`/admin/orders/${order.id}/history`)}
        />
        <AdminButton
          variant="secondary"
          icon="info"
          aria-label={t("admin.orderDetail.internalInfo.title")}
          title={t("admin.orderDetail.internalInfo.title")}
          onClick={() => navigate(`/admin/orders/${order.id}/internal`)}
        />
        {/* Create Order integration with the delivery company -- explicit
            staff action, only surfaced once the order is "shipped" (this
            app's internal status for that stage -- see
            src/firebase/deliveryOrder.ts's own comment on why this file
            picked that value). Once already sent, this becomes a
            non-interactive Badge instead of a button -- the visible half of
            this feature's duplicate-prevention (the enforced half is
            deliverySentAt/deliverySendingAt, checked server-side inside
            createDeliveryOrder() itself; this is just the UI reflecting the
            same guard so staff aren't tempted to click it twice). */}
        {order.status === "shipped" &&
          (order.deliverySentAt ? (
            <div className="flex flex-col items-end gap-1">
              <Badge tone="success">{t("admin.orderDetail.delivery.sentBadge")}</Badge>
              {order.deliveryUnitedOrderId || order.deliverySequence ? (
                <div className="text-xs text-ink-faint text-end">
                  {order.deliveryUnitedOrderId && (
                    <div>
                      {t("admin.orderDetail.delivery.unitedOrderId")}: <span className="font-mono">{order.deliveryUnitedOrderId}</span>
                    </div>
                  )}
                  {order.deliverySequence && (
                    <div>
                      {t("admin.orderDetail.delivery.sequence")}: <span className="font-mono">{order.deliverySequence}</span>
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-xs text-ink-faint">{t("admin.orderDetail.delivery.noTrackingInfo")}</div>
              )}
            </div>
          ) : (
            <AdminButton
              variant="secondary"
              icon="upload"
              loading={sendingToDelivery}
              disabled={!canWrite || sendingToDelivery}
              aria-label={t("admin.orderDetail.delivery.send")}
              title={t("admin.orderDetail.delivery.send")}
              onClick={handleSendToDelivery}
            />
          ))}
      </div>

      {invoiceOpen && <InvoiceModal order={order} skuByProductId={skuByProductId} onClose={() => setInvoiceOpen(false)} />}

      {/* Customer & Shipping / Customer History / Internal Information used
          to live in a second column here -- they're now reached via the
          three icon actions in the header above, each opening its own
          dedicated page (see OrderCustomerShipping.tsx / OrderCustomerHistory.tsx
          / OrderInternalInfo.tsx). This is a single full-width column so the
          items workspace uses the space that column used to occupy. */}
      <div className="flex flex-col gap-6">
        {/* Consolidated order header: status + customer name at a glance,
            with the status-change control right there instead of buried in
            a sidebar card -- the same updateStatus()/STATUSES logic as
            before, just relocated so it reads with the rest of the order
            instead of alongside unrelated low-frequency cards. */}
        <Card className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <Badge tone={STATUS_TONE[order.status]}>{t(`admin.orderStatus.${order.status}`)}</Badge>
              <p className="font-display text-base font-bold text-ink">{order.customerName}</p>
            </div>
            {canWrite && flowIndex >= 0 && (
              <div className="flex flex-wrap items-center gap-2">
                {prevStatus && (
                  <AdminButton
                    variant="secondary"
                    disabled={!canGoBack || stepping}
                    title={!canGoBack ? t("admin.orderDetail.steps.backFromReadyHint") : undefined}
                    onClick={() => prevStatus && stepStatus(prevStatus)}
                  >
                    {t("admin.orderDetail.steps.back")}: {t(`admin.orderStatus.${prevStatus}`)}
                  </AdminButton>
                )}
                {nextStatus && (
                  <AdminButton
                    variant="primary"
                    loading={stepping}
                    disabled={!canAdvance}
                    onClick={() => nextStatus && stepStatus(nextStatus)}
                  >
                    {t("admin.orderDetail.steps.approve")}: {t(`admin.orderStatus.${nextStatus}`)}
                  </AdminButton>
                )}
              </div>
            )}
          </div>
          {flowIndex >= 0 && (
            <ol className="mt-4 flex items-center gap-1.5" aria-label={t("admin.orderDetail.updateStatus")}>
              {STATUS_FLOW.map((s, i) => (
                <li key={s} className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <span className={`h-1.5 rounded-full ${i <= flowIndex ? "bg-wine" : "bg-cream-dim"}`} />
                  <span className={`truncate text-[11px] ${i === flowIndex ? "font-bold text-ink" : i < flowIndex ? "text-ink-soft" : "text-ink-faint"}`}>
                    {t(`admin.orderStatus.${s}`)}
                  </span>
                </li>
              ))}
            </ol>
          )}
          {canWrite && order.status === "processing" && (
            <p className="mt-2 text-xs text-ink-faint">{t("admin.orderDetail.steps.prepareHint")}</p>
          )}
          {canWrite && order.status !== "pending" && order.status !== "processing" && (
            <p className="mt-2 text-xs text-ink-faint">{t("admin.orderDetail.editableNote")}</p>
          )}
        </Card>

        <Card className="p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-display text-base font-bold text-ink">{t("admin.orderDetail.items")}</h2>
            {isEditable && (
              <AdminButton variant="secondary" size="sm" icon="plus" onClick={() => setAddOpen(true)}>
                {t("admin.orderDetail.addItem")}
              </AdminButton>
            )}
          </div>
          {draftLines.length === 0 ? (
            <p className="text-sm text-ink-faint">{t("admin.orderDetail.noLineItems")}</p>
          ) : (
            <div className="flex flex-col gap-3 md:gap-0">
              {/* Column header row -- desktop/tablet only (>=768px); the
                  mobile card layout below labels each value inline instead. */}
              <div className="hidden text-xs font-semibold uppercase tracking-wide text-ink-faint md:grid md:grid-cols-[64px_minmax(0,1fr)_170px_96px] md:gap-4 md:border-b md:border-line md:pb-2">
                <span />
                <span>{t("admin.products.colProduct")}</span>
                <span>{t("admin.orderDetail.quantity")}</span>
                <span className="text-end">{t("admin.orders.colTotal")}</span>
              </div>
              {draftLines.map((line, i) => {
                const lineKeyStr = returnLineKey(line.productId, line.variantId, line.size);
                const prepared = isLinePrepared(order.preparedLines, line);
                const prepPending = pendingPrepKeys.has(lineKeyStr);
                const scanFocused = scanHighlightKey === lineKeyStr;
                return (
                <div
                  key={`${line.productId}-${line.variantId}-${line.size}`}
                  className={`flex flex-col gap-3 rounded-xl border p-3 transition-colors md:grid md:grid-cols-[64px_minmax(0,1fr)_170px_96px] md:items-center md:gap-4 md:rounded-none md:border-0 md:border-b md:p-0 md:py-3 md:last:border-b-0 ${
                    prepared ? "border-olive bg-olive-light" : "border-line"
                  } ${scanFocused ? "ring-2 ring-wine ring-offset-2" : ""}`}
                >
                  <div className="flex items-center gap-3 md:contents">
                    <div className="flex flex-col items-center gap-1.5">
                      {/* Mandatory per-line product image -- ProductPhoto
                          already implements the exact fallback this needs
                          (empty background when no image at all, a distinct
                          "broken image" icon when a URL/id fails to load), so
                          this reuses it as-is rather than inventing another. */}
                      <ProductPhoto
                        imageId={line.imageId ?? ""}
                        imageUrl={line.imageUrl}
                        alt={line.name}
                        aspect={{ w: 1, h: 1 }}
                        className="h-16 w-16 shrink-0 rounded-lg md:h-14 md:w-14"
                      />
                      {/* Preparation checklist: confirms/resets this line's
                          entire requested quantity as one unit (no partial-
                          quantity tracking in this phase). Icon-only, but
                          each has a real accessible name; disabled state
                          (not hidden) once the check/reset is a no-op or the
                          order has moved past a preparable status, so the
                          persisted state stays visible as read-only history. */}
                      {/* `relative` lives on THIS row (unchanged: still
                          exactly the 2 original flex children, check +
                          reset, nothing added to the flex flow) so the
                          Branch Stock Note element below can be anchored to
                          it with `position: absolute` -- taking it
                          completely out of layout flow. This is
                          deliberate: an earlier version made the note icon a
                          3rd normal flex child here, which grew this row's
                          own width and visibly shifted the check button --
                          exactly what absolute positioning avoids. `start-
                          full` anchors the note element's start edge to
                          this row's end edge (the same place a 3rd flex
                          child would have sat, immediately past the reset
                          button -- left of it, in this RTL admin UI) without
                          it ever participating in this row's own sizing. */}
                      <div className="relative flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => togglePrepared(line, true)}
                          disabled={!canPrepare || prepared || prepPending}
                          aria-pressed={prepared}
                          aria-label={t("admin.orderDetail.preparation.confirm")}
                          title={t("admin.orderDetail.preparation.confirm")}
                          className="flex h-8 w-8 items-center justify-center rounded-lg text-green-600 hover:bg-cream-dim hover:text-green-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-wine disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <AdminIcon name="check" className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => togglePrepared(line, false)}
                          disabled={!canPrepare || !prepared || prepPending}
                          aria-label={t("admin.orderDetail.preparation.reset")}
                          title={t("admin.orderDetail.preparation.reset")}
                          className="flex h-8 w-8 items-center justify-center rounded-lg text-orange-500 hover:bg-cream-dim hover:text-orange-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-wine disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <AdminIcon name="refresh" className="h-4 w-4" />
                        </button>
                        {(() => {
                          const savedNote = order.lineBranchStockNotes?.[lineKeyStr]?.note ?? "";
                          const isEditingThisNote = editingNoteKey === lineKeyStr;
                          const showNoteBox = isEditingThisNote || savedNote !== "";
                          // Icon and box share the exact same anchor point
                          // (absolute, start-full, top-0) -- the box simply
                          // replaces the icon in place, never a popup
                          // underneath it, and never affects this row's own
                          // width/alignment (see the comment on the row div
                          // above).
                          return showNoteBox ? (
                            <input
                              type="text"
                              value={isEditingThisNote ? noteDraft : savedNote}
                              onFocus={() => startEditingNote(line)}
                              onChange={(e) => handleNoteChange(line, e.target.value)}
                              onBlur={() => handleNoteBlur(line)}
                              readOnly={!canEditBranchNote}
                              autoFocus={isEditingThisNote}
                              placeholder={t("admin.orderDetail.branchNote.title")}
                              title={t("admin.orderDetail.branchNote.title")}
                              className="absolute start-full top-0 ms-1 h-8 w-14 rounded-md border border-wine/40 bg-paper px-1.5 text-[11px] text-wine-dark outline-none focus:border-wine"
                            />
                          ) : (
                            <button
                              type="button"
                              onClick={() => startEditingNote(line)}
                              disabled={!canEditBranchNote}
                              aria-label={t("admin.orderDetail.branchNote.title")}
                              title={t("admin.orderDetail.branchNote.title")}
                              className="absolute start-full top-0 ms-1 flex h-8 w-8 items-center justify-center rounded-lg text-ink-faint hover:bg-cream-dim hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-wine disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              <AdminIcon name="edit" className="h-4 w-4" />
                            </button>
                          );
                        })()}
                      </div>
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-ink">{line.name}</p>
                      <p className="text-xs text-ink-faint">
                        {line.color} · {line.size} · {formatPrice(line.price)} {t("admin.orderDetail.each")}
                      </p>
                      {skuFor(line) && (
                        <p className="mt-0.5 font-mono text-xs text-ink-soft" dir="ltr">
                          {t("admin.productForm.sku")}: {skuFor(line)}
                        </p>
                      )}
                      {line.note && (
                        <p className="mt-1 rounded-md bg-sand px-2 py-1 text-xs italic text-wine-dark">
                          {t("admin.orderDetail.itemNote")}: {line.note}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-3 md:contents">
                    {isEditable ? (
                      <div className="flex items-center gap-2">
                        <div className="flex flex-col items-end gap-0.5">
                          <AdminNumberInput
                            min={1}
                            integerOnly
                            max={stockFor(line) ?? undefined}
                            value={line.qty}
                            onChange={(v) => v !== null && changeQty(i, v)}
                            className="w-16 !py-1.5 text-sm"
                          />
                          <span className="text-[11px] text-ink-faint">
                            {stockFor(line) === null || stockFor(line) === undefined
                              ? t("admin.inventory.unknown")
                              : `${stockFor(line)} ${t("admin.orderDetail.available")}`}
                          </span>
                        </div>
                        <button onClick={() => removeLine(i)} className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-faint hover:bg-cream-dim hover:text-wine">
                          <AdminIcon name="trash" className="h-4 w-4" />
                        </button>
                      </div>
                    ) : (
                      <span className="text-sm text-ink-soft">{t("admin.orderDetail.qty")} {line.qty}</span>
                    )}
                    <p className="text-end font-semibold text-ink md:w-full">{formatPrice(line.price * line.qty)}</p>
                  </div>
                </div>
                );
              })}
            </div>
          )}

          {dirty && (
            <div className="mt-3 flex items-center gap-2 rounded-lg bg-sand px-3.5 py-2.5">
              <p className="flex-1 text-xs font-semibold text-wine-dark">{t("admin.orderDetail.unsavedChanges")}</p>
              <AdminButton variant="ghost" size="sm" onClick={discardLines}>
                {t("admin.orderDetail.discard")}
              </AdminButton>
              <AdminButton variant="primary" size="sm" loading={savingLines} onClick={saveLines}>
                {t("admin.orderDetail.saveItems")}
              </AdminButton>
            </div>
          )}

          <div className="mt-4 flex flex-col gap-1.5 border-t border-line pt-4 text-sm">
            <div className="flex justify-between text-ink-soft">
              <span>{t("admin.orderDetail.subtotal")}</span>
              <span>{formatPrice(dirty ? draftSubtotal : order.subtotal)}</span>
            </div>
            <div className="flex justify-between text-ink-soft">
              <span>
                {t("admin.orderDetail.shipping")}
                {/* Denormalized at order-creation/edit time (see
                    orderTransaction.ts / adminOrderEdit.ts) -- absent on
                    any order placed before this feature existed, which is
                    exactly when this stays blank rather than guessing. */}
                {(order.deliveryZoneName || order.deliveryZoneNameAr) && (
                  <span className="text-ink-faint"> — {localizedName(order.deliveryZoneName ?? "", order.deliveryZoneNameAr, lang)}</span>
                )}
              </span>
              <span>{formatPrice(order.shipping)}</span>
            </div>
            <div className="flex justify-between font-bold text-ink">
              <span>{t("admin.orders.colTotal")}</span>
              <span>{formatPrice(dirty ? draftTotal : order.total)}</span>
            </div>
          </div>
        </Card>
      </div>

      <AddOrderItemModal open={addOpen} onClose={() => setAddOpen(false)} onAdd={addLine} />
      {profile && (
        <ProcessReturnModal
          open={returnOpen}
          onClose={() => setReturnOpen(false)}
          order={order}
          actor={{ uid: profile.id, email: profile.email, displayName: profile.displayName }}
        />
      )}
      <ConfirmDialog
        open={cancelConfirmOpen}
        onClose={() => setCancelConfirmOpen(false)}
        onConfirm={handleCancelOrder}
        title={t("admin.orderDetail.cancelOrder.confirmTitle")}
        body={t("admin.orderDetail.cancelOrder.confirmBody")}
        confirmLabel={t("admin.orderDetail.cancelOrder.confirmButton")}
        danger
        loading={cancelling}
      />
    </div>
  );
}
