import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useLanguage } from "../../../context/LanguageContext";
import { localizedName } from "../../../data/localize";
import {
  UNSELLABLE_REASON_PRIORITY,
  resolveSellability,
  unsellableReasonDetail,
  unsellableReasonLabelKey,
  type UnsellableReason,
  type UnsellableReasonCode,
} from "../../../data/sellability";
import { categoriesApi, productsApi } from "../../../firebase/collections";
import { AdminSelect, Badge, EmptyState, PageHeader, PageLoading, SearchInput } from "../../components/ui";
import DataTable, { type DataTableColumn } from "../../components/DataTable";
import { resolveProductImageSrc } from "../../imageSrc";
import { hasUnknownStock, normalizeProduct, totalStock } from "../../productVariants";
import type { AdminCategory, AdminProduct } from "../../types";

// Read-only. Lists every product the shared sellability rule
// (src/data/sellability.ts) currently hides from the storefront, search and
// POS, with the reason. Nothing here writes anything, and nothing is stored
// about "hidden" — the list is recomputed from live product data, so a
// product leaves it on its own the moment its reason is resolved.

interface Row {
  product: AdminProduct;
  primary: UnsellableReason;
  others: UnsellableReason[];
  stock: number;
  unknownStock: boolean;
}

const STATUS_TONE: Record<string, "success" | "neutral" | "warning"> = { active: "success", draft: "neutral", archived: "warning" };
const REASON_TONE: Record<UnsellableReasonCode, "danger" | "warning" | "neutral"> = {
  out_of_stock: "danger",
  checkout_unsafe: "danger",
  incomplete_data: "warning",
  inactive: "neutral",
};

function fill(text: string, params: Record<string, string | number>): string {
  return Object.entries(params).reduce((acc, [k, v]) => acc.split(`{${k}}`).join(String(v)), text);
}

function ReasonCell({ row, t }: { row: Row; t: (key: string) => string }) {
  const detail = unsellableReasonDetail(row.primary);
  return (
    <div className="flex min-w-0 flex-col items-start gap-1.5">
      <Badge tone={REASON_TONE[row.primary.code]}>{t(unsellableReasonLabelKey(row.primary.code))}</Badge>
      <p className="text-xs leading-relaxed text-ink-soft">{fill(t(detail.key), detail.params)}</p>
      {row.others.length > 0 && (
        <p className="text-xs text-ink-faint">
          {t("admin.unsellable.alsoApplies")} {row.others.map((o) => t(unsellableReasonLabelKey(o.code))).join("، ")}
        </p>
      )}
    </div>
  );
}

export default function UnsellableProducts() {
  const navigate = useNavigate();
  const { t, lang } = useLanguage();
  const [products, setProducts] = useState<AdminProduct[]>([]);
  const [categories, setCategories] = useState<AdminCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [reasonFilter, setReasonFilter] = useState<"all" | UnsellableReasonCode>("all");

  useEffect(() => {
    const unsub = productsApi.subscribe((data) => {
      setProducts(data.map(normalizeProduct));
      setLoading(false);
    });
    categoriesApi.list().then(setCategories);
    return unsub;
  }, []);

  const rows = useMemo<Row[]>(
    () =>
      products.flatMap((product) => {
        const result = resolveSellability(product);
        if (result.sellable || !result.primaryReason) return [];
        return [{ product, primary: result.primaryReason, others: result.reasons.slice(1), stock: totalStock(product), unknownStock: hasUnknownStock(product) }];
      }),
    [products]
  );

  const reasonCounts = useMemo(() => {
    const counts = new Map<UnsellableReasonCode, number>();
    for (const r of rows) counts.set(r.primary.code, (counts.get(r.primary.code) ?? 0) + 1);
    return counts;
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(({ product: p, primary }) => {
      if (reasonFilter !== "all" && primary.code !== reasonFilter) return false;
      if (categoryFilter !== "all" && p.category !== categoryFilter) return false;
      if (q && !p.name.toLowerCase().includes(q) && !(p.nameAr ?? "").toLowerCase().includes(q) && !p.id.toLowerCase().includes(q) && !p.slug.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [rows, search, categoryFilter, reasonFilter]);

  function categoryLabel(slug: string): string {
    if (slug === "uncategorized") return t("admin.unsellable.uncategorized");
    const cat = categories.find((c) => c.slug === slug);
    return cat ? localizedName(cat.name, cat.nameAr, lang) : slug;
  }

  // The product's own updatedAt (its last edit) — the only meaningful date the
  // data carries. It is not "when it became unsellable"; that isn't stored.
  function updatedParts(value: unknown): { date: string; time: string } {
    const ts = value as { toDate?: () => Date } | undefined;
    const d = ts?.toDate ? ts.toDate() : null;
    if (!d) return { date: t("admin.unsellable.neverUpdated"), time: "" };
    const locale = lang === "ar" ? "ar-u-nu-latn" : "en-GB";
    return { date: d.toLocaleDateString(locale, { dateStyle: "medium" }), time: d.toLocaleTimeString(locale, { timeStyle: "short" }) };
  }
  function updatedLabel(value: unknown): string {
    const { date, time } = updatedParts(value);
    return time ? `${date} ${time}` : date;
  }

  function stockCell(row: Row) {
    return (
      <span className={row.stock === 0 && !row.unknownStock ? "font-semibold text-wine" : "font-semibold"} title={row.unknownStock ? t("admin.unsellable.stockUnknownHint") : undefined}>
        {row.stock}
        {row.unknownStock && <span className="text-ink-faint"> ?</span>}
      </span>
    );
  }

  const columns: DataTableColumn<Row>[] = [
    {
      key: "name",
      header: `${t("admin.unsellable.colProduct")} / ${t("admin.unsellable.colId")}`,
      sortValue: ({ product: p }) => localizedName(p.name, p.nameAr, lang),
      className: "min-w-[210px]",
      render: ({ product: p }) => (
        <div className="flex items-center gap-3">
          <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-cream-dim">
            {resolveProductImageSrc(p) && <img src={resolveProductImageSrc(p)} alt="" className="h-full w-full object-cover" />}
          </div>
          <div className="min-w-0">
            <p className="line-clamp-2 font-semibold text-ink">{localizedName(p.name, p.nameAr, lang)}</p>
            {/* The product ID sits under the name (labelled by the column header) so the table stays narrow enough to fit without sideways scrolling. */}
            <span dir="ltr" title={t("admin.unsellable.colId")} className="mt-0.5 inline-block whitespace-nowrap font-mono text-xs text-ink-faint">
              {p.id}
            </span>
          </div>
        </div>
      ),
    },
    { key: "category", header: t("admin.unsellable.colCategory"), sortValue: ({ product: p }) => p.category, render: ({ product: p }) => <span className="text-ink-soft">{categoryLabel(p.category)}</span> },
    { key: "stock", header: t("admin.unsellable.colStock"), sortValue: (r) => r.stock, render: stockCell },
    {
      key: "status",
      header: t("admin.unsellable.colStatus"),
      sortValue: ({ product: p }) => p.status,
      render: ({ product: p }) => <Badge tone={STATUS_TONE[p.status] ?? "neutral"}>{t(`admin.products.status.${p.status}`)}</Badge>,
    },
    {
      key: "reason",
      header: t("admin.unsellable.colReason"),
      sortValue: (r) => `${UNSELLABLE_REASON_PRIORITY.indexOf(r.primary.code)}-${localizedName(r.product.name, r.product.nameAr, lang)}`,
      render: (r) => <ReasonCell row={r} t={t} />,
      className: "min-w-[260px] max-w-sm",
    },
    {
      key: "updated",
      header: t("admin.unsellable.colUpdated"),
      sortValue: ({ product: p }) => (p.updatedAt as { seconds?: number } | undefined)?.seconds ?? 0,
      render: ({ product: p }) => {
        const { date, time } = updatedParts(p.updatedAt);
        return (
          <div className="whitespace-nowrap text-xs text-ink-soft">
            <p>{date}</p>
            {time && <p className="text-ink-faint">{time}</p>}
          </div>
        );
      },
    },
  ];

  const chip = (active: boolean) =>
    `shrink-0 rounded-full px-4 py-2 text-sm font-semibold transition-colors ${active ? "bg-wine text-on-accent" : "bg-cream-dim text-ink-soft hover:text-ink"}`;

  const emptyState =
    rows.length === 0 ? (
      <EmptyState icon="check" title={t("admin.unsellable.emptyTitle")} body={t("admin.unsellable.emptyBody")} />
    ) : (
      <EmptyState icon="search" title={t("admin.unsellable.noMatchTitle")} body={t("admin.unsellable.noMatchBody")} />
    );

  return (
    <div>
      <PageHeader title={t("admin.unsellable.title")} description={`${rows.length} ${t("admin.unsellable.hiddenCount")}`} />
      <p className="-mt-3 mb-5 max-w-3xl text-sm text-ink-soft">{t("admin.unsellable.description")}</p>

      <div className="thin-scrollbar mb-4 flex gap-2 overflow-x-auto pb-1" role="group" aria-label={t("admin.unsellable.colReason")}>
        <button type="button" onClick={() => setReasonFilter("all")} className={chip(reasonFilter === "all")}>
          {t("admin.unsellable.allReasons")} ({rows.length})
        </button>
        {UNSELLABLE_REASON_PRIORITY.filter((code) => reasonCounts.has(code)).map((code) => (
          <button key={code} type="button" onClick={() => setReasonFilter(code)} className={chip(reasonFilter === code)}>
            {t(unsellableReasonLabelKey(code))} ({reasonCounts.get(code)})
          </button>
        ))}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SearchInput value={search} onChange={setSearch} placeholder={t("admin.unsellable.searchPlaceholder")} />
        <div className="w-full sm:w-56">
          <AdminSelect value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
            <option value="all">{t("admin.unsellable.allCategories")}</option>
            {categories.map((c) => (
              <option key={c.slug} value={c.slug}>
                {localizedName(c.name, c.nameAr, lang)}
              </option>
            ))}
          </AdminSelect>
        </div>
      </div>

      {/* Wide screens (with the sidebar open, the table needs ~1280px): table. */}
      <div className="hidden xl:block">
        <DataTable columns={columns} rows={filtered} getId={(r) => r.product.id} loading={loading} onRowClick={(r) => navigate(`/admin/products/${r.product.id}`)} defaultSort="reason" emptyState={emptyState} />
      </div>

      {/* Phones and tablets: one card per product (two columns on tablets), so nothing needs sideways scrolling. */}
      <div className="xl:hidden">
        {loading ? (
          <PageLoading />
        ) : filtered.length === 0 ? (
          emptyState
        ) : (
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {filtered.map((row) => {
              const p = row.product;
              return (
                <li key={p.id} className="rounded-2xl border border-line bg-paper p-4">
                  <Link to={`/admin/products/${p.id}`} className="flex items-center gap-3">
                    <div className="h-14 w-14 shrink-0 overflow-hidden rounded-lg bg-cream-dim">
                      {resolveProductImageSrc(p) && <img src={resolveProductImageSrc(p)} alt="" className="h-full w-full object-cover" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-2 font-semibold text-ink">{localizedName(p.name, p.nameAr, lang)}</p>
                      <p dir="ltr" className="mt-0.5 text-start font-mono text-xs text-ink-faint">
                        {p.id}
                      </p>
                    </div>
                  </Link>
                  <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                    <div>
                      <dt className="text-xs text-ink-faint">{t("admin.unsellable.colCategory")}</dt>
                      <dd className="text-ink-soft">{categoryLabel(p.category)}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-ink-faint">{t("admin.unsellable.colStock")}</dt>
                      <dd>{stockCell(row)}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-ink-faint">{t("admin.unsellable.colStatus")}</dt>
                      <dd>
                        <Badge tone={STATUS_TONE[p.status] ?? "neutral"}>{t(`admin.products.status.${p.status}`)}</Badge>
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-ink-faint">{t("admin.unsellable.colUpdated")}</dt>
                      <dd className="text-xs text-ink-soft">{updatedLabel(p.updatedAt)}</dd>
                    </div>
                  </dl>
                  <div className="mt-3 border-t border-line pt-3">
                    <ReasonCell row={row} t={t} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
