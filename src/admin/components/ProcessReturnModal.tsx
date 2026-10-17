import { useEffect, useMemo, useState } from "react";
import { where } from "../../db/firestore";
import { Modal } from "./Modal";
import { AdminButton, AdminSelect, AdminTextarea, Field } from "./ui";
import { useToast } from "./ToastContext";
import { useLanguage } from "../../context/LanguageContext";
import type { Actor } from "../actor";
import { returnsApi, productsApi } from "../../firebase/collections";
import { createReturn, ReturnIntakeError } from "../../firebase/returnsTransaction";
import { alreadyReturnedQtyForLine, RETURN_REASON_LABEL_KEY } from "../returnsHelpers";
import type { AdminOrder, AdminReturn, ReturnReason } from "../types";

const REASONS: ReturnReason[] = ["defective", "wrong_size", "wrong_color", "changed_mind", "fulfillment_error", "shipping_error", "other"];

interface ProcessReturnModalProps {
  open: boolean;
  onClose: () => void;
  order: AdminOrder;
  actor: Actor;
  onCreated?: (returnId: string) => void;
}

export default function ProcessReturnModal({ open, onClose, order, actor, onCreated }: ProcessReturnModalProps) {
  const { t } = useLanguage();
  const toast = useToast();
  const [existingReturns, setExistingReturns] = useState<AdminReturn[]>([]);
  const [skuByProductId, setSkuByProductId] = useState<Record<string, string | undefined>>({});
  const [lineIndex, setLineIndex] = useState(0);
  const [qty, setQty] = useState(1);
  const [reason, setReason] = useState<ReturnReason>("defective");
  const [reasonNote, setReasonNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLineIndex(0);
    setQty(1);
    setReason("defective");
    setReasonNote("");
    setError(null);
    returnsApi.list([where("orderId", "==", order.id)]).then(setExistingReturns);
    const distinctProductIds = [...new Set(order.lines.map((l) => l.productId))];
    Promise.all(distinctProductIds.map((id) => productsApi.get(id))).then((products) => {
      const map: Record<string, string | undefined> = {};
      products.forEach((p, i) => {
        map[distinctProductIds[i]] = p?.sku;
      });
      setSkuByProductId(map);
    });
  }, [open, order.id, order.lines]);

  const line = order.lines[lineIndex];
  const alreadyReturned = useMemo(
    () => (line ? alreadyReturnedQtyForLine(existingReturns, order.id, line.productId, line.variantId, line.size) : 0),
    [existingReturns, order.id, line]
  );
  const maxQty = line ? Math.max(0, line.qty - alreadyReturned) : 0;

  useEffect(() => {
    setQty((q) => Math.min(Math.max(1, q), Math.max(1, maxQty)));
  }, [maxQty]);

  async function handleSubmit() {
    if (!line) return;
    if (maxQty <= 0) {
      setError(t("admin.returns.form.noneLeftToReturn"));
      return;
    }
    if (qty < 1 || qty > maxQty) {
      setError(t("admin.returns.form.invalidQty"));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const id = await createReturn(
        {
          orderId: order.id,
          orderNumber: order.orderNumber,
          customerId: order.customerId,
          customerName: order.customerName,
          customerEmail: order.customerEmail ?? "",
          productId: line.productId,
          productName: line.name,
          variantId: line.variantId,
          colorName: line.color,
          size: line.size,
          sku: skuByProductId[line.productId],
          qty,
          reason,
          reasonNote: reasonNote.trim() || undefined,
        },
        actor
      );
      toast.success(t("admin.returns.form.created"));
      onCreated?.(id);
      onClose();
    } catch (err) {
      // A ReturnIntakeError means the server-side returnCounters cap in
      // firestore.rules caught a genuine over-return (most likely a race
      // with another concurrent return on the same line, since the
      // client-side alreadyReturnedQtyForLine() check above already
      // prevents the common case) — its message is specific and safe to
      // show directly, unlike a raw Firestore permission-denied.
      setError(err instanceof ReturnIntakeError ? err.message : t("admin.returns.form.createFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={t("admin.returns.form.title")} width="md">
      <div className="flex flex-col gap-4">
        <p className="text-sm text-ink-soft">
          {t("admin.returns.form.subtitle")} #{order.orderNumber}
        </p>

        <Field label={t("admin.returns.form.item")}>
          <AdminSelect value={lineIndex} onChange={(e) => setLineIndex(Number(e.target.value))}>
            {order.lines.map((l, i) => (
              <option key={i} value={i}>
                {l.name} — {l.color} / {l.size} (×{l.qty})
              </option>
            ))}
          </AdminSelect>
        </Field>

        <p className="-mt-2 text-xs text-ink-faint">
          {t("admin.returns.form.alreadyReturned")} {alreadyReturned} / {line?.qty ?? 0}
        </p>

        <Field label={t("admin.returns.form.qty")} required>
          <AdminSelect value={qty} onChange={(e) => setQty(Number(e.target.value))} disabled={maxQty <= 0}>
            {Array.from({ length: Math.max(1, maxQty) }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </AdminSelect>
        </Field>

        <Field label={t("admin.returns.form.reason")} required>
          <AdminSelect value={reason} onChange={(e) => setReason(e.target.value as ReturnReason)}>
            {REASONS.map((r) => (
              <option key={r} value={r}>
                {t(RETURN_REASON_LABEL_KEY[r])}
              </option>
            ))}
          </AdminSelect>
        </Field>

        <Field label={t("admin.returns.form.note")} hint={t("admin.returns.form.noteHint")}>
          <AdminTextarea value={reasonNote} onChange={(e) => setReasonNote(e.target.value)} rows={3} />
        </Field>

        {error && <p className="rounded-lg bg-wine-light px-3 py-2.5 text-sm font-semibold text-wine">{error}</p>}

        <div className="mt-1 flex justify-end gap-2">
          <AdminButton variant="ghost" onClick={onClose}>
            {t("admin.common.cancel")}
          </AdminButton>
          <AdminButton variant="primary" onClick={handleSubmit} loading={submitting} disabled={maxQty <= 0}>
            {t("admin.returns.form.submit")}
          </AdminButton>
        </div>
      </div>
    </Modal>
  );
}
