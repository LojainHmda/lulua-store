import { useEffect, useMemo, useRef, useState } from "react";
import { useLanguage } from "../../../context/LanguageContext";
import { LocationStockEditError, saveLocationStock } from "../../../firebase/locationStockEdit";
import { useAdminAuth } from "../../AdminAuthContext";
import { Modal } from "../../components/Modal";
import { useToast } from "../../components/ToastContext";
import { AdminButton, AdminInput, AdminSelect, Field } from "../../components/ui";
import { parseQty } from "../../stockReceipt";
import { STOCK_ADJUSTMENT_REASONS, type AdminColorVariant, type StockAdjustmentReason } from "../../types";

interface CellDraft {
  variantId: string;
  colorName: string;
  size: string;
  current: number | null; // as loaded when the popup opened
  text: string;
}

// Edit one location's stock (online store or a branch) per color × size.
// Nothing is written until Save; Save is one transaction (saveLocationStock)
// that refuses if any edited count changed in the meantime.
export default function LocationStockEditModal({
  open,
  onClose,
  product,
  variants,
  locationId,
  locationLabel,
  currentQty,
}: {
  open: boolean;
  onClose: () => void;
  product: { id: string; name: string };
  variants: AdminColorVariant[];
  locationId: string;
  locationLabel: string;
  currentQty: (locationId: string, variantId: string, size: string) => number | null;
}) {
  const { t, lang } = useLanguage();
  const toast = useToast();
  const { profile } = useAdminAuth();
  const [cells, setCells] = useState<CellDraft[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState<StockAdjustmentReason>("recount");
  const [note, setNote] = useState("");
  const submitting = useRef(false);

  // Snapshot the counts once, when the popup opens — live changes after that
  // are caught at save time instead of silently changing what's on screen.
  useEffect(() => {
    if (!open) return;
    setCells(
      variants.flatMap((v) =>
        v.sizeStock.map((s) => {
          const current = currentQty(locationId, v.id, s.size);
          return { variantId: v.id, colorName: v.colorName, size: s.size, current, text: current === null ? "" : String(current) };
        })
      )
    );
    setError(null);
    setReason("recount");
    setNote("");
    // Only when opened / for a different location.
  }, [open, locationId]);

  const rows = useMemo(
    () =>
      cells.map((c) => {
        // An unconfirmed online count left blank stays unconfirmed (no change).
        const untouchedUnknown = c.current === null && c.text.trim() === "";
        const parsed = untouchedUnknown ? null : parseQty(c.text);
        const value = parsed?.ok ? parsed.value : null;
        const changed = parsed?.ok === true && value !== c.current;
        return { ...c, parsed, value, changed, diff: changed && value !== null ? value - (c.current ?? 0) : 0 };
      }),
    [cells]
  );
  const invalid = rows.some((r) => r.parsed && !r.parsed.ok);
  const changedRows = rows.filter((r) => r.changed);
  const plus = changedRows.reduce((s, r) => s + Math.max(0, r.diff), 0);
  const minus = changedRows.reduce((s, r) => s + Math.max(0, -r.diff), 0);
  // "Other" says nothing on its own, so it needs a written explanation.
  const noteMissing = reason === "other" && note.trim() === "";
  const canSave = !invalid && changedRows.length > 0 && !noteMissing && !saving;

  function setText(i: number, text: string) {
    setCells((cs) => cs.map((c, j) => (j === i ? { ...c, text } : c)));
  }

  async function save() {
    if (!profile || submitting.current || !canSave) return;
    submitting.current = true;
    setSaving(true);
    setError(null);
    try {
      await saveLocationStock(
        product,
        locationId,
        changedRows.map((r) => ({ variantId: r.variantId, colorName: r.colorName, size: r.size, expected: r.current, qty: r.value as number })),
        { code: reason, note },
        { uid: profile.id, email: profile.email, displayName: profile.displayName }
      );
      toast.success(t("admin.locationStock.edit.saved"));
      onClose();
    } catch (e) {
      setError(e instanceof LocationStockEditError ? t(`admin.locationStock.edit.err.${e.code}`) : t("admin.locationStock.edit.saveFailed"));
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  }

  const colorLabel = (v: AdminColorVariant) => (lang === "ar" && v.colorNameAr ? v.colorNameAr : v.colorName) || "—";

  return (
    <Modal open={open} onClose={saving ? () => {} : onClose} title={`${t("admin.locationStock.edit.title")} — ${locationLabel}`} width="lg">
      <div className="flex flex-col gap-4">
        <p className="text-sm text-ink-soft">{t("admin.locationStock.edit.intro")}</p>

        {variants.map((v) => (
          <div key={v.id} className="overflow-hidden rounded-xl border border-line">
            <div className="flex items-center gap-2 border-b border-line bg-cream-dim/50 px-4 py-2">
              <span className="h-3.5 w-3.5 rounded-full border border-line" style={{ background: v.colorHex }} />
              <span className="text-sm font-semibold text-ink">{colorLabel(v)}</span>
            </div>
            <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 md:grid-cols-5">
              {rows.map((r, i) =>
                r.variantId !== v.id ? null : (
                  <div key={r.size} className={`rounded-lg border p-2.5 ${r.changed ? "border-wine/60 bg-wine-light/30" : "border-line"}`}>
                    <div className="mb-1.5 flex items-baseline justify-between text-xs">
                      <span className="font-bold text-ink">{r.size}</span>
                      <span className="text-ink-faint">
                        {t("admin.locationStock.edit.now")} {r.current ?? "?"}
                      </span>
                    </div>
                    <AdminInput
                      inputMode="numeric"
                      value={r.text}
                      placeholder={r.current === null ? "?" : "0"}
                      onChange={(e) => setText(i, e.target.value)}
                      aria-label={`${colorLabel(v)} ${r.size}`}
                      className={`!py-1.5 text-center text-base font-semibold tabular-nums ${r.parsed && !r.parsed.ok ? "!border-wine" : ""}`}
                    />
                    <div className="mt-1 h-4 text-center text-[11px] font-semibold">
                      {r.parsed && !r.parsed.ok ? (
                        <span className="text-wine">{t(`admin.stockReceipt.err.${r.parsed.error}`)}</span>
                      ) : r.changed ? (
                        <span className={r.diff >= 0 ? "text-olive" : "text-wine"}>{r.diff >= 0 ? `+${r.diff}` : `−${-r.diff}`}</span>
                      ) : null}
                    </div>
                  </div>
                )
              )}
            </div>
          </div>
        ))}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[14rem_1fr]">
          <Field label={t("admin.locationStock.edit.reason")} required>
            <AdminSelect value={reason} onChange={(e) => setReason(e.target.value as StockAdjustmentReason)}>
              {STOCK_ADJUSTMENT_REASONS.map((r) => (
                <option key={r} value={r}>
                  {t(`admin.locationStock.edit.reasons.${r}`)}
                </option>
              ))}
            </AdminSelect>
          </Field>
          <Field label={t("admin.locationStock.edit.note")} required={reason === "other"}>
            <AdminInput value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder={t("admin.locationStock.edit.notePlaceholder")} className={noteMissing && changedRows.length > 0 ? "!border-wine" : ""} />
          </Field>
        </div>

        {error && <p className="rounded-lg bg-wine-light px-3 py-2 text-sm text-wine">{error}</p>}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
          <span className="text-sm text-ink-soft">
            {changedRows.length === 0
              ? t("admin.locationStock.edit.noChanges")
              : noteMissing
                ? <span className="text-wine">{t("admin.locationStock.edit.noteRequired")}</span>
                : t("admin.locationStock.edit.summary")
                  .replace("{n}", String(changedRows.length))
                  .replace("{plus}", String(plus))
                  .replace("{minus}", String(minus))}
          </span>
          <div className="flex gap-2">
            <AdminButton variant="ghost" disabled={saving} onClick={onClose}>
              {t("admin.common.cancel")}
            </AdminButton>
            <AdminButton variant="primary" loading={saving} disabled={!canSave} onClick={save}>
              {t("admin.settings.save")}
            </AdminButton>
          </div>
        </div>
      </div>
    </Modal>
  );
}
