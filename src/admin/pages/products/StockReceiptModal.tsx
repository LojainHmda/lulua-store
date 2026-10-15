import { useEffect, useMemo, useRef, useState } from "react";
import { useLanguage } from "../../../context/LanguageContext";
import { receiveStock, StockReceiptError } from "../../../firebase/stockReceipt";
import { useAdminAuth } from "../../AdminAuthContext";
import { Modal } from "../../components/Modal";
import { useToast } from "../../components/ToastContext";
import { AdminButton, AdminInput, AdminSelect, AdminTextarea, Field } from "../../components/ui";
import { newReceiptId, validateReceipt, type QtyParse, type ReceiptLineDraft } from "../../stockReceipt";
import type { AdminColorVariant } from "../../types";

export interface ReceiptLocation {
  id: string;
  label: string;
}

interface Draft {
  receiptId: string;
  lines: ReceiptLineDraft[];
  reference: string;
  note: string;
  savedAt: number;
}

const draftKey = (productId: string) => `stockReceiptDraft:${productId}`;

function readDraft(productId: string): Draft | null {
  try {
    const raw = localStorage.getItem(draftKey(productId));
    return raw ? (JSON.parse(raw) as Draft) : null;
  } catch {
    return null;
  }
}
function writeDraft(productId: string, draft: Draft | null) {
  try {
    if (draft) localStorage.setItem(draftKey(productId), JSON.stringify(draft));
    else localStorage.removeItem(draftKey(productId));
  } catch {
    // Storage unavailable (private mode etc.) — the draft just isn't kept.
  }
}

function blankLines(variants: AdminColorVariant[]): ReceiptLineDraft[] {
  return variants.flatMap((v) => v.sizeStock.map((s) => ({ variantId: v.id, colorName: v.colorName, size: s.size, total: "", allocations: {} })));
}

// Keeps a restored draft's typed numbers for colors/sizes that still exist,
// and adds rows for any color/size created since.
function mergeDraftLines(variants: AdminColorVariant[], saved: ReceiptLineDraft[]): ReceiptLineDraft[] {
  return blankLines(variants).map((l) => saved.find((s) => s.variantId === l.variantId && s.size === l.size) ?? l);
}

const isDirty = (lines: ReceiptLineDraft[], reference: string, note: string) =>
  reference.trim() !== "" || note.trim() !== "" || lines.some((l) => l.total.trim() !== "" || Object.values(l.allocations).some((v) => v.trim() !== ""));

// "Add stock" wizard: enter how many units arrived per color/size and how
// they're split between the online store and each branch, review the
// before → after for every location, then confirm. Saving is one atomic
// transaction (receiveStock) — nothing is written until the final confirm.
export default function StockReceiptModal({
  open,
  onClose,
  product,
  variants,
  locations,
  currentQty,
}: {
  open: boolean;
  onClose: () => void;
  product: { id: string; name: string };
  variants: AdminColorVariant[];
  locations: ReceiptLocation[];
  currentQty: (locationId: string, variantId: string, size: string) => number | null;
}) {
  const { t, lang } = useLanguage();
  const toast = useToast();
  const { profile } = useAdminAuth();
  const [step, setStep] = useState<"edit" | "review">("edit");
  const [receiptId, setReceiptId] = useState(newReceiptId);
  const [lines, setLines] = useState<ReceiptLineDraft[]>([]);
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [restoredAt, setRestoredAt] = useState<number | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [fillTarget, setFillTarget] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Synchronous guard on top of the disabled button: two clicks in the same
  // frame can both get past `saving` before React re-renders.
  const submitting = useRef(false);

  const locationIds = useMemo(() => locations.map((l) => l.id), [locations]);

  // (Re)initialise every time the modal opens: restore an unfinished draft
  // for this product if there is one, otherwise start a fresh receipt.
  useEffect(() => {
    if (!open) return;
    const saved = readDraft(product.id);
    if (saved) {
      setReceiptId(saved.receiptId);
      setLines(mergeDraftLines(variants, saved.lines));
      setReference(saved.reference);
      setNote(saved.note);
      setRestoredAt(saved.savedAt);
    } else {
      setReceiptId(newReceiptId());
      setLines(blankLines(variants));
      setReference("");
      setNote("");
      setRestoredAt(null);
    }
    setStep("edit");
    setError(null);
    setConfirmDiscard(false);
    setFillTarget(locations[0]?.id ?? "");
    // Only on open — not when live stock under it changes.
  }, [open, product.id]);

  // Autosave the unfinished entry so closing the modal/tab doesn't lose it.
  useEffect(() => {
    if (!open || lines.length === 0) return;
    writeDraft(product.id, isDirty(lines, reference, note) ? { receiptId, lines, reference, note, savedAt: Date.now() } : null);
  }, [open, product.id, receiptId, lines, reference, note]);

  const validation = useMemo(() => validateReceipt(lines, locationIds), [lines, locationIds]);

  function setTotal(i: number, value: string) {
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, total: value } : l)));
  }
  function setAlloc(i: number, locationId: string, value: string) {
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, allocations: { ...l.allocations, [locationId]: value } } : l)));
  }
  // Puts each row's still-unallocated units into one location. Rows that
  // are over-allocated or have invalid numbers are left alone.
  function fillRemaining() {
    if (!fillTarget) return;
    setLines((ls) =>
      ls.map((l, i) => {
        const c = validation.lines[i];
        const tgt = c?.allocations[fillTarget];
        if (!c || !c.total.ok || c.remaining <= 0 || !tgt?.ok) return l;
        return { ...l, allocations: { ...l.allocations, [fillTarget]: String(tgt.value + c.remaining) } };
      })
    );
  }

  function discard() {
    writeDraft(product.id, null);
    setReceiptId(newReceiptId());
    setLines(blankLines(variants));
    setReference("");
    setNote("");
    setRestoredAt(null);
    setConfirmDiscard(false);
    setStep("edit");
    setError(null);
  }

  async function confirm() {
    if (!profile || submitting.current || !validation.canSave) return;
    submitting.current = true;
    setSaving(true);
    setError(null);
    try {
      const result = await receiveStock(
        { receiptId, product, lines, locationIds, reference, note },
        { uid: profile.id, email: profile.email, displayName: profile.displayName }
      );
      writeDraft(product.id, null);
      toast.success(t("admin.stockReceipt.saved").replace("{units}", String(result.units)));
      onClose();
    } catch (e) {
      if (e instanceof StockReceiptError && e.code === "duplicate") {
        // The same receipt already committed (e.g. a retry after a timeout):
        // nothing was added twice; just clear the finished draft.
        writeDraft(product.id, null);
        toast.success(t("admin.stockReceipt.alreadySaved"));
        onClose();
      } else {
        // The transaction either fully committed or not at all — on failure
        // no stock was changed, and the draft is still here to retry.
        setError(e instanceof StockReceiptError ? e.message : t("admin.stockReceipt.saveFailed"));
      }
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  }

  const qtyError = (p: QtyParse | undefined) => (p && !p.ok ? t(`admin.stockReceipt.err.${p.error}`) : null);
  const fmtNow = (q: number | null) => (q === null ? "?" : String(q));
  const byVariant = variants.map((v) => ({ v, rows: lines.map((l, i) => ({ l, i })).filter(({ l }) => l.variantId === v.id) }));
  const inputCls = "!px-2 !py-1.5 text-center tabular-nums";

  return (
    <Modal open={open} onClose={saving ? () => {} : onClose} title={`${t("admin.stockReceipt.title")} — ${product.name}`} width="xl">
      <div className="flex flex-col gap-4">
        {restoredAt && step === "edit" && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-sand/40 px-3 py-2 text-sm text-ink">
            <span>{t("admin.stockReceipt.draftRestored").replace("{time}", new Date(restoredAt).toLocaleString(lang === "ar" ? "ar" : "en-US", { dateStyle: "medium", timeStyle: "short" }))}</span>
          </div>
        )}

        {step === "edit" ? (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t("admin.stockReceipt.reference")} hint={t("admin.stockReceipt.referenceHint")}>
                <AdminInput value={reference} maxLength={80} onChange={(e) => setReference(e.target.value)} placeholder="INV-2026-0142" />
              </Field>
              <Field label={t("admin.stockReceipt.note")}>
                <AdminTextarea rows={1} value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder={t("admin.stockReceipt.notePlaceholder")} />
              </Field>
            </div>

            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-cream-dim/40 px-3 py-2 text-sm">
              <span className="text-ink-soft">{t("admin.stockReceipt.fillRemaining")}</span>
              <div className="w-48">
                <AdminSelect value={fillTarget} onChange={(e) => setFillTarget(e.target.value)} className="!py-1.5">
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.label}
                    </option>
                  ))}
                </AdminSelect>
              </div>
              <AdminButton size="sm" variant="secondary" onClick={fillRemaining}>
                {t("admin.stockReceipt.apply")}
              </AdminButton>
            </div>

            {byVariant.map(({ v, rows }) => (
              <div key={v.id} className="overflow-hidden rounded-xl border border-line">
                <div className="flex items-center gap-2 border-b border-line bg-cream-dim/60 px-3 py-2">
                  <span className="h-3.5 w-3.5 rounded-full border border-line" style={{ background: v.colorHex }} />
                  <span className="text-sm font-semibold text-ink">{lang === "ar" && v.colorNameAr ? v.colorNameAr : v.colorName}</span>
                </div>
                <div className="thin-scrollbar overflow-x-auto">
                  <table className="w-full border-collapse text-sm">
                    <thead>
                      <tr className="text-xs font-bold uppercase tracking-wide text-ink-faint">
                        <th className="w-16 px-3 py-2 text-start">{t("admin.stockReceipt.size")}</th>
                        <th className="w-28 px-2 py-2 text-center">{t("admin.stockReceipt.totalToAdd")}</th>
                        {locations.map((loc) => (
                          <th key={loc.id} className="min-w-[6.5rem] px-2 py-2 text-center normal-case">
                            {loc.label}
                          </th>
                        ))}
                        <th className="w-28 px-3 py-2 text-end">{t("admin.stockReceipt.check")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(({ l, i }) => {
                        const c = validation.lines[i];
                        const totalErr = qtyError(c?.total);
                        const touched = l.total.trim() !== "" || Object.values(l.allocations).some((x) => x.trim() !== "");
                        return (
                          <tr key={`${l.variantId}::${l.size}`} className="border-t border-line align-top">
                            <td className="px-3 py-2 font-semibold text-ink">{l.size}</td>
                            <td className="px-2 py-2">
                              <AdminInput inputMode="numeric" value={l.total} onChange={(e) => setTotal(i, e.target.value)} placeholder="0" aria-label={`${t("admin.stockReceipt.totalToAdd")} ${l.size}`} className={`${inputCls} font-semibold ${totalErr ? "!border-wine" : ""}`} />
                              {totalErr && <p className="mt-1 text-[11px] text-wine">{totalErr}</p>}
                            </td>
                            {locations.map((loc) => {
                              const err = qtyError(c?.allocations[loc.id]);
                              const now = currentQty(loc.id, l.variantId, l.size);
                              const add = c?.allocations[loc.id]?.ok ? (c.allocations[loc.id] as { value: number }).value : 0;
                              return (
                                <td key={loc.id} className="px-2 py-2">
                                  <AdminInput inputMode="numeric" value={l.allocations[loc.id] ?? ""} onChange={(e) => setAlloc(i, loc.id, e.target.value)} placeholder="0" aria-label={`${loc.label} ${l.size}`} className={`${inputCls} ${err ? "!border-wine" : ""}`} />
                                  <p className="mt-1 text-center text-[11px] text-ink-faint" dir="ltr">
                                    {add > 0 && now !== null ? `${now} → ${now + add}` : `${t("admin.stockReceipt.now")} ${fmtNow(now)}`}
                                  </p>
                                  {err && <p className="text-center text-[11px] text-wine">{err}</p>}
                                </td>
                              );
                            })}
                            <td className="px-3 py-2 text-end text-xs">
                              {!touched ? (
                                <span className="text-ink-faint">—</span>
                              ) : c && c.remaining === 0 && c.total.ok ? (
                                <span className="font-semibold text-olive">✓ {c.allocated}</span>
                              ) : c && c.remaining > 0 ? (
                                <span className="font-semibold text-wine">{t("admin.stockReceipt.left").replace("{n}", String(c.remaining))}</span>
                              ) : c && c.remaining < 0 ? (
                                <span className="font-semibold text-wine">{t("admin.stockReceipt.over").replace("{n}", String(-c.remaining))}</span>
                              ) : (
                                <span className="text-wine">!</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </>
        ) : (
          <ReviewTable lines={lines} validation={validation} locations={locations} currentQty={currentQty} reference={reference} note={note} receiptId={receiptId} />
        )}

        {/* Summary + actions */}
        <div className="sticky bottom-0 -mx-6 -mb-5 border-t border-line bg-paper px-6 py-3">
          <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <span className="font-semibold text-ink">
              {t("admin.stockReceipt.totalAdding")}: <span className="tabular-nums">{validation.grandTotal}</span>
            </span>
            {locations.map((loc) => (
              <span key={loc.id} className="text-ink-soft">
                {loc.label}: <span className="font-semibold tabular-nums text-ink">{validation.allocatedByLocation[loc.id] ?? 0}</span>
              </span>
            ))}
            <span className={`ms-auto text-xs font-semibold ${validation.canSave ? "text-olive" : "text-wine"}`}>
              {validation.canSave
                ? `✓ ${t("admin.stockReceipt.allocatedOk").replace("{n}", String(validation.grandTotal))}`
                : t(`admin.stockReceipt.problem.${validation.problem}`)}
            </span>
          </div>
          {error && <p className="mb-2 rounded-lg bg-wine-light px-3 py-2 text-sm text-wine">{error} {t("admin.stockReceipt.nothingChanged")}</p>}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              {step === "edit" &&
                (confirmDiscard ? (
                  <span className="flex items-center gap-2 text-sm">
                    {t("admin.stockReceipt.discardConfirm")}
                    <AdminButton size="sm" variant="danger" onClick={discard}>
                      {t("admin.stockReceipt.discard")}
                    </AdminButton>
                    <AdminButton size="sm" variant="ghost" onClick={() => setConfirmDiscard(false)}>
                      {t("admin.common.cancel")}
                    </AdminButton>
                  </span>
                ) : (
                  isDirty(lines, reference, note) && (
                    <AdminButton size="sm" variant="ghost" onClick={() => setConfirmDiscard(true)}>
                      {t("admin.stockReceipt.discard")}
                    </AdminButton>
                  )
                ))}
            </div>
            <div className="flex gap-2">
              {step === "edit" ? (
                <>
                  <AdminButton variant="ghost" onClick={onClose}>
                    {isDirty(lines, reference, note) ? t("admin.stockReceipt.closeKeepDraft") : t("admin.common.cancel")}
                  </AdminButton>
                  <AdminButton variant="primary" disabled={!validation.canSave} onClick={() => setStep("review")}>
                    {t("admin.stockReceipt.review")}
                  </AdminButton>
                </>
              ) : (
                <>
                  <AdminButton variant="ghost" disabled={saving} onClick={() => setStep("edit")}>
                    {t("admin.stockReceipt.back")}
                  </AdminButton>
                  <AdminButton variant="primary" loading={saving} disabled={!validation.canSave} onClick={confirm}>
                    {t("admin.stockReceipt.confirm").replace("{n}", String(validation.grandTotal))}
                  </AdminButton>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function ReviewTable({
  lines,
  validation,
  locations,
  currentQty,
  reference,
  note,
  receiptId,
}: {
  lines: ReceiptLineDraft[];
  validation: ReturnType<typeof validateReceipt>;
  locations: ReceiptLocation[];
  currentQty: (locationId: string, variantId: string, size: string) => number | null;
  reference: string;
  note: string;
  receiptId: string;
}) {
  const { t } = useLanguage();
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink-soft">{t("admin.stockReceipt.reviewIntro")}</p>
      <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
        <div className="rounded-lg bg-cream-dim/60 px-3 py-2">
          <span className="block text-xs text-ink-faint">{t("admin.stockReceipt.receiptId")}</span>
          <span className="font-mono text-xs text-ink">{receiptId}</span>
        </div>
        <div className="rounded-lg bg-cream-dim/60 px-3 py-2">
          <span className="block text-xs text-ink-faint">{t("admin.stockReceipt.reference")}</span>
          <span className="text-ink">{reference.trim() || "—"}</span>
        </div>
        <div className="rounded-lg bg-cream-dim/60 px-3 py-2">
          <span className="block text-xs text-ink-faint">{t("admin.stockReceipt.note")}</span>
          <span className="text-ink">{note.trim() || "—"}</span>
        </div>
      </div>
      {locations.map((loc) => {
        const rows = lines
          .map((l, i) => ({ l, a: validation.lines[i]?.allocations[loc.id] }))
          .filter(({ a }) => a?.ok && a.value > 0)
          .map(({ l, a }) => ({ l, add: (a as { value: number }).value, now: currentQty(loc.id, l.variantId, l.size) }));
        if (rows.length === 0) return null;
        const sum = rows.reduce((s, r) => s + r.add, 0);
        return (
          <div key={loc.id} className="overflow-hidden rounded-xl border border-line">
            <div className="flex items-center justify-between border-b border-line bg-cream-dim/60 px-3 py-2 text-sm">
              <span className="font-semibold text-ink">{loc.label}</span>
              <span className="font-semibold text-olive">+{sum}</span>
            </div>
            <table className="w-full text-sm">
              <tbody>
                {rows.map(({ l, add, now }) => (
                  <tr key={`${l.variantId}::${l.size}`} className="border-t border-line first:border-0">
                    <td className="px-3 py-1.5 text-ink">
                      {l.colorName} · {l.size}
                    </td>
                    <td className="px-3 py-1.5 text-end font-semibold text-olive">+{add}</td>
                    <td className="px-3 py-1.5 text-end tabular-nums text-ink-soft" dir="ltr">
                      {now ?? "?"} → {now === null ? "?" : now + add}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}
