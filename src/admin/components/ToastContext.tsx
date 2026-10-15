import { AnimatePresence, motion } from "motion/react";
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import AdminIcon from "./AdminIcons";

type ToastKind = "success" | "error" | "warning" | "info";
interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  description?: string;
}

interface ToastContextValue {
  push: (kind: ToastKind, message: string, description?: string) => void;
  success: (message: string, description?: string) => void;
  error: (message: string, description?: string) => void;
  warning: (message: string, description?: string) => void;
  info: (message: string, description?: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const KIND_STYLE: Record<ToastKind, string> = {
  success: "bg-ink text-paper",
  error: "bg-wine text-on-accent",
  // Same bg-sand/text-wine-dark pairing as Badge's "warning" tone (ui.tsx),
  // so the caution color language matches everywhere in the admin.
  warning: "bg-sand text-wine-dark",
  info: "bg-paper text-ink border border-line",
};

const KIND_ICON: Record<ToastKind, string> = {
  success: "check",
  error: "x",
  warning: "alertTriangle",
  info: "info",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);

  const push = useCallback((kind: ToastKind, message: string, description?: string) => {
    const id = ++idRef.current;
    setToasts((t) => [...t, { id, kind, message, description }]);
    window.setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id));
    }, 3800);
  }, []);

  const value: ToastContextValue = {
    push,
    success: (m, d) => push("success", m, d),
    error: (m, d) => push("error", m, d),
    warning: (m, d) => push("warning", m, d),
    info: (m, d) => push("info", m, d),
  };

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="fixed bottom-5 end-5 z-[200] flex w-full max-w-sm flex-col gap-2">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              initial={{ opacity: 0, y: 12, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              transition={{ duration: 0.2 }}
              className={`flex items-start gap-2.5 rounded-xl px-4 py-3 shadow-lift ${KIND_STYLE[t.kind]}`}
            >
              <AdminIcon name={KIND_ICON[t.kind]} className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-semibold leading-snug">{t.message}</span>
                {t.description && <span className="text-xs font-normal leading-snug opacity-80">{t.description}</span>}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
