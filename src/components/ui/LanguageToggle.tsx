import { AnimatePresence, motion } from "motion/react";
import { useLanguage } from "../../context/LanguageContext";

export default function LanguageToggle({ className, iconClassName }: { className?: string; iconClassName?: string }) {
  const { lang, toggleLang, t } = useLanguage();

  return (
    <button
      onClick={toggleLang}
      aria-label={t("lang.toggle")}
      className={`flex h-12 shrink-0 items-center justify-center gap-1.5 rounded-full px-3.5 text-sm font-bold text-wine transition-colors hover:bg-cream-dim ${
        className ?? ""
      }`}
    >
      <GlobeIcon className={iconClassName ?? "h-5 w-5"} />
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={lang}
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 6 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          className="inline-block"
        >
          {lang === "en" ? "عربي" : "EN"}
        </motion.span>
      </AnimatePresence>
    </button>
  );
}

function GlobeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 3.5c2.4 2.3 3.7 5.2 3.7 8.5s-1.3 6.2-3.7 8.5c-2.4-2.3-3.7-5.2-3.7-8.5S9.6 5.8 12 3.5z" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3.8 9h16.4M3.8 15h16.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
