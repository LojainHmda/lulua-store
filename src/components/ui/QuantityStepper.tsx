import { useLanguage } from "../../context/LanguageContext";

interface QuantityStepperProps {
  qty: number;
  onChange: (qty: number) => void;
  size?: "sm" | "md";
  // Undefined = no known ceiling (e.g. stock not yet resolved) — the "+"
  // button stays enabled rather than guessing a limit that might be wrong.
  max?: number;
}

export default function QuantityStepper({ qty, onChange, size = "md", max }: QuantityStepperProps) {
  const { t } = useLanguage();
  const pad = size === "sm" ? "px-2.5 py-1 text-sm" : "px-3.5 py-2 text-base";
  const atMax = max !== undefined && qty >= max;

  return (
    <div className="inline-flex items-center rounded-full border border-line bg-paper">
      <button
        type="button"
        aria-label={t("product.decreaseQty")}
        onClick={() => onChange(qty - 1)}
        className={`${pad} font-semibold text-ink-soft hover:text-wine transition-colors`}
      >
        −
      </button>
      <span className="min-w-[1.75rem] text-center text-sm font-semibold text-ink">{qty}</span>
      <button
        type="button"
        aria-label={t("product.increaseQty")}
        disabled={atMax}
        onClick={() => onChange(max !== undefined ? Math.min(max, qty + 1) : qty + 1)}
        className={`${pad} font-semibold text-ink-soft transition-colors hover:text-wine disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-ink-soft`}
      >
        +
      </button>
    </div>
  );
}
