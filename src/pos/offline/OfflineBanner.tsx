import { useState } from "react";
import { Modal } from "../../admin/components/Modal";
import { useLanguage } from "../../context/LanguageContext";
import { formatPrice } from "../../utils/currency";
import { useOffline } from "./OfflineContext";

// One strip under the till header: offline / sending / needs review, and a
// panel listing every offline sale still on this device.
export function OfflineBanner() {
  const { t, lang } = useLanguage();
  const { online, sales, pendingCount, issueCount, syncing, syncNow } = useOffline();
  const [open, setOpen] = useState(false);
  if (online && pendingCount === 0 && issueCount === 0) return null;

  const tone = !online ? "bg-wine text-on-accent" : issueCount > 0 ? "bg-sand text-wine-dark" : "bg-olive-light text-olive";
  const text = !online
    ? t("pos.offline.offline").replace("{n}", String(pendingCount))
    : pendingCount > 0
      ? syncing
        ? t("pos.offline.sending").replace("{n}", String(pendingCount))
        : t("pos.offline.waiting").replace("{n}", String(pendingCount))
      : t("pos.offline.issues").replace("{n}", String(issueCount));

  return (
    <>
      <div className={`flex shrink-0 items-center justify-center gap-3 px-3 py-1.5 text-sm font-semibold ${tone}`} role="status">
        <span className={`h-2 w-2 shrink-0 rounded-full ${online ? "bg-current" : "animate-pulse bg-on-accent"}`} />
        <span>{text}</span>
        {(sales.length > 0 || !online) && (
          <button onClick={() => setOpen(true)} className="rounded-full border border-current/40 px-2.5 py-0.5 text-xs font-semibold hover:bg-black/10">
            {t("pos.offline.details")}
          </button>
        )}
      </div>
      <Modal open={open} onClose={() => setOpen(false)} title={t("pos.offline.title")} width="md">
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-ink-soft">{t("pos.offline.explain")}</p>
          {sales.length === 0 ? (
            <p className="py-6 text-center text-ink-faint">{t("pos.offline.none")}</p>
          ) : (
            <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line">
              {sales
                .slice()
                .sort((a, b) => a.createdAt - b.createdAt)
                .map((p) => (
                  <li key={p.id} className="flex items-center gap-3 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p>
                        <span className="font-mono text-xs font-bold text-wine">{p.orderNumber}</span>{" "}
                        <span className="text-xs text-ink-faint">
                          {new Date(p.createdAt).toLocaleTimeString(lang === "ar" ? "ar" : "en-US", { hour: "2-digit", minute: "2-digit" })} · {p.itemCount}{" "}
                          {t("pos.branch.items")}
                        </span>
                      </p>
                      {p.status === "issue" ? (
                        <p className="text-xs font-semibold text-wine">
                          {t(`pos.offline.reason.${p.issue?.code ?? "unknown"}`)} {p.issue?.reported ? `· ${t("pos.offline.reported")}` : ""}
                        </p>
                      ) : (
                        <p className="text-xs text-ink-faint">{t("pos.offline.notSent")}</p>
                      )}
                    </div>
                    <span className="shrink-0 font-semibold text-ink">{formatPrice(p.total)}</span>
                  </li>
                ))}
            </ul>
          )}
          <div className="flex justify-end">
            <button
              disabled={!online && typeof navigator !== "undefined" && !navigator.onLine}
              onClick={syncNow}
              className="rounded-full bg-wine px-4 py-2 font-semibold text-on-accent hover:bg-wine-dark disabled:opacity-40"
            >
              {t("pos.offline.tryNow")}
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
