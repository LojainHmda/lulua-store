import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { Link, useNavigate, useParams } from "react-router-dom";
import { db } from "../../../firebase/config";
import { returnsApi } from "../../../firebase/collections";
import { markNeedsRepair, resolveReturn, ReturnResolutionError } from "../../../firebase/returnsTransaction";
import { useLanguage } from "../../../context/LanguageContext";
import { useAdminAuth } from "../../AdminAuthContext";
import { AdminButton, AdminTextarea, Badge, Card, PageLoading } from "../../components/ui";
import { useToast } from "../../components/ToastContext";
import MediaPicker from "../../components/MediaPicker";
import {
  RETURN_REASON_LABEL_KEY,
  RETURN_STATUS_LABEL_KEY,
  RETURN_STATUS_TONE,
  returnDispositionLabelKey,
  returnDispositionTone,
} from "../../returnsHelpers";
import type { AdminReturn, MediaAsset } from "../../types";

function tsToDate(v: unknown): Date | null {
  const ts = v as { toDate?: () => Date } | undefined;
  return ts?.toDate ? ts.toDate() : null;
}

export default function ReturnDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { t, lang } = useLanguage();
  const { profile, hasRole } = useAdminAuth();
  const canWrite = hasRole(["owner", "admin"]);
  const [ret, setRet] = useState<AdminReturn | null>(null);
  const [loading, setLoading] = useState(true);
  const [notes, setNotes] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState<"good" | "damaged" | "repair" | null>(null);

  useEffect(() => {
    if (!id) return;
    const unsub = onSnapshot(doc(db, "returns", id), (snap) => {
      const found = snap.exists() ? ({ id: snap.id, ...snap.data() } as AdminReturn) : null;
      setRet(found);
      setNotes((prev) => (found && !prev ? (found.inspectionNotes ?? "") : prev));
      setLoading(false);
    });
    return unsub;
  }, [id]);

  async function handleAddPhoto(asset: MediaAsset) {
    if (!ret) return;
    const photos = [...(ret.photos ?? []), asset.url];
    try {
      await returnsApi.update(ret.id, { photos });
      toast.success(t("admin.returns.detail.photoAdded"));
    } catch {
      toast.error(t("admin.returns.detail.actionFailed"));
    }
  }

  async function handleSaveNotes() {
    if (!ret) return;
    try {
      await returnsApi.update(ret.id, { inspectionNotes: notes });
      toast.success(t("admin.returns.detail.notesSaved"));
    } catch {
      toast.error(t("admin.returns.detail.actionFailed"));
    }
  }

  async function handleResolve(disposition: "good" | "damaged") {
    if (!ret || !profile) return;
    setBusy(disposition);
    try {
      await resolveReturn(ret.id, disposition, { uid: profile.id, email: profile.email, displayName: profile.displayName }, notes || undefined);
      toast.success(disposition === "good" ? t("admin.returns.detail.resolvedGood") : t("admin.returns.detail.resolvedDamaged"));
    } catch (err) {
      toast.error(err instanceof ReturnResolutionError ? err.message : t("admin.returns.detail.actionFailed"));
    } finally {
      setBusy(null);
    }
  }

  async function handleNeedsRepair() {
    if (!ret || !profile) return;
    setBusy("repair");
    try {
      await markNeedsRepair(ret.id, { uid: profile.id, email: profile.email, displayName: profile.displayName }, notes || undefined);
      toast.success(t("admin.returns.detail.markedNeedsRepair"));
    } catch (err) {
      toast.error(err instanceof ReturnResolutionError ? err.message : t("admin.returns.detail.actionFailed"));
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <PageLoading />;
  if (!ret) {
    return (
      <div className="text-center text-ink-soft">
        {t("admin.returns.detail.notFound")}{" "}
        <button onClick={() => navigate("/admin/returns")} className="font-semibold text-wine hover:underline">
          {t("admin.returns.detail.backToReturns")}
        </button>
      </div>
    );
  }

  const dispositionKey = returnDispositionLabelKey(ret.disposition);
  const createdAt = tsToDate(ret.createdAt);
  const resolvedAt = tsToDate(ret.resolvedAt);
  const locale = lang === "ar" ? "ar" : "en-US";

  return (
    <div className="pb-16">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-ink">
            {ret.productName} — {ret.colorName} / {ret.size}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Badge tone={RETURN_STATUS_TONE[ret.status]}>{t(RETURN_STATUS_LABEL_KEY[ret.status])}</Badge>
            {dispositionKey && <Badge tone={returnDispositionTone(ret.disposition)}>{t(dispositionKey)}</Badge>}
          </div>
        </div>
        <AdminButton variant="secondary" onClick={() => navigate("/admin/returns")}>
          {t("admin.returns.detail.backToReturns")}
        </AdminButton>
      </div>

      {ret.status !== "resolved" && (
        <div className="mb-5 rounded-xl bg-wine-light px-4 py-3 text-sm font-semibold text-wine">{t("admin.returns.detail.notSellableNotice")}</div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <Card className="p-5">
            <h2 className="mb-3 font-display text-base font-bold text-ink">{t("admin.returns.detail.itemDetails")}</h2>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-sm">
              <dt className="text-ink-faint">{t("admin.returns.colProduct")}</dt>
              <dd className="text-ink">{ret.productName}</dd>
              <dt className="text-ink-faint">{t("admin.productForm.colorName")}</dt>
              <dd className="text-ink">{ret.colorName}</dd>
              <dt className="text-ink-faint">{t("admin.orderDetail.qty")}</dt>
              <dd className="text-ink">{ret.qty}</dd>
              {ret.sku && (
                <>
                  <dt className="text-ink-faint">{t("admin.productForm.sku")}</dt>
                  <dd className="text-ink">{ret.sku}</dd>
                </>
              )}
              <dt className="text-ink-faint">{t("admin.returns.colReason")}</dt>
              <dd className="text-ink">{t(RETURN_REASON_LABEL_KEY[ret.reason])}</dd>
            </dl>
            {ret.reasonNote && (
              <div className="mt-3 rounded-lg bg-cream-dim px-3 py-2.5 text-sm text-ink-soft">{ret.reasonNote}</div>
            )}
          </Card>

          <Card className="p-5">
            <h2 className="mb-3 font-display text-base font-bold text-ink">{t("admin.returns.detail.photos")}</h2>
            <div className="flex flex-wrap gap-3">
              {(ret.photos ?? []).map((url) => (
                <a key={url} href={url} target="_blank" rel="noreferrer" className="block h-20 w-20 overflow-hidden rounded-lg border border-line bg-cream-dim">
                  <img src={url} alt="" className="h-full w-full object-cover" />
                </a>
              ))}
              {canWrite && ret.status !== "resolved" && (
                <button
                  onClick={() => setPickerOpen(true)}
                  className="flex h-20 w-20 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-line text-ink-faint hover:border-wine hover:text-wine"
                >
                  <span className="text-2xl leading-none">+</span>
                  <span className="text-[11px] font-semibold">{t("admin.returns.detail.addPhoto")}</span>
                </button>
              )}
            </div>
          </Card>

          <Card className="p-5">
            <h2 className="mb-3 font-display text-base font-bold text-ink">{t("admin.returns.detail.inspectionNotes")}</h2>
            <AdminTextarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} disabled={!canWrite || ret.status === "resolved"} />
            {canWrite && ret.status !== "resolved" && (
              <AdminButton variant="secondary" size="sm" className="mt-3" onClick={handleSaveNotes}>
                {t("admin.returns.detail.saveNotes")}
              </AdminButton>
            )}
          </Card>

          {canWrite && ret.status !== "resolved" && (
            <Card className="p-5">
              <h2 className="mb-3 font-display text-base font-bold text-ink">{t("admin.returns.detail.finalDisposition")}</h2>
              <div className="flex flex-wrap gap-2.5">
                <AdminButton variant="primary" loading={busy === "good"} disabled={!!busy} onClick={() => handleResolve("good")}>
                  {t("admin.returns.disposition.good")}
                </AdminButton>
                {ret.status === "quarantine" && (
                  <AdminButton variant="secondary" loading={busy === "repair"} disabled={!!busy} onClick={handleNeedsRepair}>
                    {t(RETURN_STATUS_LABEL_KEY.needs_repair)}
                  </AdminButton>
                )}
                <AdminButton variant="danger" loading={busy === "damaged"} disabled={!!busy} onClick={() => handleResolve("damaged")}>
                  {t("admin.returns.disposition.damaged")}
                </AdminButton>
              </div>
            </Card>
          )}
        </div>

        <div className="flex flex-col gap-6">
          <Card className="p-5">
            <h2 className="mb-3 font-display text-base font-bold text-ink">{t("admin.orders.colOrder")}</h2>
            <Link to={`/admin/orders/${ret.orderId}`} className="font-semibold text-wine hover:underline">
              #{ret.orderNumber}
            </Link>
            {createdAt && <p className="mt-2 text-xs text-ink-faint">{createdAt.toLocaleString(locale)}</p>}
          </Card>

          <Card className="p-5">
            <h2 className="mb-3 font-display text-base font-bold text-ink">{t("admin.orders.colCustomer")}</h2>
            <p className="font-medium text-ink">{ret.customerName}</p>
            <p className="text-sm text-ink-soft">{ret.customerEmail}</p>
          </Card>

          <Card className="p-5">
            <h2 className="mb-3 font-display text-base font-bold text-ink">{t("admin.returns.detail.processing")}</h2>
            <p className="text-sm text-ink-soft">
              {t("admin.returns.detail.loggedBy")} {ret.processedByName}
            </p>
            {ret.status === "resolved" && ret.resolvedByName && (
              <p className="mt-1.5 text-sm text-ink-soft">
                {t("admin.returns.detail.resolvedBy")} {ret.resolvedByName}
                {resolvedAt && ` · ${resolvedAt.toLocaleString(locale)}`}
              </p>
            )}
          </Card>
        </div>
      </div>

      <MediaPicker open={pickerOpen} onClose={() => setPickerOpen(false)} onSelect={handleAddPhoto} accept="image/*" />
    </div>
  );
}
