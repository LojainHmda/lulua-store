import { collection, doc, runTransaction, serverTimestamp } from "firebase/firestore";
import { useEffect, useMemo, useState } from "react";
import { db } from "../../firebase/config";
import { productsApi, returnsApi } from "../../firebase/collections";
import { useLanguage } from "../../context/LanguageContext";
import { localizedName } from "../../data/localize";
import { useAdminAuth } from "../AdminAuthContext";
import AdminIcon from "../components/AdminIcons";
import { useToast } from "../components/ToastContext";
import { AdminButton, AdminLinkButton, AdminNumberInput, EmptyState, PageHeader, PageLoading, SearchInput, Toggle } from "../components/ui";
import { resolveImageSrc } from "../imageSrc";
import { logActivity } from "../logActivity";
import { notifyLowStock } from "../lowStockNotify";
import { hasUnknownStock, normalizeProduct, toStockByCell, totalStock } from "../productVariants";
import { computeReturnsAggregates, returnLineKey } from "../returnsHelpers";
import { computeStockDeltas } from "../stockMovements";
import type { AdminProduct, AdminReturn } from "../types";

const LOW_STOCK_THRESHOLD = 3;

// productId -> variantId -> size -> qty. A draft entry can be `null`
// transiently (the admin cleared the box) -- getQty()'s own `?? original`
// fallback is what makes that resolve back to the untouched original value
// rather than ever being treated as/saved as 0; see AdminNumberInput's own
// nullable={false} default, used below for exactly this reason (unlike
// ProductForm.tsx's equivalent field, this one goes through that fallback
// layer instead of storing the cleared state directly).
type Drafts = Record<string, Record<string, Record<string, number | null>>>;

export default function Inventory() {
  const toast = useToast();
  const { t, lang } = useLanguage();
  const { profile, hasRole } = useAdminAuth();
  const canWrite = hasRole(["owner", "admin", "editor"]);
  const [products, setProducts] = useState<AdminProduct[]>([]);
  const [returns, setReturns] = useState<AdminReturn[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [lowStockOnly, setLowStockOnly] = useState(false);
  const [drafts, setDrafts] = useState<Drafts>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  useEffect(() => {
    const unsub = productsApi.subscribe((data) => {
      setProducts(data.filter((p) => p.status !== "archived").map(normalizeProduct));
      setLoading(false);
    });
    return unsub;
  }, []);

  // Only while this page is mounted — this is a read-only display of what's
  // sitting in quarantine per exact variant+size, it never writes anything.
  // The "Available" number above already excludes these units (see
  // returnsTransaction.ts) — this is purely so staff can see WHY a count
  // looks lower than expected instead of it being a silent mystery.
  useEffect(() => {
    const unsub = returnsApi.subscribe(setReturns);
    return unsub;
  }, []);

  const returnsAggregates = useMemo(() => computeReturnsAggregates(returns), [returns]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter((p) => {
      if (q && !p.name.toLowerCase().includes(q) && !(p.nameAr ?? "").toLowerCase().includes(q)) return false;
      if (lowStockOnly && totalStock(p) > LOW_STOCK_THRESHOLD) return false;
      return true;
    });
  }, [products, search, lowStockOnly]);

  function setDraft(productId: string, variantId: string, size: string, qty: number | null) {
    setDrafts((d) => ({
      ...d,
      [productId]: { ...d[productId], [variantId]: { ...d[productId]?.[variantId], [size]: qty } },
    }));
  }

  // Draft edits are always a real number (typed by the admin); an
  // un-drafted null (never confirmed) passes through unchanged.
  function getQty(productId: string, variantId: string, size: string, original: number | null): number | null {
    return drafts[productId]?.[variantId]?.[size] ?? original;
  }

  function hasChanges(productId: string): boolean {
    return !!drafts[productId];
  }

  async function saveRow(p: AdminProduct) {
    const rowDraft = drafts[p.id];
    if (!rowDraft || !profile) return;
    setSavingId(p.id);
    try {
      // Reassigned (never pushed/accumulated) inside the transaction below,
      // so a retried attempt's values are simply overwritten by the next
      // attempt's — only ever hold the FINAL, committed attempt's numbers
      // by the time they're read after runTransaction() resolves. Used for
      // notifyLowStock's before/after, which must reflect the actual
      // committed transition, not stale UI state (see the transaction body
      // for why the ledger doesn't have this same risk at all).
      let committedBefore: AdminProduct["colorVariants"] = [];
      let committedAfter: AdminProduct["colorVariants"] = [];

      await runTransaction(db, async (tx) => {
        const ref = doc(db, "products", p.id);
        const snap = await tx.get(ref);
        if (!snap.exists()) throw new Error("This product no longer exists.");
        // Read fresh, never the p/React-state snapshot this row was
        // rendered from — that snapshot can be stale the instant a
        // concurrent sale or another admin's edit lands. Every cell the
        // admin did NOT touch in this draft falls back to the FRESH
        // server value (not the stale one), so an untouched cell can never
        // be silently reverted; every cell they DID touch is still an
        // intentional absolute replacement (e.g. "I counted 12, set it to
        // 12") — that part of the existing user-facing behavior is
        // deliberately unchanged, only its "before" for the ledger is now
        // always the true current value.
        const fresh = normalizeProduct({ id: snap.id, ...snap.data() } as AdminProduct);
        const nextVariants = fresh.colorVariants.map((v) => ({
          ...v,
          sizeStock: v.sizeStock.map((s) => ({ size: s.size, qty: rowDraft[v.id]?.[s.size] ?? s.qty })),
        }));
        // A manual stock edit only ever changes quantities, never a color's
        // metadata — written as `stockByCell` alone, same reasoning as
        // orderTransaction.ts's identical comment.
        tx.update(ref, { stockByCell: toStockByCell(nextVariants), updatedAt: serverTimestamp() });

        for (const delta of computeStockDeltas(fresh.colorVariants, nextVariants)) {
          tx.set(doc(collection(db, "stockMovements")), {
            productId: p.id,
            productName: fresh.name,
            variantId: delta.variantId,
            colorName: delta.colorName,
            size: delta.size,
            qtyBefore: delta.qtyBefore,
            qtyChange: delta.qtyChange,
            qtyAfter: delta.qtyAfter,
            reason: "manual_adjustment",
            source: "admin",
            actorEmail: profile.email,
            actorName: profile.displayName || profile.email,
            createdAt: serverTimestamp(),
          });
        }

        committedBefore = fresh.colorVariants;
        committedAfter = nextVariants;
      });

      await logActivity(profile, "inventory.stockUpdated", p.name);
      // Fire-and-forget, after the save has already succeeded — a no-op
      // check for a restock-only edit, never a false alert (see
      // lowStockNotify.ts). Uses the transaction's own committed before/
      // after, not the stale prop this row was rendered from.
      void notifyLowStock({ id: p.id, name: p.name }, committedBefore, committedAfter);
      setDrafts((d) => {
        const next = { ...d };
        delete next[p.id];
        return next;
      });
      toast.success(t("admin.inventory.stockUpdated"));
    } catch {
      toast.error(t("admin.inventory.updateFailed"));
    } finally {
      setSavingId(null);
    }
  }

  if (loading) return <PageLoading />;

  return (
    <div>
      <PageHeader title={t("admin.nav.inventory")} description={t("admin.inventory.subtitle")} />

      <div className="mb-4 flex flex-wrap items-center gap-4">
        <SearchInput value={search} onChange={setSearch} placeholder={t("admin.products.searchPlaceholder")} />
        <label className="flex items-center gap-2 text-sm font-semibold text-ink-soft">
          <Toggle checked={lowStockOnly} onChange={setLowStockOnly} />
          {t("admin.inventory.lowStockOnly")}
        </label>
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon="box" title={t("admin.inventory.noneToShow")} body={t("admin.inventory.tryClearing")} />
      ) : (
        <div className="flex flex-col gap-3">
          {filtered.map((p) => {
            const productTotal = p.colorVariants.reduce(
              (sum, v) => sum + v.sizeStock.reduce((s, x) => s + (getQty(p.id, v.id, x.size, x.qty) ?? 0), 0),
              0
            );
            const productHasUnknown = hasUnknownStock(p);
            return (
              <div key={p.id} className="rounded-xl border border-line bg-paper p-3 shadow-soft">
                <div className="mb-2.5 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex min-w-[180px] items-center gap-3">
                    <div className="h-11 w-11 shrink-0 overflow-hidden rounded-lg bg-cream-dim">
                      {resolveImageSrc(p.colorVariants[0]) && (
                        <img src={resolveImageSrc(p.colorVariants[0])} alt="" className="h-full w-full object-cover" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-ink">{localizedName(p.name, p.nameAr, lang)}</p>
                      <p className={`text-xs font-semibold ${productTotal <= LOW_STOCK_THRESHOLD ? "text-wine" : "text-ink-faint"}`}>
                        {productTotal} {t("admin.inventory.inStock")}
                        {productHasUnknown && <span className="text-wine"> · {t("admin.inventory.someUnknown")}</span>}
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <AdminLinkButton
                      to={`/admin/stock-ledger?productId=${p.id}&productName=${encodeURIComponent(localizedName(p.name, p.nameAr, lang))}`}
                      variant="ghost"
                      size="sm"
                      icon="history"
                    >
                      {t("admin.inventory.viewHistory")}
                    </AdminLinkButton>
                    {canWrite && (
                      <AdminButton
                        variant={hasChanges(p.id) ? "primary" : "ghost"}
                        size="sm"
                        icon="check"
                        disabled={!hasChanges(p.id)}
                        loading={savingId === p.id}
                        onClick={() => saveRow(p)}
                      >
                        {t("admin.inventory.save")}
                      </AdminButton>
                    )}
                  </div>
                </div>

                <div className="flex flex-col gap-2 border-t border-line pt-2.5">
                  {p.colorVariants.map((v) => (
                    <div key={v.id} className="flex flex-wrap items-center gap-2.5">
                      <span className="flex shrink-0 items-center gap-1.5 text-xs font-semibold text-ink-soft">
                        <span className="h-3 w-3 rounded-full ring-1 ring-inset ring-ink/10" style={{ backgroundColor: v.colorHex }} />
                        {localizedName(v.colorName, v.colorNameAr, lang) || t("admin.inventory.color")}
                      </span>
                      <div className="flex flex-wrap gap-2">
                        {v.sizeStock.map((s) => {
                          const qty = getQty(p.id, v.id, s.size, s.qty);
                          const isUnknown = qty === null;
                          const aggregate = returnsAggregates.get(returnLineKey(p.id, v.id, s.size));
                          return (
                            <div key={s.size} className="flex flex-col items-center gap-1">
                              <div className="flex items-center gap-1.5">
                                <span className="text-xs font-bold text-ink-faint">{s.size}</span>
                                <AdminNumberInput
                                  min={0}
                                  integerOnly
                                  disabled={!canWrite}
                                  title={isUnknown ? t("admin.inventory.unknownHint") : undefined}
                                  value={qty}
                                  placeholder={isUnknown ? t("admin.inventory.unknown") : undefined}
                                  onChange={(nextQty) => setDraft(p.id, v.id, s.size, nextQty)}
                                  className={`w-16 !py-1.5 text-center ${isUnknown ? "border-dashed border-wine-light placeholder:text-wine" : ""}`}
                                />
                              </div>
                              {aggregate && (aggregate.quarantineQty > 0 || aggregate.damagedQty > 0) && (
                                <span className="text-[10px] font-semibold leading-tight text-wine">
                                  {aggregate.quarantineQty > 0 && `${t("admin.inventory.quarantineShort")} ${aggregate.quarantineQty}`}
                                  {aggregate.quarantineQty > 0 && aggregate.damagedQty > 0 && " · "}
                                  {aggregate.damagedQty > 0 && `${t("admin.inventory.damagedShort")} ${aggregate.damagedQty}`}
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p className="mt-4 flex items-center gap-1.5 text-xs text-ink-faint">
        <AdminIcon name="info" className="h-3.5 w-3.5" />
        {t("admin.inventory.thresholdNote")}
      </p>
    </div>
  );
}
