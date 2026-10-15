import { orderBy } from "firebase/firestore";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ordersApi } from "../../../firebase/collections";
import { useLanguage } from "../../../context/LanguageContext";
import { useAdminAuth } from "../../AdminAuthContext";
import DataTable, { BulkActionBar, type DataTableColumn } from "../../components/DataTable";
import { Modal } from "../../components/Modal";
import { useToast } from "../../components/ToastContext";
import { AdminButton, AdminInput, AdminNumberInput, AdminSelect, AdminTextarea, Badge, EmptyState, Field, PageHeader, SearchInput } from "../../components/ui";
import { logActivity } from "../../logActivity";
import { orderMatchesListSearch } from "../../orderListSearch";
import { BULK_ORDER_STATUSES, summarizeBulkStatusOutcomes, type BulkStatusOutcome } from "../../orderBulkStatus";
import { countOrdersByStatus } from "../../orderStatusCounts";
import { lineBranchStockNoteTexts } from "../../returnsHelpers";
import { BulkStatusUpdateError, updateOrderStatusIfEligible } from "../../../firebase/orderBulkStatusUpdate";
import OrderStatusCards from "../../components/OrderStatusCards";
import { ProductAvailabilityCheckModal } from "./ProductAvailabilityCheckModal";
import type { AdminOrder, OrderStatus } from "../../types";
import { formatPrice } from "../../../utils/currency";
import NonDeliveryWarningBanner from "../../components/NonDeliveryWarningBanner";

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

export default function OrderList() {
  const navigate = useNavigate();
  const toast = useToast();
  const { t } = useLanguage();
  const { profile, hasRole } = useAdminAuth();
  // Matches this route's own gate (AdminApp.tsx: orders/orders/:id are both
  // RequireRole roles={["owner","admin"]}) -- an in-page check too, same as
  // CustomerList.tsx/DiscountList.tsx, so selection/bulk actions stay
  // correctly gated even if the route's roles are ever loosened later.
  const canWrite = hasRole(["owner", "admin"]);
  const [orders, setOrders] = useState<AdminOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [showCreate, setShowCreate] = useState(false);
  const [showAvailabilityCheck, setShowAvailabilityCheck] = useState(false);
  const [form, setForm] = useState({ customerName: "", customerEmail: "", customerPhone: "", shippingAddress: "", shippingCost: 0 });
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showBulkStatus, setShowBulkStatus] = useState(false);
  const [bulkTargetStatus, setBulkTargetStatus] = useState<OrderStatus | "">("");
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkOutcomes, setBulkOutcomes] = useState<BulkStatusOutcome[] | null>(null);

  useEffect(() => {
    const unsub = ordersApi.subscribe(
      (data) => {
        setOrders(data);
        setLoading(false);
      },
      [orderBy("createdAt", "desc")]
    );
    return unsub;
  }, []);

  const filtered = useMemo(() => {
    return orders.filter((o) => {
      if (!orderMatchesListSearch(o, search)) return false;
      if (statusFilter !== "all" && o.status !== statusFilter) return false;
      return true;
    });
  }, [orders, search, statusFilter]);

  // Live per-status breakdown for the status-summary cards below, derived
  // from this page's own existing `orders` subscription (see the useEffect
  // above) -- deliberately from the FULL unfiltered `orders`, not `filtered`,
  // so the cards always show the true system-wide count per status
  // regardless of whatever search/statusFilter is currently narrowing the
  // table. No new Firestore listener is opened for this.
  const statusCounts = useMemo(() => countOrdersByStatus(orders), [orders]);

  async function handleCreate() {
    if (!form.customerName.trim()) {
      toast.error(t("admin.orders.errRequired"));
      return;
    }
    if (!profile) return;
    setSaving(true);
    try {
      const orderNumber = `SIS-${Date.now().toString(36).toUpperCase()}`;
      // No line items exist yet (added afterward via "Add item" on the order
      // detail page — unchanged), so subtotal is genuinely 0 here and total
      // is never independently typed: it's always subtotal + shipping, the
      // same derived relationship every other order in this app already
      // keeps. That's just the shipping cost for now, and recalculates for
      // real (see adminOrderEdit.ts) the moment real items are added.
      const shipping = form.shippingCost;
      const id = await ordersApi.create({
        orderNumber,
        customerName: form.customerName.trim(),
        customerEmail: form.customerEmail.trim() || undefined,
        customerPhone: form.customerPhone.trim() || undefined,
        shippingAddress: form.shippingAddress.trim() || undefined,
        lines: [],
        subtotal: 0,
        shipping,
        total: shipping,
        status: "pending",
        // Lets cashiers' online-orders query (source in [web, manual]) and
        // firestore.rules' cashier read scope find manual orders too.
        source: "manual",
        // This is Sisley's manual/off-site order path -- a genuine employee
        // typed this order in, unlike a web checkout, so it's attributed as
        // the creator (never set for a real customer checkout).
        createdByUid: profile.id,
        createdByEmail: profile.email,
        createdByName: profile.displayName || profile.email,
      });
      await logActivity(profile, "order.created", orderNumber);
      toast.success(t("admin.orders.created"));
      setShowCreate(false);
      setForm({ customerName: "", customerEmail: "", customerPhone: "", shippingAddress: "", shippingCost: 0 });
      navigate(`/admin/orders/${id}`);
    } finally {
      setSaving(false);
    }
  }

  function openBulkStatus() {
    setBulkTargetStatus("");
    setBulkOutcomes(null);
    setShowBulkStatus(true);
  }

  function closeBulkStatus() {
    setShowBulkStatus(false);
    setBulkTargetStatus("");
    setBulkOutcomes(null);
  }

  // Promise.allSettled, deliberately not Promise.all: every existing bulk
  // action in this app (CustomerList.tsx, DiscountList.tsx) uses Promise.all,
  // where one rejection loses the whole batch with no record of which items
  // had already succeeded. A status change spans a much larger, much more
  // varied selection than "delete these few rows I just picked" -- losing
  // that visibility here is exactly the gap the bulk-status-update spec
  // calls out by name, so this path intentionally does it differently:
  // every order gets its own settled outcome, good or bad, and nothing about
  // one order's failure stops or hides another's success.
  //
  // Each order's eligibility+write goes through updateOrderStatusIfEligible()
  // (firebase/orderBulkStatusUpdate.ts), one Firestore transaction per order,
  // rather than checking eligibility here against this component's own
  // (onSnapshot-cached, potentially stale) `orders` state and then issuing a
  // bare update: that would leave a real race where an order cancelled by
  // someone else a moment ago could still look "pending" here and get
  // silently moved to another status with its already-restored stock never
  // re-decremented. The transaction re-reads and re-checks status itself,
  // right before writing, so this can't happen no matter how stale this
  // page's own copy of `orders` is.
  async function runBulkStatusUpdate() {
    if (!profile || !bulkTargetStatus) return;
    const targetStatus = bulkTargetStatus;
    const targets = orders.filter((o) => selected.has(o.id));
    setBulkRunning(true);
    try {
      const outcomes = await Promise.allSettled(
        targets.map(async (order): Promise<BulkStatusOutcome> => {
          try {
            await updateOrderStatusIfEligible(order.id, targetStatus, { uid: profile.id, email: profile.email, displayName: profile.displayName });
            // Per-order entry, same action code / target shape the single-
            // order OrderDetail.tsx update already writes -- so this order's
            // own activity history reads identically whether it was updated
            // one at a time or as part of a batch.
            if (profile) await logActivity(profile, "order.statusUpdated", `#${order.orderNumber} → ${t(`admin.orderStatus.${targetStatus}`)}`);
            return { orderId: order.id, orderNumber: order.orderNumber, ok: true };
          } catch (err) {
            if (err instanceof BulkStatusUpdateError) {
              return { orderId: order.id, orderNumber: order.orderNumber, ok: false, reasonKey: err.reasonKey, errorMessage: err.reasonKey ? undefined : err.message };
            }
            return { orderId: order.id, orderNumber: order.orderNumber, ok: false, errorMessage: err instanceof Error ? err.message : String(err) };
          }
        })
      ).then((settled) =>
        // The map body above never itself throws (every failure path returns
        // a { ok: false } outcome instead) -- this .then() only exists to
        // unwrap Promise.allSettled's { status, value } envelope, not to
        // handle a genuine rejection. A defensive fallback outcome covers the
        // theoretical case anyway, so a single unexpected throw still can't
        // take down the rest of the batch's reporting.
        settled.map((r, i) =>
          r.status === "fulfilled" ? r.value : { orderId: targets[i].id, orderNumber: targets[i].orderNumber, ok: false, errorMessage: String(r.reason) }
        )
      );

      const { succeeded, failed, total } = summarizeBulkStatusOutcomes(outcomes);
      const statusLabel = t(`admin.orderStatus.${targetStatus}`);
      await logActivity(
        profile,
        "order.bulkStatusUpdated",
        `${total} ${t("admin.orders.colOrder")} → ${statusLabel}`,
        `${succeeded} ${t("admin.orders.bulk.done")}, ${failed} ${t("admin.orders.bulk.failedListTitle")}`
      );

      setBulkOutcomes(outcomes);
      if (failed === 0) {
        toast.success(
          (succeeded === 1 ? t("admin.orders.bulk.resultAllSucceededOne") : t("admin.orders.bulk.resultAllSucceededPlural"))
            .replace("{n}", String(succeeded))
            .replace("{status}", statusLabel)
        );
        setSelected(new Set());
      } else if (succeeded === 0) {
        toast.error(t("admin.orders.bulk.resultAllFailed").replace("{n}", String(failed)));
      } else {
        toast.error(t("admin.orders.bulk.resultPartial").replace("{success}", String(succeeded)).replace("{failed}", String(failed)));
        // Only the orders that actually failed stay selected -- the ones
        // that succeeded are done, no reason to keep offering to re-run them.
        setSelected(new Set(outcomes.filter((o) => !o.ok).map((o) => o.orderId)));
      }
    } finally {
      setBulkRunning(false);
    }
  }

  const columns: DataTableColumn<AdminOrder>[] = [
    { key: "orderNumber", header: t("admin.orders.colOrder"), sortValue: (o) => o.orderNumber, render: (o) => <span className="font-semibold text-ink">#{o.orderNumber}</span> },
    { key: "customer", header: t("admin.orders.colCustomer"), sortValue: (o) => o.customerName, render: (o) => {
      // Every line's Branch Stock Note (order.lineBranchStockNotes, keyed by
      // returnLineKey — same map, same key OrderDetail.tsx itself reads/
      // writes), in product-line order, joined for a compact summary here on
      // the main Orders page — without opening the order. Never a count:
      // each note's own text is preserved and shown, exactly as the OLD
      // Sisley system surfaced a single note's text on its order card.
      const noteTexts = lineBranchStockNoteTexts(o);
      const noteSummary = noteTexts.length > 0 ? noteTexts.join(" / ") : null;
      return (
        <div>
          <p className="font-medium text-ink">{o.customerName}</p>
          {/* Email may not exist for a manual/off-site order — fall back to
              phone so this line isn't left blank for that (now common) case. */}
          <p className="text-xs text-ink-faint">{o.customerEmail || o.customerPhone}</p>
          {noteSummary && (
            <p className="mt-0.5 max-w-[16rem] truncate text-xs italic text-wine-dark" title={noteSummary}>
              {noteSummary}
            </p>
          )}
        </div>
      );
    } },
    { key: "items", header: t("admin.orders.colItems"), sortValue: (o) => o.lines.length, render: (o) => o.lines.length },
    { key: "total", header: t("admin.orders.colTotal"), sortValue: (o) => o.total, render: (o) => <span className="font-semibold">{formatPrice(o.total)}</span> },
    { key: "status", header: t("admin.products.colStatus"), sortValue: (o) => o.status, render: (o) => <Badge tone={STATUS_TONE[o.status]}>{t(`admin.orderStatus.${o.status}`)}</Badge> },
  ];

  return (
    <div>
      <PageHeader
        title={t("admin.nav.orders")}
        description={`${orders.length} ${t("admin.products.total")}`}
        actions={
          <>
            {/* Read-only lookup -- see ProductAvailabilityCheckModal.tsx for
                why this lives here rather than inside AddOrderItemModal or
                POS. Reuses this page's own already-live `orders` (no new
                Firestore listener for orders). */}
            <AdminButton variant="secondary" icon="barcode" onClick={() => setShowAvailabilityCheck(true)}>
              {t("admin.orders.availabilityCheck.button")}
            </AdminButton>
            <AdminButton variant="primary" icon="plus" onClick={() => setShowCreate(true)}>{t("admin.orders.newOrder")}</AdminButton>
          </>
        }
      />

      <OrderStatusCards counts={statusCounts} activeStatus={statusFilter} onSelectStatus={setStatusFilter} />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SearchInput value={search} onChange={setSearch} placeholder={t("admin.orders.searchPlaceholder")} />
        {/* "Completed" (the POS in-store terminal state) is deliberately not
            offered here -- this filter mirrors the shipping/preparation
            workflow's exact 7-status list, in order; a completed POS sale
            still shows up under "All". "Ready" is filterable like any other
            status even though it can never be manually SET (see the single-
            order and bulk status pickers below). */}
        <AdminSelect value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="w-auto">
          <option value="all">{t("admin.products.allStatuses")}</option>
          <option value="pending">{t("admin.orderStatus.pending")}</option>
          <option value="processing">{t("admin.orderStatus.processing")}</option>
          <option value="ready">{t("admin.orderStatus.ready")}</option>
          <option value="shipped">{t("admin.orderStatus.shipped")}</option>
          <option value="delivered">{t("admin.orderStatus.delivered")}</option>
          <option value="cancelled">{t("admin.orderStatus.cancelled")}</option>
          <option value="refunded">{t("admin.orderStatus.refunded")}</option>
        </AdminSelect>
      </div>

      {canWrite && (
        <BulkActionBar count={selected.size} onClear={() => setSelected(new Set())}>
          <AdminButton size="sm" variant="ghost" className="!text-paper hover:!bg-paper/15" onClick={openBulkStatus}>
            {t("admin.orders.bulk.changeStatus")}
          </AdminButton>
        </BulkActionBar>
      )}

      <DataTable
        columns={columns}
        rows={filtered}
        getId={(o) => o.id}
        loading={loading}
        selectable={canWrite}
        selected={selected}
        onSelectionChange={setSelected}
        onRowClick={(o) => navigate(`/admin/orders/${o.id}`)}
        defaultSort="orderNumber"
        emptyState={
          <EmptyState
            icon="bag"
            title={t("admin.orders.noneYet")}
            body={t("admin.orders.emptyBody")}
            action={<AdminButton variant="primary" icon="plus" onClick={() => setShowCreate(true)}>{t("admin.orders.newOrder")}</AdminButton>}
          />
        }
      />

      <Modal open={showCreate} onClose={() => setShowCreate(false)} title={t("admin.orders.newOrder")} width="sm">
        <div className="flex flex-col gap-4">
          <Field label={t("admin.orders.customerName")} required>
            <AdminInput value={form.customerName} onChange={(e) => setForm((f) => ({ ...f, customerName: e.target.value }))} />
          </Field>
          <Field label={t("admin.orders.customerPhone")} hint={t("admin.orders.customerPhoneHint")}>
            <AdminInput type="tel" value={form.customerPhone} onChange={(e) => setForm((f) => ({ ...f, customerPhone: e.target.value }))} />
          </Field>
          <NonDeliveryWarningBanner name={form.customerName} phone={form.customerPhone} />
          {/* Optional — Sisley's manual/off-site orders are identified by
              name + phone; many customers don't have an email at all. */}
          <Field label={t("admin.orders.customerEmail")}>
            <AdminInput type="email" value={form.customerEmail} onChange={(e) => setForm((f) => ({ ...f, customerEmail: e.target.value }))} />
          </Field>
          <Field label={t("admin.orders.shippingAddress")} hint={t("admin.orders.shippingAddressHint")}>
            <AdminTextarea
              rows={2}
              value={form.shippingAddress}
              onChange={(e) => setForm((f) => ({ ...f, shippingAddress: e.target.value }))}
            />
          </Field>
          <Field label={t("admin.orders.shippingCost")} hint={t("admin.orders.shippingCostHint")}>
            <AdminNumberInput
              min={0}
              value={form.shippingCost}
              onChange={(v) => v !== null && setForm((f) => ({ ...f, shippingCost: v }))}
            />
          </Field>
          {/* Total is never independently typed — see handleCreate()'s own
              comment for why it's always derived (subtotal + shipping, same
              as every other order), shown here read-only so that's obvious
              rather than inviting a value that can't actually be saved. */}
          <Field label={t("admin.orders.colTotal")} hint={t("admin.orders.totalHint")}>
            <AdminInput type="text" value={formatPrice(form.shippingCost)} disabled />
          </Field>
          <AdminButton variant="primary" loading={saving} className="w-full justify-center" onClick={handleCreate}>
            {t("admin.orders.createOrder")}
          </AdminButton>
        </div>
      </Modal>

      <Modal
        open={showBulkStatus}
        onClose={bulkRunning ? () => {} : closeBulkStatus}
        title={t("admin.orders.bulk.changeStatus")}
        width="sm"
      >
        {bulkOutcomes ? (
          <div className="flex flex-col gap-4">
            {(() => {
              const { succeeded, failed } = summarizeBulkStatusOutcomes(bulkOutcomes);
              return (
                <p className="text-sm font-semibold text-ink">
                  {failed === 0
                    ? (succeeded === 1 ? t("admin.orders.bulk.resultAllSucceededOne") : t("admin.orders.bulk.resultAllSucceededPlural"))
                        .replace("{n}", String(succeeded))
                        .replace("{status}", bulkTargetStatus ? t(`admin.orderStatus.${bulkTargetStatus}`) : "")
                    : succeeded === 0
                      ? t("admin.orders.bulk.resultAllFailed").replace("{n}", String(failed))
                      : t("admin.orders.bulk.resultPartial").replace("{success}", String(succeeded)).replace("{failed}", String(failed))}
                </p>
              );
            })()}
            {bulkOutcomes.some((o) => !o.ok) && (
              <div>
                <p className="mb-1.5 text-xs font-bold uppercase tracking-wide text-ink-faint">{t("admin.orders.bulk.failedListTitle")}</p>
                <ul className="flex flex-col gap-1 rounded-lg bg-cream-dim px-3 py-2.5 text-sm">
                  {bulkOutcomes
                    .filter((o) => !o.ok)
                    .map((o) => (
                      <li key={o.orderId} className="flex justify-between gap-3 text-ink-soft">
                        <span className="font-semibold text-ink">#{o.orderNumber}</span>
                        <span>{o.reasonKey ? t(o.reasonKey) : o.errorMessage}</span>
                      </li>
                    ))}
                </ul>
              </div>
            )}
            <AdminButton variant="secondary" className="w-full justify-center" onClick={closeBulkStatus}>
              {t("admin.orders.bulk.done")}
            </AdminButton>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <Field label={t("admin.orders.bulk.selectStatusLabel")} required>
              <AdminSelect value={bulkTargetStatus} onChange={(e) => setBulkTargetStatus(e.target.value as OrderStatus)} disabled={bulkRunning}>
                <option value="" disabled>
                  {t("admin.orders.bulk.selectStatusPlaceholder")}
                </option>
                {BULK_ORDER_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {t(`admin.orderStatus.${s}`)}
                  </option>
                ))}
              </AdminSelect>
            </Field>
            {bulkTargetStatus && (
              <p className="text-sm text-ink-soft">
                {(selected.size === 1 ? t("admin.orders.bulk.confirmTextOne") : t("admin.orders.bulk.confirmTextPlural"))
                  .replace("{n}", String(selected.size))
                  .replace("{status}", t(`admin.orderStatus.${bulkTargetStatus}`))}
              </p>
            )}
            <AdminButton
              variant="primary"
              loading={bulkRunning}
              disabled={!bulkTargetStatus}
              className="w-full justify-center"
              onClick={runBulkStatusUpdate}
            >
              {(selected.size === 1 ? t("admin.orders.bulk.updateButtonOne") : t("admin.orders.bulk.updateButtonPlural")).replace("{n}", String(selected.size))}
            </AdminButton>
          </div>
        )}
      </Modal>

      <ProductAvailabilityCheckModal open={showAvailabilityCheck} onClose={() => setShowAvailabilityCheck(false)} orders={orders} ordersLoading={loading} />
    </div>
  );
}
