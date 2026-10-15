import { where } from "firebase/firestore";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useLanguage } from "../../context/LanguageContext";
import { cashMovementsApi, ordersApi, registerSessionsApi } from "../../firebase/collections";
import { sessionExpectedCash } from "../../firebase/registerSession";
import { formatPrice } from "../../utils/currency";
import type { AdminOrder, CashMovement, Register, RegisterSession } from "../types";
import { Modal } from "./Modal";
import { Badge, PageLoading } from "./ui";

function tsToDate(v: unknown): Date | null {
  const ts = v as { toDate?: () => Date } | undefined;
  return ts?.toDate ? ts.toDate() : null;
}

function useFmt() {
  const { lang } = useLanguage();
  return (v: unknown) => {
    const d = tsToDate(v);
    return d ? d.toLocaleString(lang === "ar" ? "ar" : "en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
  };
}

const byTimeDesc = (a: { createdAt?: unknown }, b: { createdAt?: unknown }) => (tsToDate(b.createdAt)?.getTime() ?? 0) - (tsToDate(a.createdAt)?.getTime() ?? 0);

function VarianceText({ value }: { value?: number }) {
  if (value === undefined) return <>—</>;
  return <span className={`font-semibold ${value < 0 ? "text-wine" : value > 0 ? "text-olive" : "text-ink-soft"}`}>{formatPrice(value)}</span>;
}

// One shift (register session): its cash reconciliation, every sale rung up
// on it and every cash withdrawal made during it.
export function ShiftDetailModal({ session, onClose }: { session: RegisterSession | null; onClose: () => void }) {
  const { t } = useLanguage();
  const fmt = useFmt();
  const [orders, setOrders] = useState<AdminOrder[] | null>(null);
  const [movements, setMovements] = useState<CashMovement[]>([]);

  useEffect(() => {
    if (!session) return;
    setOrders(null);
    setMovements([]);
    ordersApi
      .list([where("registerSessionId", "==", session.id)])
      .then((o) => setOrders(o.sort(byTimeDesc)))
      .catch(() => setOrders([]));
    cashMovementsApi
      .list([where("sessionId", "==", session.id)])
      .then((m) => setMovements(m.sort(byTimeDesc)))
      .catch(() => setMovements([]));
  }, [session]);

  const rows: [string, React.ReactNode][] = session
    ? [
        [t("admin.shifts.pos"), `${session.branchName ?? "—"} · ${session.registerName ?? "—"}`],
        [t("pos.branch.cashier"), session.cashierName],
        [t("admin.posSales.opened"), fmt(session.openedAt)],
        [t("admin.posSales.closed"), session.status === "open" ? <Badge key="s" tone="success">{t("admin.posSales.open")}</Badge> : fmt(session.closedAt)],
        ...(session.closedByName && session.closedByName !== session.cashierName ? [[t("admin.shifts.closedBy"), session.closedByName] as [string, React.ReactNode]] : []),
        [t("pos.openRegister.startingCash"), formatPrice(session.startingCash)],
        [t("pos.closeRegister.cashSales"), `+${formatPrice(session.cashTotal)}`],
        [t("pos.cashOut.withdrawals"), `-${formatPrice(session.cashOutTotal ?? 0)}`],
        [t("pos.closeRegister.expectedCash"), formatPrice(session.expectedCash ?? sessionExpectedCash(session))],
        [t("admin.posSales.counted"), session.countedCash !== undefined ? formatPrice(session.countedCash) : "—"],
        [t("admin.posSales.variance"), <VarianceText key="v" value={session.variance} />],
        [t("pos.closeRegister.cardSales"), formatPrice(session.cardTotal)],
        [t("pos.branch.gross"), `${formatPrice(session.grossTotal)} · ${session.salesCount} ${t("admin.branches.salesShort")}`],
      ]
    : [];

  return (
    <Modal open={!!session} onClose={onClose} title={t("admin.shifts.detailTitle")} width="xl">
      {session && (
        <div className="flex flex-col gap-5">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
            {rows.map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3 border-b border-line/60 py-1">
                <dt className="text-ink-soft">{k}</dt>
                <dd className="text-end text-ink">{v}</dd>
              </div>
            ))}
          </dl>

          <section>
            <h3 className="mb-2 font-display text-base font-bold text-ink">
              {t("admin.posSales.sales")} {orders && <span className="text-ink-faint">({orders.length})</span>}
            </h3>
            {orders === null ? (
              <PageLoading />
            ) : orders.length === 0 ? (
              <p className="rounded-lg border border-dashed border-line px-4 py-4 text-center text-sm text-ink-faint">{t("admin.posSales.noSales")}</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-line">
                <table className="w-full text-sm">
                  <thead className="whitespace-nowrap bg-cream-dim text-xs uppercase text-ink-faint">
                    <tr>
                      <th className="px-3 py-2 text-start">{t("pos.branch.time")}</th>
                      <th className="px-3 py-2 text-start">#</th>
                      <th className="px-3 py-2 text-start">{t("pos.branch.cashier")}</th>
                      <th className="px-3 py-2 text-start">{t("pos.branch.payment")}</th>
                      <th className="px-3 py-2 text-end">{t("admin.orders.colTotal")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {orders.map((o) => (
                      <tr key={o.id}>
                        <td className="px-3 py-2 text-ink-soft">{fmt(o.createdAt)}</td>
                        <td className="px-3 py-2">
                          <Link to={`/admin/orders/${o.id}`} onClick={onClose} className="font-mono text-xs font-semibold text-wine hover:underline">
                            {o.orderNumber}
                          </Link>
                          {(o.status === "cancelled" || o.status === "refunded") && (
                            <span className="ms-2">
                              <Badge tone="neutral">{t(`admin.orderStatus.${o.status}`)}</Badge>
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-ink">{o.cashierName ?? "—"}</td>
                        <td className="px-3 py-2 text-ink-soft">{o.paymentMethod ? t(`pos.terminal.payment.${o.paymentMethod}`) : "—"}</td>
                        <td className="px-3 py-2 text-end font-semibold text-ink">{formatPrice(o.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {movements.length > 0 && (
            <section>
              <h3 className="mb-2 font-display text-base font-bold text-ink">{t("pos.cashOut.withdrawals")}</h3>
              <ul className="divide-y divide-line rounded-lg border border-line text-sm">
                {movements.map((m) => (
                  <li key={m.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <span className="text-ink-soft">
                      {fmt(m.createdAt)} · {m.actorName}
                      {m.reason ? ` · ${m.reason}` : ""}
                    </span>
                    <span className="font-semibold text-ink">-{formatPrice(m.amount)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </Modal>
  );
}

// Every shift ever run on one POS register, newest first. Kept forever --
// shifts are never deleted, even after the register is deactivated.
export function RegisterHistoryModal({ register, onClose, onOpenShift }: { register: Register | null; onClose: () => void; onOpenShift: (s: RegisterSession) => void }) {
  const { t } = useLanguage();
  const fmt = useFmt();
  const [sessions, setSessions] = useState<RegisterSession[] | null>(null);

  useEffect(() => {
    if (!register) return;
    setSessions(null);
    registerSessionsApi
      .list([where("registerId", "==", register.id)])
      .then((s) => setSessions(s.sort((a, b) => (tsToDate(b.openedAt)?.getTime() ?? 0) - (tsToDate(a.openedAt)?.getTime() ?? 0))))
      .catch(() => setSessions([]));
  }, [register]);

  return (
    <Modal open={!!register} onClose={onClose} title={`${t("admin.shifts.historyTitle")} · ${register?.name ?? ""}`} width="xl">
      {sessions === null ? (
        <PageLoading />
      ) : sessions.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-sm text-ink-faint">{t("admin.posSales.noShifts")}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead className="whitespace-nowrap bg-cream-dim text-xs uppercase text-ink-faint">
              <tr>
                <th className="px-3 py-2 text-start">{t("pos.branch.cashier")}</th>
                <th className="px-3 py-2 text-start">{t("admin.posSales.opened")}</th>
                <th className="px-3 py-2 text-start">{t("admin.posSales.closed")}</th>
                <th className="px-3 py-2 text-end">{t("pos.openRegister.startingCash")}</th>
                <th className="px-3 py-2 text-end">{t("pos.closeRegister.expectedCash")}</th>
                <th className="px-3 py-2 text-end">{t("admin.posSales.counted")}</th>
                <th className="px-3 py-2 text-end">{t("admin.posSales.variance")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {sessions.map((s) => (
                <tr key={s.id} onClick={() => onOpenShift(s)} className="cursor-pointer hover:bg-cream-dim/50">
                  <td className="px-3 py-2 font-semibold text-ink">{s.cashierName}</td>
                  <td className="px-3 py-2 text-ink-soft">{fmt(s.openedAt)}</td>
                  <td className="px-3 py-2 text-ink-soft">{s.status === "open" ? <Badge tone="success">{t("admin.posSales.open")}</Badge> : fmt(s.closedAt)}</td>
                  <td className="px-3 py-2 text-end">{formatPrice(s.startingCash)}</td>
                  <td className="px-3 py-2 text-end">{formatPrice(s.expectedCash ?? sessionExpectedCash(s))}</td>
                  <td className="px-3 py-2 text-end">{s.countedCash !== undefined ? formatPrice(s.countedCash) : "—"}</td>
                  <td className="px-3 py-2 text-end">
                    <VarianceText value={s.variance} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
