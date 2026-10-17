import { AnimatePresence, motion } from "motion/react";
import { orderBy, limit } from "../../db/firestore";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { notificationsApi } from "../../firebase/collections";
import { STORE_NOTIFICATION_KINDS } from "../navConfig";
import { useLanguage } from "../../context/LanguageContext";
import type { AdminNotification } from "../types";
import AdminIcon from "./AdminIcons";

export default function NotificationBell() {
  const { t } = useLanguage();
  const [items, setItems] = useState<AdminNotification[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const unsub = notificationsApi.subscribe((data) => setItems(data.filter((n) => !STORE_NOTIFICATION_KINDS.includes(n.kind))), [orderBy("createdAt", "desc"), limit(20)]);
    return unsub;
  }, []);

  const unreadCount = useMemo(() => items.filter((n) => !n.read).length, [items]);

  async function markRead(n: AdminNotification) {
    if (!n.read) await notificationsApi.update(n.id, { read: true });
  }

  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} className="relative flex h-9 w-9 items-center justify-center rounded-lg text-wine hover:bg-cream-dim">
        <AdminIcon name="bell" className="h-4.5 w-4.5" />
        {unreadCount > 0 && (
          <span className="absolute -end-0.5 -top-0.5 flex h-4.5 min-w-[1.125rem] items-center justify-center rounded-full bg-wine px-1 text-[10px] font-bold text-on-accent">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>
      <AnimatePresence>
        {open && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            <motion.div
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.15 }}
              className="absolute end-0 z-50 mt-2 max-h-96 w-80 overflow-y-auto rounded-xl border border-line bg-paper shadow-lift"
            >
              <div className="flex items-center justify-between border-b border-line px-4 py-3">
                <p className="text-sm font-bold text-ink">{t("admin.nav.notifications")}</p>
                <Link to="/admin/notifications" onClick={() => setOpen(false)} className="text-xs font-semibold text-wine hover:underline">
                  {t("admin.common.viewAll")}
                </Link>
              </div>
              {items.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-ink-faint">{t("admin.notificationBell.empty")}</p>
              ) : (
                items.slice(0, 8).map((n) => (
                  <button
                    key={n.id}
                    onClick={() => markRead(n)}
                    className={`block w-full border-b border-line px-4 py-3 text-start last:border-0 hover:bg-cream-dim/50 ${n.read ? "opacity-60" : ""}`}
                  >
                    <p className="text-sm font-semibold text-ink">{n.title}</p>
                    <p className="mt-0.5 text-xs text-ink-soft">{n.body}</p>
                  </button>
                ))
              )}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
