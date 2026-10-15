import { useRef } from "react";
import type { ReactNode } from "react";
import { useLanguage } from "../../context/LanguageContext";

export default function Rail({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const { dir, t } = useLanguage();

  function scrollBy(forward: 1 | -1) {
    const el = ref.current;
    if (!el) return;
    const rtlSign = dir === "rtl" ? -1 : 1;
    el.scrollBy({ left: forward * rtlSign * el.clientWidth * 0.8, behavior: "smooth" });
  }

  return (
    <div className="relative">
      <div
        ref={ref}
        className={`no-scrollbar flex snap-x snap-mandatory gap-4 overflow-x-auto scroll-smooth pb-2 ${className ?? ""}`}
      >
        {children}
      </div>
      <div className="pointer-events-none absolute -top-[4.5rem] end-0 hidden items-center gap-2 md:flex">
        <button
          onClick={() => scrollBy(-1)}
          aria-label={t("rail.previous")}
          className="pointer-events-auto flex h-12 w-12 items-center justify-center rounded-full border border-line bg-paper text-lg text-ink transition-colors hover:bg-ink hover:text-paper"
        >
          <span className="rtl:-scale-x-100">←</span>
        </button>
        <button
          onClick={() => scrollBy(1)}
          aria-label={t("rail.next")}
          className="pointer-events-auto flex h-12 w-12 items-center justify-center rounded-full border border-line bg-paper text-lg text-ink transition-colors hover:bg-ink hover:text-paper"
        >
          <span className="rtl:-scale-x-100">→</span>
        </button>
      </div>
    </div>
  );
}
