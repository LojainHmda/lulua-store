import { AnimatePresence, motion } from "motion/react";
import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLanguage } from "../../context/LanguageContext";
import AdminIcon from "./AdminIcons";

// Shared chrome for the barcode/QR product-label modals. Portals straight to
// document.body and scopes printing to a single #printAreaId element via
// `@media print`, rather than opening a separate popup window — mirrors
// Catchy's AdminProductBarcodeModal/AdminProductQrModal. The portal also
// sidesteps a real stacking-context bug already hit once in this codebase:
// a fixed-position element nested inside an ancestor with an active
// `transform` (e.g. a Framer/Motion-animated card) gets visually clipped to
// that ancestor's box instead of the viewport.
export function ProductCodeModal({
  printAreaId,
  title,
  onClose,
  children,
  footer,
}: {
  printAreaId: string;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
}) {
  const { dir, lang } = useLanguage();

  // Matches Modal.tsx's Escape-to-close behavior so this portal-based modal
  // (necessarily separate from Modal.tsx — see the print-layout note above)
  // still behaves like every other admin modal.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <AnimatePresence>
      <div dir={dir} lang={lang} className="fixed inset-0 z-[400]" role="presentation">
        <style>{`
          @media print {
            body * { visibility: hidden; }
            #${printAreaId}, #${printAreaId} * { visibility: visible; }
            #${printAreaId} { position: fixed; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; background: #fff; }
          }
        `}</style>
        <motion.button
          type="button"
          aria-label="Close"
          className="absolute inset-0 bg-ink/40 backdrop-blur-[2px] print:hidden"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        />
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4 print:relative print:block print:p-0">
          <motion.div
            role="dialog"
            aria-modal="true"
            className="pointer-events-auto w-full max-w-sm overflow-hidden rounded-2xl border border-line bg-paper shadow-lift print:w-auto print:max-w-none print:border-0 print:shadow-none"
            initial={{ opacity: 0, y: 16, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.98 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          >
            <div className="flex items-center justify-between border-b border-line px-5 py-4 print:hidden">
              <h2 className="font-display text-base font-bold text-ink">{title}</h2>
              <button
                type="button"
                onClick={onClose}
                className="flex h-8 w-8 items-center justify-center rounded-full text-ink-soft hover:bg-cream-dim hover:text-ink"
              >
                <AdminIcon name="x" className="h-4 w-4" />
              </button>
            </div>

            <div id={printAreaId} className="flex flex-col items-center gap-3 px-6 py-6 text-center">
              {children}
            </div>

            <div className="flex gap-2 border-t border-line p-4 print:hidden">{footer}</div>
          </motion.div>
        </div>
      </div>
    </AnimatePresence>,
    document.body
  );
}
