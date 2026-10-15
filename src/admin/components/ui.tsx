import { Link } from "react-router-dom";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { useLanguage } from "../../context/LanguageContext";
import { NumberInput, type NumberInputProps } from "../../components/ui/NumberInput";
import AdminIcon from "./AdminIcons";

// ---- Button -----------------------------------------------------------

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
interface AdminButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm" | "md";
  icon?: string;
  loading?: boolean;
}

const BTN_VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-wine text-on-accent hover:bg-wine-dark",
  secondary: "bg-transparent border border-line text-ink hover:bg-cream-dim",
  ghost: "bg-transparent text-ink-soft hover:bg-cream-dim hover:text-ink",
  danger: "bg-transparent border border-wine/40 text-wine hover:bg-wine hover:text-on-accent",
};

export function AdminButton({
  variant = "secondary",
  size = "md",
  icon,
  loading,
  disabled,
  className,
  children,
  ...rest
}: AdminButtonProps) {
  return (
    <button
      disabled={disabled || loading}
      className={`inline-flex shrink-0 items-center justify-center gap-2 rounded-lg font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        size === "sm" ? "px-3 py-2 text-sm" : "px-4 py-2.5 text-sm"
      } ${BTN_VARIANT[variant]} ${className ?? ""}`}
      {...rest}
    >
      {loading ? (
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
      ) : (
        icon && <AdminIcon name={icon} className="h-4 w-4 shrink-0" />
      )}
      {children}
    </button>
  );
}

export function AdminLinkButton({
  to,
  variant = "secondary",
  size = "md",
  icon,
  className,
  children,
}: {
  to: string;
  variant?: ButtonVariant;
  size?: "sm" | "md";
  icon?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link
      to={to}
      className={`inline-flex shrink-0 items-center justify-center gap-2 rounded-lg font-semibold transition-colors ${
        size === "sm" ? "px-3 py-2 text-sm" : "px-4 py-2.5 text-sm"
      } ${BTN_VARIANT[variant]} ${className ?? ""}`}
    >
      {icon && <AdminIcon name={icon} className="h-4 w-4 shrink-0" />}
      {children}
    </Link>
  );
}

// ---- Form fields --------------------------------------------------------

export function Field({ label, hint, error, required, children }: { label: string; hint?: string; error?: string; required?: boolean; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-center gap-1 text-sm font-semibold text-ink">
        {label}
        {required && <span className="text-wine">*</span>}
      </span>
      {children}
      {hint && !error && <span className="mt-1 block text-xs text-ink-faint">{hint}</span>}
      {error && <span className="mt-1 block text-xs font-semibold text-wine">{error}</span>}
    </label>
  );
}

const fieldClass =
  "w-full rounded-lg border border-line bg-paper px-3.5 py-2.5 text-sm text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-wine";

export function AdminInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const { className, ...rest } = props;
  return <input className={`${fieldClass} ${className ?? ""}`} {...rest} />;
}

// The numeric counterpart to AdminInput -- same field styling, but backed by
// the shared NumberInput (src/components/ui/NumberInput.tsx) instead of a
// bare <input>: no permanent "0", no native spinners, no mid-keystroke
// clamping. See that file's own doc comment for the full behavior contract
// (nullable/integerOnly/min/max).
export function AdminNumberInput(props: NumberInputProps) {
  const { className, ...rest } = props;
  return <NumberInput className={`${fieldClass} ${className ?? ""}`} {...rest} />;
}

export function AdminTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { className, ...rest } = props;
  return <textarea className={`${fieldClass} resize-y ${className ?? ""}`} {...rest} />;
}

export function AdminSelect(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const { className, children, ...rest } = props;
  return (
    <select className={`${fieldClass} ${className ?? ""}`} {...rest}>
      {children}
    </select>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${checked ? "bg-wine" : "bg-line"}`}
    >
      <span className={`inline-block h-4.5 w-4.5 transform rounded-full bg-paper shadow-soft transition-transform ${checked ? "translate-x-6 rtl:-translate-x-6" : "translate-x-1 rtl:-translate-x-1"}`} />
      {label && <span className="sr-only">{label}</span>}
    </button>
  );
}

// ---- Layout primitives ---------------------------------------------------

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={`rounded-2xl border border-line bg-paper shadow-soft ${className ?? ""}`}>{children}</div>;
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="font-display text-2xl font-bold text-ink">{title}</h1>
        {description && <p className="mt-1 text-sm text-ink-soft">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

// ---- Badge ----------------------------------------------------------------

const BADGE_TONE: Record<string, string> = {
  neutral: "bg-cream-dim text-ink-soft",
  success: "bg-olive-light text-olive",
  warning: "bg-sand text-wine-dark",
  danger: "bg-wine-light text-wine",
  info: "bg-cream-dim text-ink",
};

export function Badge({ tone = "neutral", children }: { tone?: keyof typeof BADGE_TONE; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-bold uppercase tracking-wide ${BADGE_TONE[tone]}`}>{children}</span>;
}

// ---- Empty state ------------------------------------------------------------

export function EmptyState({ icon, title, body, action }: { icon: string; title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-line px-6 py-16 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-cream-dim text-ink-faint">
        <AdminIcon name={icon} className="h-6 w-6" />
      </div>
      <p className="font-display text-lg font-bold text-ink">{title}</p>
      {body && <p className="max-w-sm text-sm text-ink-soft">{body}</p>}
      {action}
    </div>
  );
}

// fullWidth: fill the parent instead of the usual fixed toolbar width.
export function SearchInput({ value, onChange, placeholder, fullWidth }: { value: string; onChange: (v: string) => void; placeholder?: string; fullWidth?: boolean }) {
  const { t } = useLanguage();
  return (
    <div className="relative">
      <AdminIcon name="search" className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? t("admin.common.searchPlaceholder")}
        className={`w-full rounded-lg border border-line bg-paper py-2.5 ps-9 pe-3 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-wine ${fullWidth ? "" : "sm:w-64"}`}
      />
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <span className={`inline-block animate-spin rounded-full border-2 border-current border-t-transparent ${className ?? "h-5 w-5"}`} />;
}

export function PageLoading() {
  return (
    <div className="flex items-center justify-center py-24 text-ink-faint">
      <Spinner className="h-6 w-6" />
    </div>
  );
}
