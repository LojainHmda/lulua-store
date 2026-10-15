export type ButtonVariant = "primary" | "dark" | "outline" | "outline-light" | "ghost";
export type ButtonSize = "sm" | "md" | "lg";

const variants: Record<ButtonVariant, string> = {
  primary: "bg-wine text-on-accent hover:bg-wine-dark",
  dark: "bg-ink text-paper hover:bg-ink/85",
  outline: "bg-transparent text-ink border border-ink hover:bg-ink hover:text-paper",
  "outline-light": "bg-transparent text-paper border border-paper hover:bg-paper hover:text-ink",
  ghost: "bg-cream-dim text-ink hover:bg-line",
};

const sizes: Record<ButtonSize, string> = {
  sm: "px-4 py-2 text-sm sm:px-5 sm:py-2.5",
  md: "px-5 py-2.5 text-sm sm:px-6 sm:py-3 sm:text-base",
  lg: "px-6 py-3 text-base sm:px-8 sm:py-3.5 sm:text-lg",
};

export function buttonClasses(variant: ButtonVariant, size: ButtonSize, fullWidth?: boolean, extra?: string) {
  return `inline-flex items-center justify-center gap-2 rounded-full font-semibold tracking-tight transition-colors duration-200 disabled:opacity-40 disabled:pointer-events-none ${variants[variant]} ${sizes[size]} ${fullWidth ? "w-full" : ""} ${extra ?? ""}`;
}
