import { useLanguage } from "../../context/LanguageContext";
import type { OrderStatus } from "../../admin/types";

// Sisley's real OrderStatus has 8 values, not Catchy's 4 — "completed" is
// the terminal state for POS/in-store sales (Terminal.tsx sets it directly,
// skipping shipping entirely since there's nothing to ship), and both
// "cancelled" and "refunded" are negative terminal states a linear shipping
// bar would misrepresent. Only pending/processing/ready/shipped/delivered —
// a real, ordered shipping sequence (Phase 3 inserted "ready" between
// processing and shipped: every item confirmed prepared, not yet shipped)
// — get the step bar; the other three get a plain status message, matching
// Catchy's own precedent for "cancelled" extended to the two other
// non-linear outcomes.
const SHIP_STEPS: OrderStatus[] = ["pending", "processing", "ready", "shipped", "delivered"];

const STATUS_LABEL_KEY: Record<OrderStatus, string> = {
  pending: "account.statusPending",
  processing: "account.statusProcessing",
  ready: "account.statusReady",
  shipped: "account.statusShipped",
  delivered: "account.statusDelivered",
  completed: "account.statusCompleted",
  cancelled: "account.statusCancelled",
  refunded: "account.statusRefunded",
};

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className} fill="none">
      <path d="M4 10.5l4 4 8-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function OrderStatusTimeline({ status }: { status: OrderStatus }) {
  const { t } = useLanguage();

  if (status === "cancelled" || status === "refunded") {
    return (
      <div className="rounded-xl bg-wine-light px-4 py-3.5 text-sm font-semibold text-wine">
        {t(status === "cancelled" ? "account.orderCancelledMessage" : "account.orderRefundedMessage")}
      </div>
    );
  }

  if (status === "completed") {
    return (
      <div className="flex items-center gap-2.5 rounded-xl bg-cream-dim px-4 py-3.5 text-sm font-semibold text-ink">
        <CheckIcon className="h-5 w-5 shrink-0 text-wine" />
        {t("account.orderCompletedInStore")}
      </div>
    );
  }

  const currentIndex = SHIP_STEPS.indexOf(status);

  return (
    <div className="flex items-start">
      {SHIP_STEPS.map((step, i) => {
        const done = i <= currentIndex;
        return (
          <div key={step} className="flex flex-1 items-center last:flex-none">
            <div className="flex flex-col items-center gap-1.5">
              <span
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 text-xs font-bold transition-colors ${
                  done ? "border-wine bg-wine text-on-accent" : "border-line text-ink-faint"
                }`}
              >
                {done ? <CheckIcon className="h-3.5 w-3.5" /> : i + 1}
              </span>
              <span className={`max-w-[5.5rem] text-center text-xs font-semibold leading-tight ${done ? "text-ink" : "text-ink-faint"}`}>
                {t(STATUS_LABEL_KEY[step])}
              </span>
            </div>
            {i < SHIP_STEPS.length - 1 && <div className={`mx-2 h-0.5 flex-1 rounded-full ${i < currentIndex ? "bg-wine" : "bg-line"}`} />}
          </div>
        );
      })}
    </div>
  );
}
