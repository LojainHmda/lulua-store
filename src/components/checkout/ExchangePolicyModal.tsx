import type { ExchangePolicySettingsDoc } from "../../admin/types";
import { useLanguage } from "../../context/LanguageContext";
import { localizedName } from "../../data/localize";
import Button from "../ui/Button";
import { StoreModal } from "../ui/InfoModals";

// Behavior reference: Catchy's ExchangePolicyModal (read-only inspection,
// not reused code) — a mandatory read-then-accept step shown right before
// the order is actually placed. "Accept" both records consent and submits
// the order in one action (no separate second click), matching that
// reference; "Cancel"/backdrop/Escape return the customer to the checkout
// form with everything they already typed still in place, and are disabled
// while submitting so an in-flight order can't be interrupted.
export function ExchangePolicyModal({
  open,
  policy,
  submitting = false,
  error = null,
  onAccept,
  onClose,
}: {
  open: boolean;
  policy: ExchangePolicySettingsDoc;
  submitting?: boolean;
  error?: string | null;
  // Omit to open the modal read-only (a single "Close" button, no
  // accept/submit action) — used by the "Read the exchange policy" link,
  // which can be opened before the checkout form is even filled in and must
  // never be able to place an order on its own.
  onAccept?: () => void;
  onClose: () => void;
}) {
  const { lang, t } = useLanguage();
  const title = localizedName(policy.title, policy.titleAr, lang);
  const subtitle = localizedName(policy.subtitle, policy.subtitleAr, lang);
  const points = lang === "ar" && policy.pointsAr.length > 0 ? policy.pointsAr : policy.points;

  return (
    <StoreModal open={open} onClose={onClose} title={title} preventClose={submitting}>
      <p className="text-sm text-ink-soft">{subtitle}</p>

      <ul className="mt-4 flex flex-col gap-3 text-sm leading-relaxed text-ink-soft">
        {points.map((point, i) => (
          <li key={i} className="flex gap-2.5">
            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-wine" aria-hidden="true" />
            <span>{point}</span>
          </li>
        ))}
      </ul>

      {error && <p className="mt-4 rounded-lg bg-wine-light px-3.5 py-2.5 text-sm font-semibold text-wine">{error}</p>}

      <div className="mt-6 flex flex-col gap-2.5 sm:flex-row-reverse">
        {onAccept ? (
          <>
            <Button type="button" variant="primary" fullWidth disabled={submitting} onClick={onAccept}>
              {submitting ? t("checkout.placingOrder") : t("checkout.exchangePolicyAccept")}
            </Button>
            <Button type="button" variant="outline" fullWidth disabled={submitting} onClick={onClose}>
              {t("checkout.exchangePolicyCancel")}
            </Button>
          </>
        ) : (
          <Button type="button" variant="outline" fullWidth onClick={onClose}>
            {t("checkout.exchangePolicyClose")}
          </Button>
        )}
      </div>
    </StoreModal>
  );
}
