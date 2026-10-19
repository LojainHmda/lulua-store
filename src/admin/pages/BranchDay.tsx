import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { doc, serverTimestamp, setDoc, Timestamp, where } from "../../db/firestore";
import { useLanguage } from "../../context/LanguageContext";
import { localizedName } from "../../data/localize";
import { db } from "../../firebase/config";
import { branchDaySnapshotsApi, branchesApi, branchStockApi, ordersApi, posReturnsApi, registerSessionsApi } from "../../firebase/collections";
import { formatPrice } from "../../utils/currency";
import { useAdminAuth } from "../AdminAuthContext";
import { Modal } from "../components/Modal";
import { ShiftDetailModal } from "../components/ShiftHistory";
import { useToast } from "../components/ToastContext";
import { AdminButton, AdminInput, Badge, Card, PageHeader, PageLoading } from "../components/ui";
import { buildDayFigures, dayBounds, figuresDiffer, snapshotId, type BranchDaySnapshot, type DayFigures } from "../daySnapshot";
import { logActivity } from "../logActivity";
import { toInputDate } from "../posDateRange";
import type { AdminOrder, Branch, BranchStockDoc, PosReturn, RegisterSession } from "../types";

function Tile({ label, value, tone }: { label: string; value: string; tone?: "wine" | "olive" }) {
  return (
    <div className="rounded-xl border border-line bg-paper px-3 py-2.5">
      <p className="text-[11px] font-bold uppercase tracking-wide text-ink-faint">{label}</p>
      <p className={`mt-0.5 font-display text-lg font-bold ${tone === "wine" ? "text-wine" : tone === "olive" ? "text-olive" : "text-ink"}`}>{value}</p>
    </div>
  );
}

function Row({ label, value, strong, minus }: { label: string; value: number; strong?: boolean; minus?: boolean }) {
  return (
    <div className={`flex justify-between py-1 ${strong ? "border-t border-line pt-2 font-bold text-ink" : "text-ink-soft"}`}>
      <span>{label}</span>
      <span className={minus && value ? "text-wine" : ""}>
        {minus && value ? "-" : ""}
        {formatPrice(value)}
      </span>
    </div>
  );
}

function H2({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-2 mt-5 font-display text-base font-bold text-ink">{children}</h2>;
}

const shiftDay = (date: string, by: number) => {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + by);
  return toInputDate(d);
};

// Admin → Branches → End of day: one branch, one day. Live figures from the
// day's sales, returns and shifts; "Close day" freezes them as the day's
// snapshot (branchDaySnapshots), which is what this page shows afterwards.
export default function BranchDay() {
  const { branchId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const today = toInputDate(new Date());
  const date = /^\d{4}-\d{2}-\d{2}$/.test(params.get("date") ?? "") ? params.get("date")! : today;
  const setDate = (d: string) => setParams(d === today ? {} : { date: d }, { replace: true });
  const { t, lang } = useLanguage();
  const { profile } = useAdminAuth();
  const toast = useToast();
  const printRef = useRef<HTMLDivElement>(null);

  const [branch, setBranch] = useState<Branch | null | undefined>(undefined);
  const [orders, setOrders] = useState<AdminOrder[] | null>(null);
  const [returns, setReturns] = useState<PosReturn[] | null>(null);
  const [sessions, setSessions] = useState<RegisterSession[] | null>(null);
  const [openSessions, setOpenSessions] = useState<RegisterSession[]>([]);
  const [stock, setStock] = useState<BranchStockDoc[] | null>(null);
  const [snaps, setSnaps] = useState<BranchDaySnapshot[]>([]);
  const [showLive, setShowLive] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [shift, setShift] = useState<RegisterSession | null>(null);

  useEffect(() => {
    branchesApi.list().then((bs) => setBranch(bs.find((b) => b.id === branchId) ?? null));
  }, [branchId]);

  useEffect(() => {
    const { start, end } = dayBounds(date);
    const range = (f: string) => [where(f, ">=", Timestamp.fromDate(start)), where(f, "<", Timestamp.fromDate(end))];
    setOrders(null);
    setReturns(null);
    setSessions(null);
    setShowLive(false);
    const u = [
      ordersApi.subscribe(setOrders, [where("source", "==", "pos"), where("branchId", "==", branchId), ...range("createdAt")]),
      posReturnsApi.subscribe(setReturns, [where("branchId", "==", branchId), ...range("createdAt")]),
      registerSessionsApi.subscribe(setSessions, [where("branchId", "==", branchId), ...range("openedAt")]),
      registerSessionsApi.subscribe(setOpenSessions, [where("branchId", "==", branchId), where("status", "==", "open")]),
      branchDaySnapshotsApi.subscribe(setSnaps, [where("branchId", "==", branchId), where("date", "==", date)]),
    ];
    // Stock on hand only means something for today (it's "now").
    if (date === today) u.push(branchStockApi.subscribe(setStock, [where("branchId", "==", branchId)]));
    else setStock(null);
    return () => u.forEach((f) => f());
  }, [branchId, date, today]);

  const live = useMemo<DayFigures | null>(
    () => (orders && returns && sessions ? buildDayFigures({ orders, returns, sessions, stock: date === today ? stock : null }) : null),
    [orders, returns, sessions, stock, date, today]
  );
  const snap = snaps[0] ?? null;
  const figures = snap && !showLive ? snap.figures : live;
  const changed = !!(snap && live && figuresDiffer(snap.figures, live));
  // Shifts still open that belong to this day (or started before it and still running).
  const { end } = dayBounds(date);
  const stillOpen = openSessions.filter((s) => {
    const o = (s.openedAt as { toDate?: () => Date } | undefined)?.toDate?.();
    return !o || o < end;
  });
  const future = date > today;

  async function closeDay() {
    if (!profile || !branch || !live) return;
    setSaving(true);
    try {
      const data: Record<string, unknown> = {
        branchId,
        branchName: branch.name,
        date,
        figures: JSON.parse(JSON.stringify(live)),
        closedByUid: profile.id,
        closedByName: profile.displayName,
        closedAt: serverTimestamp(),
        version: (snap?.version ?? 0) + 1,
        note: note.trim().slice(0, 500),
      };
      if (branch.code) data.branchCode = branch.code;
      await setDoc(doc(db, "branchDaySnapshots", snapshotId(branchId, date)), data);
      await logActivity(profile, "branch.dayClosed", `${branch.code ?? branch.name} · ${date}`, `${formatPrice(live.netTotal)}${snap ? ` · v${snap.version + 1}` : ""}`);
      toast.success(t("admin.dayEnd.saved"));
      setCloseOpen(false);
      setNote("");
      setShowLive(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function print() {
    const w = window.open("", "_blank", "width=900,height=1000");
    if (!w || !printRef.current) return;
    const styles = [...document.querySelectorAll('link[rel="stylesheet"], style')].map((n) => n.outerHTML).join("");
    w.document.write(
      `<!doctype html><html dir="${document.documentElement.dir}" lang="${lang}"><head><meta charset="utf-8"><title>${branch?.code ?? ""} ${date}</title>${styles}</head><body class="admin-root bg-cream text-ink" style="padding:24px">${printRef.current.innerHTML}</body></html>`
    );
    w.document.close();
    setTimeout(() => w.print(), 400);
  }

  if (branch === undefined) return <PageLoading />;
  if (branch === null) return <p className="p-6 text-ink-soft">{t("admin.dayEnd.noBranch")}</p>;

  const fmtTime = (msv: number | null) => (msv ? new Date(msv).toLocaleTimeString(lang === "ar" ? "ar" : "en-US", { hour: "2-digit", minute: "2-digit" }) : "—");
  const closedAt = (snap?.closedAt as { toDate?: () => Date } | undefined)?.toDate?.();
  const maxHour = figures ? Math.max(1, ...figures.hours) : 1;
  const dateLabel = new Date(`${date}T00:00:00`).toLocaleDateString(lang === "ar" ? "ar" : "en-US", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  return (
    <div>
      <PageHeader
        title={`${t("admin.dayEnd.title")} · ${branch.code ? `${branch.code} ` : ""}${localizedName(branch.name, branch.nameAr, lang)}`}
        description={t("admin.dayEnd.subtitle")}
        actions={
          <Link to="/admin/branches" className="text-sm font-semibold text-wine hover:underline">
            {t("admin.dayEnd.back")}
          </Link>
        }
      />

      {/* Day picker + status + actions */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-lg border border-line bg-paper p-0.5">
          <button onClick={() => setDate(shiftDay(date, -1))} aria-label={t("admin.dayEnd.prev")} className="rounded-md px-2.5 py-1.5 text-ink-soft hover:text-wine">
            <span className="inline-block rtl:-scale-x-100">‹</span>
          </button>
          <AdminInput type="date" value={date} max={today} onChange={(e) => e.target.value && setDate(e.target.value)} className="!w-auto !border-0 !py-1" />
          <button disabled={date >= today} onClick={() => setDate(shiftDay(date, 1))} aria-label={t("admin.dayEnd.next")} className="rounded-md px-2.5 py-1.5 text-ink-soft hover:text-wine disabled:opacity-30">
            <span className="inline-block rtl:-scale-x-100">›</span>
          </button>
        </div>
        {date !== today && (
          <button onClick={() => setDate(today)} className="rounded-full border border-line px-3 py-1 text-sm font-semibold text-ink-soft hover:text-wine">
            {t("admin.dayEnd.today")}
          </button>
        )}
        <span className="text-sm text-ink-soft">{dateLabel}</span>
        <div className="ms-auto flex flex-wrap items-center gap-2">
          {snap ? (
            <Badge tone="success">
              {t("admin.dayEnd.closedBy").replace("{name}", snap.closedByName).replace("{time}", closedAt ? closedAt.toLocaleString(lang === "ar" ? "ar" : "en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—")}
              {snap.version > 1 ? ` · v${snap.version}` : ""}
            </Badge>
          ) : (
            <Badge tone="warning">{t("admin.dayEnd.notClosed")}</Badge>
          )}
          <AdminButton size="sm" icon="download" disabled={!figures} onClick={print}>
            {t("admin.dayEnd.print")}
          </AdminButton>
          {!future && (
            <AdminButton size="sm" variant="primary" disabled={!live || stillOpen.length > 0 || (!!snap && !changed)} onClick={() => setCloseOpen(true)}>
              {snap ? t("admin.dayEnd.closeAgain") : t("admin.dayEnd.closeDay")}
            </AdminButton>
          )}
        </div>
      </div>

      {stillOpen.length > 0 && (
        <Card className="mb-3 border-wine/40 px-4 py-3 text-sm">
          <p className="font-semibold text-wine">{t("admin.dayEnd.openShifts").replace("{n}", String(stillOpen.length))}</p>
          <p className="mt-0.5 text-ink-soft">
            {stillOpen.map((s) => `${s.registerName ?? "—"} · ${s.cashierName}`).join(" — ")}{" "}
            <Link to="/admin/pos-sales" className="font-semibold text-wine hover:underline">
              {t("admin.dayEnd.goClose")}
            </Link>
          </p>
        </Card>
      )}
      {changed && (
        <Card className="mb-3 border-wine/40 px-4 py-3 text-sm">
          <p className="font-semibold text-wine">{t("admin.dayEnd.changed")}</p>
          <p className="mt-0.5 text-ink-soft">
            {t("admin.dayEnd.changedDetail")
              .replace("{saved}", formatPrice(snap!.figures.netTotal))
              .replace("{now}", formatPrice(live!.netTotal))}{" "}
            <button onClick={() => setShowLive((v) => !v)} className="font-semibold text-wine hover:underline">
              {showLive ? t("admin.dayEnd.showSaved") : t("admin.dayEnd.showLive")}
            </button>
          </p>
        </Card>
      )}

      {!figures ? (
        <PageLoading />
      ) : (
        <div ref={printRef}>
          <p className="mb-2 hidden text-sm font-bold print:block">
            {branch.code} {branch.name} · {dateLabel}
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
            <Tile label={t("admin.dayEnd.net")} value={formatPrice(figures.netTotal)} tone="olive" />
            <Tile label={t("admin.dayEnd.sales")} value={formatPrice(figures.salesTotal)} />
            <Tile label={t("admin.dayEnd.refunds")} value={figures.refundTotal ? `-${formatPrice(figures.refundTotal)}` : formatPrice(0)} tone="wine" />
            <Tile label={t("admin.dayEnd.discounts")} value={formatPrice(figures.discountTotal)} />
            <Tile label={t("admin.dayEnd.salesCount")} value={String(figures.salesCount)} />
            <Tile label={t("admin.dayEnd.items")} value={`${figures.itemsSold}${figures.itemsReturned ? ` / -${figures.itemsReturned}` : ""}`} />
            <Tile label={t("admin.dayEnd.avg")} value={formatPrice(figures.avgSale)} />
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <Card className="p-4 text-sm">
              <h3 className="mb-1 font-bold text-ink">{t("admin.dayEnd.payments")}</h3>
              <Row label={t("admin.dayEnd.cashSales")} value={figures.cashSales} />
              <Row label={t("admin.dayEnd.cardSales")} value={figures.cardSales} />
              <Row label={t("admin.dayEnd.cashRefunds")} value={figures.cashRefunds} minus />
              <Row label={t("admin.dayEnd.cardRefunds")} value={figures.cardRefunds} minus />
              <Row label={t("admin.dayEnd.net")} value={figures.netTotal} strong />
              {(figures.promoDiscount > 0 || figures.manualDiscount > 0) && (
                <p className="mt-2 text-xs text-ink-faint">
                  {t("admin.dayEnd.discountSplit").replace("{promo}", formatPrice(figures.promoDiscount)).replace("{manual}", formatPrice(figures.manualDiscount))}
                </p>
              )}
              {(figures.offlineCount > 0 || figures.cancelledCount > 0) && (
                <p className="mt-1 text-xs text-ink-faint">
                  {figures.offlineCount > 0 && t("admin.dayEnd.offlineCount").replace("{n}", String(figures.offlineCount))}{" "}
                  {figures.cancelledCount > 0 && t("admin.dayEnd.cancelledCount").replace("{n}", String(figures.cancelledCount))}
                </p>
              )}
            </Card>
            <Card className="p-4 text-sm">
              <h3 className="mb-1 font-bold text-ink">{t("admin.dayEnd.drawer")}</h3>
              <Row label={t("admin.dayEnd.startingCash")} value={figures.drawer.startingCash} />
              <Row label={t("admin.dayEnd.cashSales")} value={figures.drawer.cashSales} />
              <Row label={t("admin.dayEnd.cashRefunds")} value={figures.drawer.cashRefunds} minus />
              <Row label={t("admin.dayEnd.withdrawals")} value={figures.drawer.withdrawals} minus />
              <Row label={t("admin.dayEnd.expected")} value={figures.drawer.expected} strong />
              <Row label={t("admin.dayEnd.counted")} value={figures.drawer.counted} />
              <div className="flex justify-between py-1 font-bold">
                <span>{t("admin.dayEnd.variance")}</span>
                <span className={figures.drawer.variance < 0 ? "text-wine" : figures.drawer.variance > 0 ? "text-olive" : "text-ink"}>
                  {figures.drawer.variance > 0 ? "+" : ""}
                  {formatPrice(figures.drawer.variance)}
                </span>
              </div>
              {figures.drawer.uncounted > 0 && <p className="mt-1 text-xs text-wine">{t("admin.dayEnd.uncounted").replace("{n}", String(figures.drawer.uncounted))}</p>}
            </Card>
            <Card className="p-4 text-sm">
              <h3 className="mb-2 font-bold text-ink">{t("admin.dayEnd.byHour")}</h3>
              {figures.salesCount === 0 ? (
                <p className="py-6 text-center text-ink-faint">{t("admin.dayEnd.noSales")}</p>
              ) : (
                <div dir="ltr">
                  <div className="flex h-24 items-end gap-[3px] border-b border-line">
                    {figures.hours.map((v, h) => (
                      <div
                        key={h}
                        title={`${String(h).padStart(2, "0")}:00 · ${formatPrice(v)}`}
                        className="flex-1 rounded-t bg-wine/80"
                        style={{ height: `${(v / maxHour) * 100}%`, minHeight: v ? 3 : 0 }}
                      />
                    ))}
                  </div>
                  <div className="mt-0.5 flex gap-[3px] text-[9px] text-ink-faint">
                    {figures.hours.map((_, h) => (
                      <span key={h} className="flex-1 text-center">
                        {h % 3 === 0 ? h : ""}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {figures.stock && (
                <div className="mt-3 border-t border-line pt-2 text-xs text-ink-soft">
                  <p className="font-bold text-ink">{t("admin.dayEnd.stock")}</p>
                  {t("admin.dayEnd.stockLine")
                    .replace("{units}", String(figures.stock.units))
                    .replace("{out}", String(figures.stock.outOfStock))}
                  {figures.stock.negative > 0 && <span className="font-semibold text-wine"> · {t("admin.dayEnd.stockNegative").replace("{n}", String(figures.stock.negative))}</span>}
                </div>
              )}
            </Card>
          </div>

          <H2>{t("admin.dayEnd.shifts")}</H2>
          {figures.shifts.length === 0 ? (
            <Card className="px-4 py-5 text-center text-sm text-ink-faint">{t("admin.dayEnd.noShifts")}</Card>
          ) : (
            <Card className="overflow-x-auto p-0">
              <table className="w-full text-sm">
                <thead className="whitespace-nowrap bg-cream-dim text-xs uppercase text-ink-faint">
                  <tr>
                    <th className="px-3 py-2 text-start">{t("admin.dayEnd.till")}</th>
                    <th className="px-3 py-2 text-start">{t("pos.branch.cashier")}</th>
                    <th className="px-3 py-2 text-start">{t("admin.dayEnd.hours")}</th>
                    <th className="px-3 py-2 text-end">{t("admin.dayEnd.salesCount")}</th>
                    <th className="px-3 py-2 text-end">{t("admin.dayEnd.sales")}</th>
                    <th className="px-3 py-2 text-end">{t("admin.dayEnd.refunds")}</th>
                    <th className="px-3 py-2 text-end">{t("admin.dayEnd.expected")}</th>
                    <th className="px-3 py-2 text-end">{t("admin.dayEnd.counted")}</th>
                    <th className="px-3 py-2 text-end">{t("admin.dayEnd.variance")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {figures.shifts.map((s) => {
                    const full = sessions?.find((x) => x.id === s.id) ?? null;
                    return (
                      <tr key={s.id} onClick={() => full && setShift(full)} className={full ? "cursor-pointer hover:bg-cream-dim/50" : ""}>
                        <td className="px-3 py-2 font-semibold text-ink">{s.registerName}</td>
                        <td className="px-3 py-2">{s.cashierName}</td>
                        <td className="whitespace-nowrap px-3 py-2 text-ink-soft">
                          {fmtTime(s.openedAt)} – {s.open ? <Badge tone="warning">{t("admin.dayEnd.open")}</Badge> : fmtTime(s.closedAt)}
                        </td>
                        <td className="px-3 py-2 text-end">{s.salesCount}</td>
                        <td className="px-3 py-2 text-end">{formatPrice(s.grossTotal)}</td>
                        <td className="px-3 py-2 text-end text-wine">{s.refundTotal ? `-${formatPrice(s.refundTotal)}` : "—"}</td>
                        <td className="px-3 py-2 text-end">{formatPrice(s.expectedCash)}</td>
                        <td className="px-3 py-2 text-end">{s.countedCash === null ? "—" : formatPrice(s.countedCash)}</td>
                        <td className={`px-3 py-2 text-end font-semibold ${s.variance && s.variance < 0 ? "text-wine" : s.variance && s.variance > 0 ? "text-olive" : ""}`}>
                          {s.variance === null ? "—" : `${s.variance > 0 ? "+" : ""}${formatPrice(s.variance)}`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Card>
          )}

          <div className="grid gap-4 lg:grid-cols-3">
            <div>
              <H2>{t("admin.dayEnd.tills")}</H2>
              <Card className="divide-y divide-line p-0 text-sm">
                {figures.registers.length === 0 && <p className="px-4 py-4 text-center text-ink-faint">—</p>}
                {figures.registers.map((r) => (
                  <div key={r.registerId} className="flex items-center justify-between px-4 py-2">
                    <span className="font-semibold text-ink">
                      {r.name} <span className="text-xs font-normal text-ink-faint">· {r.salesCount}</span>
                    </span>
                    <span className="text-end">
                      <b>{formatPrice(r.netTotal)}</b>
                      {r.refundTotal > 0 && <span className="block text-[11px] text-wine">-{formatPrice(r.refundTotal)}</span>}
                    </span>
                  </div>
                ))}
              </Card>
            </div>
            <div>
              <H2>{t("admin.dayEnd.cashiers")}</H2>
              <Card className="divide-y divide-line p-0 text-sm">
                {figures.cashiers.length === 0 && <p className="px-4 py-4 text-center text-ink-faint">—</p>}
                {figures.cashiers.map((c) => (
                  <div key={c.id} className="flex items-center justify-between px-4 py-2">
                    <span className="font-semibold text-ink">
                      {c.name} <span className="text-xs font-normal text-ink-faint">· {c.salesCount}</span>
                    </span>
                    <span className="text-end">
                      <b>{formatPrice(c.salesTotal)}</b>
                      {c.discountTotal > 0 && (
                        <span className="block text-[11px] text-ink-faint">
                          {t("admin.dayEnd.discounts")} {formatPrice(c.discountTotal)}
                        </span>
                      )}
                    </span>
                  </div>
                ))}
              </Card>
            </div>
            <div>
              <H2>{t("admin.dayEnd.topProducts")}</H2>
              <Card className="divide-y divide-line p-0 text-sm">
                {figures.topProducts.length === 0 && <p className="px-4 py-4 text-center text-ink-faint">—</p>}
                {figures.topProducts.map((p, i) => (
                  <div key={p.productId} className="flex items-center justify-between gap-2 px-4 py-2">
                    <span className="min-w-0 truncate">
                      <span className="me-1.5 text-xs text-ink-faint">{i + 1}</span>
                      {p.name}
                    </span>
                    <span className="shrink-0 text-end">
                      <b>×{p.qty}</b> <span className="text-xs text-ink-faint">{formatPrice(p.total)}</span>
                    </span>
                  </div>
                ))}
              </Card>
            </div>
          </div>
          {snap?.note && !showLive && (
            <p className="mt-4 text-sm text-ink-soft">
              <b>{t("admin.dayEnd.note")}:</b> {snap.note}
            </p>
          )}
        </div>
      )}

      <Modal open={closeOpen} onClose={() => !saving && setCloseOpen(false)} title={`${snap ? t("admin.dayEnd.closeAgain") : t("admin.dayEnd.closeDay")} · ${date}`} width="sm">
        {live && (
          <div className="flex flex-col gap-3 text-sm">
            <p className="text-ink-soft">{t("admin.dayEnd.closeExplain")}</p>
            <div className="rounded-lg border border-line px-3 py-2">
              <Row label={t("admin.dayEnd.sales")} value={live.salesTotal} />
              <Row label={t("admin.dayEnd.refunds")} value={live.refundTotal} minus />
              <Row label={t("admin.dayEnd.net")} value={live.netTotal} strong />
              <Row label={t("admin.dayEnd.variance")} value={live.drawer.variance} />
            </div>
            <AdminInput value={note} maxLength={500} placeholder={t("admin.dayEnd.notePlaceholder")} onChange={(e) => setNote(e.target.value)} />
            <div className="flex justify-end gap-2">
              <AdminButton onClick={() => setCloseOpen(false)}>{t("admin.common.cancel")}</AdminButton>
              <AdminButton variant="primary" loading={saving} onClick={() => void closeDay()}>
                {snap ? t("admin.dayEnd.closeAgain") : t("admin.dayEnd.closeDay")}
              </AdminButton>
            </div>
          </div>
        )}
      </Modal>
      <ShiftDetailModal session={shift} onClose={() => setShift(null)} />
    </div>
  );
}
