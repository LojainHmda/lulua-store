import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useLanguage } from "../../../context/LanguageContext";
import { useAdminAuth } from "../../AdminAuthContext";
import AdminIcon from "../../components/AdminIcons";
import { AdminButton, AdminInput, AdminSelect, Badge, EmptyState, PageHeader, SearchInput } from "../../components/ui";
import DataTable, { BulkActionBar, type DataTableColumn } from "../../components/DataTable";
import { ConfirmDialog } from "../../components/Modal";
import { useToast } from "../../components/ToastContext";
import { branchStockApi, categoriesApi, productsApi } from "../../../firebase/collections";
import { branchTotalQty } from "../../../firebase/branchStock";
import { flattenTree } from "../../../data/categoryTree";
import { localizedName } from "../../../data/localize";
import { logActivity } from "../../logActivity";
import { resolveProductImageSrc } from "../../imageSrc";
import { exceedsCheckoutSafeLimit, normalizeProduct, totalStock } from "../../productVariants";
import { seedStarterCatalog } from "../../seedCatalog";
import type { AdminCategory, AdminProduct } from "../../types";
import { formatPrice } from "../../../utils/currency";

const STATUS_TONE: Record<string, "success" | "neutral" | "warning"> = {
  active: "success",
  draft: "neutral",
  archived: "warning",
};

const ALL_TAGS: NonNullable<AdminProduct["tags"]>[number][] = ["new", "bestseller", "sale", "limited"];
// Same threshold the Stock column already highlights in wine.
const LOW_STOCK = 3;
type StockFilter = "all" | "in" | "low" | "out";

export default function ProductList() {
  const navigate = useNavigate();
  const toast = useToast();
  const { t, lang } = useLanguage();
  const { profile, hasRole } = useAdminAuth();
  const [products, setProducts] = useState<AdminProduct[]>([]);
  const [branchTotals, setBranchTotals] = useState<Map<string, number>>(new Map());
  const [categories, setCategories] = useState<AdminCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  // ?category=<slug> preselects the filter (e.g. "View products" from a
  // category that can't be deleted yet).
  const [searchParams] = useSearchParams();
  const [categoryFilter, setCategoryFilter] = useState(() => searchParams.get("category") || "all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [stockFilter, setStockFilter] = useState<StockFilter>("all");
  const [tagFilter, setTagFilter] = useState("all");
  const [priceMin, setPriceMin] = useState("");
  const [priceMax, setPriceMax] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState<AdminProduct | AdminProduct[] | null>(null);
  const [seeding, setSeeding] = useState(false);

  const canWrite = hasRole(["owner", "admin", "editor"]);

  async function handleSeed() {
    setSeeding(true);
    try {
      const result = await seedStarterCatalog();
      toast.success(t("admin.products.imported").replace("{cats}", String(result.categories)).replace("{prods}", String(result.products)));
    } catch {
      toast.error(t("admin.products.importFailed"));
    } finally {
      setSeeding(false);
    }
  }

  useEffect(() => {
    const unsub = productsApi.subscribe((data) => {
      setProducts(data.map(normalizeProduct));
      setLoading(false);
    });
    categoriesApi.list().then(setCategories);
    // Every branch's stock, summed per product, so the Stock column is the
    // real total: online (product doc) + all branches (branchStock docs).
    const unsubBranches = branchStockApi.subscribe((docs) => {
      const next = new Map<string, number>();
      for (const d of docs) next.set(d.productId, (next.get(d.productId) ?? 0) + branchTotalQty(d));
      setBranchTotals(next);
    });
    return () => {
      unsub();
      unsubBranches();
    };
  }, []);

  const allStock = (p: AdminProduct) => totalStock(p) + (branchTotals.get(p.id) ?? 0);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const min = priceMin === "" ? null : Number(priceMin);
    const max = priceMax === "" ? null : Number(priceMax);
    return products.filter((p) => {
      // nameAr is searchable too, since the name cell now renders it in Arabic
      // — searching for what you can actually see has to work.
      if (q && !p.name.toLowerCase().includes(q) && !(p.nameAr ?? "").toLowerCase().includes(q) && !p.slug.toLowerCase().includes(q)) return false;
      if (categoryFilter !== "all" && p.category !== categoryFilter) return false;
      if (statusFilter !== "all" && p.status !== statusFilter) return false;
      if (stockFilter !== "all") {
        const stock = allStock(p);
        if (stockFilter === "in" && stock <= 0) return false;
        if (stockFilter === "low" && (stock <= 0 || stock > LOW_STOCK)) return false;
        if (stockFilter === "out" && stock > 0) return false;
      }
      if (tagFilter !== "all" && !(p.tags ?? []).includes(tagFilter as (typeof ALL_TAGS)[number])) return false;
      if (min !== null && p.price < min) return false;
      if (max !== null && p.price > max) return false;
      return true;
    });
  }, [products, branchTotals, search, categoryFilter, statusFilter, stockFilter, tagFilter, priceMin, priceMax]);

  const filtersActive = search.trim() !== "" || categoryFilter !== "all" || statusFilter !== "all" || stockFilter !== "all" || tagFilter !== "all" || priceMin !== "" || priceMax !== "";

  function clearFilters() {
    setSearch("");
    setCategoryFilter("all");
    setStatusFilter("all");
    setStockFilter("all");
    setTagFilter("all");
    setPriceMin("");
    setPriceMax("");
  }

  async function handleArchiveToggle(p: AdminProduct) {
    const nextStatus = p.status === "archived" ? "active" : "archived";
    await productsApi.update(p.id, { status: nextStatus });
    if (profile) await logActivity(profile, nextStatus === "archived" ? "product.archived" : "product.restored", p.name);
    toast.success(nextStatus === "archived" ? t("admin.products.archived") : t("admin.products.restored"));
  }

  async function performDelete(targets: AdminProduct[]) {
    await Promise.all(targets.map((p) => productsApi.remove(p.id)));
    if (profile) await logActivity(profile, "product.deleted", targets.map((p) => p.name).join(", "));
    toast.success(targets.length > 1 ? `${targets.length} ${t("admin.products.deletedPlural")}` : t("admin.products.deletedSingle"));
    setSelected(new Set());
    setConfirmDelete(null);
  }

  const columns: DataTableColumn<AdminProduct>[] = [
    {
      key: "name",
      header: t("admin.products.colProduct"),
      // Same localizedName() helper POS's ProductPicker/Terminal already use,
      // so a product reads the same way in Arabic everywhere in the app.
      sortValue: (p) => localizedName(p.name, p.nameAr, lang),
      render: (p) => (
        <div className="flex items-center gap-3">
          <div className="h-11 w-11 shrink-0 overflow-hidden rounded-lg bg-cream-dim">
            {resolveProductImageSrc(p) && <img src={resolveProductImageSrc(p)} alt="" className="h-full w-full object-cover" />}
          </div>
          <div className="min-w-0">
            <p className="truncate font-semibold text-ink">{localizedName(p.name, p.nameAr, lang)}</p>
            <p className="truncate text-xs text-ink-faint">{p.slug}</p>
          </div>
        </div>
      ),
    },
    {
      key: "category",
      header: t("admin.nav.categories"),
      sortValue: (p) => p.category,
      render: (p) => {
        const cat = categories.find((c) => c.slug === p.category);
        return <span className="capitalize text-ink-soft">{cat ? localizedName(cat.name, cat.nameAr, lang) : p.category}</span>;
      },
    },
    { key: "price", header: t("admin.products.colPrice"), sortValue: (p) => p.price, render: (p) => <span className="font-semibold">{formatPrice(p.price)}</span> },
    {
      key: "stock",
      header: t("admin.products.colStock"),
      sortValue: (p) => allStock(p),
      render: (p) => {
        const online = totalStock(p);
        const branches = branchTotals.get(p.id) ?? 0;
        const total = online + branches;
        return (
          <div className="leading-tight" title={t("admin.products.stockSplitHint")}>
            <span className={total <= LOW_STOCK ? "font-semibold text-wine" : "font-semibold text-ink"}>{total}</span>
            <span className="block whitespace-nowrap text-[11px] text-ink-faint">
              {t("admin.products.stockOnline")} {online} · {t("admin.products.stockBranches")} {branches}
            </span>
          </div>
        );
      },
    },
    {
      key: "status",
      header: t("admin.products.colStatus"),
      sortValue: (p) => p.status,
      render: (p) => (
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={STATUS_TONE[p.status]}>{t(`admin.products.status.${p.status}`)}</Badge>
          {exceedsCheckoutSafeLimit(p) && (
            <span title={t("admin.products.tooManyVariantsBadgeHint")}>
              <Badge tone="warning">{t("admin.products.tooManyVariantsBadge")}</Badge>
            </span>
          )}
        </div>
      ),
    },
    {
      key: "actions",
      header: "",
      render: (p) => (
        <div className="flex items-center justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
          {canWrite && (
            <>
              <button onClick={() => handleArchiveToggle(p)} className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-ink-soft hover:bg-cream-dim hover:text-ink">
                {p.status === "archived" ? t("admin.products.restore") : t("admin.products.archive")}
              </button>
              <button onClick={() => setConfirmDelete(p)} className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-wine hover:bg-wine-light">
                {t("admin.products.delete")}
              </button>
            </>
          )}
        </div>
      ),
      headerClassName: "text-end",
      className: "text-end",
    },
  ];

  return (
    <div>
      <PageHeader
        title={t("admin.nav.products")}
        description={`${products.length} ${t("admin.products.total")}`}
        actions={canWrite && <AdminButton variant="primary" icon="plus" onClick={() => navigate("/admin/products/new")}>{t("admin.products.addProduct")}</AdminButton>}
      />

      {/* AdminSelect/AdminInput are w-full by design, so each control sits in a sized wrapper. */}
      <div className="mb-4 rounded-2xl border border-line bg-paper p-3 shadow-soft">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6 2xl:grid-cols-[minmax(14rem,1fr)_repeat(4,minmax(0,10.5rem))_repeat(2,minmax(0,7rem))]">
          <div className="col-span-2 sm:col-span-3 lg:col-span-6 2xl:col-span-1 [&>div]:w-full [&_input]:sm:w-full">
            <SearchInput value={search} onChange={setSearch} placeholder={t("admin.products.searchPlaceholder")} />
          </div>
          <AdminSelect value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} aria-label={t("admin.products.allCategories")}>
            <option value="all">{t("admin.products.allCategories")}</option>
            {flattenTree(categories).map(({ cat: c, depth }) => (
              <option key={c.slug} value={c.slug}>
                {"   ".repeat(depth)}
                {depth > 0 ? "└ " : ""}
                {localizedName(c.name, c.nameAr, lang)}
              </option>
            ))}
          </AdminSelect>
          <AdminSelect value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label={t("admin.products.allStatuses")}>
            <option value="all">{t("admin.products.allStatuses")}</option>
            <option value="active">{t("admin.products.status.active")}</option>
            <option value="draft">{t("admin.products.status.draft")}</option>
            <option value="archived">{t("admin.products.status.archived")}</option>
          </AdminSelect>
          <AdminSelect value={stockFilter} onChange={(e) => setStockFilter(e.target.value as StockFilter)} aria-label={t("admin.products.allStock")}>
            <option value="all">{t("admin.products.allStock")}</option>
            <option value="in">{t("admin.products.inStock")}</option>
            <option value="low">{t("admin.products.lowStock")}</option>
            <option value="out">{t("admin.products.outOfStock")}</option>
          </AdminSelect>
          <AdminSelect value={tagFilter} onChange={(e) => setTagFilter(e.target.value)} aria-label={t("admin.products.allTags")}>
            <option value="all">{t("admin.products.allTags")}</option>
            {ALL_TAGS.map((tag) => (
              <option key={tag} value={tag}>
                {t(`admin.productForm.tag.${tag}`)}
              </option>
            ))}
          </AdminSelect>
          <AdminInput type="number" inputMode="decimal" min={0} value={priceMin} onChange={(e) => setPriceMin(e.target.value)} placeholder={t("admin.products.priceMin")} aria-label={t("admin.products.priceMin")} />
          <AdminInput type="number" inputMode="decimal" min={0} value={priceMax} onChange={(e) => setPriceMax(e.target.value)} placeholder={t("admin.products.priceMax")} aria-label={t("admin.products.priceMax")} />
        </div>
        <div className="mt-2 flex min-h-7 items-center justify-between gap-2 px-1 text-xs text-ink-soft">
          <span>{t("admin.products.showingOf").replace("{shown}", String(filtered.length)).replace("{total}", String(products.length))}</span>
          {filtersActive && (
            <button onClick={clearFilters} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 font-semibold text-wine hover:bg-wine-light">
              <AdminIcon name="x" className="h-3.5 w-3.5" />
              {t("admin.products.clearFilters")}
            </button>
          )}
        </div>
      </div>

      {canWrite && (
        <BulkActionBar count={selected.size} onClear={() => setSelected(new Set())}>
          <AdminButton
            size="sm"
            variant="ghost"
            className="!text-paper hover:!bg-paper/15"
            onClick={() => setConfirmDelete(products.filter((p) => selected.has(p.id)))}
          >
            {t("admin.products.deleteSelected")}
          </AdminButton>
        </BulkActionBar>
      )}

      <DataTable
        columns={columns}
        rows={filtered}
        getId={(p) => p.id}
        loading={loading}
        selectable={canWrite}
        selected={selected}
        onSelectionChange={setSelected}
        onRowClick={(p) => navigate(`/admin/products/${p.id}`)}
        defaultSort="name"
        emptyState={
          <EmptyState
            icon="shirt"
            title={t("admin.products.noneFound")}
            body={products.length === 0 ? t("admin.products.emptyBody") : t("admin.products.tryFilter")}
            action={
              canWrite && products.length === 0 ? (
                <div className="flex flex-wrap justify-center gap-2">
                  <AdminButton variant="primary" icon="plus" onClick={() => navigate("/admin/products/new")}>
                    {t("admin.products.addProduct")}
                  </AdminButton>
                  <AdminButton variant="secondary" icon="upload" loading={seeding} onClick={handleSeed}>
                    {t("admin.products.importStarter")}
                  </AdminButton>
                </div>
              ) : undefined
            }
          />
        }
      />

      <ConfirmDialog
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && performDelete(Array.isArray(confirmDelete) ? confirmDelete : [confirmDelete])}
        title={t("admin.products.deleteTitle")}
        body={t("admin.products.deleteBody")}
        confirmLabel={t("admin.products.delete")}
        danger
      />
    </div>
  );
}
