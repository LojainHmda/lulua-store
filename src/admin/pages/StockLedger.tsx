import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { productsApi, stockMovementsApi } from "../../firebase/collections";
import { useLanguage } from "../../context/LanguageContext";
import { localizedName } from "../../data/localize";
import AdminIcon from "../components/AdminIcons";
import { AdminButton, AdminInput, AdminSelect, Badge, Card, EmptyState, Field, PageHeader, PageLoading, SearchInput } from "../components/ui";
import { resolveProductImageSrc } from "../imageSrc";
import {
  applyClientLedgerFilters,
  buildLedgerQueryConstraints,
  findPageCursor,
  resolveActorDisplay,
  stockMovementDeltaTone,
  STOCK_MOVEMENT_REASON_LABEL_KEY,
  STOCK_MOVEMENT_SOURCE_LABEL_KEY,
  type ClientLedgerFilters,
  type LedgerFilters,
  type LedgerPageCursor,
} from "../stockMovements";
import type { AdminProduct, StockMovement, StockMovementReason, StockMovementSource } from "../types";

const PAGE_SIZE = 50;
const REASONS = Object.keys(STOCK_MOVEMENT_REASON_LABEL_KEY) as StockMovementReason[];
const SOURCES = Object.keys(STOCK_MOVEMENT_SOURCE_LABEL_KEY) as StockMovementSource[];

function tsToDate(v: unknown): Date | null {
  const ts = v as { toDate?: () => Date } | undefined;
  return ts?.toDate ? ts.toDate() : null;
}

interface ServerFilterState extends LedgerFilters {
  productName?: string; // display-only, never sent to the query
}

export default function StockLedger() {
  const { t, lang } = useLanguage();
  const [searchParams] = useSearchParams();

  const [serverFilters, setServerFilters] = useState<ServerFilterState>(() => {
    const productId = searchParams.get("productId") ?? undefined;
    return productId ? { productId, productName: searchParams.get("productName") ?? undefined } : {};
  });
  const [clientFilters, setClientFilters] = useState<ClientLedgerFilters>({});
  const [filtersOpen, setFiltersOpen] = useState(false);

  const [rows, setRows] = useState<StockMovement[]>([]);
  const [cursor, setCursor] = useState<LedgerPageCursor | undefined>(undefined);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState(false);

  const [productQuery, setProductQuery] = useState("");
  const [productResultsOpen, setProductResultsOpen] = useState(false);
  const [allProducts, setAllProducts] = useState<AdminProduct[]>([]);
  const [productCache, setProductCache] = useState<Map<string, AdminProduct | null>>(new Map());
  const [orderIdDraft, setOrderIdDraft] = useState(serverFilters.orderId ?? "");

  useEffect(() => {
    setOrderIdDraft(serverFilters.orderId ?? "");
  }, [serverFilters.orderId]);

  // A one-time fetch for the product search/autocomplete filter -- not a
  // live subscription, matching the same pattern AddOrderItemModal already
  // uses for its own product picker. The "no full-collection subscribe()"
  // requirement is about stockMovements itself (see the pagination below),
  // not this unrelated, already-established product lookup.
  useEffect(() => {
    productsApi.list().then(setAllProducts).catch(() => {});
  }, []);

  const productMatches = useMemo(() => {
    const q = productQuery.trim().toLowerCase();
    if (!q) return [];
    return allProducts.filter((p) => p.name.toLowerCase().includes(q) || (p.nameAr ?? "").toLowerCase().includes(q)).slice(0, 8);
  }, [allProducts, productQuery]);

  function selectProductFilter(p: AdminProduct) {
    setServerFilters((f) => ({ ...f, productId: p.id, productName: localizedName(p.name, p.nameAr, lang) }));
    setProductQuery("");
    setProductResultsOpen(false);
  }

  function clearProductFilter() {
    setServerFilters((f) => ({ ...f, productId: undefined, productName: undefined }));
  }

  function commitOrderId() {
    const trimmed = orderIdDraft.trim();
    setServerFilters((f) => ({ ...f, orderId: trimmed || undefined }));
  }

  function clearAllFilters() {
    setServerFilters({});
    setClientFilters({});
    setOrderIdDraft("");
    setProductQuery("");
  }

  const hasAnyFilter = !!(
    serverFilters.productId ||
    serverFilters.orderId ||
    serverFilters.dateFrom ||
    serverFilters.dateTo ||
    clientFilters.colorName ||
    clientFilters.size ||
    clientFilters.reason ||
    clientFilters.source ||
    clientFilters.actor
  );

  async function loadPage(reset: boolean) {
    if (reset) {
      setLoading(true);
      setLoadError(false);
    } else {
      setLoadingMore(true);
    }
    try {
      const { productName: _productName, ...ledgerFilters } = serverFilters;
      void _productName;
      const constraints = buildLedgerQueryConstraints(ledgerFilters, { cursor: reset ? undefined : cursor, pageSize: PAGE_SIZE });
      const page = await stockMovementsApi.list(constraints);
      setRows((prev) => (reset ? page : [...prev, ...page]));
      setCursor(findPageCursor(page));
      setHasMore(!ledgerFilters.orderId && page.length === PAGE_SIZE);
    } catch {
      setLoadError(true);
      if (reset) setRows([]);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    void loadPage(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverFilters.productId, serverFilters.orderId, serverFilters.dateFrom, serverFilters.dateTo]);

  // Best-effort live thumbnail lookup, capped to whatever's on the current
  // page and cached across pages -- the ledger schema stores no image
  // reference (see stockMovements.ts), so this is the only way to show
  // one. A product that no longer exists resolves to `null` and simply
  // falls back to a placeholder icon; the row's text always comes from the
  // denormalized productName regardless, so nothing here is ever required
  // for the row to render correctly.
  useEffect(() => {
    const missing = Array.from(new Set(rows.map((r) => r.productId))).filter((id) => !productCache.has(id));
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        missing.map(async (id) => {
          try {
            const p = await productsApi.get(id);
            return [id, p ?? null] as const;
          } catch {
            return [id, null] as const;
          }
        })
      );
      if (cancelled) return;
      setProductCache((prev) => {
        const next = new Map(prev);
        for (const [id, p] of entries) next.set(id, p);
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [rows, productCache]);

  const colorOptions = useMemo(() => Array.from(new Set(rows.map((r) => r.colorName))).sort(), [rows]);
  const sizeOptions = useMemo(() => Array.from(new Set(rows.map((r) => r.size))).sort(), [rows]);
  const visibleRows = useMemo(() => applyClientLedgerFilters(rows, clientFilters), [rows, clientFilters]);

  return (
    <div>
      <PageHeader title={t("admin.stockLedger.pageTitle")} description={t("admin.stockLedger.pageDescription")} />

      <div className="mb-4 flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          {serverFilters.productId ? (
            <div className="flex items-center gap-2 rounded-lg border border-line bg-cream-dim px-3 py-2 text-sm">
              <span className="font-semibold text-ink">
                {t("admin.stockLedger.showingHistoryFor").replace("{product}", serverFilters.productName ?? serverFilters.productId)}
              </span>
              <button type="button" onClick={clearProductFilter} className="font-semibold text-wine hover:underline">
                {t("admin.stockLedger.clearProductFilter")}
              </button>
            </div>
          ) : (
            <div className="relative">
              <SearchInput
                value={productQuery}
                onChange={(v) => {
                  setProductQuery(v);
                  setProductResultsOpen(true);
                }}
                placeholder={t("admin.stockLedger.searchProductPlaceholder")}
              />
              {productResultsOpen && productMatches.length > 0 && (
                <div className="absolute z-10 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-line bg-paper shadow-soft sm:w-72">
                  {productMatches.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onMouseDown={() => selectProductFilter(p)}
                      className="flex w-full items-center px-3 py-2 text-start text-sm text-ink hover:bg-cream-dim"
                    >
                      {localizedName(p.name, p.nameAr, lang)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <AdminButton variant="ghost" size="sm" icon="filter" onClick={() => setFiltersOpen((v) => !v)}>
            {filtersOpen ? t("admin.stockLedger.hideFilters") : t("admin.stockLedger.filters")}
          </AdminButton>

          {hasAnyFilter && (
            <button type="button" onClick={clearAllFilters} className="text-sm font-semibold text-wine hover:underline">
              {t("admin.stockLedger.clearFilters")}
            </button>
          )}
        </div>

        {filtersOpen && (
          <Card className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label={t("admin.stockLedger.color")}>
              <AdminSelect
                value={clientFilters.colorName ?? ""}
                onChange={(e) => setClientFilters((f) => ({ ...f, colorName: e.target.value || undefined }))}
              >
                <option value="">{t("admin.stockLedger.allColors")}</option>
                {colorOptions.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </AdminSelect>
            </Field>

            <Field label={t("admin.stockLedger.size")}>
              <AdminSelect value={clientFilters.size ?? ""} onChange={(e) => setClientFilters((f) => ({ ...f, size: e.target.value || undefined }))}>
                <option value="">{t("admin.stockLedger.allSizes")}</option>
                {sizeOptions.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </AdminSelect>
            </Field>

            <Field label={t("admin.stockLedger.reasonLabel")}>
              <AdminSelect
                value={clientFilters.reason ?? ""}
                onChange={(e) => setClientFilters((f) => ({ ...f, reason: (e.target.value || undefined) as StockMovementReason | undefined }))}
              >
                <option value="">{t("admin.stockLedger.allReasons")}</option>
                {REASONS.map((r) => (
                  <option key={r} value={r}>
                    {t(STOCK_MOVEMENT_REASON_LABEL_KEY[r])}
                  </option>
                ))}
              </AdminSelect>
            </Field>

            <Field label={t("admin.stockLedger.sourceLabel")}>
              <AdminSelect
                value={clientFilters.source ?? ""}
                onChange={(e) => setClientFilters((f) => ({ ...f, source: (e.target.value || undefined) as StockMovementSource | undefined }))}
              >
                <option value="">{t("admin.stockLedger.allSources")}</option>
                {SOURCES.map((s) => (
                  <option key={s} value={s}>
                    {t(STOCK_MOVEMENT_SOURCE_LABEL_KEY[s])}
                  </option>
                ))}
              </AdminSelect>
            </Field>

            <Field label={t("admin.stockLedger.actor")}>
              <AdminInput
                value={clientFilters.actor ?? ""}
                onChange={(e) => setClientFilters((f) => ({ ...f, actor: e.target.value || undefined }))}
                placeholder={t("admin.stockLedger.actorPlaceholder")}
              />
            </Field>

            <Field label={t("admin.stockLedger.orderId")}>
              <AdminInput
                value={orderIdDraft}
                onChange={(e) => setOrderIdDraft(e.target.value)}
                onBlur={commitOrderId}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitOrderId();
                }}
                placeholder={t("admin.stockLedger.orderIdPlaceholder")}
              />
            </Field>

            <Field label={t("admin.stockLedger.dateFrom")}>
              <AdminInput
                type="date"
                value={serverFilters.dateFrom ?? ""}
                onChange={(e) => setServerFilters((f) => ({ ...f, dateFrom: e.target.value || undefined }))}
              />
            </Field>

            <Field label={t("admin.stockLedger.dateTo")}>
              <AdminInput
                type="date"
                value={serverFilters.dateTo ?? ""}
                onChange={(e) => setServerFilters((f) => ({ ...f, dateTo: e.target.value || undefined }))}
              />
            </Field>
          </Card>
        )}
      </div>

      {loading ? (
        <PageLoading />
      ) : loadError ? (
        <EmptyState
          icon="info"
          title={t("admin.stockLedger.loadFailed")}
          action={
            <AdminButton variant="secondary" size="sm" onClick={() => loadPage(true)}>
              {t("admin.stockLedger.retry")}
            </AdminButton>
          }
        />
      ) : visibleRows.length === 0 ? (
        hasAnyFilter ? (
          <EmptyState icon="filter" title={t("admin.stockLedger.noMatch")} body={t("admin.stockLedger.noMatchBody")} />
        ) : (
          <EmptyState icon="history" title={t("admin.stockLedger.noneYet")} body={t("admin.stockLedger.emptyBody")} />
        )
      ) : (
        <div className="flex flex-col gap-2.5">
          {visibleRows.map((m) => {
            const product = productCache.get(m.productId);
            const thumbSrc = product ? resolveProductImageSrc(product) : "";
            const isKnownDeleted = productCache.has(m.productId) && product === null;
            const tone = stockMovementDeltaTone(m.qtyChange);
            const actor = resolveActorDisplay(m);
            const date = tsToDate(m.createdAt);

            return (
              <Card key={m.id} className="p-3.5">
                <div className="flex items-start gap-3">
                  <div className="h-11 w-11 shrink-0 overflow-hidden rounded-lg bg-cream-dim">
                    {thumbSrc ? (
                      <img src={thumbSrc} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-ink-faint">
                        <AdminIcon name="shirt" className="h-5 w-5" />
                      </div>
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate font-semibold text-ink">{m.productName}</p>
                        <p className="text-xs text-ink-faint">
                          {m.colorName} · {m.size} · {m.qtyBefore} → {m.qtyAfter}
                        </p>
                      </div>
                      <Badge tone={tone}>{m.qtyChange > 0 ? `+${m.qtyChange}` : m.qtyChange}</Badge>
                    </div>

                    {isKnownDeleted && <p className="mt-1 text-xs text-ink-faint">{t("admin.stockLedger.deletedProductNote")}</p>}

                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <Badge tone="neutral">{t(STOCK_MOVEMENT_REASON_LABEL_KEY[m.reason])}</Badge>
                      <Badge tone="neutral">{t(STOCK_MOVEMENT_SOURCE_LABEL_KEY[m.source])}</Badge>
                      <span className="text-xs text-ink-faint">
                        {actor.kind === "webCheckout" ? t("admin.stockLedger.websiteCheckout") : actor.kind === "named" ? actor.name : "—"}
                      </span>
                      <span className="text-xs text-ink-faint">{date ? date.toLocaleString(lang === "ar" ? "ar" : "en-US", { dateStyle: "medium", timeStyle: "short" }) : "—"}</span>
                      {m.orderId && (
                        <Link to={`/admin/orders/${m.orderId}`} className="text-xs font-semibold text-wine hover:underline">
                          {t("admin.stockLedger.order")} #{m.orderNumber ?? m.orderId}
                        </Link>
                      )}
                      {m.returnId && (
                        <Link to={`/admin/returns/${m.returnId}`} className="text-xs font-semibold text-wine hover:underline">
                          {t("admin.stockLedger.returnRef")}
                        </Link>
                      )}
                    </div>
                  </div>
                </div>
              </Card>
            );
          })}

          {hasMore && (
            <div className="mt-2 flex justify-center">
              <AdminButton variant="secondary" size="sm" loading={loadingMore} onClick={() => loadPage(false)}>
                {t("admin.stockLedger.loadMore")}
              </AdminButton>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
