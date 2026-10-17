import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { serverTimestamp } from "../../../db/firestore";
import { ordersApi } from "../../../firebase/collections";
import { useLanguage } from "../../../context/LanguageContext";
import { useAdminAuth } from "../../AdminAuthContext";
import { useToast } from "../../components/ToastContext";
import { AdminButton, AdminTextarea, Badge, Card, PageLoading } from "../../components/ui";
import { logActivity } from "../../logActivity";
import { useOrder } from "./useOrder";

function formatMarkedAt(value: unknown): string {
  const ts = value as { toDate?: () => Date } | undefined;
  const date = ts?.toDate ? ts.toDate() : null;
  // Explicit locale for the same reason as NonDeliveryWarningBanner's
  // formatOrderDate — avoids invisible bidi marks from the browser/OS
  // default locale garbling the visible digit order.
  return date ? date.toLocaleString("en-GB") : "";
}

// Dedicated page for one order's Notes / Non-Delivery / Branch Stock Note --
// extracted verbatim out of OrderDetail.tsx's former "Internal Information"
// accordion (see that file's history). Each subsection keeps its exact save
// function, data fields, and permission checks; the accordion/collapse
// wrapper itself is gone since this is now an opt-in dedicated page rather
// than a section permanently on the main workspace -- there's nothing left
// to collapse against. The underlying non-delivery warning/data is
// unchanged and still visible here, just no longer auto-expanded on Order
// Detail itself.
export default function OrderInternalInfo() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { t } = useLanguage();
  const { profile, hasRole } = useAdminAuth();
  const canWrite = hasRole(["owner", "admin"]);
  const { order, setOrder, loading } = useOrder(id);

  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [nonDeliveryNote, setNonDeliveryNote] = useState("");
  const [markingNonDelivery, setMarkingNonDelivery] = useState(false);

  // Keyed on the order id only (not the whole `order` object) -- seeds these
  // fields once when this order first loads. markNonDelivery() below calls
  // setOrder() afterward with a new object reference for the same order id;
  // if this effect re-ran from that, it would discard an in-progress,
  // unsaved edit to Notes or the Branch Stock Note the moment the employee
  // used a different save action on this same page.
  useEffect(() => {
    if (!order) return;
    setNotes(order.notes ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?.id]);

  async function saveNotes() {
    if (!order || !profile) return;
    setSaving(true);
    try {
      await ordersApi.update(order.id, {
        notes,
        internalNoteUpdatedByUid: profile.id,
        internalNoteUpdatedByEmail: profile.email,
        internalNoteUpdatedByName: profile.displayName || profile.email,
        internalNoteUpdatedAt: serverTimestamp(),
      });
      await logActivity(profile, "order.notesUpdated", `#${order.orderNumber}`);
      toast.success(t("admin.orderDetail.notesSaved"));
    } finally {
      setSaving(false);
    }
  }

  async function markNonDelivery() {
    if (!order || !profile) return;
    setMarkingNonDelivery(true);
    try {
      const note = nonDeliveryNote.trim() || undefined;
      await ordersApi.update(order.id, {
        nonDeliveryFlagged: true,
        nonDeliveryNote: note,
        nonDeliveryMarkedBy: profile.email,
        nonDeliveryMarkedByName: profile.displayName || profile.email,
        nonDeliveryMarkedByUid: profile.id,
        nonDeliveryMarkedAt: serverTimestamp(),
      });
      // Optimistic local timestamp only — the write above used
      // serverTimestamp(), so this is purely so the badge/meta line has
      // something to render immediately without a re-fetch.
      setOrder({
        ...order,
        nonDeliveryFlagged: true,
        nonDeliveryNote: note,
        nonDeliveryMarkedBy: profile.email,
        nonDeliveryMarkedByName: profile.displayName || profile.email,
        nonDeliveryMarkedByUid: profile.id,
        nonDeliveryMarkedAt: new Date(),
      });
      await logActivity(profile, "order.markedNonDelivery", `#${order.orderNumber}`);
      toast.success(t("admin.orderDetail.nonDelivery.marked"));
    } catch {
      toast.error(t("admin.orderDetail.nonDelivery.markFailed"));
    } finally {
      setMarkingNonDelivery(false);
    }
  }

  if (loading) return <PageLoading />;
  if (!order) {
    return (
      <div className="text-center text-ink-soft">
        {t("admin.orderDetail.notFound")}{" "}
        <button onClick={() => navigate("/admin/orders")} className="font-semibold text-wine hover:underline">
          {t("admin.orderDetail.backToOrders")}
        </button>
      </div>
    );
  }

  return (
    <div className="pb-16">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
            {t("admin.orderDetail.orderHash")}
            {order.orderNumber}
          </p>
          <h1 className="mt-1 font-display text-2xl font-bold text-ink">{t("admin.orderDetail.internalInfo.title")}</h1>
        </div>
        <AdminButton variant="secondary" onClick={() => navigate(`/admin/orders/${order.id}`)}>
          {t("admin.orderDetail.backToOrder")}
        </AdminButton>
      </div>

      <Card className="max-w-xl p-5">
        <div className="flex flex-col gap-4">
          <div>
            <h2 className="mb-2 font-display text-base font-bold text-ink">{t("admin.customers.notes")}</h2>
            <AdminTextarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} disabled={!canWrite} placeholder={t("admin.orderDetail.notesPlaceholder")} />
            {canWrite && (
              <AdminButton variant="secondary" size="sm" className="mt-3" loading={saving} onClick={saveNotes}>
                {t("admin.orderDetail.saveNotes")}
              </AdminButton>
            )}
          </div>

          <div className="border-t border-line pt-4">
            <h2 className="mb-3 font-display text-base font-bold text-ink">{t("admin.orderDetail.nonDelivery.title")}</h2>
            {order.nonDeliveryFlagged ? (
              <div className="flex flex-col gap-1.5 rounded-lg bg-wine-light px-3.5 py-3">
                <Badge tone="danger">{t("admin.orderDetail.nonDelivery.flaggedBadge")}</Badge>
                {order.nonDeliveryNote && <p className="text-sm text-wine">{order.nonDeliveryNote}</p>}
                <p className="text-xs text-wine/80">
                  {t("admin.orderDetail.nonDelivery.markedMeta")
                    .replace("{name}", order.nonDeliveryMarkedByName ?? "")
                    .replace("{date}", formatMarkedAt(order.nonDeliveryMarkedAt))}
                </p>
              </div>
            ) : canWrite ? (
              <div className="flex flex-col gap-2.5">
                <p className="text-sm text-ink-soft">{t("admin.orderDetail.nonDelivery.hint")}</p>
                <AdminTextarea
                  rows={2}
                  value={nonDeliveryNote}
                  onChange={(e) => setNonDeliveryNote(e.target.value)}
                  placeholder={t("admin.orderDetail.nonDelivery.notePlaceholder")}
                />
                <AdminButton variant="secondary" size="sm" loading={markingNonDelivery} onClick={markNonDelivery}>
                  {t("admin.orderDetail.nonDelivery.markButton")}
                </AdminButton>
              </div>
            ) : (
              <p className="text-sm text-ink-faint">{t("admin.orderDetail.nonDelivery.notFlagged")}</p>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
