import { AnimatePresence, motion } from "motion/react";
import { useEffect, type ReactNode } from "react";
import { useLanguage } from "../../context/LanguageContext";
import AdminIcon from "./AdminIcons";
import { AdminButton } from "./ui";

export function Modal({
  open,
  onClose,
  title,
  children,
  width = "md",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  width?: "sm" | "md" | "lg" | "xl";
}) {
  const widthClass = { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-2xl", xl: "max-w-4xl" }[width];

  // Mirrors StoreModal's (src/components/ui/InfoModals.tsx) Escape-to-close
  // pattern — the backdrop click here already closes unconditionally, so
  // Escape matches that with no extra guard.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[150] flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="absolute inset-0 bg-ink/40 backdrop-blur-[2px]"
            onClick={onClose}
          />
          <motion.div
            initial={{ opacity: 0, y: 16, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.98 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            className={`relative z-10 max-h-[88vh] w-full overflow-y-auto rounded-2xl bg-paper shadow-lift ${widthClass}`}
          >
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-paper px-6 py-4">
              <h2 className="font-display text-lg font-bold text-ink">{title}</h2>
              <button onClick={onClose} className="flex h-9 w-9 items-center justify-center rounded-full text-ink-soft hover:bg-cream-dim hover:text-ink">
                <AdminIcon name="x" className="h-4.5 w-4.5" />
              </button>
            </div>
            <div className="px-6 py-5">{children}</div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  body,
  confirmLabel,
  danger,
  loading,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  body: string;
  confirmLabel?: string;
  danger?: boolean;
  loading?: boolean;
}) {
  const { t } = useLanguage();
  return (
    <Modal open={open} onClose={onClose} title={title} width="sm">
      <p className="text-sm text-ink-soft">{body}</p>
      <div className="mt-6 flex justify-end gap-2">
        <AdminButton variant="ghost" onClick={onClose}>
          {t("admin.common.cancel")}
        </AdminButton>
        <AdminButton variant={danger ? "danger" : "primary"} onClick={onConfirm} loading={loading}>
          {confirmLabel ?? t("admin.common.confirm")}
        </AdminButton>
      </div>
    </Modal>
  );
}
