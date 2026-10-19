import { Timestamp } from "../../db/firestore";
import { useEffect, useMemo, useState } from "react";
import { useLanguage } from "../../context/LanguageContext";
import { subtreeSlugs } from "../../data/categoryTree";
import { localizedName } from "../../data/localize";
import { categoriesApi, productsApi, promotionsApi } from "../../firebase/collections";
import { formatPrice } from "../../utils/currency";
import { useAdminAuth } from "../AdminAuthContext";
import { logActivity } from "../logActivity";
import { normalizeProduct } from "../productVariants";
import type { AdminCategory, AdminOrder, AdminProduct, AdminPromotion, Branch } from "../types";
import { ConfirmDialog, Modal } from "./Modal";
import { useToast } from "./ToastContext";
import { AdminButton, AdminInput, AdminNumberInput, AdminTextarea, Badge, Card, Field, PageLoading, SearchInput, Toggle } from "./ui";

type PromoType = AdminPromotion["type"];
type PromoScope = AdminPromotion["scope"];

const tsMs = (v: unknown): number | null => {
  const o = v as { toMillis?: () => number } | undefined;
  return o?.toMillis ? o.toMillis() : null;
};
// <input type="datetime-local"> value for a timestamp, in local time.
const toLocalInput = (v: unknown) => {
  const ms = tsMs(v);
  if (ms === null) return "";
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
};

type PromotionStatus = "live" | "scheduled" | "ended" | "off";
function promotionStatus(p: AdminPromotion, now = Date.now()): PromotionStatus {
  if (!p.active) return "off";
  const start = tsMs(p.startsAt);
  const end = tsMs(p.endsAt);
  if (start !== null && now < start) return "scheduled";
  if (end !== null && now > end) return "ended";
  return "live";
}
const STATUS_TONE: Record<PromotionStatus, "success" | "info" | "neutral" | "warning"> = { live: "success", scheduled: "info", ended: "neutral", off: "warning" };

// "20% off", "30.00₪ off each", "Buy 2 get 1 free", "3 for 100.00₪"...
export function useOfferText() {
  const { t } = useLanguage();
  return (p: Pick<AdminPromotion, "type" | "scope" | "value" | "buyQty" | "getQty" | "getPercent" | "bundleQty">) => {
    if (p.type === "percent") return t("admin.promotions.offer.percent").replace("{v}", String(p.value));
    if (p.type === "amount") return t(p.scope === "sale" ? "admin.promotions.offer.amountSale" : "admin.promotions.offer.amount").replace("{v}", formatPrice(p.value));
    if (p.type === "buy_x_get_y")
      return (p.getPercent ?? 100) >= 100
        ? t("admin.promotions.offer.bxgyFree").replace("{x}", String(p.buyQty ?? 1)).replace("{y}", String(p.getQty ?? 1))
        : t("admin.promotions.offer.bxgy").replace("{x}", String(p.buyQty ?? 1)).replace("{y}", String(p.getQty ?? 1)).replace("{p}", String(p.getPercent ?? 100));
    return t("admin.promotions.offer.bundle").replace("{n}", String(p.bundleQty ?? 2)).replace("{v}", formatPrice(p.value));
  };
}

interface Draft {
  name: string;
  description: string;
  active: boolean;
  type: PromoType;
  scope: PromoScope;
  value: number | null;
  buyQty: number | null;
  getQty: number | null;
  getPercent: number | null;
  bundleQty: number | null;
  productIds: string[];
  categoryIds: string[];
  minSubtotal: number | null;
  branchIds: string[];
  startsAt: string;
  endsAt: string;
}

const EMPTY: Draft = {
  name: "",
  description: "",
  active: true,
  type: "percent",
  scope: "products",
  value: 10,
  buyQty: 2,
  getQty: 1,
  getPercent: 100,
  bundleQty: 3,
  productIds: [],
  categoryIds: [],
  minSubtotal: null,
  branchIds: [],
  startsAt: "",
  endsAt: "",
};

// Automatic promotions: list (status, offer, where/when, what it gave in the
// report period) and the create/edit form. The till applies live ones by
// itself; how they combine is documented in services/api/src/shared/promotions.ts.
export function PromotionsManager({ branches, orders }: { branches: Branch[]; orders: AdminOrder[] | null }) {
  const { t, lang } = useLanguage();
  const toast = useToast();
  const { profile } = useAdminAuth();
  const offerText = useOfferText();
  const [promotions, setPromotions] = useState<AdminPromotion[] | null>(null);
  const [products, setProducts] = useState<AdminProduct[]>([]);
  const [categories, setCategories] = useState<AdminCategory[]>([]);
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft } | null>(null);
  const [deleting, setDeleting] = useState<AdminPromotion | null>(null);
  // Status (Live / Scheduled / Ended) follows the clock while the page is open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    productsApi
      .list()
      .then((list) => setProducts(list.map(normalizeProduct).filter((p) => p.status === "active")))
      .catch(() => setProducts([]));
    categoriesApi
      .list()
      .then((c) => setCategories(c.sort((a, b) => a.order - b.order)))
      .catch(() => setCategories([]));
    return promotionsApi.subscribe((list) => setPromotions(list.sort((a, b) => a.name.localeCompare(b.name))));
  }, []);

  // What each promotion took off in the report period (all branches/filters of the page).
  const given = useMemo(() => {
    const m = new Map<string, { sales: number; amount: number }>();
    (orders ?? []).forEach((o) =>
      o.promotions?.forEach((p) => {
        const e = m.get(p.id) ?? { sales: 0, amount: 0 };
        e.sales += 1;
        e.amount += p.amount;
        m.set(p.id, e);
      })
    );
    return m;
  }, [orders]);

  const appliesText = (p: AdminPromotion) => {
    if (p.scope === "sale") return p.minSubtotal ? t("admin.promotions.wholeSaleMin").replace("{v}", formatPrice(p.minSubtotal)) : t("admin.promotions.wholeSale");
    if (p.scope === "categories")
      return (p.categoryIds ?? [])
        .map((id) => categories.find((c) => c.id === id))
        .filter(Boolean)
        .map((c) => localizedName(c!.name, c!.nameAr, lang))
        .join(", ");
    const names = (p.productIds ?? []).map((id) => products.find((x) => x.id === id)).filter(Boolean).map((x) => localizedName(x!.name, x!.nameAr, lang));
    return names.length > 2 ? `${names.slice(0, 2).join(", ")} +${names.length - 2}` : names.join(", ");
  };
  const branchesText = (p: AdminPromotion) =>
    !p.branchIds?.length ? t("admin.posSales.allBranches") : p.branchIds.map((id) => branches.find((b) => b.id === id)?.code ?? "?").join(", ");
  const fmt = (v: unknown) => {
    const ms = tsMs(v);
    return ms === null ? "" : new Date(ms).toLocaleString(lang === "ar" ? "ar" : "en-US", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  };

  function openNew() {
    setEditing({ id: null, draft: { ...EMPTY } });
  }
  function openEdit(p: AdminPromotion) {
    setEditing({
      id: p.id,
      draft: {
        name: p.name,
        description: p.description ?? "",
        active: p.active,
        type: p.type,
        scope: p.scope,
        value: p.value,
        buyQty: p.buyQty ?? 2,
        getQty: p.getQty ?? 1,
        getPercent: p.getPercent ?? 100,
        bundleQty: p.bundleQty ?? 3,
        productIds: p.productIds ?? [],
        categoryIds: p.categoryIds ?? [],
        minSubtotal: p.minSubtotal ?? null,
        branchIds: p.branchIds ?? [],
        startsAt: toLocalInput(p.startsAt),
        endsAt: toLocalInput(p.endsAt),
      },
    });
  }

  async function toggleActive(p: AdminPromotion) {
    try {
      await promotionsApi.update(p.id, { active: !p.active });
      if (profile) void logActivity(profile, p.active ? "promotion.deactivated" : "promotion.activated", p.name);
    } catch {
      toast.error(t("admin.promotions.saveFailed"));
    }
  }

  async function remove() {
    if (!deleting) return;
    try {
      await promotionsApi.remove(deleting.id);
      if (profile) void logActivity(profile, "promotion.deleted", deleting.name);
      toast.success(t("admin.promotions.deleted"));
    } catch {
      toast.error(t("admin.promotions.saveFailed"));
    }
    setDeleting(null);
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-ink-soft">{t("admin.promotions.intro")}</p>
        <AdminButton variant="primary" icon="plus" onClick={openNew}>
          {t("admin.promotions.new")}
        </AdminButton>
      </div>
      {promotions === null ? (
        <PageLoading />
      ) : promotions.length === 0 ? (
        <Card className="px-4 py-8 text-center text-sm text-ink-faint">{t("admin.promotions.none")}</Card>
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="whitespace-nowrap bg-cream-dim text-xs uppercase text-ink-faint">
              <tr>
                <th className="px-3 py-2 text-start">{t("admin.promotions.name")}</th>
                <th className="px-3 py-2 text-start">{t("admin.promotions.offerCol")}</th>
                <th className="px-3 py-2 text-start">{t("admin.promotions.appliesTo")}</th>
                <th className="px-3 py-2 text-start">{t("pos.branch.branch")}</th>
                <th className="px-3 py-2 text-start">{t("admin.promotions.dates")}</th>
                <th className="px-3 py-2 text-start">{t("admin.promotions.status")}</th>
                <th className="px-3 py-2 text-end">{t("admin.promotions.given")}</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {promotions.map((p) => {
                const st = promotionStatus(p, now);
                const g = given.get(p.id);
                return (
                  <tr key={p.id} className="hover:bg-cream-dim/50">
                    <td className="px-3 py-2">
                      <button onClick={() => openEdit(p)} className="text-start font-semibold text-ink hover:text-wine">
                        {p.name}
                      </button>
                      {p.description && <p className="max-w-[14rem] truncate text-xs text-ink-faint">{p.description}</p>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 font-semibold text-olive">{offerText(p)}</td>
                    <td className="max-w-[14rem] truncate px-3 py-2 text-ink-soft">{appliesText(p)}</td>
                    <td className="px-3 py-2 text-ink-soft">{branchesText(p)}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-ink-soft">
                      {fmt(p.startsAt) || t("admin.promotions.now")} → {fmt(p.endsAt) || t("admin.promotions.noEnd")}
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={STATUS_TONE[st]}>{t(`admin.promotions.statusLabel.${st}`)}</Badge>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-end">
                      {g ? (
                        <>
                          <span className="font-semibold text-wine">-{formatPrice(g.amount)}</span>
                          <span className="block text-[11px] text-ink-faint">
                            {g.sales} {t("admin.branches.salesShort")}
                          </span>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-end">
                      <span className="inline-flex items-center gap-1.5">
                        <Toggle checked={p.active} onChange={() => void toggleActive(p)} />
                        <AdminButton size="sm" variant="ghost" icon="edit" aria-label={t("admin.common.edit")} onClick={() => openEdit(p)} />
                        <AdminButton size="sm" variant="ghost" icon="trash" aria-label={t("admin.common.delete")} onClick={() => setDeleting(p)} />
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      {editing && (
        <PromotionEditor
          id={editing.id}
          initial={editing.draft}
          products={products}
          categories={categories}
          branches={branches}
          onClose={() => setEditing(null)}
          onSaved={(name, created) => {
            if (profile) void logActivity(profile, created ? "promotion.created" : "promotion.updated", name);
            toast.success(t("admin.settings.saved"));
            setEditing(null);
          }}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => void remove()}
        danger
        title={t("admin.promotions.deleteTitle")}
        body={t("admin.promotions.deleteBody").replace("{name}", deleting?.name ?? "")}
        confirmLabel={t("admin.common.delete")}
      />
    </div>
  );
}

function PromotionEditor({
  id,
  initial,
  products,
  categories,
  branches,
  onClose,
  onSaved,
}: {
  id: string | null;
  initial: Draft;
  products: AdminProduct[];
  categories: AdminCategory[];
  branches: Branch[];
  onClose: () => void;
  onSaved: (name: string, created: boolean) => void;
}) {
  const { t, lang } = useLanguage();
  const toast = useToast();
  const offerText = useOfferText();
  const [d, setD] = useState<Draft>(initial);
  const [productSearch, setProductSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  // Whole-sale promotions are a % or an amount off the sale.
  useEffect(() => {
    if (d.scope === "sale" && (d.type === "buy_x_get_y" || d.type === "bundle")) set({ type: "percent" });
  }, [d.scope, d.type]);

  const errors: string[] = [];
  if (!d.name.trim()) errors.push(t("admin.promotions.err.name"));
  if (d.type === "percent" && !(d.value !== null && d.value > 0 && d.value <= 100)) errors.push(t("admin.promotions.err.percent"));
  if ((d.type === "amount" || d.type === "bundle") && !(d.value !== null && d.value > 0)) errors.push(t("admin.promotions.err.amount"));
  if (d.type === "buy_x_get_y" && !((d.buyQty ?? 0) >= 1 && (d.getQty ?? 0) >= 1 && (d.getPercent ?? 0) > 0 && (d.getPercent ?? 0) <= 100))
    errors.push(t("admin.promotions.err.bxgy"));
  if (d.type === "bundle" && !((d.bundleQty ?? 0) >= 2)) errors.push(t("admin.promotions.err.bundleQty"));
  if (d.scope === "products" && d.productIds.length === 0) errors.push(t("admin.promotions.err.products"));
  if (d.scope === "categories" && d.categoryIds.length === 0) errors.push(t("admin.promotions.err.categories"));
  if (d.startsAt && d.endsAt && new Date(d.endsAt) <= new Date(d.startsAt)) errors.push(t("admin.promotions.err.dates"));
  // An end that has already passed would make the promotion do nothing.
  if (d.active && d.endsAt && new Date(d.endsAt).getTime() <= Date.now()) errors.push(t("admin.promotions.err.ended"));
  // Not an error, but almost always a typo: a promotion shorter than a day.
  const runMs = d.endsAt ? new Date(d.endsAt).getTime() - (d.startsAt ? new Date(d.startsAt).getTime() : Date.now()) : null;
  const shortRun = runMs !== null && runMs > 0 && runMs < 24 * 3600e3;

  async function save() {
    if (errors.length > 0) return;
    setSaving(true);
    const doc: Omit<AdminPromotion, "id"> = {
      name: d.name.trim().slice(0, 80),
      description: d.description.trim() || undefined,
      active: d.active,
      type: d.type,
      scope: d.scope,
      value: d.type === "buy_x_get_y" ? 0 : (d.value ?? 0),
      buyQty: d.type === "buy_x_get_y" ? Math.floor(d.buyQty ?? 1) : undefined,
      getQty: d.type === "buy_x_get_y" ? Math.floor(d.getQty ?? 1) : undefined,
      getPercent: d.type === "buy_x_get_y" ? (d.getPercent ?? 100) : undefined,
      bundleQty: d.type === "bundle" ? Math.floor(d.bundleQty ?? 2) : undefined,
      productIds: d.scope === "products" ? d.productIds : [],
      categoryIds: d.scope === "categories" ? d.categoryIds : [],
      // Resolved now (with sub-categories) so the till and the server read slugs.
      categorySlugs: d.scope === "categories" ? [...new Set(d.categoryIds.flatMap((cid) => [...subtreeSlugs(categories, cid)]))] : [],
      minSubtotal: d.scope === "sale" && d.minSubtotal ? d.minSubtotal : undefined,
      branchIds: d.branchIds,
      startsAt: d.startsAt ? Timestamp.fromDate(new Date(d.startsAt)) : undefined,
      endsAt: d.endsAt ? Timestamp.fromDate(new Date(d.endsAt)) : undefined,
    };
    try {
      if (id) await promotionsApi.update(id, doc);
      else await promotionsApi.create(doc);
      onSaved(doc.name, !id);
    } catch {
      toast.error(t("admin.promotions.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  const shownProducts = useMemo(() => {
    const q = productSearch.trim().toLowerCase();
    return products.filter((p) => !q || p.name.toLowerCase().includes(q) || p.nameAr?.toLowerCase().includes(q) || p.sku?.toLowerCase().includes(q)).slice(0, 60);
  }, [products, productSearch]);

  const chip = (on: boolean) => `rounded-md border px-2.5 py-1 text-xs font-semibold ${on ? "border-wine bg-wine-light text-wine-dark" : "border-line text-ink-soft hover:text-ink"}`;
  const TYPES: PromoType[] = ["percent", "amount", "buy_x_get_y", "bundle"];
  const SCOPES: PromoScope[] = ["products", "categories", "sale"];

  return (
    <Modal open onClose={onClose} title={id ? t("admin.promotions.edit") : t("admin.promotions.new")} width="lg">
      <div className="flex flex-col gap-4 text-sm">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
          <Field label={t("admin.promotions.name")} required>
            <AdminInput value={d.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} placeholder={t("admin.promotions.namePlaceholder")} />
          </Field>
          <label className="flex items-end gap-2 pb-2">
            <Toggle checked={d.active} onChange={(v) => set({ active: v })} />
            <span className="font-semibold text-ink">{t("admin.promotions.activeLabel")}</span>
          </label>
        </div>
        <Field label={t("admin.promotions.description")}>
          <AdminTextarea rows={2} value={d.description} onChange={(e) => set({ description: e.target.value })} />
        </Field>

        <div>
          <p className="mb-1.5 font-semibold text-ink">{t("admin.promotions.appliesTo")}</p>
          <div className="flex flex-wrap gap-1.5">
            {SCOPES.map((sc) => (
              <button key={sc} type="button" onClick={() => set({ scope: sc })} className={chip(d.scope === sc)}>
                {t(`admin.promotions.scope.${sc}`)}
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className="mb-1.5 font-semibold text-ink">{t("admin.promotions.typeLabel")}</p>
          <div className="flex flex-wrap gap-1.5">
            {TYPES.filter((ty) => d.scope !== "sale" || ty === "percent" || ty === "amount").map((ty) => (
              <button key={ty} type="button" onClick={() => set({ type: ty })} className={chip(d.type === ty)}>
                {t(`admin.promotions.type.${ty}`)}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {d.type === "percent" && (
            <Field label={t("admin.promotions.percentOff")}>
              <AdminNumberInput min={0} max={100} value={d.value} onChange={(v) => set({ value: v })} />
            </Field>
          )}
          {d.type === "amount" && (
            <Field label={d.scope === "sale" ? t("admin.promotions.amountOffSale") : t("admin.promotions.amountOffEach")}>
              <AdminNumberInput min={0} value={d.value} onChange={(v) => set({ value: v })} />
            </Field>
          )}
          {d.type === "buy_x_get_y" && (
            <>
              <Field label={t("admin.promotions.buyQty")}>
                <AdminNumberInput integerOnly min={1} value={d.buyQty} onChange={(v) => set({ buyQty: v })} />
              </Field>
              <Field label={t("admin.promotions.getQty")}>
                <AdminNumberInput integerOnly min={1} value={d.getQty} onChange={(v) => set({ getQty: v })} />
              </Field>
              <Field label={t("admin.promotions.getPercent")} hint={t("admin.promotions.getPercentHint")}>
                <AdminNumberInput min={1} max={100} value={d.getPercent} onChange={(v) => set({ getPercent: v })} />
              </Field>
            </>
          )}
          {d.type === "bundle" && (
            <>
              <Field label={t("admin.promotions.bundleQty")}>
                <AdminNumberInput integerOnly min={2} value={d.bundleQty} onChange={(v) => set({ bundleQty: v })} />
              </Field>
              <Field label={t("admin.promotions.bundlePrice")}>
                <AdminNumberInput min={0} value={d.value} onChange={(v) => set({ value: v })} />
              </Field>
            </>
          )}
          {d.scope === "sale" && (
            <Field label={t("admin.promotions.minSubtotal")} hint={t("admin.promotions.optional")}>
              <AdminNumberInput min={0} nullable value={d.minSubtotal} onChange={(v) => set({ minSubtotal: v })} />
            </Field>
          )}
        </div>
        <p className="rounded-lg bg-olive-light px-3 py-2 font-semibold text-olive">
          {t("admin.promotions.preview")}: {offerText({ ...d, value: d.value ?? 0, buyQty: d.buyQty ?? 1, getQty: d.getQty ?? 1, getPercent: d.getPercent ?? 100, bundleQty: d.bundleQty ?? 2 })}
        </p>

        {d.scope === "products" && (
          <div>
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <p className="font-semibold text-ink">
                {t("admin.promotions.products")} <span className="text-ink-faint">({d.productIds.length})</span>
              </p>
              <SearchInput value={productSearch} onChange={setProductSearch} placeholder={t("admin.promotions.searchProducts")} />
            </div>
            <div className="grid max-h-48 grid-cols-1 gap-1 overflow-y-auto rounded-lg border border-line p-2 sm:grid-cols-2">
              {shownProducts.map((p) => (
                <label key={p.id} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 hover:bg-cream-dim">
                  <input type="checkbox" checked={d.productIds.includes(p.id)} onChange={() => set({ productIds: toggle(d.productIds, p.id) })} />
                  <span className="truncate">{localizedName(p.name, p.nameAr, lang)}</span>
                  <span className="ms-auto shrink-0 text-xs text-ink-faint">{formatPrice(p.price)}</span>
                </label>
              ))}
            </div>
          </div>
        )}
        {d.scope === "categories" && (
          <div>
            <p className="mb-1.5 font-semibold text-ink">{t("admin.promotions.categories")}</p>
            <p className="mb-1.5 text-xs text-ink-faint">{t("admin.promotions.categoriesHint")}</p>
            <div className="flex flex-wrap gap-1.5">
              {categories.map((c) => (
                <button key={c.id} type="button" onClick={() => set({ categoryIds: toggle(d.categoryIds, c.id) })} className={chip(d.categoryIds.includes(c.id))}>
                  {localizedName(c.name, c.nameAr, lang)}
                </button>
              ))}
            </div>
          </div>
        )}

        <div>
          <p className="mb-1.5 font-semibold text-ink">{t("pos.branch.branch")}</p>
          <div className="flex flex-wrap gap-1.5">
            <button type="button" onClick={() => set({ branchIds: [] })} className={chip(d.branchIds.length === 0)}>
              {t("admin.posSales.allBranches")}
            </button>
            {branches.map((b) => (
              <button key={b.id} type="button" onClick={() => set({ branchIds: toggle(d.branchIds, b.id) })} className={chip(d.branchIds.includes(b.id))}>
                {b.code} · {localizedName(b.name, b.nameAr, lang)}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t("admin.promotions.startsAt")} hint={t("admin.promotions.startsAtHint")}>
            <AdminInput type="datetime-local" value={d.startsAt} onChange={(e) => set({ startsAt: e.target.value })} />
          </Field>
          <Field label={t("admin.promotions.endsAt")} hint={t("admin.promotions.endsAtHint")}>
            <AdminInput type="datetime-local" value={d.endsAt} onChange={(e) => set({ endsAt: e.target.value })} />
          </Field>
        </div>

        {shortRun && errors.length === 0 && (
          <p className="rounded-lg bg-sand px-3 py-2 text-xs font-semibold text-wine-dark">
            {t("admin.promotions.shortWarning").replace("{time}", runMs! < 3600e3 ? `${Math.max(1, Math.round(runMs! / 60000))} min` : `${Math.round(runMs! / 3600e3)} h`)}
          </p>
        )}
        {errors.length > 0 && (
          <ul className="rounded-lg bg-wine-light px-3 py-2 text-xs font-semibold text-wine">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
        <div className="flex justify-end gap-2">
          <AdminButton variant="ghost" onClick={onClose}>
            {t("admin.common.cancel")}
          </AdminButton>
          <AdminButton variant="primary" loading={saving} disabled={errors.length > 0} onClick={() => void save()}>
            {t("admin.settings.save")}
          </AdminButton>
        </div>
      </div>
    </Modal>
  );
}
