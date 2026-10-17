import { AnimatePresence, motion } from "motion/react";
import { orderBy, limit, where } from "../../db/firestore";
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { OPEN_ORDERS_PANEL_EVENT } from "../../pos/ordersPanelEvent";
import { categoriesApi, ordersApi, productsApi } from "../../firebase/collections";
import { useLanguage } from "../../context/LanguageContext";
import { useAdminSession, type AdminSessionInfo } from "../../hooks/useAdminSession";
import { resolveImageSrc } from "../../admin/imageSrc";
import AdminIcon from "../../admin/components/AdminIcons";
import { AdminButton, Badge } from "../../admin/components/ui";
import ProcessReturnModal from "../../admin/components/ProcessReturnModal";
import { RETURNABLE_ORDER_STATUSES } from "../../admin/returnsHelpers";
import type { AdminCategory, AdminOrder, AdminProduct, OrderStatus } from "../../admin/types";
import { buildCategoryLookup, buildOrderSearchBlob, buildProductLookup, matchesSearch } from "./orderSearch";
import { formatPrice } from "../../utils/currency";

const OPEN_KEY = "lulua-global-orders-open";
const LAST_VIEWED_KEY = "lulua-global-orders-last-viewed";
const MAX_ORDERS = 300;

const STATUS_TONE: Record<OrderStatus, "neutral" | "warning" | "info" | "success" | "danger"> = {
  pending: "neutral",
  processing: "warning",
  ready: "success",
  shipped: "info",
  delivered: "success",
  completed: "success",
  cancelled: "danger",
  refunded: "danger",
};

type SourceFilter = "all" | "web" | "pos";

function tsToDate(v: unknown): Date | null {
  const ts = v as { toDate?: () => Date } | undefined;
  return ts?.toDate ? ts.toDate() : null;
}

function timeAgo(v: unknown, t: (key: string) => string): string {
  const date = tsToDate(v);
  if (!date) return "";
  const seconds = Math.max(0, (Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return t("admin.dashboard.justNow");
  if (seconds < 3600) return t("admin.dashboard.minAgo").replace("{n}", String(Math.floor(seconds / 60)));
  if (seconds < 86400) return t("admin.dashboard.hourAgo").replace("{n}", String(Math.floor(seconds / 3600)));
  return t("admin.dashboard.dayAgo").replace("{n}", String(Math.floor(seconds / 86400)));
}

export default function GlobalOrdersSidebarPanel() {
  const { t, dir } = useLanguage();
  const session = useAdminSession();
  const [open, setOpen] = useState(() => localStorage.getItem(OPEN_KEY) === "1");
  const [orders, setOrders] = useState<AdminOrder[]>([]);
  const [products, setProducts] = useState<AdminProduct[]>([]);
  const [categories, setCategories] = useState<AdminCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [selected, setSelected] = useState<AdminOrder | null>(null);
  // On the POS the floating edge tab would sit on top of the till's sale
  // panel, so it's hidden there and the POS header's menu opens the panel
  // through OPEN_ORDERS_PANEL_EVENT instead.
  const pathname = useLocation().pathname;
  const onPos = pathname.startsWith("/pos");
  // The admin is scoped to POS operations, so this online-orders panel is
  // not shown there (storefront and POS behaviour are unchanged).
  const onAdmin = pathname === "/admin" || pathname.startsWith("/admin/");
  useEffect(() => {
    const openPanel = () => setOpen(true);
    window.addEventListener(OPEN_ORDERS_PANEL_EVENT, openPanel);
    return () => window.removeEventListener(OPEN_ORDERS_PANEL_EVENT, openPanel);
  }, []);
  const [lastViewedAt, setLastViewedAt] = useState(() => Number(localStorage.getItem(LAST_VIEWED_KEY) ?? 0));

  const role = session?.role;
  const branchKey = session?.branchIds.join(",") ?? "";

  useEffect(() => {
    if (!role) return;
    if (role !== "cashier") {
      const unsub = ordersApi.subscribe(
        (data) => {
          setOrders(data);
          setLoading(false);
        },
        [orderBy("createdAt", "desc"), limit(MAX_ORDERS)]
      );
      return unsub;
    }
    // Multi-branch: a cashier may only read online (web/manual) orders plus
    // POS sales from their own branches (firestore.rules) -- an unfiltered
    // list query would be rejected outright. Two queries that each filter on
    // exactly what the rule checks, merged newest-first.
    const branchIds = branchKey ? branchKey.split(",").slice(0, 30) : [];
    let online: AdminOrder[] = [];
    let branch: AdminOrder[] = [];
    let pending = branchIds.length ? 2 : 1;
    const publish = () => {
      const merged = [...online, ...branch].sort((a, b) => (tsToDate(b.createdAt)?.getTime() ?? 0) - (tsToDate(a.createdAt)?.getTime() ?? 0));
      setOrders(merged.slice(0, MAX_ORDERS));
      if (pending <= 0) setLoading(false);
    };
    const unsubs = [
      ordersApi.subscribe(
        (data) => {
          online = data;
          pending--;
          publish();
        },
        [where("source", "in", ["web", "manual"]), orderBy("createdAt", "desc"), limit(MAX_ORDERS)]
      ),
    ];
    if (branchIds.length) {
      unsubs.push(
        ordersApi.subscribe(
          (data) => {
            branch = data;
            pending--;
            publish();
          },
          [where("branchId", "in", branchIds), orderBy("createdAt", "desc"), limit(MAX_ORDERS)]
        )
      );
    }
    return () => unsubs.forEach((u) => u());
  }, [role, branchKey]);

  // Product/category catalogs power the search index (a sold item's order
  // line only ever stores the English name it was sold under — searching
  // by Arabic product name or by category needs a live cross-reference by
  // id). Fetched once; catalogs change far less often than orders do.
  useEffect(() => {
    Promise.all([productsApi.list(), categoriesApi.list()]).then(([p, c]) => {
      setProducts(p);
      setCategories(c);
    });
  }, []);

  const productLookup = useMemo(() => buildProductLookup(products), [products]);
  const categoryLookup = useMemo(() => buildCategoryLookup(categories), [categories]);

  // One normalized search blob per order, rebuilt only when the orders or
  // catalogs actually change — not on every keystroke — so typing stays
  // instant regardless of how many orders are loaded.
  const searchBlobs = useMemo(() => {
    const map = new Map<string, string>();
    for (const o of orders) map.set(o.id, buildOrderSearchBlob(o, productLookup, categoryLookup));
    return map;
  }, [orders, productLookup, categoryLookup]);

  useEffect(() => {
    localStorage.setItem(OPEN_KEY, open ? "1" : "0");
    if (open) {
      const now = Date.now();
      setLastViewedAt(now);
      localStorage.setItem(LAST_VIEWED_KEY, String(now));
    }
  }, [open]);

  const hasNew = useMemo(() => {
    const latest = orders[0] ? tsToDate(orders[0].createdAt)?.getTime() ?? 0 : 0;
    return latest > lastViewedAt;
  }, [orders, lastViewedAt]);

  // Keeps the open detail view's order in sync with the live subscription
  // above (e.g. right after saving a branch stock note) — `selected` is a
  // captured snapshot, not a reference into `orders`, so without this it
  // would otherwise only ever reflect the moment it was clicked.
  useEffect(() => {
    setSelected((prev) => (prev ? orders.find((o) => o.id === prev.id) ?? prev : prev));
  }, [orders]);

  const filtered = useMemo(() => {
    return orders.filter((o) => {
      if (sourceFilter === "web" && o.source === "pos") return false;
      if (sourceFilter === "pos" && o.source !== "pos") return false;
      if (search.trim() && !matchesSearch(searchBlobs.get(o.id) ?? "", search)) return false;
      return true;
    });
  }, [orders, search, sourceFilter, searchBlobs]);

  function close() {
    setOpen(false);
    setSelected(null);
  }

  if (onAdmin) return null;

  return (
    <>
      {/* Persistent edge tab — always present for an admin, tiny footprint when closed */}
      {!open && !onPos && (
        <button
          onClick={() => setOpen(true)}
          aria-label={t("admin.globalOrders.open")}
          title={t("admin.globalOrders.open")}
          className="fixed end-0 bottom-6 z-[240] flex flex-col items-center gap-1.5 rounded-s-2xl border border-e-0 border-line bg-paper px-2.5 py-4 text-wine shadow-lift transition-colors hover:bg-cream-dim lg:top-1/2 lg:bottom-auto lg:-translate-y-1/2"
        >
          <span className="relative">
            <AdminIcon name="bag" className="h-5 w-5" />
            {hasNew && <span className="absolute -end-1 -top-1 h-2 w-2 rounded-full bg-wine" />}
          </span>
        </button>
      )}

      <AnimatePresence>
        {open && (
          <>
            <motion.div
              key="backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="fixed inset-0 z-[241] bg-ink/30 backdrop-blur-[1px]"
              onClick={close}
            />
            <motion.aside
              key="panel"
              initial={{ x: dir === "rtl" ? "-100%" : "100%" }}
              animate={{ x: 0 }}
              exit={{ x: dir === "rtl" ? "-100%" : "100%" }}
              transition={{ type: "spring", stiffness: 340, damping: 36 }}
              dir={dir}
              className="admin-root fixed end-0 top-0 z-[242] flex h-full w-full max-w-md flex-col bg-paper shadow-lift"
              role="dialog"
              aria-modal="true"
              aria-label={t("admin.globalOrders.title")}
            >
              <div className="flex items-center justify-between border-b border-line px-5 py-4">
                <div className="flex items-center gap-2">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-olive opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-olive" />
                  </span>
                  <h2 className="font-display text-lg font-bold text-ink">{t("admin.globalOrders.title")}</h2>
                </div>
                <button
                  onClick={close}
                  aria-label={t("admin.globalOrders.close")}
                  className="flex h-9 w-9 items-center justify-center rounded-full text-ink-soft hover:bg-cream-dim hover:text-ink"
                >
                  <AdminIcon name="x" className="h-4.5 w-4.5" />
                </button>
              </div>

              {selected ? (
                <OrderDetailView order={selected} onBack={() => setSelected(null)} onClose={close} t={t} session={session} />
              ) : (
                <>
                  <div className="flex flex-col gap-2.5 border-b border-line px-5 py-3">
                    <div className="relative">
                      <AdminIcon name="search" className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
                      <input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder={t("admin.globalOrders.searchPlaceholder")}
                        className="w-full rounded-lg border border-line bg-paper py-2 ps-9 pe-3 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-wine"
                      />
                    </div>
                    <div className="flex gap-1 rounded-lg bg-cream-dim p-1">
                      {(["all", "web", "pos"] as SourceFilter[]).map((f) => (
                        <button
                          key={f}
                          onClick={() => setSourceFilter(f)}
                          className={`flex-1 rounded-md py-1.5 text-xs font-semibold transition-colors ${
                            sourceFilter === f ? "bg-paper text-ink shadow-soft" : "text-ink-soft hover:text-ink"
                          }`}
                        >
                          {f === "all" ? t("admin.globalOrders.filterAll") : f === "web" ? t("admin.globalOrders.sourceWeb") : t("admin.globalOrders.sourcePos")}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="flex-1 overflow-y-auto">
                    {loading ? (
                      <div className="flex justify-center py-14">
                        <span className="h-6 w-6 animate-spin rounded-full border-2 border-wine border-t-transparent" />
                      </div>
                    ) : filtered.length === 0 ? (
                      <p className="px-5 py-14 text-center text-sm text-ink-faint">{t("admin.globalOrders.empty")}</p>
                    ) : (
                      filtered.map((o) => (
                        <button
                          key={o.id}
                          onClick={() => setSelected(o)}
                          className="flex w-full items-start gap-3 border-b border-line px-5 py-3 text-start transition-colors hover:bg-cream-dim/60"
                        >
                          <div
                            className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
                              o.source === "pos" ? "bg-olive-light text-olive" : "bg-wine-light text-wine"
                            }`}
                          >
                            <AdminIcon name={o.source === "pos" ? "grid" : "bag"} className="h-4 w-4" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-semibold text-ink">{o.customerName}</p>
                            <p className="truncate text-xs text-ink-faint">
                              #{o.orderNumber} · {o.source === "pos" ? t("admin.globalOrders.sourcePos") : t("admin.globalOrders.sourceWeb")} · {timeAgo(o.createdAt, t)}
                            </p>
                          </div>
                          <div className="shrink-0 text-end">
                            <p className="text-sm font-bold text-ink">{formatPrice(o.total)}</p>
                            <div className="mt-0.5">
                              <Badge tone={STATUS_TONE[o.status]}>{t(`admin.orderStatus.${o.status}`)}</Badge>
                            </div>
                          </div>
                        </button>
                      ))
                    )}
                  </div>

                  <div className="border-t border-line px-5 py-3">
                    <Link to="/admin/orders" onClick={close} className="block text-center text-sm font-semibold text-wine hover:underline">
                      {t("admin.globalOrders.viewAll")}
                    </Link>
                  </div>
                </>
              )}
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </>
  );
}

function OrderDetailView({
  order,
  onBack,
  onClose,
  t,
  session,
}: {
  order: AdminOrder;
  onBack: () => void;
  onClose: () => void;
  t: (key: string) => string;
  session: AdminSessionInfo | null;
}) {
  const placedAt = tsToDate(order.createdAt);
  const [returnModalOpen, setReturnModalOpen] = useState(false);
  const canProcessReturn =
    !!session && ["owner", "admin", "cashier"].includes(session.role) && RETURNABLE_ORDER_STATUSES.includes(order.status);

  return (
    <>
      <div className="flex items-center gap-2 border-b border-line px-5 py-3">
        <button onClick={onBack} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-ink-soft hover:bg-cream-dim hover:text-ink">
          <AdminIcon name="chevronLeft" className="h-4 w-4 rtl:rotate-180" />
        </button>
        <p className="flex-1 truncate font-display text-base font-bold text-ink">#{order.orderNumber}</p>
        <Link to={`/admin/orders/${order.id}`} onClick={onClose} className="shrink-0 text-xs font-semibold text-wine hover:underline">
          {t("admin.globalOrders.openFull")}
        </Link>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={STATUS_TONE[order.status]}>{t(`admin.orderStatus.${order.status}`)}</Badge>
          <Badge tone={order.source === "pos" ? "success" : "info"}>
            {order.source === "pos" ? t("admin.globalOrders.sourcePos") : t("admin.globalOrders.sourceWeb")}
          </Badge>
        </div>
        {placedAt && <p className="mt-2 text-xs text-ink-faint">{placedAt.toLocaleString()}</p>}

        <div className="mt-4 rounded-xl border border-line p-3.5">
          <p className="text-sm font-semibold text-ink">{order.customerName}</p>
          {order.customerEmail && <p className="text-xs text-ink-soft">{order.customerEmail}</p>}
          {order.customerPhone && <p className="text-xs text-ink-soft">{order.customerPhone}</p>}
          {order.shippingAddress && <p className="mt-1.5 text-xs text-ink-soft">{order.shippingAddress}</p>}
          {order.source === "pos" && order.paymentMethod && (
            <p className="mt-1.5 text-xs text-ink-soft">
              {t("admin.globalOrders.paidVia")} {t(`pos.terminal.payment.${order.paymentMethod}`)}
              {order.paymentMethod === "split" && order.cashAmount != null && order.cardAmount != null && (
                <> · {t("pos.terminal.cash")} {formatPrice(order.cashAmount)} · {t("pos.terminal.card")} {formatPrice(order.cardAmount)}</>
              )}
            </p>
          )}
        </div>

        <div className="mt-4">
          <p className="mb-2 text-sm font-semibold text-ink">{t("admin.orderDetail.items")}</p>
          <div className="flex flex-col divide-y divide-line rounded-xl border border-line">
            {order.lines.map((line, i) => (
              <div key={i} className="flex items-center gap-3 p-3">
                <div className="h-11 w-11 shrink-0 overflow-hidden rounded-lg bg-cream-dim">
                  {resolveImageSrc(line) && <img src={resolveImageSrc(line)} alt="" className="h-full w-full object-cover" />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink">{line.name}</p>
                  <p className="text-xs text-ink-faint">
                    {line.color} · {line.size} · ×{line.qty}
                  </p>
                </div>
                <p className="shrink-0 text-sm font-semibold text-ink">{formatPrice(line.price * line.qty)}</p>
              </div>
            ))}
          </div>
        </div>

        {canProcessReturn && (
          <div className="mt-3">
            <AdminButton variant="secondary" size="sm" icon="refresh" onClick={() => setReturnModalOpen(true)} className="w-full">
              {t("admin.returns.processReturn")}
            </AdminButton>
          </div>
        )}

        <div className="mt-4 flex flex-col gap-1.5 text-sm">
          <div className="flex justify-between text-ink-soft">
            <span>{t("admin.orderDetail.subtotal")}</span>
            <span>{formatPrice(order.subtotal)}</span>
          </div>
          {!!order.discount && (
            <div className="flex justify-between text-ink-soft">
              <span>{t("pos.terminal.discountLabel")}</span>
              <span>-{formatPrice(order.discount)}</span>
            </div>
          )}
          <div className="flex justify-between text-ink-soft">
            <span>{t("admin.orderDetail.shipping")}</span>
            <span>{formatPrice(order.shipping)}</span>
          </div>
          <div className="flex justify-between border-t border-line pt-1.5 font-bold text-ink">
            <span>{t("admin.orders.colTotal")}</span>
            <span>{formatPrice(order.total)}</span>
          </div>
        </div>

        {order.notes && (
          <div className="mt-4">
            <p className="mb-1 text-sm font-semibold text-ink">{t("admin.customers.notes")}</p>
            <p className="rounded-lg bg-cream-dim px-3 py-2.5 text-sm text-ink-soft">{order.notes}</p>
          </div>
        )}

      </div>

      {canProcessReturn && session && (
        <ProcessReturnModal
          open={returnModalOpen}
          onClose={() => setReturnModalOpen(false)}
          order={order}
          actor={session}
        />
      )}
    </>
  );
}
