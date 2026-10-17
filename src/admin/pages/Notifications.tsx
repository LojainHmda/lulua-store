import { orderBy } from "../../db/firestore";
import { useEffect, useState } from "react";
import { notificationsApi } from "../../firebase/collections";
import { getSingletonDoc, setSingletonDoc } from "../../firebase/firestore";
import { useLanguage } from "../../context/LanguageContext";
import { useAdminAuth } from "../AdminAuthContext";
import { STORE_NOTIFICATION_KINDS } from "../navConfig";
import { useToast } from "../components/ToastContext";
import { AdminButton, AdminNumberInput, Card, EmptyState, Field, PageHeader, PageLoading, Toggle } from "../components/ui";
import type { AdminNotification, NotificationPrefsDoc } from "../types";

const DEFAULT_PREFS: NotificationPrefsDoc = { lowStockAlerts: true, lowStockThreshold: 3, newOrderAlerts: true, newReviewAlerts: true };

function timeAgo(value: unknown, t: (key: string) => string): string {
  const ts = value as { toDate?: () => Date } | undefined;
  const date = ts?.toDate ? ts.toDate() : null;
  if (!date) return "";
  const seconds = Math.max(0, (Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return t("admin.dashboard.justNow");
  if (seconds < 3600) return t("admin.dashboard.minAgo").replace("{n}", String(Math.floor(seconds / 60)));
  if (seconds < 86400) return t("admin.dashboard.hourAgo").replace("{n}", String(Math.floor(seconds / 3600)));
  return t("admin.dashboard.dayAgo").replace("{n}", String(Math.floor(seconds / 86400)));
}

export default function Notifications() {
  const toast = useToast();
  const { t } = useLanguage();
  const { hasRole } = useAdminAuth();
  const canWrite = hasRole(["owner", "admin"]);
  const [items, setItems] = useState<AdminNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [prefs, setPrefs] = useState<NotificationPrefsDoc>(DEFAULT_PREFS);
  const [savingPrefs, setSavingPrefs] = useState(false);

  useEffect(() => {
    const unsub = notificationsApi.subscribe(
      (data) => {
        setItems(data.filter((n) => !STORE_NOTIFICATION_KINDS.includes(n.kind)));
        setLoading(false);
      },
      [orderBy("createdAt", "desc")]
    );
    getSingletonDoc<NotificationPrefsDoc>("settings", "notifications").then((doc) => {
      if (doc) setPrefs(doc);
    });
    return unsub;
  }, []);

  async function markAllRead() {
    await Promise.all(items.filter((n) => !n.read).map((n) => notificationsApi.update(n.id, { read: true })));
    toast.success(t("admin.notifications.allCaughtUp"));
  }

  async function savePrefs() {
    setSavingPrefs(true);
    await setSingletonDoc("settings", "notifications", prefs);
    toast.success(t("admin.notifications.prefsSaved"));
    setSavingPrefs(false);
  }

  if (loading) return <PageLoading />;

  return (
    <div>
      <PageHeader
        title={t("admin.nav.notifications")}
        description={`${items.filter((n) => !n.read).length} ${t("admin.notifications.unread")}`}
        actions={items.some((n) => !n.read) && <AdminButton variant="secondary" onClick={markAllRead}>{t("admin.notifications.markAllRead")}</AdminButton>}
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          {items.length === 0 ? (
            <EmptyState icon="bell" title={t("admin.notifications.noneYet")} body={t("admin.notifications.emptyBody")} />
          ) : (
            <div className="flex flex-col gap-2">
              {items.map((n) => (
                <div key={n.id} className={`flex items-start justify-between gap-3 rounded-xl border border-line bg-paper p-4 ${n.read ? "opacity-60" : ""}`}>
                  <div>
                    <p className="font-semibold text-ink">{n.title}</p>
                    <p className="mt-0.5 text-sm text-ink-soft">{n.body}</p>
                    <p className="mt-1 text-xs text-ink-faint">{timeAgo(n.createdAt, t)}</p>
                  </div>
                  {!n.read && (
                    <button onClick={() => notificationsApi.update(n.id, { read: true })} className="shrink-0 text-xs font-semibold text-wine hover:underline">
                      {t("admin.notifications.markRead")}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <Card className="p-5">
          <h2 className="mb-4 font-display text-base font-bold text-ink">{t("admin.notifications.preferences")}</h2>
          <div className="flex flex-col gap-3.5">
            <label className="flex items-center justify-between">
              <span className="text-sm text-ink">{t("admin.notifications.lowStockAlerts")}</span>
              <Toggle checked={prefs.lowStockAlerts} onChange={(v) => setPrefs({ ...prefs, lowStockAlerts: v })} />
            </label>
            {prefs.lowStockAlerts && (
              <Field label={t("admin.notifications.threshold")}>
                <AdminNumberInput
                  min={1}
                  integerOnly
                  value={prefs.lowStockThreshold}
                  onChange={(v) => v !== null && setPrefs({ ...prefs, lowStockThreshold: v })}
                />
              </Field>
            )}
            {/* New-order / new-review alert toggles are storefront settings,
                hidden here; their saved values are kept as-is on save. */}
          </div>
          {canWrite && (
            <AdminButton variant="primary" loading={savingPrefs} className="mt-5 w-full justify-center" onClick={savePrefs}>
              {t("admin.notifications.savePrefs")}
            </AdminButton>
          )}
        </Card>
      </div>
    </div>
  );
}
