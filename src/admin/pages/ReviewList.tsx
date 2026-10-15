import { useEffect, useMemo, useState } from "react";
import { reviewsApi } from "../../firebase/collections";
import { useLanguage } from "../../context/LanguageContext";
import { useAdminAuth } from "../AdminAuthContext";
import { ConfirmDialog } from "../components/Modal";
import { useToast } from "../components/ToastContext";
import { AdminButton, AdminSelect, Badge, Card, EmptyState, PageHeader, PageLoading } from "../components/ui";
import { logActivity } from "../logActivity";
import type { AdminReview, ReviewStatus } from "../types";

const STATUS_TONE: Record<ReviewStatus, "neutral" | "success" | "danger"> = {
  pending: "neutral",
  approved: "success",
  rejected: "danger",
};

const REVIEW_ACTION_BY_STATUS: Record<ReviewStatus, string> = {
  approved: "review.approved",
  pending: "review.pending",
  rejected: "review.rejected",
};

function Stars({ rating }: { rating: number }) {
  return (
    <div className="flex gap-0.5 text-wine">
      {Array.from({ length: 5 }).map((_, i) => (
        <span key={i} className={i < rating ? "opacity-100" : "opacity-25"}>
          ★
        </span>
      ))}
    </div>
  );
}

export default function ReviewList() {
  const toast = useToast();
  const { t } = useLanguage();
  const { profile, hasRole } = useAdminAuth();
  const canWrite = hasRole(["owner", "admin", "editor"]);
  const [reviews, setReviews] = useState<AdminReview[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<ReviewStatus | "all">("pending");
  const [confirmDelete, setConfirmDelete] = useState<AdminReview | null>(null);

  useEffect(() => {
    const unsub = reviewsApi.subscribe((data) => {
      setReviews(data);
      setLoading(false);
    });
    return unsub;
  }, []);

  const filtered = useMemo(() => (statusFilter === "all" ? reviews : reviews.filter((r) => r.status === statusFilter)), [reviews, statusFilter]);

  async function setStatus(review: AdminReview, status: ReviewStatus) {
    await reviewsApi.update(review.id, { status });
    if (profile) await logActivity(profile, REVIEW_ACTION_BY_STATUS[status], review.productName);
    toast.success(`${t("admin.reviews.review")} ${t(`admin.reviewStatus.${status}`)}`);
  }

  async function handleDelete() {
    if (!confirmDelete) return;
    await reviewsApi.remove(confirmDelete.id);
    if (profile) await logActivity(profile, "review.deleted", confirmDelete.productName);
    toast.success(t("admin.reviews.deleted"));
    setConfirmDelete(null);
  }

  if (loading) return <PageLoading />;

  return (
    <div>
      <PageHeader title={t("admin.nav.reviews")} description={`${reviews.filter((r) => r.status === "pending").length} ${t("admin.reviews.pendingModeration")}`} />

      <div className="mb-4">
        <AdminSelect value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as ReviewStatus | "all")} className="w-auto">
          <option value="all">{t("admin.reviews.allReviews")}</option>
          <option value="pending">{t("admin.reviewStatus.pending")}</option>
          <option value="approved">{t("admin.reviewStatus.approved")}</option>
          <option value="rejected">{t("admin.reviewStatus.rejected")}</option>
        </AdminSelect>
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon="star" title={t("admin.reviews.noneHere")} body={t("admin.reviews.emptyBody")} />
      ) : (
        <div className="flex flex-col gap-3">
          {filtered.map((r) => (
            <Card key={r.id} className="p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-semibold text-ink">{r.productName}</p>
                  <div className="mt-1 flex items-center gap-2">
                    <Stars rating={r.rating} />
                    <span className="text-sm text-ink-soft">
                      {r.author} · {r.title}
                    </span>
                  </div>
                </div>
                <Badge tone={STATUS_TONE[r.status]}>{t(`admin.reviewStatus.${r.status}`)}</Badge>
              </div>
              <p className="mt-3 text-sm leading-relaxed text-ink-soft">{r.body}</p>
              {canWrite && (
                <div className="mt-4 flex flex-wrap gap-2">
                  {r.status !== "approved" && (
                    <AdminButton size="sm" variant="secondary" icon="check" onClick={() => setStatus(r, "approved")}>
                      {t("admin.reviews.approve")}
                    </AdminButton>
                  )}
                  {r.status !== "rejected" && (
                    <AdminButton size="sm" variant="secondary" icon="x" onClick={() => setStatus(r, "rejected")}>
                      {t("admin.reviews.reject")}
                    </AdminButton>
                  )}
                  <AdminButton size="sm" variant="danger" icon="trash" onClick={() => setConfirmDelete(r)}>
                    {t("admin.products.delete")}
                  </AdminButton>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      <ConfirmDialog open={!!confirmDelete} onClose={() => setConfirmDelete(null)} onConfirm={handleDelete} title={t("admin.reviews.deleteReview")} body={t("admin.reviews.deleteBody")} confirmLabel={t("admin.products.delete")} danger />
    </div>
  );
}
