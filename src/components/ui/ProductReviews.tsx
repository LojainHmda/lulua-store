import { useEffect, useState } from "react";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { db } from "../../firebase/config";
import { reviewsApi } from "../../firebase/collections";
import { useCustomerAuth } from "../../context/CustomerAuthContext";
import { useLanguage } from "../../context/LanguageContext";
import type { AdminReview } from "../../admin/types";
import { StarIcon } from "./Icons";
import Button from "./Button";

function Stars({ value, onChange }: { value: number; onChange?: (v: number) => void }) {
  return (
    <div className="flex gap-1">
      {[1, 2, 3, 4, 5].map((i) => (
        <button
          key={i}
          type="button"
          disabled={!onChange}
          onClick={() => onChange?.(i)}
          className={onChange ? "cursor-pointer" : "cursor-default"}
          aria-label={`${i} star`}
        >
          <StarIcon className="h-6 w-6 text-wine" style={{ opacity: i <= value ? 1 : 0.25 }} />
        </button>
      ))}
    </div>
  );
}

export default function ProductReviews({ productId, productName }: { productId: string; productName: string }) {
  const { isSignedIn, profile, openSignIn } = useCustomerAuth();
  const { t } = useLanguage();
  const [reviews, setReviews] = useState<AdminReview[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [rating, setRating] = useState(0);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    const unsub = onSnapshot(
      query(collection(db, "reviews"), where("productId", "==", productId), where("status", "==", "approved")),
      (snap) => setReviews(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as AdminReview))
    );
    return unsub;
  }, [productId]);

  async function submitReview() {
    if (!profile || rating === 0 || !body.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await reviewsApi.create({
        productId,
        productName,
        author: profile.name || t("product.reviewsSection.anonymous"),
        rating,
        title: title.trim() || undefined,
        body: body.trim(),
        status: "pending",
      });
      setSubmitted(true);
      setShowForm(false);
      setRating(0);
      setTitle("");
      setBody("");
    } catch {
      setError(t("product.reviewsSection.submitFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="mt-16 border-t border-line pt-10">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2 className="font-display text-2xl font-semibold">{t("product.reviewsSection.title")}</h2>
        {!showForm && !submitted && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => (isSignedIn ? setShowForm(true) : openSignIn())}
          >
            {t("product.reviewsSection.write")}
          </Button>
        )}
      </div>

      {submitted && (
        <p className="mt-4 rounded-xl bg-wine-light px-4 py-3 text-sm font-semibold text-wine">
          {t("product.reviewsSection.submittedNote")}
        </p>
      )}

      {showForm && (
        <div className="mt-5 flex flex-col gap-3 rounded-2xl bg-paper p-5 shadow-soft">
          <div>
            <p className="mb-1.5 text-sm font-semibold text-ink">{t("product.reviewsSection.yourRating")}</p>
            <Stars value={rating} onChange={setRating} />
          </div>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-semibold text-ink">{t("product.reviewsSection.titleLabel")}</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="rounded-xl border border-line bg-paper px-4 py-2.5 text-sm outline-none focus:border-wine"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-semibold text-ink">{t("product.reviewsSection.bodyLabel")}</span>
            <textarea
              rows={4}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              className="rounded-xl border border-line bg-paper px-4 py-2.5 text-sm outline-none focus:border-wine"
            />
          </label>
          {error && <p className="text-sm font-semibold text-wine">{error}</p>}
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => setShowForm(false)}>
              {t("product.reviewsSection.cancel")}
            </Button>
            <Button size="sm" disabled={submitting || rating === 0 || !body.trim()} onClick={() => void submitReview()}>
              {submitting ? t("product.reviewsSection.submitting") : t("product.reviewsSection.submit")}
            </Button>
          </div>
        </div>
      )}

      <div className="mt-8 flex flex-col gap-6">
        {reviews.length === 0 ? (
          <p className="text-sm text-ink-faint">{t("product.reviewsSection.none")}</p>
        ) : (
          reviews.map((r) => (
            <div key={r.id} className="border-b border-line pb-6 last:border-0">
              <div className="flex items-center gap-3">
                <Stars value={r.rating} />
                <span className="text-sm font-semibold text-ink">{r.author}</span>
              </div>
              {r.title && <p className="mt-2 font-semibold text-ink">{r.title}</p>}
              <p className="mt-1 text-sm leading-relaxed text-ink-soft">{r.body}</p>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
