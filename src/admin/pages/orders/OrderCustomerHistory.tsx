import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { where } from "firebase/firestore";
import { customersApi, ordersApi, returnsApi } from "../../../firebase/collections";
import { findGuestPossibleMatches, summarizeCustomerHistory } from "../../customerHistory";
import { useLanguage } from "../../../context/LanguageContext";
import AdminIcon from "../../components/AdminIcons";
import { AdminButton, Badge, Card, PageLoading } from "../../components/ui";
import { formatPrice } from "../../../utils/currency";
import type { AdminOrder, AdminReturn, OrderStatus } from "../../types";
import { useOrder } from "./useOrder";

const STATUSES: OrderStatus[] = ["pending", "processing", "ready", "shipped", "delivered", "completed", "cancelled", "refunded"];

// Matches OrderList.tsx's/OrderDetail.tsx's own STATUS_TONE exactly -- each
// already keeps its own local copy rather than a shared export, so this
// follows the same established convention.
const HISTORY_STATUS_TONE: Record<OrderStatus, "neutral" | "warning" | "info" | "success" | "danger"> = {
  pending: "neutral",
  processing: "warning",
  ready: "success",
  shipped: "info",
  delivered: "success",
  completed: "success",
  cancelled: "danger",
  refunded: "danger",
};

// Dedicated page for one order's Customer History -- extracted verbatim out
// of OrderDetail.tsx's former sidebar card (see that file's history). Fetch,
// summarization, and every displayed figure are unchanged; only where it's
// rendered moved. Read-only: this page never writes anything.
export default function OrderCustomerHistory() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { t } = useLanguage();
  const { order, loading } = useOrder(id);

  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState(false);
  // True only once a real customers/{id} document was found for
  // order.customerId -- NOT simply whether customerId is set, since a web
  // checkout sets it even for an anonymous guest session (see the fetch
  // effect below for why that distinction matters).
  const [historyHasProfile, setHistoryHasProfile] = useState(false);
  const [historyCandidateOrders, setHistoryCandidateOrders] = useState<AdminOrder[]>([]);
  // null = not fetched/not applicable (the guest path -- see
  // customerHistory.ts's own note on why a guest's returns can never be
  // reliably linked), distinct from an empty array (fetched, genuinely zero).
  const [historyReturns, setHistoryReturns] = useState<AdminReturn[] | null>(null);
  const [historyExpanded, setHistoryExpanded] = useState(false);

  // A web checkout ALWAYS sets order.customerId to the checking-out Firebase
  // Auth uid -- including an anonymous guest session's own uid (see
  // orderTransaction.ts: `customerId = input.customerId ?? (isPos ? undefined
  // : uid)`) -- so `customerId` being present does NOT by itself mean
  // "registered". A genuine account only ever gets a customers/{uid}
  // document written by CustomerAuthContext.tsx's own signup flow; an
  // anonymous guest's uid never does, and is also a fresh, one-off id every
  // session (never persists across visits/devices), so querying orders by
  // that id would only ever find this exact order. The one extra get()
  // below (by id, same shape CustomerDetail.tsx already does) is what tells
  // the two apart -- it's a correctness requirement, not just a display
  // nicety. A missing/deleted profile doc for a real customerId falls back
  // to the same email/phone matching a guest gets -- a reasonable
  // degradation, not a crash.
  useEffect(() => {
    if (!order) return;
    let cancelledEffect = false;
    setHistoryLoading(true);
    setHistoryError(false);
    (async () => {
      try {
        const customerDoc = order.customerId ? await customersApi.get(order.customerId) : undefined;
        if (cancelledEffect) return;
        if (order.customerId && customerDoc) {
          setHistoryHasProfile(true);
          const [orders, returns] = await Promise.all([
            ordersApi.list([where("customerId", "==", order.customerId)]),
            returnsApi.list([where("customerId", "==", order.customerId)]),
          ]);
          if (cancelledEffect) return;
          setHistoryCandidateOrders(orders.filter((o) => o.id !== order.id));
          setHistoryReturns(returns);
        } else {
          setHistoryHasProfile(false);
          // No stable identity to query by -- narrow, single-field exact-
          // match queries only (no composite index, no full-collection
          // scan). This intentionally does NOT catch every phone-format
          // variant phoneNumbersLikelyMatch() could in principle tolerate;
          // it catches same-format repeat guests cheaply, and the pure
          // matching step below still re-validates with the real tolerant
          // comparison rather than trusting Firestore's exact-string result
          // blindly.
          const queries: Promise<AdminOrder[]>[] = [];
          if (order.customerEmail) queries.push(ordersApi.list([where("customerEmail", "==", order.customerEmail)]));
          if (order.customerPhone) queries.push(ordersApi.list([where("customerPhone", "==", order.customerPhone)]));
          const results = queries.length > 0 ? await Promise.all(queries) : [];
          if (cancelledEffect) return;
          const byId = new Map<string, AdminOrder>();
          for (const list of results) for (const o of list) if (o.id !== order.id) byId.set(o.id, o);
          setHistoryCandidateOrders([...byId.values()]);
          setHistoryReturns(null);
        }
      } catch {
        if (!cancelledEffect) setHistoryError(true);
      } finally {
        if (!cancelledEffect) setHistoryLoading(false);
      }
    })();
    return () => {
      cancelledEffect = true;
    };
    // Deliberately depends on these four primitive fields only, not the
    // whole `order` object -- see useOrder.ts; this file never itself calls
    // setOrder after the initial fetch, but keeping the same narrow
    // dependency list as OrderDetail.tsx's own copy of this effect avoids
    // any future edit here silently reintroducing that refetch-on-every-
    // unrelated-change bug if a write is ever added to this page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?.id, order?.customerId, order?.customerEmail, order?.customerPhone]);

  // "Guest" here means "no verified, persistent customer profile" -- not
  // merely "no customerId" (see the fetch effect above for why those differ
  // for an anonymous checkout session).
  const isGuestOrder = !!order && !historyHasProfile;
  const guestMatches = useMemo(
    () =>
      order && isGuestOrder
        ? findGuestPossibleMatches(historyCandidateOrders, { email: order.customerEmail, phone: order.customerPhone }, order.id)
        : [],
    [order, isGuestOrder, historyCandidateOrders]
  );
  const historyOrders = isGuestOrder ? guestMatches.map((m) => m.order) : historyCandidateOrders;
  const historySummary = useMemo(
    () => summarizeCustomerHistory(historyOrders, isGuestOrder ? null : historyReturns),
    [historyOrders, isGuestOrder, historyReturns]
  );

  if (loading) return <PageLoading />;
  if (!order) {
    return (
      <div className="text-center text-ink-soft">
        {t("admin.orderDetail.notFound")}{" "}
        <button onClick={() => navigate("/admin/orders")} className="font-semibold text-wine hover:underline">
          {t("admin.orderDetail.backToOrders")}
        </button>
      </div>
    );
  }

  return (
    <div className="pb-16">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
            {t("admin.orderDetail.orderHash")}
            {order.orderNumber}
          </p>
          <h1 className="mt-1 font-display text-2xl font-bold text-ink">{t("admin.orderDetail.customerHistory.title")}</h1>
        </div>
        <AdminButton variant="secondary" onClick={() => navigate(`/admin/orders/${order.id}`)}>
          {t("admin.orderDetail.backToOrder")}
        </AdminButton>
      </div>

      {/* Read-only, no gate beyond reaching this page at all -- the route
          itself is already RequireRole-gated the same as Order Detail, and
          this never lets anyone modify anything. */}
      <Card className="max-w-xl p-5">
        <div className="mb-3 flex items-center justify-between gap-2">
          <p className="text-sm text-ink-soft">{order.customerName}</p>
          {historyHasProfile && order.customerId && (
            <button onClick={() => navigate(`/admin/customers/${order.customerId}`)} className="shrink-0 text-xs font-semibold text-wine hover:underline">
              {t("admin.orderDetail.customerHistory.viewProfile")}
            </button>
          )}
        </div>

        {historyLoading ? (
          <p className="text-sm text-ink-faint">{t("admin.orderDetail.customerHistory.loading")}</p>
        ) : historyError ? (
          <p className="text-sm text-ink-faint">{t("admin.orderDetail.customerHistory.loadFailed")}</p>
        ) : isGuestOrder && historySummary.totalOrders === 0 ? (
          <p className="text-sm text-ink-faint">{t("admin.orderDetail.customerHistory.noGuestMatch")}</p>
        ) : !isGuestOrder && historySummary.totalOrders === 0 ? (
          <p className="text-sm text-ink-faint">{t("admin.orderDetail.customerHistory.noHistory")}</p>
        ) : (
          <div className="flex flex-col gap-3">
            {isGuestOrder && (
              <div className="flex flex-wrap items-center gap-2 rounded-lg bg-sand px-3 py-2.5">
                <Badge tone="warning">{t("admin.orderDetail.customerHistory.possibleMatch")}</Badge>
                <p className="text-xs text-wine-dark">{t("admin.orderDetail.customerHistory.possibleMatchHint")}</p>
              </div>
            )}

            {historySummary.nonDeliveryFlaggedCount > 0 && (
              <div className="rounded-lg bg-wine-light px-3 py-2">
                <Badge tone="danger">
                  {t("admin.orderDetail.customerHistory.nonDeliveryWarning").replace("{count}", String(historySummary.nonDeliveryFlaggedCount))}
                </Badge>
              </div>
            )}

            {historySummary.isRepeatCustomer && (
              <div>
                <Badge tone="info">{t("admin.orderDetail.customerHistory.repeatCustomer")}</Badge>
              </div>
            )}

            <div className="flex flex-col gap-1.5 text-sm">
              <div className="flex justify-between text-ink-soft">
                <span>{t("admin.orderDetail.customerHistory.totalOrders")}</span>
                <span className="font-semibold text-ink">{historySummary.totalOrders}</span>
              </div>
              <div className="flex justify-between text-ink-soft">
                <span>{t("admin.orderDetail.customerHistory.successfulOrders")}</span>
                <span className="font-semibold text-ink">{historySummary.successfulCount}</span>
              </div>
              <div className="flex justify-between text-ink-soft">
                <span>{t("admin.orderDetail.customerHistory.cancelledOrders")}</span>
                <span className="font-semibold text-ink">{historySummary.cancelledCount}</span>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setHistoryExpanded((v) => !v)}
              className="flex items-center gap-1 self-start text-xs font-semibold text-wine hover:underline"
            >
              {t(historyExpanded ? "admin.orderDetail.customerHistory.hideDetails" : "admin.orderDetail.customerHistory.showDetails")}
              <AdminIcon name="chevronDown" className={`h-3.5 w-3.5 transition-transform ${historyExpanded ? "rotate-180" : ""}`} />
            </button>

            {historyExpanded && (
              <div className="flex flex-col gap-3 border-t border-line pt-3">
                <div className="flex flex-col gap-1.5 text-sm">
                  <div className="flex justify-between text-ink-soft">
                    <span>{t("admin.orderDetail.customerHistory.successfulSpend")}</span>
                    <span className="font-semibold text-ink">{formatPrice(historySummary.successfulSpend)}</span>
                  </div>
                  <div className="flex justify-between text-ink-soft">
                    <span>{t("admin.orderDetail.customerHistory.averageOrderValue")}</span>
                    <span className="font-semibold text-ink">
                      {historySummary.averageSuccessfulOrderValue !== null ? formatPrice(historySummary.averageSuccessfulOrderValue) : "—"}
                    </span>
                  </div>
                  {historySummary.returnedOrderCount !== null && (
                    <div className="flex justify-between text-ink-soft">
                      <span>{t("admin.orderDetail.customerHistory.returnedOrders")}</span>
                      <span className="font-semibold text-ink">{historySummary.returnedOrderCount}</span>
                    </div>
                  )}
                  {historySummary.cancellationRatio !== null && (
                    <div className="flex justify-between text-ink-soft">
                      <span>{t("admin.orderDetail.customerHistory.cancellationRate")}</span>
                      <span className="font-semibold text-ink">{Math.round(historySummary.cancellationRatio * 100)}%</span>
                    </div>
                  )}
                  <div className="flex justify-between text-ink-soft">
                    <span>{t("admin.orderDetail.customerHistory.firstOrder")}</span>
                    <span className="font-semibold text-ink">{historySummary.firstOrderAt ? historySummary.firstOrderAt.toLocaleDateString("en-GB") : "—"}</span>
                  </div>
                  <div className="flex justify-between text-ink-soft">
                    <span>{t("admin.orderDetail.customerHistory.lastOrder")}</span>
                    <span className="font-semibold text-ink">{historySummary.lastOrderAt ? historySummary.lastOrderAt.toLocaleDateString("en-GB") : "—"}</span>
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">{t("admin.orderDetail.customerHistory.statusBreakdown")}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {STATUSES.filter((s) => (historySummary.statusCounts[s] ?? 0) > 0).map((s) => (
                      <Badge key={s} tone={HISTORY_STATUS_TONE[s]}>
                        {t(`admin.orderStatus.${s}`)}: {historySummary.statusCounts[s]}
                      </Badge>
                    ))}
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  {historyOrders.map((o) => (
                    <button
                      key={o.id}
                      onClick={() => navigate(`/admin/orders/${o.id}`)}
                      className="flex items-center justify-between gap-2 rounded-lg border border-line px-3 py-2 text-start text-xs hover:border-wine"
                    >
                      <span className="font-semibold text-ink">#{o.orderNumber}</span>
                      <Badge tone={HISTORY_STATUS_TONE[o.status]}>{t(`admin.orderStatus.${o.status}`)}</Badge>
                      <span className="text-ink-soft">{formatPrice(o.total)}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
