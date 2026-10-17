import { orderBy, Timestamp, where } from "../db/firestore";
import { useEffect, useMemo, useState } from "react";
import { PageLoading } from "../admin/components/ui";
import type { AdminOrder, RegisterSession } from "../admin/types";
import { useLanguage } from "../context/LanguageContext";
import { ordersApi } from "../firebase/collections";
import { sessionExpectedCash } from "../firebase/registerSession";
import { formatPrice } from "../utils/currency";

function tsToDate(v: unknown): Date | null {
  const ts = v as { toDate?: () => Date } | undefined;
  return ts?.toDate ? ts.toDate() : null;
}

// The cashier's own end-of-day view: this shift's running totals (from the
// register session) and every sale rung up today at this branch, across all
// of its registers. Only this branch's POS sales are readable to a cashier
// at all (firestore.rules), and this query filters on exactly that.
export default function TodaySales({ session }: { session: RegisterSession }) {
  const { t, lang } = useLanguage();
  const [orders, setOrders] = useState<AdminOrder[] | null>(null);
  const [registerFilter, setRegisterFilter] = useState<"all" | "mine">("all");

  useEffect(() => {
    if (!session.branchId) {
      setOrders([]);
      return;
    }
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return ordersApi.subscribe(setOrders, [
      where("branchId", "==", session.branchId),
      where("createdAt", ">=", Timestamp.fromDate(start)),
      orderBy("createdAt", "desc"),
    ]);
  }, [session.branchId]);

  const shown = useMemo(
    () => (orders ?? []).filter((o) => o.source === "pos" && (registerFilter === "all" || o.registerId === session.registerId)),
    [orders, registerFilter, session.registerId]
  );
  const totals = useMemo(() => {
    const valid = shown.filter((o) => o.status !== "cancelled" && o.status !== "refunded");
    return {
      count: valid.length,
      gross: valid.reduce((s, o) => s + o.total, 0),
      cash: valid.reduce((s, o) => s + (o.cashAmount ?? 0), 0),
      card: valid.reduce((s, o) => s + (o.cardAmount ?? 0), 0),
      items: valid.reduce((s, o) => s + o.lines.reduce((n, l) => n + l.qty, 0), 0),
    };
  }, [shown]);

  if (orders === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <PageLoading />
      </div>
    );
  }

  const expectedCash = sessionExpectedCash(session);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-4xl flex-col gap-6 p-6">
        <section>
          <h1 className="font-display text-2xl font-bold text-ink">{t("pos.branch.thisShift")}</h1>
          <p className="text-sm text-ink-soft">
            {session.branchName} · {session.registerName} · {session.cashierName}
          </p>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: t("pos.closeRegister.salesCount"), value: String(session.salesCount) },
              { label: t("pos.branch.gross"), value: formatPrice(session.grossTotal) },
              { label: t("pos.closeRegister.cashSales"), value: formatPrice(session.cashTotal) },
              { label: t("pos.closeRegister.cardSales"), value: formatPrice(session.cardTotal) },
            ].map((k) => (
              <div key={k.label} className="rounded-xl bg-paper p-4 shadow-soft">
                <p className="text-xs font-semibold uppercase text-ink-faint">{k.label}</p>
                <p className="mt-1 font-display text-xl font-bold text-ink">{k.value}</p>
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-ink-faint">
            {t("pos.closeRegister.expectedCash")}: {formatPrice(expectedCash)} ({t("pos.openRegister.startingCash")} {formatPrice(session.startingCash)}
            {(session.cashOutTotal ?? 0) > 0 && (
              <>
                {" "}
                · {t("pos.cashOut.withdrawals")} -{formatPrice(session.cashOutTotal ?? 0)}
              </>
            )}
            )
          </p>
        </section>

        <section>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-display text-xl font-bold text-ink">{t("pos.branch.todayAtBranch")}</h2>
            <div className="flex rounded-full border border-line p-1 text-sm">
              {(["all", "mine"] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setRegisterFilter(f)}
                  className={`rounded-full px-3 py-1 font-semibold ${registerFilter === f ? "bg-wine text-on-accent" : "text-ink-soft"}`}
                >
                  {f === "all" ? t("pos.branch.allRegisters") : t("pos.branch.thisRegister")}
                </button>
              ))}
            </div>
          </div>
          <div className="mb-3 flex flex-wrap gap-4 text-sm text-ink-soft">
            <span>
              {t("pos.closeRegister.salesCount")}: <b className="text-ink">{totals.count}</b>
            </span>
            <span>
              {t("pos.branch.items")}: <b className="text-ink">{totals.items}</b>
            </span>
            <span>
              {t("pos.branch.gross")}: <b className="text-ink">{formatPrice(totals.gross)}</b>
            </span>
            <span>
              {t("pos.terminal.cash")}: <b className="text-ink">{formatPrice(totals.cash)}</b>
            </span>
            <span>
              {t("pos.terminal.card")}: <b className="text-ink">{formatPrice(totals.card)}</b>
            </span>
          </div>
          {shown.length === 0 ? (
            <p className="rounded-xl border border-dashed border-line py-10 text-center text-sm text-ink-faint">{t("pos.branch.noSalesToday")}</p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-line bg-paper">
              <table className="w-full text-sm">
                <thead className="bg-cream-dim text-xs uppercase text-ink-faint">
                  <tr>
                    <th className="px-3 py-2 text-start">{t("pos.branch.time")}</th>
                    <th className="px-3 py-2 text-start">#</th>
                    <th className="px-3 py-2 text-start">{t("pos.branch.register")}</th>
                    <th className="px-3 py-2 text-start">{t("pos.branch.cashier")}</th>
                    <th className="px-3 py-2 text-start">{t("pos.branch.payment")}</th>
                    <th className="px-3 py-2 text-end">{t("admin.orders.colTotal")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {shown.map((o) => (
                    <tr key={o.id}>
                      <td className="px-3 py-2 text-ink-soft">
                        {tsToDate(o.createdAt)?.toLocaleTimeString(lang === "ar" ? "ar" : "en-US", { hour: "2-digit", minute: "2-digit" }) ?? "—"}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-ink">{o.orderNumber}</td>
                      <td className="px-3 py-2 text-ink">{o.registerName ?? "—"}</td>
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
      </div>
    </div>
  );
}
