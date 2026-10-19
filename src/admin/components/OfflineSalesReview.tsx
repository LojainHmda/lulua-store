import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { doc, serverTimestamp, updateDoc, where } from "../../db/firestore";
import { useLanguage } from "../../context/LanguageContext";
import { db } from "../../firebase/config";
import { ordersApi, posSyncIssuesApi } from "../../firebase/collections";
import { formatPrice } from "../../utils/currency";
import { useAdminAuth } from "../AdminAuthContext";
import { logActivity } from "../logActivity";
import type { AdminOrder, PosSyncIssue } from "../types";
import { Modal } from "./Modal";
import { useToast } from "./ToastContext";
import { AdminButton, AdminInput, Badge, Card } from "./ui";

type Item = { kind: "issue"; issue: PosSyncIssue } | { kind: "shortage"; order: AdminOrder };

function when(v: unknown, lang: string): string {
  const d = (v as { toDate?: () => Date } | undefined)?.toDate?.();
  return d ? d.toLocaleString(lang === "ar" ? "ar" : "en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
}

// Offline till sales that need a person (Feature 5), shown on POS Sales only
// while there is something open: sales the server refused (posSyncIssues)
// and offline sales recorded with branch stock going below zero.
export function OfflineSalesReview({ branchName }: { branchName: (id?: string) => string }) {
  const { t, lang } = useLanguage();
  const { profile } = useAdminAuth();
  const toast = useToast();
  const [issues, setIssues] = useState<PosSyncIssue[]>([]);
  const [offlineOrders, setOfflineOrders] = useState<AdminOrder[]>([]);
  const [open, setOpen] = useState<Item | null>(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const u1 = posSyncIssuesApi.subscribe(setIssues, [where("status", "==", "open")]);
    const u2 = ordersApi.subscribe(setOfflineOrders, [where("source", "==", "pos"), where("offline", "==", true)]);
    return () => {
      u1();
      u2();
    };
  }, []);

  const shortages = offlineOrders.filter((o) => (o.stockShortage?.length ?? 0) > 0 && !o.shortageReviewedAt);
  const items: Item[] = [...issues.map((issue) => ({ kind: "issue" as const, issue })), ...shortages.map((order) => ({ kind: "shortage" as const, order }))];
  if (items.length === 0) return null;

  async function settle() {
    if (!open || !profile) return;
    setSaving(true);
    try {
      if (open.kind === "issue") {
        await updateDoc(doc(db, "posSyncIssues", open.issue.id), {
          status: "resolved",
          resolvedByUid: profile.id,
          resolvedByName: profile.displayName,
          resolvedAt: serverTimestamp(),
          resolution: note.trim().slice(0, 500),
        });
        await logActivity(profile, "pos.offlineIssueResolved", `#${open.issue.orderNumber}`, note.trim() || undefined);
      } else {
        await updateDoc(doc(db, "orders", open.order.id), {
          shortageReviewedAt: serverTimestamp(),
          shortageReviewedByName: profile.displayName,
          shortageReviewNote: note.trim().slice(0, 500),
        });
        await logActivity(profile, "pos.offlineIssueResolved", `#${open.order.orderNumber}`, note.trim() || undefined);
      }
      toast.success(t("admin.offlineReview.done"));
      setOpen(null);
      setNote("");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="mb-4 border-wine/40 p-0">
      <div className="border-b border-line px-4 py-3">
        <h2 className="flex items-center gap-2 font-display text-base font-bold text-wine">
          {t("admin.offlineReview.title")}
          <span className="rounded-full bg-wine px-2 py-0.5 text-xs font-bold text-on-accent">{items.length}</span>
        </h2>
        <p className="mt-0.5 text-xs text-ink-soft">{t("admin.offlineReview.explain")}</p>
      </div>
      <ul className="divide-y divide-line text-sm">
        {items.map((it) => {
          const key = it.kind === "issue" ? `i-${it.issue.id}` : `s-${it.order.id}`;
          const num = it.kind === "issue" ? it.issue.orderNumber : it.order.orderNumber;
          const at = it.kind === "issue" ? it.issue.saleCreatedAt : it.order.createdAt;
          const branch = it.kind === "issue" ? it.issue.branchId : it.order.branchId;
          const cashier = it.kind === "issue" ? it.issue.cashierName : (it.order.cashierName ?? "");
          const total = it.kind === "issue" ? it.issue.total : it.order.total;
          return (
            <li key={key} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
              {it.kind === "issue" ? <Badge tone="danger">{t("admin.offlineReview.notRecorded")}</Badge> : <Badge tone="warning">{t("admin.offlineReview.shortage")}</Badge>}
              <span className="font-mono text-xs font-bold text-wine">
                {it.kind === "shortage" ? (
                  <Link to={`/admin/orders/${it.order.id}`} className="hover:underline">
                    {num}
                  </Link>
                ) : (
                  num
                )}
              </span>
              <span className="text-xs text-ink-soft">
                {when(at, lang)} · {branchName(branch)} · {cashier}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-ink">
                {it.kind === "issue"
                  ? `${t(`pos.offline.reason.${it.issue.reason}`)}${it.issue.message ? ` — ${it.issue.message}` : ""}`
                  : it.order.stockShortage!.map((s) => `${s.name} ${s.size} (${t("admin.offlineReview.short").replace("{n}", String(s.short))})`).join(", ")}
              </span>
              <span className="font-semibold text-ink">{formatPrice(total)}</span>
              <AdminButton size="sm" onClick={() => setOpen(it)}>
                {it.kind === "issue" ? t("admin.offlineReview.resolve") : t("admin.offlineReview.reviewed")}
              </AdminButton>
            </li>
          );
        })}
      </ul>
      <Modal
        open={!!open}
        onClose={() => setOpen(null)}
        title={open?.kind === "issue" ? `${t("admin.offlineReview.resolve")} · ${open.issue.orderNumber}` : `${t("admin.offlineReview.reviewed")} · ${open?.order.orderNumber ?? ""}`}
        width="md"
      >
        {open?.kind === "issue" && (
          <ul className="mb-3 divide-y divide-line rounded-lg border border-line text-sm">
            {open.issue.lines.map((l, i) => (
              <li key={i} className="flex justify-between px-3 py-1.5">
                <span>
                  {l.qty} × {l.name} {[l.color, l.size].filter(Boolean).join(" / ")}
                </span>
                <span>{formatPrice(l.price * l.qty)}</span>
              </li>
            ))}
          </ul>
        )}
        <AdminInput value={note} maxLength={500} placeholder={t("admin.offlineReview.note")} onChange={(e) => setNote(e.target.value)} />
        <div className="mt-4 flex justify-end">
          <AdminButton variant="primary" loading={saving} onClick={() => void settle()}>
            {open?.kind === "issue" ? t("admin.offlineReview.resolve") : t("admin.offlineReview.reviewed")}
          </AdminButton>
        </div>
      </Modal>
    </Card>
  );
}
