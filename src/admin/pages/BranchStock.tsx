import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { branchesApi, branchStockApi, categoriesApi, productsApi } from "../../firebase/collections";
import { BranchTransferError, branchCellQty, branchStockId, branchTotalQty, saveBranchStock, transferBranchStock } from "../../firebase/branchStock";
import { useLanguage } from "../../context/LanguageContext";
import { localizedName } from "../../data/localize";
import { useAdminAuth } from "../AdminAuthContext";
import AdminIcon from "../components/AdminIcons";
import { Modal } from "../components/Modal";
import StockTable from "../components/StockTable";
import { useToast } from "../components/ToastContext";
import { AdminButton, AdminNumberInput, AdminSelect, EmptyState, Field, PageHeader, PageLoading, SearchInput } from "../components/ui";
import { resolveImageSrc } from "../imageSrc";
import { normalizeProduct, stockCellKey, totalStock } from "../productVariants";
import type { AdminCategory, AdminProduct, Branch, BranchStockDoc } from "../types";

// productId -> "<branchId>|<variantId>::<size>" -> qty being edited
type Drafts = Record<string, Record<string, number | null>>;
type Status = "all" | "in" | "low" | "out" | "imbalanced";
type Sort = "name" | "totalDesc" | "totalAsc" | "newest";
const TAGS = ["new", "bestseller", "sale", "limited"] as const;

const LOW = 2;

// Branch stock, one product at a time: a searchable product list on the side
// (each with its count per branch), and the picked product's size x branch
// table -- the same table, Excel-style drag handle included, as the product
// page. Each branch's numbers are separate from the website stock and from
// every other branch's: that's what its POS registers sell from. Counts are
// edited directly or moved between branches with a transfer; every change is
// written to the stock ledger with its branch attached.
export default function BranchStock() {
  const toast = useToast();
  const { t, lang } = useLanguage();
  const { profile, hasRole } = useAdminAuth();
  const canWrite = hasRole(["owner", "admin", "editor"]);
  const [branches, setBranches] = useState<Branch[] | null>(null);
  const [products, setProducts] = useState<AdminProduct[]>([]);
  const [categories, setCategories] = useState<AdminCategory[]>([]);
  const [stockDocs, setStockDocs] = useState<BranchStockDoc[]>([]);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [status, setStatus] = useState<Status>("all");
  const [branchFilter, setBranchFilter] = useState("all");
  const [sizeFilter, setSizeFilter] = useState("all");
  const [colorFilter, setColorFilter] = useState("all");
  const [productStatus, setProductStatus] = useState("all");
  const [tag, setTag] = useState("all");
  const [sort, setSort] = useState<Sort>("name");
  const [showFilters, setShowFilters] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Drafts>({});
  const [saving, setSaving] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);

  useEffect(() => {
    const u1 = branchesApi.subscribe((b) => setBranches(b.filter((x) => x.active !== false).sort((x, y) => String(x.code).localeCompare(String(y.code)))));
    const u2 = productsApi.subscribe((p) => setProducts(p.filter((x) => x.status !== "archived").map(normalizeProduct)));
    const u3 = branchStockApi.subscribe(setStockDocs);
    const u4 = categoriesApi.subscribe(setCategories);
    return () => {
      u1();
      u2();
      u3();
      u4();
    };
  }, []);

  const docById = useMemo(() => new Map(stockDocs.map((d) => [d.id, d])), [stockDocs]);
  const branchList = branches ?? [];
  const totalAt = (productId: string, branchId: string) => branchTotalQty(docById.get(branchStockId(branchId, productId)));
  const totalAll = (productId: string) => branchList.reduce((sum, b) => sum + totalAt(productId, b.id), 0);
  const name = (p: AdminProduct) => localizedName(p.name, p.nameAr, lang);

  // Choices for the size/color filters, from the whole catalog.
  const allSizes = useMemo(() => [...new Set(products.flatMap((p) => p.colorVariants.flatMap((v) => v.sizeStock.map((s) => s.size))))], [products]);
  const allColors = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of products) for (const v of p.colorVariants) if (v.colorName && !m.has(v.colorName.toLowerCase())) m.set(v.colorName.toLowerCase(), localizedName(v.colorName, v.colorNameAr, lang));
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [products, lang]);

  // Stock that counts for the filters: one branch, or all of them; narrowed
  // to the picked size/color when those filters are set.
  function filteredQty(p: AdminProduct, branchId: string): number {
    const doc = docById.get(branchStockId(branchId, p.id));
    let n = 0;
    for (const v of p.colorVariants) {
      if (colorFilter !== "all" && v.colorName.toLowerCase() !== colorFilter) continue;
      for (const s of v.sizeStock) if (sizeFilter === "all" || s.size === sizeFilter) n += branchCellQty(doc, v.id, s.size);
    }
    return n;
  }

  const list = useMemo(() => {
    const q = search.trim().toLowerCase();
    const scope = branchFilter === "all" ? branchList : branchList.filter((b) => b.id === branchFilter);
    const qtyIn = (p: AdminProduct) => scope.reduce((sum, b) => sum + filteredQty(p, b.id), 0);
    const created = (p: AdminProduct) => (p.createdAt as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0;
    return products
      .filter((p) => category === "all" || p.category === category)
      .filter((p) => productStatus === "all" || p.status === productStatus)
      .filter((p) => tag === "all" || p.tags?.includes(tag as (typeof TAGS)[number]))
      .filter((p) => sizeFilter === "all" || p.colorVariants.some((v) => v.sizeStock.some((s) => s.size === sizeFilter)))
      .filter((p) => colorFilter === "all" || p.colorVariants.some((v) => v.colorName.toLowerCase() === colorFilter))
      .filter((p) => !q || p.name.toLowerCase().includes(q) || p.nameAr?.toLowerCase().includes(q) || p.sku?.toLowerCase().includes(q))
      .filter((p) => {
        if (status === "all") return true;
        if (status === "imbalanced") {
          const per = branchList.map((b) => filteredQty(p, b.id));
          return per.some((n) => n === 0) && per.some((n) => n > 0);
        }
        const total = qtyIn(p);
        if (status === "in") return total > 0;
        if (status === "out") return total === 0;
        return total > 0 && total <= LOW * Math.max(1, scope.length);
      })
      .sort((a, b) =>
        sort === "totalDesc" ? qtyIn(b) - qtyIn(a) || name(a).localeCompare(name(b))
        : sort === "totalAsc" ? qtyIn(a) - qtyIn(b) || name(a).localeCompare(name(b))
        : sort === "newest" ? created(b) - created(a)
        : name(a).localeCompare(name(b))
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products, search, category, status, branchFilter, sizeFilter, colorFilter, productStatus, tag, sort, docById, branches, lang]);

  const activeFilters = [category, status, branchFilter, sizeFilter, colorFilter, productStatus, tag].filter((x) => x !== "all").length;
  function clearFilters() {
    setCategory("all");
    setStatus("all");
    setBranchFilter("all");
    setSizeFilter("all");
    setColorFilter("all");
    setProductStatus("all");
    setTag("all");
  }

  // Keep a product open: the first one in the list until the admin picks.
  useEffect(() => {
    if (list.length && (!selectedId || !products.some((p) => p.id === selectedId))) setSelectedId(list[0].id);
  }, [list, selectedId, products]);

  const product = products.find((p) => p.id === selectedId) ?? null;

  // ---- Editing the selected product --------------------------------------
  const stored = (productId: string, branchId: string, key: string) => {
    const [variantId, size] = key.split("::");
    return branchCellQty(docById.get(branchStockId(branchId, productId)), variantId, size);
  };
  const productDrafts = (product && drafts[product.id]) || {};
  const shownQty = (key: string, branchId: string) => {
    const d = productDrafts[`${branchId}|${key}`];
    return d !== undefined ? d : product ? stored(product.id, branchId, key) : 0;
  };
  const countOf = (key: string, branchId: string) => Math.max(0, Math.round(shownQty(key, branchId) ?? 0));

  function setQty(key: string, branchId: string, qty: number | null) {
    if (!product) return;
    const id = product.id;
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], [`${branchId}|${key}`]: qty } }));
  }

  function changesOf(p: AdminProduct) {
    const byBranch = new Map<string, { variantId: string; size: string; qty: number; colorName: string }[]>();
    for (const [k, v] of Object.entries(drafts[p.id] ?? {})) {
      if (v === null) continue;
      const [branchId, key] = k.split("|");
      const qty = Math.max(0, Math.floor(v));
      if (qty === stored(p.id, branchId, key)) continue;
      const [variantId, size] = key.split("::");
      const colorName = p.colorVariants.find((x) => x.id === variantId)?.colorName ?? "";
      byBranch.set(branchId, [...(byBranch.get(branchId) ?? []), { variantId, size, qty, colorName }]);
    }
    return byBranch;
  }
  const isDirty = (p: AdminProduct) => changesOf(p).size > 0;
  const dirty = product ? isDirty(product) : false;

  function discard() {
    if (!product) return;
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[product.id];
      return next;
    });
  }

  async function save() {
    if (!product || !profile) return;
    setSaving(true);
    try {
      for (const [branchId, edits] of changesOf(product)) {
        await saveBranchStock(branchId, { id: product.id, name: product.name }, edits, { uid: profile.id, email: profile.email, displayName: profile.displayName });
      }
      discard();
      toast.success(t("admin.branchStock.saved"));
    } catch {
      toast.error(t("admin.branchStock.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  if (branches === null) return <PageLoading />;

  if (branches.length === 0) {
    return (
      <div>
        <PageHeader title={t("admin.nav.branchStock")} description={t("admin.branchStock.subtitle")} />
        <EmptyState
          icon="map"
          title={t("admin.branches.emptyTitle")}
          body={t("admin.branches.emptyBody")}
          action={
            hasRole(["owner", "admin"]) ? (
              <Link to="/admin/branches" className="rounded-lg bg-wine px-4 py-2.5 text-sm font-semibold text-on-accent">
                {t("admin.branches.addBranch")}
              </Link>
            ) : undefined
          }
        />
      </div>
    );
  }

  const locations = branches.map((b) => {
    const label = localizedName(b.name, b.nameAr, lang);
    return { id: b.id, label, title: `${label} (${b.code})` };
  });
  const categoryName = (slug: string) => {
    const c = categories.find((x) => x.slug === slug);
    return c ? localizedName(c.name, c.nameAr, lang) : slug;
  };

  return (
    <div>
      <PageHeader title={t("admin.nav.branchStock")} description={t("admin.branchStock.subtitle")} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[22rem_minmax(0,1fr)]">
        {/* ---- Product list ---- */}
        <aside className="flex flex-col overflow-hidden rounded-xl border border-line bg-paper shadow-soft lg:sticky lg:top-4 lg:max-h-[calc(100vh-7rem)]">
          <div className="flex flex-col gap-2 border-b border-line p-3">
            <div className="flex gap-2">
              <div className="min-w-0 flex-1">
                <SearchInput value={search} onChange={setSearch} fullWidth />
              </div>
              <button
                type="button"
                aria-expanded={showFilters}
                onClick={() => setShowFilters((s) => !s)}
                className={`relative flex shrink-0 items-center gap-1.5 rounded-lg border px-3 text-sm font-semibold transition-colors ${
                  showFilters || activeFilters ? "border-wine text-wine" : "border-line text-ink-soft hover:border-ink-soft"
                }`}
              >
                <AdminIcon name="filter" className="h-4 w-4" />
                {t("admin.branchStock.filters")}
                {activeFilters > 0 && <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-wine px-1 text-[11px] text-on-accent">{activeFilters}</span>}
              </button>
            </div>
            {/* The two most used filters stay visible; the rest fold out. */}
            <div className="grid grid-cols-2 gap-2">
              <AdminSelect value={branchFilter} onChange={(e) => setBranchFilter(e.target.value)} className="!py-1.5 text-sm">
                <option value="all">{t("admin.branchStock.anyBranch")}</option>
                {branchList.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.code} · {localizedName(b.name, b.nameAr, lang)}
                  </option>
                ))}
              </AdminSelect>
              <AdminSelect value={status} onChange={(e) => setStatus(e.target.value as Status)} className="!py-1.5 text-sm" aria-label={t("admin.branchStock.stockAt")}>
                <option value="all">{t("admin.branchStock.statusAll")}</option>
                <option value="in">{t("admin.branchStock.statusIn")}</option>
                <option value="low">{t("admin.branchStock.statusLow").replace(" (≤ {n})", "")}</option>
                <option value="out">{t("admin.branchStock.statusOut")}</option>
                {branchList.length > 1 && <option value="imbalanced">{t("admin.branchStock.imbalanced")}</option>}
              </AdminSelect>
            </div>
            {showFilters && (
              <div className="grid grid-cols-2 gap-2 rounded-lg bg-cream-dim/50 p-2">
                <AdminSelect value={category} onChange={(e) => setCategory(e.target.value)} className="!py-1.5 text-sm">
                  <option value="all">{t("admin.branchStock.allCategories")}</option>
                  {categories.map((c) => (
                    <option key={c.slug} value={c.slug}>
                      {localizedName(c.name, c.nameAr, lang)}
                    </option>
                  ))}
                </AdminSelect>
                <AdminSelect value={productStatus} onChange={(e) => setProductStatus(e.target.value)} className="!py-1.5 text-sm">
                  <option value="all">{t("admin.branchStock.anyProductStatus")}</option>
                  <option value="active">{t("admin.products.status.active")}</option>
                  <option value="draft">{t("admin.products.status.draft")}</option>
                </AdminSelect>
                <AdminSelect value={sizeFilter} onChange={(e) => setSizeFilter(e.target.value)} className="!py-1.5 text-sm">
                  <option value="all">{t("admin.branchStock.anySize")}</option>
                  {allSizes.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </AdminSelect>
                <AdminSelect value={colorFilter} onChange={(e) => setColorFilter(e.target.value)} className="!py-1.5 text-sm">
                  <option value="all">{t("admin.branchStock.anyColor")}</option>
                  {allColors.map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </AdminSelect>
                <AdminSelect value={tag} onChange={(e) => setTag(e.target.value)} className="!py-1.5 text-sm">
                  <option value="all">{t("admin.branchStock.anyTag")}</option>
                  {TAGS.map((x) => (
                    <option key={x} value={x}>
                      {t(`admin.productForm.tag.${x}`)}
                    </option>
                  ))}
                </AdminSelect>
                <AdminSelect value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="!py-1.5 text-sm">
                  <option value="name">{t("admin.branchStock.sortName")}</option>
                  <option value="totalDesc">{t("admin.branchStock.sortTotalDesc")}</option>
                  <option value="totalAsc">{t("admin.branchStock.sortTotalAsc")}</option>
                  <option value="newest">{t("admin.branchStock.sortNewest")}</option>
                </AdminSelect>
              </div>
            )}
            <div className="flex items-center justify-between text-[11px] text-ink-faint">
              <span>
                {list.length} {t("admin.branchStock.products")}
              </span>
              {activeFilters > 0 && (
                <button type="button" onClick={clearFilters} className="font-semibold text-wine hover:underline">
                  {t("admin.branchStock.clearFilters")}
                </button>
              )}
            </div>
          </div>
          <ul className="thin-scrollbar max-h-[60vh] flex-1 overflow-y-auto lg:max-h-none">
            {list.length === 0 && <li className="p-6 text-center text-sm text-ink-faint">{t("admin.orderDetail.noProductsFound")}</li>}
            {list.map((p) => {
              const active = p.id === selectedId;
              const total = totalAll(p.id);
              const img = resolveImageSrc(p.colorVariants[0] ?? {});
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(p.id)}
                    className={`flex w-full items-center gap-3 border-b border-line/70 px-3 py-2.5 text-start transition-colors ${
                      active ? "bg-wine-light/50 shadow-[inset_3px_0_0_var(--color-wine)] rtl:shadow-[inset_-3px_0_0_var(--color-wine)]" : "hover:bg-cream-dim/60"
                    }`}
                  >
                    <div className="h-10 w-10 shrink-0 overflow-hidden rounded-md bg-cream-dim">{img && <img src={img} alt="" className="h-full w-full object-cover" />}</div>
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-1.5 truncate text-sm font-semibold text-ink">
                        {isDirty(p) && <span title={t("admin.branchStock.unsaved")} className="h-1.5 w-1.5 shrink-0 rounded-full bg-wine" />}
                        <span className="truncate">{name(p)}</span>
                      </p>
                      <p className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] tabular-nums text-ink-faint">
                        {branches.map((b) => {
                          const n = totalAt(p.id, b.id);
                          return (
                            <span key={b.id} className={n === 0 ? "text-wine/80" : ""}>
                              <span className="font-mono opacity-70">{b.code}</span> {n}
                            </span>
                          );
                        })}
                      </p>
                    </div>
                    <span className={`shrink-0 rounded-md px-2 py-0.5 text-xs font-bold tabular-nums ${total === 0 ? "bg-wine-light text-wine" : "bg-cream-dim text-ink"}`}>{total}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>

        {/* ---- Selected product ---- */}
        <section className="min-w-0">
          {!product ? (
            <div className="flex h-full min-h-[20rem] flex-col items-center justify-center rounded-xl border border-dashed border-line p-8 text-center">
              <AdminIcon name="box" className="h-8 w-8 text-ink-faint" />
              <p className="mt-3 font-semibold text-ink">{t("admin.branchStock.pickProduct")}</p>
              <p className="mt-1 max-w-sm text-sm text-ink-faint">{t("admin.branchStock.pickProductHint")}</p>
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-line bg-paper shadow-soft">
              <header className="flex flex-wrap items-center gap-4 border-b border-line p-4">
                <div className="h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-cream-dim">
                  {resolveImageSrc(product.colorVariants[0] ?? {}) && <img src={resolveImageSrc(product.colorVariants[0] ?? {})} alt="" className="h-full w-full object-cover" />}
                </div>
                <div className="min-w-0 flex-1">
                  <h2 className="truncate font-display text-lg font-bold text-ink">{name(product)}</h2>
                  <p className="mt-0.5 text-xs text-ink-faint">
                    {product.sku && <span className="me-2 font-mono">{product.sku}</span>}
                    {categoryName(product.category)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Link to={`/admin/products/${product.id}`} className="rounded-lg px-3 py-2 text-xs font-semibold text-ink-soft hover:bg-cream-dim hover:text-wine">
                    {t("admin.common.edit")}
                  </Link>
                  {canWrite && branches.length > 1 && (
                    <AdminButton size="sm" variant="secondary" icon="refresh" disabled={dirty} onClick={() => setTransferOpen(true)}>
                      {t("admin.branchStock.transfer")}
                    </AdminButton>
                  )}
                </div>
              </header>

              {/* Totals per location */}
              <div className="grid grid-cols-2 gap-px border-b border-line bg-line sm:grid-cols-[repeat(auto-fit,minmax(8rem,1fr))]">
                {branches.map((b) => {
                  const n = product.colorVariants.reduce((sum, v) => sum + v.sizeStock.reduce((x, s) => x + countOf(stockCellKey(v.id, s.size), b.id), 0), 0);
                  return (
                    <div key={b.id} className="bg-paper px-4 py-2.5">
                      <p className="truncate text-[11px] font-semibold text-ink-faint">{localizedName(b.name, b.nameAr, lang)}</p>
                      <p className={`font-display text-xl font-bold tabular-nums ${n === 0 ? "text-wine" : "text-ink"}`}>{n}</p>
                    </div>
                  );
                })}
                <div className="bg-cream-dim/50 px-4 py-2.5">
                  <p className="text-[11px] font-semibold text-ink-faint">{t("admin.branchStock.online")}</p>
                  <p className="font-display text-xl font-bold tabular-nums text-ink-soft">{totalStock(product)}</p>
                </div>
              </div>

              <div className="flex flex-col divide-y divide-line">
                {product.colorVariants.map((v) => (
                  <div key={v.id} className="py-2">
                    <p className="flex items-center gap-2 px-4 pb-1 text-sm font-semibold text-ink">
                      <span className="h-3.5 w-3.5 rounded-full border border-line/60" style={{ backgroundColor: v.colorHex }} />
                      {localizedName(v.colorName, v.colorNameAr, lang)}
                    </p>
                    <div className="px-2">
                      <StockTable
                        colorId={v.id}
                        sizes={v.sizeStock.map((s) => s.size)}
                        locations={locations}
                        shownQty={shownQty}
                        countOf={countOf}
                        isEdited={(key, branchId) => {
                          const d = productDrafts[`${branchId}|${key}`];
                          return d !== undefined && d !== null && Math.floor(d) !== stored(product.id, branchId, key);
                        }}
                        isUnknown={() => false}
                        onChange={canWrite ? setQty : () => {}}
                        reference={{
                          label: t("admin.branchStock.online"),
                          title: t("admin.branchStock.onlineHint"),
                          qty: (key) => v.sizeStock.find((s) => stockCellKey(v.id, s.size) === key)?.qty ?? null,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>

              {canWrite && (
                <footer className={`flex items-center gap-3 border-t border-line px-4 py-3 ${dirty ? "bg-wine-light/30" : ""}`}>
                  <span className="text-xs text-ink-faint">{dirty ? <b className="text-wine">{t("admin.branchStock.unsaved")}</b> : t("admin.productForm.quickAdd.fillHandle")}</span>
                  <div className="ms-auto flex gap-2">
                    {dirty && (
                      <AdminButton variant="ghost" disabled={saving} onClick={discard}>
                        {t("admin.branchStock.discard")}
                      </AdminButton>
                    )}
                    <AdminButton variant="primary" icon="check" disabled={!dirty} loading={saving} onClick={() => void save()}>
                      {t("admin.common.save")}
                    </AdminButton>
                  </div>
                </footer>
              )}
            </div>
          )}
        </section>
      </div>

      {product && profile && (
        <TransferModal
          open={transferOpen}
          onClose={() => setTransferOpen(false)}
          product={product}
          branches={branches}
          available={(branchId, variantId, size) => stored(product.id, branchId, stockCellKey(variantId, size))}
          onTransfer={async (from, to, variantId, size, qty) => {
            const colorName = product.colorVariants.find((x) => x.id === variantId)?.colorName ?? "";
            await transferBranchStock(from, to, { id: product.id, name: product.name }, { variantId, colorName, size }, qty, {
              uid: profile.id,
              email: profile.email,
              displayName: profile.displayName,
            });
          }}
        />
      )}
    </div>
  );
}

function TransferModal({
  open,
  onClose,
  product,
  branches,
  available,
  onTransfer,
}: {
  open: boolean;
  onClose: () => void;
  product: AdminProduct;
  branches: Branch[];
  available: (branchId: string, variantId: string, size: string) => number;
  onTransfer: (from: string, to: string, variantId: string, size: string, qty: number) => Promise<void>;
}) {
  const { t, lang } = useLanguage();
  const toast = useToast();
  const [from, setFrom] = useState(branches[0]?.id ?? "");
  const [to, setTo] = useState(branches[1]?.id ?? "");
  const [variantId, setVariantId] = useState(product.colorVariants[0]?.id ?? "");
  const [size, setSize] = useState(product.colorVariants[0]?.sizeStock[0]?.size ?? "");
  const [qty, setQty] = useState<number | null>(1);
  const [busy, setBusy] = useState(false);

  // Fresh form for each product / each opening.
  useEffect(() => {
    if (!open) return;
    setFrom(branches[0]?.id ?? "");
    setTo(branches[1]?.id ?? "");
    setVariantId(product.colorVariants[0]?.id ?? "");
    setSize(product.colorVariants[0]?.sizeStock[0]?.size ?? "");
    setQty(1);
  }, [open, product, branches]);

  const variant = product.colorVariants.find((v) => v.id === variantId);
  const max = from && variantId && size ? available(from, variantId, size) : 0;
  const valid = from && to && from !== to && variantId && size && qty !== null && qty > 0 && qty <= max;
  const bname = (b: Branch) => `${localizedName(b.name, b.nameAr, lang)} (${b.code})`;

  async function submit() {
    if (!valid) return;
    setBusy(true);
    try {
      await onTransfer(from, to, variantId, size, qty!);
      toast.success(t("admin.branchStock.transferDone"));
      onClose();
    } catch (err) {
      toast.error(t("admin.branchStock.transferFailed").replace("{msg}", err instanceof BranchTransferError ? err.message : ""));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={t("admin.branchStock.transferTitle")} width="sm">
      <div className="flex flex-col gap-4">
        <p className="text-sm font-semibold text-ink">{localizedName(product.name, product.nameAr, lang)}</p>
        <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
          <Field label={t("admin.branchStock.from")}>
            <AdminSelect value={from} onChange={(e) => setFrom(e.target.value)}>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {bname(b)}
                </option>
              ))}
            </AdminSelect>
          </Field>
          <button
            type="button"
            onClick={() => {
              setFrom(to);
              setTo(from);
            }}
            className="mb-1 flex h-9 w-9 items-center justify-center rounded-lg border border-line text-ink-soft hover:border-wine hover:text-wine"
            aria-label="swap"
          >
            <AdminIcon name="refresh" className="h-4 w-4" />
          </button>
          <Field label={t("admin.branchStock.to")}>
            <AdminSelect value={to} onChange={(e) => setTo(e.target.value)}>
              {branches.map((b) => (
                <option key={b.id} value={b.id} disabled={b.id === from}>
                  {bname(b)}
                </option>
              ))}
            </AdminSelect>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label={t("admin.branchStock.color")}>
            <AdminSelect
              value={variantId}
              onChange={(e) => {
                setVariantId(e.target.value);
                setSize(product.colorVariants.find((v) => v.id === e.target.value)?.sizeStock[0]?.size ?? "");
              }}
            >
              {product.colorVariants.map((v) => (
                <option key={v.id} value={v.id}>
                  {localizedName(v.colorName, v.colorNameAr, lang)}
                </option>
              ))}
            </AdminSelect>
          </Field>
          <Field label={t("admin.branchStock.size")}>
            <AdminSelect value={size} onChange={(e) => setSize(e.target.value)}>
              {(variant?.sizeStock ?? []).map((s) => (
                <option key={s.size} value={s.size}>
                  {s.size} · {from ? available(from, variantId, s.size) : 0}
                </option>
              ))}
            </AdminSelect>
          </Field>
        </div>
        <Field label={t("admin.branchStock.qty")} hint={t("admin.branchStock.available").replace("{n}", String(max))}>
          <AdminNumberInput dir="ltr" inputMode="numeric" min={1} integerOnly nullable value={qty} onChange={setQty} className={qty !== null && qty > max ? "!border-wine" : ""} />
        </Field>
        <AdminButton variant="primary" loading={busy} disabled={!valid} className="w-full justify-center" onClick={() => void submit()}>
          {t("admin.branchStock.transferDo")}
        </AdminButton>
      </div>
    </Modal>
  );
}
