import { collection, doc, onSnapshot, query, where } from "firebase/firestore";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useLanguage } from "../../../context/LanguageContext";
import { localizedName } from "../../../data/localize";
import { branchesApi } from "../../../firebase/collections";
import { branchCellQty, branchTotalQty, subscribeProductBranchStock } from "../../../firebase/branchStock";
import { db } from "../../../firebase/config";
import { useAdminAuth } from "../../AdminAuthContext";
import { AdminSelect, Badge, Card } from "../../components/ui";
import { movementLocation, ONLINE_LOCATION, summarizeLocationStock, type LedgerMovement, type LocationStockSummary } from "../../locationStock";
import { joinProductFields } from "../../productVariants";
import { resolveActorDisplay, STOCK_MOVEMENT_REASON_LABEL_KEY, stockMovementDeltaTone } from "../../stockMovements";
import type { AdminColorVariant, Branch, BranchStockDoc } from "../../types";
import AdminIcon from "../../components/AdminIcons";
import LocationStockEditModal from "./LocationStockEditModal";

function toMs(v: unknown): number {
  const ts = v as { toMillis?: () => number } | undefined;
  return ts?.toMillis ? ts.toMillis() : 0;
}

// Per-location stock for one product: the website's own stock plus every
// branch's, each with its opening stock, additions, sales, returns and
// current count, and the full movement history behind those numbers. Reads
// live from the same three sources every stock writer already maintains
// (products/{id}.stockByCell, branchStock, stockMovements) — no separate
// stock record of its own.
export default function ProductStockByLocation({ productId }: { productId: string }) {
  const { t, lang } = useLanguage();
  const { hasRole } = useAdminAuth();
  const canWrite = hasRole(["owner", "admin", "editor"]);
  const [onlineCurrent, setOnlineCurrent] = useState<number | null>(null);
  const [variants, setVariants] = useState<AdminColorVariant[]>([]);
  const [productName, setProductName] = useState("");
  // Location whose stock is open in the edit popup.
  const [editLocation, setEditLocation] = useState<string | null>(null);
  const [branchDocs, setBranchDocs] = useState<BranchStockDoc[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [movements, setMovements] = useState<LedgerMovement[] | null>(null);
  const [failed, setFailed] = useState(false);
  // Location picked in the summary table — drives the color/size card only.
  const [locationFilter, setLocationFilter] = useState("all");
  // The history card's own filter, independent of everything above it.
  const [historyLocation, setHistoryLocation] = useState("all");
  // One color × size expanded in the color/size card (its own stock per
  // location and its own movements, shown inside that card).
  const [cellFilter, setCellFilter] = useState<{ variantId: string; size: string } | null>(null);

  useEffect(() => {
    branchesApi.list().then(setBranches).catch(() => setBranches([]));
    const unsubProduct = onSnapshot(doc(db, "products", productId), (snap) => {
      const variants = snap.exists() ? joinProductFields(snap.data()) : [];
      setVariants(variants);
      setProductName(snap.exists() ? String(snap.get("name") ?? "") : "");
      setOnlineCurrent(variants.reduce((sum, v) => sum + v.sizeStock.reduce((s, x) => s + (typeof x.qty === "number" && x.qty > 0 ? x.qty : 0), 0), 0));
    });
    const unsubBranch = subscribeProductBranchStock(productId, setBranchDocs);
    // Single equality filter: no composite index needed; sorted client-side.
    const unsubMovements = onSnapshot(
      query(collection(db, "stockMovements"), where("productId", "==", productId)),
      (snap) => {
        setFailed(false);
        setMovements(snap.docs.map((d) => ({ id: d.id, ...(d.data({ serverTimestamps: "estimate" }) as Omit<LedgerMovement, "id" | "at">), at: toMs(d.data({ serverTimestamps: "estimate" }).createdAt) })));
      },
      (error) => {
        console.error("[ProductStockByLocation] movements error:", error);
        setFailed(true);
        setMovements([]);
      }
    );
    return () => {
      unsubProduct();
      unsubBranch();
      unsubMovements();
    };
  }, [productId]);

  const branchById = useMemo(() => new Map(branches.map((b) => [b.id, b])), [branches]);

  const summaries = useMemo(() => {
    if (onlineCurrent === null || movements === null) return null;
    const current = new Map<string, number>([[ONLINE_LOCATION, onlineCurrent]]);
    for (const b of branches) if (b.active) current.set(b.id, 0);
    for (const d of branchDocs) current.set(d.branchId, branchTotalQty(d));
    const map = summarizeLocationStock(movements, current);
    const rows = [...map.values()];
    // Online first, then branches in the Branches page's own name order.
    return rows.sort((a, b) => (a.locationId === ONLINE_LOCATION ? -1 : b.locationId === ONLINE_LOCATION ? 1 : locationName(a.locationId).localeCompare(locationName(b.locationId))));
  }, [onlineCurrent, movements, branches, branchDocs, lang]);

  function locationName(id: string): string {
    if (id === ONLINE_LOCATION) return t("admin.locationStock.online");
    const b = branchById.get(id);
    return b ? `${localizedName(b.name, b.nameAr, lang)}${b.code ? ` (${b.code})` : ""}` : id;
  }

  const history = useMemo(() => {
    const list = (movements ?? []).filter(
      (m) => historyLocation === "all" || movementLocation(m) === historyLocation
    );
    return list.sort((a, b) => (b.at || Number.MAX_SAFE_INTEGER) - (a.at || Number.MAX_SAFE_INTEGER));
  }, [movements, historyLocation]);

  const cellMovements = useMemo(
    () =>
      cellFilter
        ? (movements ?? [])
            .filter((m) => m.variantId === cellFilter.variantId && m.size === cellFilter.size && (locationFilter === "all" || movementLocation(m) === locationFilter))
            .sort((a, b) => (b.at || Number.MAX_SAFE_INTEGER) - (a.at || Number.MAX_SAFE_INTEGER))
        : [],
    [movements, cellFilter, locationFilter]
  );

  function currentQty(locationId: string, variantId: string, size: string): number | null {
    if (locationId === ONLINE_LOCATION) return variants.find((v) => v.id === variantId)?.sizeStock.find((s) => s.size === size)?.qty ?? 0;
    return branchCellQty(branchDocs.find((d) => d.branchId === locationId), variantId, size);
  }

  const fmtDate = (ms: number) => (ms ? new Date(ms).toLocaleString(lang === "ar" ? "ar" : "en-US", { dateStyle: "medium", timeStyle: "short" }) : "—");

  if (!summaries) {
    return (
      <Card className="p-5">
        <h2 className="font-display text-base font-bold text-ink">{t("admin.locationStock.title")}</h2>
        <p className="mt-3 text-sm text-ink-faint">{t("admin.locationStock.loading")}</p>
      </Card>
    );
  }

  const totals = summaries.reduce(
    (acc, s) => ({
      opening: acc.opening + s.opening + Math.max(0, s.untracked),
      added: acc.added + s.added,
      sold: acc.sold + s.sold,
      returned: acc.returned + s.returned,
      removed: acc.removed + s.removed,
      unexplained: acc.unexplained + Math.min(0, s.untracked),
      current: acc.current + s.current,
    }),
    { opening: 0, added: 0, sold: 0, returned: 0, removed: 0, unexplained: 0, current: 0 }
  );
  const anyUntracked = summaries.some((s) => s.untracked > 0);
  const anyUnexplained = summaries.some((s) => s.untracked < 0);

  // Zeros fade out; only real movement draws the eye (green in, red out).
  const numCell = "px-3 py-3 text-end tabular-nums";
  const zero = <span className="text-ink-faint/60">–</span>;
  const signed = (n: number, sign: "+" | "−", tone: string) => (n ? <span className={`font-medium ${tone}`}>{sign}{n}</span> : zero);
  const row = (s: Pick<LocationStockSummary, "opening" | "untracked" | "added" | "sold" | "returned" | "removed" | "current">) => (
    <>
      <td className={`${numCell} text-ink-soft`}>
        {s.opening + Math.max(0, s.untracked) || zero}
        {s.untracked > 0 && <span className="text-wine">*</span>}
      </td>
      <td className={numCell}>
        {/* Manual removals share this column (no separate "Removed" column). */}
        {s.added || !s.removed ? signed(s.added, "+", "text-olive") : null}
        {s.removed > 0 && <span className="block text-xs font-medium text-wine">−{s.removed}</span>}
      </td>
      <td className={numCell}>
        {/* Returns put back on the shelf share this column (no separate "Returned" column). */}
        {s.sold || !s.returned ? signed(s.sold, "−", "text-wine") : null}
        {s.returned > 0 && <span className="block text-xs font-medium text-olive">+{s.returned}</span>}
      </td>
      <td className="px-3 py-3 text-end">
        <span className={`inline-block min-w-[2.75rem] rounded-lg px-2.5 py-1 text-center text-base font-bold tabular-nums ${s.current > 0 ? "bg-cream-dim text-ink" : "bg-wine-light text-wine"}`}>{s.current}</span>
        {s.untracked < 0 && <span className="block text-[11px] text-wine">{s.untracked} {t("admin.locationStock.unexplainedShort")}</span>}
      </td>
    </>
  );

  return (
    <>
    <Card className="p-5">
      <div className="mb-4">
        <h2 className="font-display text-base font-bold text-ink">{t("admin.locationStock.title")}</h2>
        <p className="mt-0.5 text-xs text-ink-soft" title={t("admin.locationStock.formula")}>
          {t("admin.locationStock.description")}
        </p>
      </div>

      <div className="thin-scrollbar overflow-x-auto rounded-xl border border-line">
        <table className="w-full min-w-[680px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-line text-xs font-medium text-ink-faint">
              <th className="px-3 py-2.5 text-start font-medium">{t("admin.locationStock.location")}</th>
              <th className="px-3 py-2.5 text-end font-medium">{t("admin.locationStock.opening")}</th>
              <th className="px-3 py-2.5 text-end font-medium">{t("admin.locationStock.added")}</th>
              <th className="px-3 py-2.5 text-end font-medium">{t("admin.locationStock.sold")}</th>
              <th className="px-3 py-2.5 text-end font-semibold text-ink-soft">{t("admin.locationStock.current")}</th>
              {canWrite && <th className="w-20 px-3 py-2.5" />}
            </tr>
          </thead>
          <tbody>
            {summaries.map((s) => (
              <tr
                key={s.locationId}
                onClick={() => setLocationFilter(locationFilter === s.locationId ? "all" : s.locationId)}
                className={`cursor-pointer border-b border-line transition-colors last:border-0 hover:bg-cream-dim/40 ${locationFilter === s.locationId ? "bg-wine-light/40 shadow-[inset_3px_0_0_var(--color-wine)] rtl:shadow-[inset_-3px_0_0_var(--color-wine)]" : ""}`}
              >
                <td className="px-3 py-3">
                  <span className="flex items-center gap-2 font-semibold text-ink">
                    <AdminIcon name={s.locationId === ONLINE_LOCATION ? "globe" : "map"} className="h-4 w-4 shrink-0 text-ink-faint" />
                    {locationName(s.locationId)}
                  </span>
                  <span className="block text-[11px] text-ink-faint">
                    {s.lastMovementAt ? `${t("admin.locationStock.lastChange")}: ${fmtDate(s.lastMovementAt)}` : t("admin.locationStock.noHistory")}
                  </span>
                </td>
                {row(s)}
                {canWrite && (
                  <td className="px-3 py-3 text-end">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditLocation(s.locationId);
                      }}
                      disabled={variants.length === 0}
                      className="inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-xs font-semibold text-ink-soft transition-colors hover:border-wine hover:text-wine disabled:opacity-40"
                    >
                      <AdminIcon name="edit" className="h-3.5 w-3.5" />
                      {t("admin.locationStock.edit.button")}
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {summaries.length > 1 && (
              <tr
                onClick={() => setLocationFilter("all")}
                className={`cursor-pointer border-t-2 border-line font-semibold hover:bg-cream-dim/60 ${locationFilter === "all" ? "bg-wine-light/50" : "bg-cream-dim/40"}`}
              >
                <td className="px-3 py-3 text-ink">{t("admin.locationStock.allLocations")}</td>
                {row({ ...totals, untracked: totals.unexplained })}
                {canWrite && <td />}
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {anyUntracked && <p className="mt-2 text-xs text-ink-soft"><span className="text-wine">*</span> {t("admin.locationStock.untrackedNote")}</p>}
      {anyUnexplained && <p className="mt-1 text-xs text-wine">{t("admin.locationStock.unexplainedNote")}</p>}

      <div className="mt-6 border-t border-line pt-5">
      <ColorSizeBreakdown
        variants={variants}
        locationIds={summaries.map((s) => s.locationId)}
        locationFilter={locationFilter}
        locationLabel={locationFilter === "all" ? t("admin.locationStock.allLocations") : locationName(locationFilter)}
        locationName={locationName}
        currentQty={currentQty}
        selected={cellFilter}
        onSelect={setCellFilter}
        cellMovements={cellMovements}
        fmtDate={fmtDate}
        onEdit={canWrite && locationFilter !== "all" ? () => setEditLocation(locationFilter) : undefined}
      />
      </div>
    </Card>

    <Card className="p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-base font-bold text-ink">
          {t("admin.locationStock.history")} <span className="font-sans text-xs font-normal text-ink-faint">({history.length})</span>
        </h2>
        <div className="w-full sm:w-56">
          <AdminSelect value={historyLocation} onChange={(e) => setHistoryLocation(e.target.value)} aria-label={t("admin.locationStock.location")}>
            <option value="all">{t("admin.locationStock.allLocations")}</option>
            {summaries.map((s) => (
              <option key={s.locationId} value={s.locationId}>
                {locationName(s.locationId)}
              </option>
            ))}
          </AdminSelect>
        </div>
      </div>

      {failed ? (
        <p className="text-sm text-wine">{t("admin.locationStock.loadFailed")}</p>
      ) : history.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-ink-faint">{t("admin.locationStock.noMovements")}</p>
      ) : (
        <div className="thin-scrollbar max-h-[28rem] overflow-auto rounded-xl border border-line">
          <table className="w-full min-w-[760px] border-collapse text-sm">
            <thead className="sticky top-0 z-[1]">
              <tr className="border-b border-line bg-cream-dim text-xs font-bold uppercase tracking-wide text-ink-faint">
                <th className="px-3 py-2.5 text-start">{t("admin.locationStock.dateTime")}</th>
                <th className="px-3 py-2.5 text-start">{t("admin.locationStock.location")}</th>
                <th className="px-3 py-2.5 text-start">{t("admin.locationStock.type")}</th>
                <th className="px-3 py-2.5 text-start">{t("admin.locationStock.item")}</th>
                <th className="px-3 py-2.5 text-end">{t("admin.locationStock.qty")}</th>
                <th className="px-3 py-2.5 text-end">{t("admin.locationStock.beforeAfter")}</th>
                <th className="px-3 py-2.5 text-start">{t("admin.locationStock.reference")}</th>
                <th className="px-3 py-2.5 text-start">{t("admin.locationStock.by")}</th>
              </tr>
            </thead>
            <tbody>
              {history.map((m) => {
                const actor = resolveActorDisplay(m);
                return (
                  <tr key={m.id} className="border-b border-line last:border-0">
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-ink-soft">{fmtDate(m.at)}</td>
                    <td className="px-3 py-2 text-ink">{locationName(movementLocation(m))}</td>
                    <td className="px-3 py-2 text-ink">{t(STOCK_MOVEMENT_REASON_LABEL_KEY[m.reason] ?? "admin.stockLedger.reason.manualAdjustment")}</td>
                    <td className="px-3 py-2 text-ink-soft">
                      {m.colorName || "—"} · {m.size}
                    </td>
                    <td className="px-3 py-2 text-end">
                      <Badge tone={stockMovementDeltaTone(m.qtyChange)}>{m.qtyChange > 0 ? `+${m.qtyChange}` : `−${-m.qtyChange}`}</Badge>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-end tabular-nums text-ink-soft" dir="ltr">
                      {m.qtyBefore} → {m.qtyAfter}
                    </td>
                    <td className="px-3 py-2">
                      {m.receiptId ? (
                        <span className="text-xs text-ink">
                          {m.reference && <span className="block font-semibold">{m.reference}</span>}
                          <span className="block font-mono text-[10px] text-ink-faint">{m.receiptId}</span>
                          {m.note && <span className="block text-[11px] text-ink-soft">{m.note}</span>}
                        </span>
                      ) : m.adjustmentReason ? (
                        <span className="text-xs text-ink">
                          <span className="block font-semibold">{t(`admin.locationStock.edit.reasons.${m.adjustmentReason}`)}</span>
                          {m.note && <span className="block text-[11px] text-ink-soft">{m.note}</span>}
                        </span>
                      ) : m.orderId ? (
                        <Link to={`/admin/orders/${m.orderId}`} className="text-xs font-semibold text-wine hover:underline">
                          {t("admin.stockLedger.order")} #{m.orderNumber ?? m.orderId}
                        </Link>
                      ) : m.returnId ? (
                        <Link to={`/admin/returns/${m.returnId}`} className="text-xs font-semibold text-wine hover:underline">
                          {t("admin.stockLedger.returnRef")}
                        </Link>
                      ) : (
                        <span className="text-ink-faint">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-ink-soft">
                      {actor.kind === "named" ? actor.name : actor.kind === "webCheckout" ? t("admin.stockLedger.websiteCheckout") : "—"}
                      {m.registerName && <span className="block text-[11px] text-ink-faint">{m.registerName}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {canWrite && editLocation && (
        <LocationStockEditModal
          open
          onClose={() => setEditLocation(null)}
          product={{ id: productId, name: productName }}
          variants={variants}
          locationId={editLocation}
          locationLabel={locationName(editLocation)}
          currentQty={currentQty}
        />
      )}
    </Card>
    </>
  );
}

// The product's stock per color × size at the selected location (or summed
// over every location for "All locations"). Clicking a size expands it into
// that combination's stock at each location and filters the history to it.
function ColorSizeBreakdown({
  variants,
  locationIds,
  locationFilter,
  locationLabel,
  locationName,
  currentQty,
  selected,
  onSelect,
  cellMovements,
  fmtDate,
  onEdit,
}: {
  variants: AdminColorVariant[];
  locationIds: string[];
  locationFilter: string;
  locationLabel: string;
  locationName: (id: string) => string;
  currentQty: (locationId: string, variantId: string, size: string) => number | null;
  selected: { variantId: string; size: string } | null;
  onSelect: (cell: { variantId: string; size: string } | null) => void;
  cellMovements: LedgerMovement[];
  fmtDate: (ms: number) => string;
  onEdit?: () => void;
}) {
  const { t, lang } = useLanguage();
  if (variants.length === 0) return null;
  const at = (loc: string, variantId: string, size: string) => currentQty(loc, variantId, size);
  // null = unconfirmed online count; shown as "?" and never summed as a number.
  const qty = (variantId: string, size: string): number | null => {
    if (locationFilter !== "all") return at(locationFilter, variantId, size);
    let sum = 0;
    for (const loc of locationIds) {
      const q = at(loc, variantId, size);
      if (q === null) return null;
      sum += q;
    }
    return sum;
  };
  const colorLabel = (v: AdminColorVariant) => (lang === "ar" && v.colorNameAr ? v.colorNameAr : v.colorName) || "—";
  const selectedVariant = selected ? variants.find((v) => v.id === selected.variantId) : undefined;

  return (
    <div>
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-display text-sm font-bold text-ink">{t("admin.locationStock.byColorSize")}</h3>
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-cream-dim px-2.5 py-0.5 text-xs font-semibold text-ink-soft">{locationLabel}</span>
          {onEdit && (
            <button
              type="button"
              onClick={onEdit}
              className="inline-flex items-center gap-1 rounded-lg bg-wine px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-wine-dark"
            >
              <AdminIcon name="edit" className="h-3.5 w-3.5" />
              {t("admin.locationStock.edit.buttonLocation").replace("{location}", locationLabel)}
            </button>
          )}
        </div>
      </div>
      <p className="mb-3 text-xs text-ink-soft">{t("admin.locationStock.byColorSizeHint")}</p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {variants.map((v) => {
          const sizes = v.sizeStock.map((s) => ({ size: s.size, q: qty(v.id, s.size) }));
          const total = sizes.some((s) => s.q === null) ? null : sizes.reduce((sum, s) => sum + (s.q ?? 0), 0);
          return (
            <div key={v.id} className="rounded-xl border border-line p-3">
              <div className="mb-2 flex items-center gap-2">
                <span className="h-3.5 w-3.5 shrink-0 rounded-full border border-line" style={{ background: v.colorHex }} />
                <span className="font-semibold text-ink">{colorLabel(v)}</span>
                <span className="ms-auto text-xs text-ink-soft">
                  {t("admin.locationStock.colorTotal")}: <span className="font-bold tabular-nums text-ink">{total ?? "?"}</span>
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {sizes.map(({ size, q }) => {
                  const isSel = selected?.variantId === v.id && selected.size === size;
                  return (
                    <button
                      key={size}
                      type="button"
                      onClick={() => onSelect(isSel ? null : { variantId: v.id, size })}
                      aria-pressed={isSel}
                      className={`flex min-w-[3.25rem] flex-col items-center rounded-lg border px-2 py-1 text-xs transition-colors ${
                        isSel ? "border-wine bg-wine text-white" : q === 0 ? "border-line bg-cream-dim/50 text-ink-faint hover:border-wine" : "border-line bg-paper text-ink hover:border-wine"
                      }`}
                    >
                      <span className="font-semibold">{size}</span>
                      <span className={`text-sm font-bold tabular-nums ${!isSel && q !== null && q > 0 && q <= 3 ? "text-wine" : ""}`}>{q ?? "?"}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {selected && selectedVariant && (
        <div className="mt-3 rounded-xl border border-wine/40 bg-wine-light/30 p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-semibold text-ink">
              {colorLabel(selectedVariant)} · {selected.size} — {t("admin.locationStock.cellPerLocation")}
            </span>
            <button type="button" onClick={() => onSelect(null)} className="text-xs font-semibold text-wine hover:underline">
              {t("admin.locationStock.clearCell")}
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {locationIds.map((loc) => {
              const q = at(loc, selected.variantId, selected.size);
              return (
                <div key={loc} className={`rounded-lg border bg-paper px-3 py-1.5 text-sm ${locationFilter === loc ? "border-wine" : "border-line"}`}>
                  <span className="text-ink-soft">{locationName(loc)}: </span>
                  <span className="font-bold tabular-nums text-ink">{q ?? "?"}</span>
                </div>
              );
            })}
          </div>
          <p className="mb-1 mt-3 text-xs font-semibold text-ink-soft">
            {t("admin.locationStock.cellMovements")} ({cellMovements.length}) · {locationLabel}
          </p>
          {cellMovements.length === 0 ? (
            <p className="text-xs text-ink-faint">{t("admin.locationStock.noMovements")}</p>
          ) : (
            <ul className="thin-scrollbar max-h-56 divide-y divide-line overflow-auto rounded-lg border border-line bg-paper text-xs">
              {cellMovements.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-1.5">
                  <span className="text-ink-faint">{fmtDate(m.at)}</span>
                  <span className="text-ink">{locationName(movementLocation(m))}</span>
                  <span className="text-ink-soft">{t(STOCK_MOVEMENT_REASON_LABEL_KEY[m.reason] ?? "admin.stockLedger.reason.manualAdjustment")}</span>
                  <span className={`font-bold tabular-nums ${m.qtyChange > 0 ? "text-olive" : "text-wine"}`}>{m.qtyChange > 0 ? `+${m.qtyChange}` : `−${-m.qtyChange}`}</span>
                  <span className="tabular-nums text-ink-faint" dir="ltr">
                    {m.qtyBefore} → {m.qtyAfter}
                  </span>
                  {m.adjustmentReason && !m.orderNumber && (
                    <span className="text-ink-soft">
                      {t(`admin.locationStock.edit.reasons.${m.adjustmentReason}`)}
                      {m.note ? ` — ${m.note}` : ""}
                    </span>
                  )}
                  {(m.orderNumber || m.reference) && <span className="ms-auto font-semibold text-wine">{m.orderNumber ? `#${m.orderNumber}` : m.reference}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
