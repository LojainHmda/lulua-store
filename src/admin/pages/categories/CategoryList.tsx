import { collection, doc, getCountFromServer, query, serverTimestamp, setDoc, where, writeBatch } from "firebase/firestore";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { db } from "../../../firebase/config";
import { categoriesApi, productsApi } from "../../../firebase/collections";
import { useLanguage } from "../../../context/LanguageContext";
import { childrenOf, effectiveParent, flattenTree, isCategoryActive, pathTo, subtree } from "../../../data/categoryTree";
import { localizedName } from "../../../data/localize";
import { useAdminAuth } from "../../AdminAuthContext";
import AdminIcon from "../../components/AdminIcons";
import MediaPicker from "../../components/MediaPicker";
import { Modal } from "../../components/Modal";
import { useToast } from "../../components/ToastContext";
import { AdminButton, AdminInput, AdminSelect, AdminTextarea, Badge, EmptyState, Field, PageHeader, PageLoading, Toggle } from "../../components/ui";
import { CATEGORY_ICON_KEYS, resolveCategoryIcon } from "../../../components/ui/CategoryIcons";
import { resolveImageSrc } from "../../imageSrc";
import { logActivity } from "../../logActivity";
import { seedStarterCategories } from "../../seedCatalog";
import { importStoreCategories } from "../../storeCategoryPreset";
import type { AdminCategory } from "../../types";

function slugify(input: string): string {
  return input.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

// Arabic-only names have no Latin slug to derive; products only need it to
// be unique and stable, so a short random one is fine.
function fallbackSlug(): string {
  return `cat-${Math.random().toString(36).slice(2, 8)}`;
}

// Same folding as the POS category search, so admins find what cashiers do.
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[ً-ْـ]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .trim();
}

type FormState = Omit<AdminCategory, "id" | "order" | "createdAt" | "updatedAt">;

const BLANK: FormState = {
  slug: "",
  name: "",
  nameAr: "",
  tagline: "",
  taglineAr: "",
  imageId: "",
  imageUrl: "",
  icon: "tag",
  parentId: null,
  isActive: true,
};

// Rewrites `order` as 0..n in tree (depth-first) order for `next`, so the
// flat sort the storefront uses always matches the tree. `stored` is what
// Firestore currently holds; only docs whose order differs are written.
async function commitOrder(next: AdminCategory[], stored: AdminCategory[]) {
  const prev = new Map(stored.map((c) => [c.id, c.order]));
  const batch = writeBatch(db);
  let writes = 0;
  flattenTree(next).forEach(({ cat }, i) => {
    if (prev.get(cat.id) !== i) {
      batch.update(doc(db, "categories", cat.id), { order: i });
      writes++;
    }
  });
  if (writes) await batch.commit();
}

export default function CategoryList() {
  const toast = useToast();
  const { t, lang } = useLanguage();
  const { profile, hasRole } = useAdminAuth();
  const canWrite = hasRole(["owner", "admin", "editor"]);
  const [categories, setCategories] = useState<AdminCategory[]>([]);
  const [productCounts, setProductCounts] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<AdminCategory | null>(null);
  const [form, setForm] = useState<FormState>(BLANK);
  const [showForm, setShowForm] = useState(false);
  const [slugTouched, setSlugTouched] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [deleting, setDeleting] = useState<AdminCategory | null>(null);
  const [deleteProductCount, setDeleteProductCount] = useState<number | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState<"store" | "starter" | null>(null);
  const dragId = useRef<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);

  useEffect(() => {
    const unsub = categoriesApi.subscribe((data) => {
      setCategories(data);
      setLoading(false);
    });
    return unsub;
  }, []);

  // Per-category product counts (every status — an archived product still
  // belongs to its category, so it still blocks deletion).
  useEffect(() => {
    return productsApi.subscribe((products) => {
      const m = new Map<string, number>();
      for (const p of products) m.set(p.category, (m.get(p.category) ?? 0) + 1);
      setProductCounts(m);
    });
  }, []);

  const rows = useMemo(() => flattenTree(categories), [categories]);
  const name = (c: Pick<AdminCategory, "name" | "nameAr">) => localizedName(c.name, c.nameAr, lang) || c.nameAr || c.name;
  const otherName = (c: AdminCategory) => (lang === "ar" ? c.name : c.nameAr) ?? "";

  // While searching: the matches plus their ancestors, so each hit is shown
  // in context.
  const visibleRows = useMemo(() => {
    const q = norm(search);
    if (!q) return rows;
    const keep = new Set<string>();
    for (const { cat } of rows) {
      if (norm(cat.name).includes(q) || norm(cat.nameAr ?? "").includes(q) || cat.slug.includes(q)) {
        for (const c of pathTo(categories, cat.id)) keep.add(c.id);
      }
    }
    return rows.filter(({ cat }) => keep.has(cat.id));
  }, [rows, search, categories]);

  const productTotal = (c: AdminCategory) => subtree(categories, c.id).reduce((n, x) => n + (productCounts.get(x.slug) ?? 0), 0);

  function openCreate(parentId: string | null = null) {
    setEditing(null);
    setForm({ ...BLANK, parentId });
    setSlugTouched(false);
    setShowForm(true);
  }

  function openEdit(cat: AdminCategory) {
    setEditing(cat);
    setForm({
      slug: cat.slug,
      name: cat.name ?? "",
      nameAr: cat.nameAr ?? "",
      tagline: cat.tagline ?? "",
      taglineAr: cat.taglineAr ?? "",
      imageId: cat.imageId ?? "",
      imageUrl: cat.imageUrl ?? "",
      icon: cat.icon || "tag",
      parentId: effectiveParent(categories, cat),
      isActive: isCategoryActive(cat),
    });
    setSlugTouched(true);
    setShowForm(true);
  }

  // Can't make a category its own ancestor.
  const parentOptions = useMemo(() => {
    const banned = editing ? new Set(subtree(categories, editing.id).map((c) => c.id)) : new Set<string>();
    return rows.filter(({ cat }) => !banned.has(cat.id));
  }, [rows, editing, categories]);

  async function handleSave() {
    const nameAr = (form.nameAr ?? "").trim();
    const nameEn = form.name.trim();
    if (!nameAr && !nameEn) {
      toast.error(t("admin.categories.errName"));
      return;
    }
    const slug = editing ? editing.slug : slugify(form.slug) || slugify(nameEn) || fallbackSlug();
    if (!editing && categories.some((c) => c.slug === slug)) {
      toast.error(t("admin.categories.errSlugTaken"));
      return;
    }
    const data: FormState = {
      ...form,
      slug,
      // `name` is what every English/fallback surface shows — never blank.
      name: nameEn || nameAr,
      nameAr,
      tagline: form.tagline.trim(),
      taglineAr: (form.taglineAr ?? "").trim(),
      parentId: form.parentId || null,
      isActive: form.isActive !== false,
    };
    setSaving(true);
    try {
      // New, or moved to another parent: goes to the end of its new siblings.
      const siblings = childrenOf(categories, data.parentId ?? null).filter((c) => c.id !== editing?.id);
      const moved = !editing || (effectiveParent(categories, editing) ?? null) !== data.parentId;
      const endOrder = siblings.reduce((m, c) => Math.max(m, c.order ?? 0), -1) + 1;

      if (editing) {
        const order = moved ? endOrder : editing.order;
        await categoriesApi.update(editing.id, { ...data, order });
        if (moved) {
          const stored = categories.map((c) => (c.id === editing.id ? { ...c, ...data, order } : c));
          await commitOrder(stored, stored);
        }
        if (profile) await logActivity(profile, "category.updated", data.name);
        toast.success(t("admin.categories.saved"));
      } else {
        // While the collection is empty the storefront shows its built-in
        // categories; write them first so this one doesn't replace them all.
        if (categories.length === 0) await seedStarterCategories();
        const ref = doc(collection(db, "categories"));
        const created: AdminCategory = { ...data, id: ref.id, order: endOrder };
        const { id: _id, ...fields } = created;
        void _id;
        await setDoc(ref, { ...fields, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
        await commitOrder([...categories, created], [...categories, created]);
        if (profile) await logActivity(profile, "category.created", data.name);
        toast.success(t("admin.categories.created"));
      }
      setShowForm(false);
    } catch {
      toast.error(t("admin.categories.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function handleImport(kind: "store" | "starter") {
    setImporting(kind);
    try {
      const count = kind === "store" ? await importStoreCategories(categories) : await seedStarterCategories();
      if (count === 0) {
        toast.success(t("admin.categories.importStoreNone"));
      } else {
        if (profile) await logActivity(profile, "category.created", `${count} ${kind} categories`);
        toast.success(t(kind === "store" ? "admin.categories.importedStore" : "admin.categories.importedStarter").replace("{count}", String(count)));
      }
    } catch {
      toast.error(t("admin.categories.saveFailed"));
    } finally {
      setImporting(null);
    }
  }

  async function setActive(cat: AdminCategory, active: boolean) {
    try {
      await categoriesApi.update(cat.id, { isActive: active });
      if (profile) await logActivity(profile, "category.updated", `${cat.name} → ${active ? "active" : "inactive"}`);
      toast.success(t(active ? "admin.categories.activated" : "admin.categories.deactivated"));
    } catch {
      toast.error(t("admin.categories.saveFailed"));
    }
  }

  async function openDelete(cat: AdminCategory) {
    setDeleting(cat);
    setDeleteProductCount(null);
    // Server count, not the live tally above: that one only sees what this
    // admin's listener has loaded, the server sees everything.
    const snap = await getCountFromServer(query(collection(db, "products"), where("category", "==", cat.slug)));
    setDeleteProductCount(snap.data().count);
  }

  async function handleDelete() {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      await categoriesApi.remove(deleting.id);
      if (profile) await logActivity(profile, "category.deleted", deleting.name);
      toast.success(t("admin.categories.deleted"));
      setDeleting(null);
    } catch {
      toast.error(t("admin.categories.saveFailed"));
    } finally {
      setDeleteBusy(false);
    }
  }

  // Moves a category within its own siblings (never across parents — that's
  // what the "Parent category" field is for).
  async function moveWithinSiblings(id: string, toIndex: number) {
    const cat = categories.find((c) => c.id === id);
    if (!cat) return;
    const siblings = childrenOf(categories, effectiveParent(categories, cat));
    const ids = siblings.map((c) => c.id).filter((x) => x !== id);
    ids.splice(Math.max(0, Math.min(toIndex, ids.length)), 0, id);
    const slots = siblings.map((c) => c.order ?? 0).sort((a, b) => a - b);
    // Duplicate legacy orders would make the swap a no-op: spread them out.
    const distinct = slots.map((o, i) => (i > 0 && o <= slots[i - 1] ? slots[i - 1] + 0.001 * i : o));
    const next = categories.map((c) => {
      const i = ids.indexOf(c.id);
      return i === -1 ? c : { ...c, order: distinct[i] };
    });
    setCategories(next);
    try {
      await commitOrder(next, categories);
    } catch {
      toast.error(t("admin.categories.saveFailed"));
    }
  }

  function onDrop(targetId: string) {
    const sourceId = dragId.current;
    dragId.current = null;
    setDragOver(null);
    if (!sourceId || sourceId === targetId) return;
    const source = categories.find((c) => c.id === sourceId);
    const target = categories.find((c) => c.id === targetId);
    if (!source || !target || effectiveParent(categories, source) !== effectiveParent(categories, target)) return;
    const siblings = childrenOf(categories, effectiveParent(categories, target));
    void moveWithinSiblings(sourceId, siblings.findIndex((c) => c.id === targetId));
  }

  if (loading) return <PageLoading />;

  const deletingChildren = deleting ? childrenOf(categories, deleting.id).length : 0;

  return (
    <div>
      <PageHeader
        title={t("admin.nav.categories")}
        description={`${t("admin.categories.totalCount").replace("{count}", String(categories.length))} · ${t("admin.categories.reorderHint")}`}
        actions={
          canWrite && (
            <>
              <AdminButton variant="secondary" icon="download" loading={importing === "store"} onClick={() => void handleImport("store")}>
                {t("admin.categories.importStore")}
              </AdminButton>
              <AdminButton variant="primary" icon="plus" onClick={() => openCreate()}>
                {t("admin.categories.addCategory")}
              </AdminButton>
            </>
          )
        }
      />

      {categories.length === 0 ? (
        <EmptyState
          icon="layers"
          title={t("admin.categories.noneYet")}
          body={t("admin.categories.emptyBodyStarter")}
          action={
            canWrite && (
              <div className="flex flex-wrap justify-center gap-2">
                <AdminButton variant="primary" icon="download" loading={importing === "store"} onClick={() => void handleImport("store")}>
                  {t("admin.categories.importStore")}
                </AdminButton>
                <AdminButton variant="secondary" icon="upload" loading={importing === "starter"} onClick={() => void handleImport("starter")}>
                  {t("admin.categories.importStarter")}
                </AdminButton>
                <AdminButton variant="ghost" icon="plus" onClick={() => openCreate()}>
                  {t("admin.categories.addCategory")}
                </AdminButton>
              </div>
            )
          }
        />
      ) : (
        <>
          <div className="relative mb-4 max-w-md">
            <AdminIcon name="search" className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("admin.categories.searchPlaceholder")}
              className="w-full rounded-lg border border-line bg-paper py-2.5 pe-3 ps-9 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-wine"
            />
          </div>

          {visibleRows.length === 0 ? (
            <p className="rounded-xl border border-dashed border-line py-12 text-center text-sm text-ink-faint">{t("admin.categories.noMatches")}</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {visibleRows.map(({ cat, depth }) => {
                const Icon = resolveCategoryIcon(cat.icon);
                const active = isCategoryActive(cat);
                const kids = childrenOf(categories, cat.id).length;
                const siblings = childrenOf(categories, effectiveParent(categories, cat));
                const index = siblings.findIndex((c) => c.id === cat.id);
                const count = productTotal(cat);
                const other = otherName(cat);
                return (
                  <li
                    key={cat.id}
                    draggable={canWrite && !search}
                    onDragStart={() => (dragId.current = cat.id)}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragOver(cat.id);
                    }}
                    onDragLeave={() => setDragOver((v) => (v === cat.id ? null : v))}
                    onDrop={() => onDrop(cat.id)}
                    style={{ marginInlineStart: `${Math.min(depth, 4) * 1.75}rem` }}
                    className={`flex items-center gap-3 rounded-xl border bg-paper px-3 py-2.5 shadow-soft transition-colors ${
                      dragOver === cat.id ? "border-wine" : "border-line"
                    } ${depth === 0 && kids > 0 ? "mt-2 first:mt-0" : ""}`}
                  >
                    {canWrite && !search && <AdminIcon name="drag" className="hidden h-4 w-4 shrink-0 cursor-grab text-ink-faint sm:block" />}
                    <div
                      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${
                        active ? (depth === 0 ? "bg-wine text-on-accent" : "bg-wine-light text-wine") : "bg-cream-dim text-ink-faint"
                      }`}
                    >
                      <Icon className="h-6 w-6" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <p className={`truncate font-semibold ${active ? "text-ink" : "text-ink-faint line-through decoration-1"}`}>{name(cat)}</p>
                        {!active && <Badge tone="neutral">{t("admin.categories.inactive")}</Badge>}
                      </div>
                      <p className="truncate text-xs text-ink-faint">
                        {other && other !== name(cat) && <>{other} · </>}
                        <span className="font-mono">{cat.slug}</span>
                        {" · "}
                        {t("admin.categories.productsCount").replace("{count}", String(count))}
                        {kids > 0 && <> · {t("admin.categories.subCount").replace("{count}", String(kids))}</>}
                      </p>
                    </div>
                    {canWrite && (
                      <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
                        <span className="me-1 hidden sm:inline-flex" title={active ? t("admin.categories.active") : t("admin.categories.inactive")}>
                          <Toggle checked={active} onChange={(v) => void setActive(cat, v)} label={t("admin.categories.status")} />
                        </span>
                        {!search && (
                          <>
                            <button
                              onClick={() => void moveWithinSiblings(cat.id, index - 1)}
                              disabled={index <= 0}
                              aria-label={t("admin.categories.moveUp")}
                              title={t("admin.categories.moveUp")}
                              className="flex h-9 w-9 items-center justify-center rounded-lg text-ink-soft hover:bg-cream-dim hover:text-ink disabled:opacity-30"
                            >
                              <AdminIcon name="arrowUp" className="h-4 w-4" />
                            </button>
                            <button
                              onClick={() => void moveWithinSiblings(cat.id, index + 1)}
                              disabled={index >= siblings.length - 1}
                              aria-label={t("admin.categories.moveDown")}
                              title={t("admin.categories.moveDown")}
                              className="flex h-9 w-9 items-center justify-center rounded-lg text-ink-soft hover:bg-cream-dim hover:text-ink disabled:opacity-30"
                            >
                              <AdminIcon name="arrowDown" className="h-4 w-4" />
                            </button>
                          </>
                        )}
                        <button
                          onClick={() => openEdit(cat)}
                          aria-label={t("admin.categories.editCategory")}
                          title={t("admin.categories.editCategory")}
                          className="flex h-9 w-9 items-center justify-center rounded-lg text-ink-soft hover:bg-cream-dim hover:text-ink"
                        >
                          <AdminIcon name="edit" className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => void openDelete(cat)}
                          aria-label={t("admin.categories.deleteCategory")}
                          title={t("admin.categories.deleteCategory")}
                          className="flex h-9 w-9 items-center justify-center rounded-lg text-ink-soft hover:bg-wine-light hover:text-wine"
                        >
                          <AdminIcon name="trash" className="h-4 w-4" />
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      <Modal open={showForm} onClose={() => setShowForm(false)} title={editing ? t("admin.categories.editCategory") : t("admin.categories.addCategory")} width="lg">
        <div className="flex flex-col gap-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("admin.categories.nameAr")} required>
              <AdminInput dir="rtl" autoFocus value={form.nameAr ?? ""} onChange={(e) => setForm((f) => ({ ...f, nameAr: e.target.value }))} />
            </Field>
            <Field label={t("admin.categories.nameEn")}>
              <AdminInput
                dir="ltr"
                value={form.name}
                onChange={(e) => {
                  const v = e.target.value;
                  setForm((f) => ({ ...f, name: v, slug: !editing && !slugTouched ? slugify(v) : f.slug }));
                }}
              />
            </Field>
          </div>

          <Field label={t("admin.categories.icon")}>
            <CategoryIconPicker value={form.icon} onChange={(icon) => setForm((f) => ({ ...f, icon }))} />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("admin.categories.parent")}>
              <AdminSelect value={form.parentId ?? ""} onChange={(e) => setForm((f) => ({ ...f, parentId: e.target.value || null }))}>
                <option value="">{t("admin.categories.noParent")}</option>
                {parentOptions.map(({ cat, depth }) => (
                  <option key={cat.id} value={cat.id}>
                    {"   ".repeat(depth)}
                    {depth > 0 ? "└ " : ""}
                    {name(cat)}
                  </option>
                ))}
              </AdminSelect>
            </Field>
            <Field label={t("admin.categories.status")} hint={form.isActive === false ? t("admin.categories.inactiveHint") : undefined}>
              <div className="flex h-[2.625rem] items-center gap-3">
                <Toggle checked={form.isActive !== false} onChange={(v) => setForm((f) => ({ ...f, isActive: v }))} label={t("admin.categories.status")} />
                <span className={`text-sm font-semibold ${form.isActive !== false ? "text-olive" : "text-ink-faint"}`}>
                  {form.isActive !== false ? t("admin.categories.active") : t("admin.categories.inactive")}
                </span>
              </div>
            </Field>
          </div>

          <Field label={t("admin.categories.descriptionAr")}>
            <AdminTextarea dir="rtl" rows={2} value={form.taglineAr ?? ""} onChange={(e) => setForm((f) => ({ ...f, taglineAr: e.target.value }))} />
          </Field>

          <details className="group rounded-xl border border-line">
            <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-semibold text-ink-soft hover:text-ink">
              {t("admin.categories.moreOptions")}
              <AdminIcon name="chevronDown" className="h-4 w-4 transition-transform group-open:rotate-180" />
            </summary>
            <div className="flex flex-col gap-4 border-t border-line px-4 py-4">
              <Field label={t("admin.categories.slug")} hint={editing ? t("admin.categories.slugLocked") : undefined}>
                <AdminInput
                  dir="ltr"
                  disabled={!!editing}
                  value={form.slug}
                  placeholder="auto"
                  onChange={(e) => {
                    setSlugTouched(true);
                    setForm((f) => ({ ...f, slug: slugify(e.target.value) }));
                  }}
                />
              </Field>
              <Field label={t("admin.categories.description")}>
                <AdminInput dir="ltr" value={form.tagline} onChange={(e) => setForm((f) => ({ ...f, tagline: e.target.value }))} />
              </Field>
              <Field label={t("admin.categories.image")}>
                <div className="flex items-center gap-3">
                  <div className="h-14 w-24 shrink-0 overflow-hidden rounded-lg bg-cream-dim">
                    {resolveImageSrc(form) ? (
                      <img src={resolveImageSrc(form, 300)} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <div className="flex h-full items-center justify-center text-ink-faint">
                        <AdminIcon name="image" className="h-5 w-5" />
                      </div>
                    )}
                  </div>
                  <AdminButton variant="secondary" size="sm" onClick={() => setPickerOpen(true)}>
                    {resolveImageSrc(form) ? t("admin.categories.changeImage") : t("admin.categories.chooseImage")}
                  </AdminButton>
                </div>
              </Field>
            </div>
          </details>

          <div className="flex justify-end gap-2 border-t border-line pt-4">
            <AdminButton variant="ghost" onClick={() => setShowForm(false)}>
              {t("admin.common.cancel")}
            </AdminButton>
            <AdminButton variant="primary" icon="check" loading={saving} onClick={() => void handleSave()}>
              {t("admin.categories.createCategory")}
            </AdminButton>
          </div>
        </div>
      </Modal>

      <MediaPicker open={pickerOpen} onClose={() => setPickerOpen(false)} onSelect={(asset) => setForm((f) => ({ ...f, imageUrl: asset.url, imageId: "" }))} />

      {/* Delete: only ever offered when nothing depends on the category.
          Products or subcategories still in it get a clear way out instead. */}
      <Modal
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={
          deleting && (deletingChildren > 0 || (deleteProductCount ?? 0) > 0)
            ? t("admin.categories.cannotDeleteTitle")
            : t("admin.categories.deleteCategory")
        }
        width="sm"
      >
        {deleting && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-3 rounded-xl bg-cream-dim p-3">
              {(() => {
                const Icon = resolveCategoryIcon(deleting.icon);
                return <Icon className="h-6 w-6 shrink-0 text-wine" />;
              })()}
              <p className="font-semibold text-ink">{name(deleting)}</p>
            </div>
            {deleteProductCount === null ? (
              <p className="text-sm text-ink-soft">{t("admin.categories.checkingProducts")}</p>
            ) : deletingChildren > 0 ? (
              <p className="flex gap-2 rounded-lg bg-sand/60 p-3 text-sm font-semibold text-wine-dark">
                <AdminIcon name="alertTriangle" className="mt-0.5 h-4 w-4 shrink-0" />
                {t("admin.categories.cannotDeleteChildren")}
              </p>
            ) : deleteProductCount > 0 ? (
              <div className="flex gap-2 rounded-lg bg-sand/60 p-3 text-sm text-wine-dark">
                <AdminIcon name="alertTriangle" className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <p className="font-semibold">{t("admin.categories.cannotDeleteProducts").replace("{count}", String(deleteProductCount))}</p>
                  <p>{t("admin.categories.cannotDeleteProductsAction")}</p>
                </div>
              </div>
            ) : (
              <p className="text-sm text-ink-soft">
                "{name(deleting)}" {t("admin.categories.deleteBodyEmpty")}
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <AdminButton variant="ghost" onClick={() => setDeleting(null)}>
                {t("admin.common.cancel")}
              </AdminButton>
              {deleteProductCount !== null && (deletingChildren > 0 || deleteProductCount > 0) ? (
                <>
                  {isCategoryActive(deleting) && (
                    <AdminButton
                      variant="secondary"
                      icon="eyeOff"
                      onClick={() => {
                        void setActive(deleting, false);
                        setDeleting(null);
                      }}
                    >
                      {t("admin.categories.deactivateInstead")}
                    </AdminButton>
                  )}
                  {deleteProductCount > 0 && (
                    <Link
                      to={`/admin/products?category=${encodeURIComponent(deleting.slug)}`}
                      className="inline-flex items-center gap-2 rounded-lg bg-wine px-4 py-2.5 text-sm font-semibold text-on-accent hover:bg-wine-dark"
                    >
                      <AdminIcon name="box" className="h-4 w-4" />
                      {t("admin.categories.viewProducts")}
                    </Link>
                  )}
                </>
              ) : (
                <AdminButton variant="danger" icon="trash" loading={deleteBusy} disabled={deleteProductCount === null} onClick={() => void handleDelete()}>
                  {t("admin.products.delete")}
                </AdminButton>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

// A visual grid picker rather than a <select> — icons are shapes, not
// words, so seeing them is how an admin actually chooses one.
function CategoryIconPicker({ value, onChange }: { value?: string; onChange: (icon: string) => void }) {
  const { t } = useLanguage();
  const label = (key: string) => t(`admin.categories.icons.${key}`);
  const current = value && (CATEGORY_ICON_KEYS as string[]).includes(value) ? value : "tag";
  return (
    <div>
      <div role="radiogroup" className="grid grid-cols-6 gap-1.5 sm:grid-cols-9">
        {CATEGORY_ICON_KEYS.map((key) => {
          const Icon = resolveCategoryIcon(key);
          const selected = current === key;
          return (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={selected}
              title={label(key)}
              aria-label={label(key)}
              onClick={() => onChange(key)}
              className={`flex aspect-square items-center justify-center rounded-xl border transition-colors ${
                selected ? "border-wine bg-wine text-on-accent shadow-soft" : "border-line bg-paper text-ink-soft hover:border-wine/40 hover:bg-wine-light hover:text-wine"
              }`}
            >
              <Icon className="h-6 w-6" />
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-ink-faint">
        {t("admin.categories.iconSelected")}: <span className="font-semibold text-ink">{label(current)}</span>
      </p>
    </div>
  );
}
