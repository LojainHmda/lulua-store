import { collection, deleteField, doc, getDocs, limit, onSnapshot, query, runTransaction, serverTimestamp, where } from "firebase/firestore";
import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { db } from "../../../firebase/config";
import { branchesApi, categoriesApi, productsApi } from "../../../firebase/collections";
import { branchStockId, subscribeProductBranchStock } from "../../../firebase/branchStock";
import { uploadMediaFile } from "../../../firebase/storageUpload";
import { useLanguage } from "../../../context/LanguageContext";
import { flattenTree } from "../../../data/categoryTree";
import { localizedName } from "../../../data/localize";
import { SWATCHES } from "../../../data/palette";
import { AR_COLORS } from "../../../i18n/arData";
import { formatPrice } from "../../../utils/currency";
import { CameraScannerModal } from "../../../pos/CameraScannerModal";
import { ProductCodeActions } from "../../../components/admin/ProductCodeActions";
import { useAdminAuth } from "../../AdminAuthContext";
import AdminIcon from "../../components/AdminIcons";
import MediaPicker from "../../components/MediaPicker";
import ProductVideoPicker from "../../components/ProductVideoPicker";
import { AdminButton, AdminInput, AdminLinkButton, AdminNumberInput, AdminSelect, AdminTextarea, Card, Field, PageHeader, PageLoading, Toggle } from "../../components/ui";
import { useToast } from "../../components/ToastContext";
import { ONLINE_LOCATION } from "../../locationStock";
import { logActivity } from "../../logActivity";
import { notifyLowStock } from "../../lowStockNotify";
import { APPAREL_SIZES, joinProductFields, newVariantId, normalizeProduct, SHOE_SIZES, SIZE_OPTIONS, sortSizes, splitProductFields, stockCellKey, unionSizes } from "../../productVariants";
import { seedStarterCategories, starterCategories } from "../../seedCatalog";
import { slugify } from "../../slugify";
import { computeStockDeltas } from "../../stockMovements";
import type { AdminCategory, AdminColorVariant, AdminProduct, Branch, BranchStockDoc } from "../../types";
import NewCategoryModal from "./NewCategoryModal";
import StockTable from "../../components/StockTable";

// The admin product page, for both adding (/admin/products/new) and editing
// (/admin/products/:id): one compact screen -- product info on top, then a
// full-width stock table per color (size rows x one column per location),
// so it stays usable however many branches there are. Every location keeps
// its own count: the website's stock lives on the product document
// (stockByCell), each branch's in its branchStock document, and every change
// writes stockMovements ledger rows, all in one transaction.

const ALL_TAGS: NonNullable<AdminProduct["tags"]>[number][] = ["new", "bestseller", "sale", "limited"];

type ColorDraft = Omit<AdminColorVariant, "sizeStock">;

interface Draft {
  name: string;
  nameAr: string;
  sku: string;
  slug: string;
  category: string;
  description: string;
  descriptionAr: string;
  originalPrice: number | null;
  discountPrice: number | null;
  sizes: string[];
  colors: ColorDraft[];
  images: string[];
  videoUrl: string;
  status: AdminProduct["status"];
  tags: NonNullable<AdminProduct["tags"]>;
  details: string[];
}

// A typed-in quantity, with the count that location held when the admin
// first touched it (undefined = the cell didn't exist yet). Saving refuses
// to overwrite a cell whose stored count moved since -- e.g. a POS sale.
interface StockEdit {
  qty: number | null;
  expected: number | null | undefined;
}
// cellKey ("<variantId>::<size>") -> locationId -> edit
type StockEdits = Record<string, Record<string, StockEdit>>;

type ErrorKey = "name" | "nameAr" | "category" | "originalPrice" | "discountPrice" | "colors";

const FIELD_IDS: Record<Exclude<ErrorKey, "colors">, string> = {
  name: "pe-name",
  nameAr: "pe-name-ar",
  category: "pe-category",
  originalPrice: "pe-original-price",
  discountPrice: "pe-discount-price",
};

function emptyColor(existingIds: string[] = [], order = 0): ColorDraft {
  return { id: newVariantId("color", existingIds), colorName: "", colorHex: "#1c1a17", order };
}

const BLANK: Draft = {
  name: "",
  nameAr: "",
  sku: "",
  slug: "",
  category: "",
  description: "",
  descriptionAr: "",
  originalPrice: null,
  discountPrice: null,
  sizes: [],
  colors: [],
  images: [],
  videoUrl: "",
  status: "draft",
  tags: [],
  details: [],
};

// Category, sizes and visibility carry over to the next new product (and the
// next visit) -- consecutive products are usually from the same batch.
const STICKY_KEY = "admin.productQuickAdd.sticky";
type Sticky = Pick<Draft, "category" | "sizes" | "status">;

function readSticky(): Partial<Sticky> {
  try {
    const raw = window.localStorage.getItem(STICKY_KEY);
    return raw ? (JSON.parse(raw) as Partial<Sticky>) : {};
  } catch {
    return {};
  }
}

function writeSticky(s: Sticky) {
  try {
    window.localStorage.setItem(STICKY_KEY, JSON.stringify(s));
  } catch {
    // Storage unavailable -- defaults just won't carry over.
  }
}

function newProductDraft(): Draft {
  const sticky = readSticky();
  return { ...BLANK, sizes: sortSizes(sticky.sizes ?? []), status: sticky.status === "active" ? "active" : "draft", colors: [emptyColor()] };
}

// price is the selling price and compareAtPrice the crossed-out one; the
// form shows them as "original" and "discounted".
function draftFromProduct(p: AdminProduct): Draft {
  const discounted = p.compareAtPrice !== undefined && p.compareAtPrice > p.price;
  return {
    name: p.name ?? "",
    nameAr: p.nameAr ?? "",
    sku: p.sku ?? "",
    slug: p.slug ?? "",
    category: p.category ?? "",
    description: p.description ?? "",
    descriptionAr: p.descriptionAr ?? "",
    originalPrice: discounted ? p.compareAtPrice! : p.price,
    discountPrice: discounted ? p.price : null,
    sizes: p.sizes?.length ? p.sizes : unionSizes(p.colorVariants),
    colors: p.colorVariants.map(({ sizeStock: _s, ...meta }, i) => ({ ...meta, order: meta.order ?? i })),
    images: p.images ?? [],
    videoUrl: p.videoUrl ?? "",
    status: p.status,
    tags: p.tags ?? [],
    details: p.details ?? [],
  };
}

class StockConflictError extends Error {}

export default function ProductEditorRoute() {
  const { id } = useParams();
  // Keyed so going from /new to the saved product's page starts fresh.
  return <ProductEditor key={id ?? "new"} id={id} />;
}

function ProductEditor({ id }: { id?: string }) {
  const isNew = !id;
  const navigate = useNavigate();
  const toast = useToast();
  const { t, lang } = useLanguage();
  const { profile, hasRole } = useAdminAuth();
  const canWrite = hasRole(["owner", "admin", "editor"]);

  const formRef = useRef<HTMLFieldSetElement>(null);
  const savingRef = useRef(false);
  const [loading, setLoading] = useState(!isNew);
  const [missing, setMissing] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => (isNew ? newProductDraft() : BLANK));
  const [edits, setEdits] = useState<StockEdits>({});
  // Live stored counts (edit page only): website cells from the product doc,
  // and each branch's stockByCell.
  const [onlineBase, setOnlineBase] = useState<Record<string, number | null>>({});
  const [branchBase, setBranchBase] = useState<Map<string, BranchStockDoc["stockByCell"]>>(new Map());
  const [categories, setCategories] = useState<AdminCategory[]>([]);
  const [usingStarterCategories, setUsingStarterCategories] = useState(false);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [errors, setErrors] = useState<Partial<Record<ErrorKey, string>>>({});
  const [saving, setSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<{ id: string; name: string } | null>(null);
  const [skuOwner, setSkuOwner] = useState<{ id: string; name: string } | null>(null);
  const [uploading, setUploading] = useState<string | null>(null); // "video" or a color id
  const [imagePickerColor, setImagePickerColor] = useState<string | null>(null);
  const [videoLibraryOpen, setVideoLibraryOpen] = useState(false);
  const [imagesLibraryOpen, setImagesLibraryOpen] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [newCatOpen, setNewCatOpen] = useState(false);

  useEffect(() => {
    const unsubCategories = categoriesApi.subscribe((fetched) => {
      const starter = fetched.length === 0;
      const cats = starter ? starterCategories() : [...fetched].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      setUsingStarterCategories(starter);
      setCategories(cats);
      if (!isNew) return;
      const sticky = readSticky().category;
      setDraft((d) => (d.category ? d : { ...d, category: sticky && cats.some((c) => c.slug === sticky) ? sticky : cats[0]?.slug ?? "" }));
    });
    // Live, so a branch added (or re-activated) while this page is open gets
    // its stock column without a reload.
    const unsubBranches = branchesApi.subscribe((all) => setBranches(all.sort((a, b) => a.name.localeCompare(b.name))));
    return () => {
      unsubCategories();
      unsubBranches();
    };
  }, [isNew]);

  useEffect(() => {
    if (!id) return;
    productsApi.get(id).then((p) => {
      if (p) setDraft(draftFromProduct(normalizeProduct(p)));
      else setMissing(true);
      setLoading(false);
    });
    const unsubProduct = onSnapshot(doc(db, "products", id), (snap) => {
      const next: Record<string, number | null> = {};
      if (snap.exists()) for (const v of joinProductFields(snap.data())) for (const s of v.sizeStock) next[stockCellKey(v.id, s.size)] = s.qty;
      setOnlineBase(next);
    });
    const unsubBranches = subscribeProductBranchStock(id, (docs) => setBranchBase(new Map(docs.map((d) => [d.branchId, d.stockByCell ?? {}]))));
    return () => {
      unsubProduct();
      unsubBranches();
    };
  }, [id]);

  // Website first, then every active branch (plus an inactive one that still
  // holds stock of this product).
  const locations = useMemo(
    () => [
      { id: ONLINE_LOCATION, label: t("admin.productForm.quickAdd.online"), title: t("admin.locationStock.online") },
      ...branches
        .filter((b) => b.active || branchBase.has(b.id))
        .map((b) => {
          const name = localizedName(b.name, b.nameAr, lang);
          return { id: b.id, label: name, title: b.code ? `${name} (${b.code})` : name };
        }),
    ],
    [branches, branchBase, lang, t]
  );

  // Stored count for one cell at one location; undefined = no stored cell
  // (always the case on a new product). A branch with no cell holds 0.
  function baseQty(key: string, locationId: string): number | null | undefined {
    if (isNew) return undefined;
    if (locationId === ONLINE_LOCATION) return key in onlineBase ? onlineBase[key] : undefined;
    const q = branchBase.get(locationId)?.[key]?.qty;
    return typeof q === "number" ? q : 0;
  }

  function shownQty(key: string, locationId: string): number | null {
    const e = edits[key]?.[locationId];
    if (e) return e.qty;
    return baseQty(key, locationId) ?? null;
  }

  const countOf = (key: string, locationId: string) => {
    const q = shownQty(key, locationId);
    return typeof q === "number" && q > 0 ? Math.round(q) : 0;
  };

  function setQty(key: string, locationId: string, qty: number | null) {
    setEdits((prev) => {
      const current = prev[key]?.[locationId];
      return { ...prev, [key]: { ...prev[key], [locationId]: { qty, expected: current ? current.expected : baseQty(key, locationId) } } };
    });
  }

  // Gives every branch the same count the website has, for each size of one
  // color (or every color when colorId is omitted).
  function copyOnlineToBranches(colorId?: string) {
    for (const c of draft.colors) {
      if (colorId && c.id !== colorId) continue;
      for (const size of draft.sizes) {
        const key = stockCellKey(c.id, size);
        const qty = countOf(key, ONLINE_LOCATION);
        for (const l of locations) if (l.id !== ONLINE_LOCATION) setQty(key, l.id, qty);
      }
    }
  }

  const o = draft.originalPrice;
  const d = draft.discountPrice;
  const discount = o !== null && d !== null && o > 0 && d < o ? { pct: Math.round((1 - d / o) * 100), amount: o - d } : null;

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
    if (errors[key as ErrorKey]) setErrors((e) => ({ ...e, [key]: undefined }));
  }

  function updateColor(colorId: string, patch: Partial<ColorDraft>) {
    setDraft((prev) => ({ ...prev, colors: prev.colors.map((c) => (c.id === colorId ? { ...c, ...patch } : c)) }));
    if (errors.colors) setErrors((e) => ({ ...e, colors: undefined }));
  }

  function addColor() {
    setDraft((prev) => ({
      ...prev,
      colors: [...prev.colors, emptyColor(prev.colors.map((c) => c.id), Math.max(-1, ...prev.colors.map((c) => c.order ?? 0)) + 1)],
    }));
  }

  function removeColor(colorId: string) {
    setDraft((prev) => (prev.colors.length <= 1 ? prev : { ...prev, colors: prev.colors.filter((c) => c.id !== colorId) }));
  }

  function pickSwatch(colorId: string, name: string) {
    const swatch = SWATCHES[name.toLowerCase()];
    if (swatch) updateColor(colorId, { colorName: swatch.name, colorHex: swatch.hex, colorNameAr: AR_COLORS[swatch.name] ?? undefined });
  }

  function toggleSize(size: string) {
    setDraft((prev) => ({ ...prev, sizes: prev.sizes.includes(size) ? prev.sizes.filter((s) => s !== size) : sortSizes([...prev.sizes, size]) }));
  }

  async function persistStarterCategoriesIfNeeded() {
    if (!usingStarterCategories) return;
    await seedStarterCategories();
    setUsingStarterCategories(false);
  }

  async function checkBarcode(value: string) {
    const sku = value.trim();
    if (!sku) return setSkuOwner(null);
    try {
      const snap = await getDocs(query(collection(db, "products"), where("sku", "==", sku), limit(2)));
      const hit = snap.docs.find((x) => x.id !== id);
      setSkuOwner(hit ? { id: hit.id, name: localizedName(String(hit.get("name") ?? ""), hit.get("nameAr") as string | undefined, lang) } : null);
    } catch {
      setSkuOwner(null);
    }
  }

  async function uploadFile(file: File | undefined, kind: "image" | "video", onDone: (url: string) => void, busyKey: string) {
    if (!file || !file.type.startsWith(kind)) return;
    setUploading(busyKey);
    try {
      onDone((await uploadMediaFile(file)).url);
    } catch {
      toast.error(t("admin.media.uploadFailed"));
    } finally {
      setUploading(null);
    }
  }

  function addImage(url: string) {
    setDraft((prev) => ({ ...prev, images: [...prev.images, url] }));
  }

  async function uploadImages(files: File[]) {
    for (const file of files) await uploadFile(file, "image", addImage, "images");
  }

  function validate(): Partial<Record<ErrorKey, string>> {
    const req = t("admin.productForm.quickAdd.errRequired");
    const e: Partial<Record<ErrorKey, string>> = {};
    if (!draft.name.trim()) e.name = req;
    if (!draft.nameAr.trim()) e.nameAr = req;
    if (!draft.category) e.category = req;
    if (draft.originalPrice === null) e.originalPrice = req;
    else if (draft.discountPrice !== null && draft.discountPrice > draft.originalPrice) e.discountPrice = t("admin.productForm.quickAdd.errDiscountHigher");
    if (draft.colors.length > 1 && draft.colors.some((c) => !c.colorName.trim())) e.colors = t("admin.productForm.quickAdd.errColorName");
    return e;
  }

  // Product slugs are what the storefront URL and the default barcode use,
  // so a name that's already taken gets a short random suffix.
  async function uniqueSlug(base: string): Promise<string> {
    let slug = base;
    for (let i = 0; i < 5; i++) {
      const snap = await getDocs(query(collection(db, "products"), where("slug", "==", slug), limit(1)));
      if (snap.empty) return slug;
      slug = `${base}-${Math.random().toString(36).slice(2, 6)}`;
    }
    return slug;
  }

  async function save(after: "stay" | "next" | "open") {
    if (savingRef.current || !canWrite || !profile) return;
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length) {
      const first = (Object.keys(FIELD_IDS) as (keyof typeof FIELD_IDS)[]).find((k) => found[k]);
      if (first) document.getElementById(FIELD_IDS[first])?.focus();
      toast.error(t("admin.productForm.quickAdd.fixErrors"));
      return;
    }

    savingRef.current = true;
    setSaving(true);
    try {
      await persistStarterCategoriesIfNeeded();
      const name = draft.name.trim();
      const original = draft.originalPrice!;
      const hasDiscount = draft.discountPrice !== null && draft.discountPrice < original;
      const sizes = draft.sizes;
      const colors = draft.colors.map((c, i) => ({ ...c, colorName: c.colorName.trim(), colorNameAr: c.colorNameAr?.trim() || undefined, order: i }));
      const slug = isNew ? await uniqueSlug(slugify(name) || "product") : draft.slug.trim() || slugify(name) || id!;
      const productRef = isNew ? doc(collection(db, "products")) : doc(db, "products", id!);
      const editedBranchIds = locations.filter((l) => l.id !== ONLINE_LOCATION && Object.values(edits).some((cell) => cell[l.id])).map((l) => l.id);

      const fields = {
        slug,
        sku: draft.sku.trim(),
        name,
        nameAr: draft.nameAr.trim(),
        category: draft.category,
        price: hasDiscount ? draft.discountPrice! : original,
        sizes,
        tags: draft.tags,
        description: draft.description,
        descriptionAr: draft.descriptionAr.trim(),
        details: draft.details.filter((x) => x.trim()),
        status: draft.status,
      };
      const ledgerBase = {
        productId: productRef.id,
        productName: name,
        reason: isNew ? "initial_stock" : "manual_adjustment",
        source: "admin",
        actorUid: profile.id,
        actorEmail: profile.email,
        actorName: profile.displayName || profile.email,
      };

      let before: AdminColorVariant[] = [];
      let variants: AdminColorVariant[] = [];
      await runTransaction(db, async (tx) => {
        // All reads first: the product and every branch whose counts changed.
        let fresh: AdminColorVariant[] = [];
        if (!isNew) {
          const snap = await tx.get(productRef);
          if (!snap.exists()) throw new Error("This product no longer exists.");
          fresh = normalizeProduct({ id: snap.id, ...snap.data() } as AdminProduct).colorVariants;
        }
        const branchSnaps = isNew ? [] : await Promise.all(editedBranchIds.map((b) => tx.get(doc(db, "branchStock", branchStockId(b, productRef.id)))));

        // Website stock: cells the admin typed into take the new count; every
        // other cell keeps whatever is stored right now, so a sale made while
        // this page was open is never overwritten.
        variants = colors.map((c) => ({
          ...c,
          sizeStock: sizes.map((size) => {
            const stored = fresh.find((v) => v.id === c.id)?.sizeStock.find((s) => s.size === size);
            const e = edits[stockCellKey(c.id, size)]?.[ONLINE_LOCATION];
            if (!e) return stored ?? { size, qty: 0 };
            // Clearing a never-confirmed (unknown) count leaves it unknown; clearing a real one means 0.
            const qty = e.qty === null ? (e.expected === null ? null : 0) : Math.max(0, Math.round(e.qty));
            if (e.expected !== undefined && qty !== e.expected && (stored?.qty ?? null) !== e.expected) throw new StockConflictError();
            return { size, qty };
          }),
        }));
        before = fresh;
        const { colorVariants: flatColorVariants, stockByCell } = splitProductFields(variants);
        if (isNew) {
          tx.set(productRef, {
            ...fields,
            compareAtPrice: hasDiscount ? original : undefined,
            images: draft.images.length ? draft.images : undefined,
            videoUrl: draft.videoUrl || undefined,
            rating: 4.8,
            reviewCount: 0,
            detailsAr: [],
            colorVariants: flatColorVariants,
            stockByCell,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } else {
          tx.update(productRef, {
            ...fields,
            compareAtPrice: hasDiscount ? original : deleteField(),
            images: draft.images,
            videoUrl: draft.videoUrl,
            colorVariants: flatColorVariants,
            stockByCell,
            updatedAt: serverTimestamp(),
          });
        }
        for (const delta of computeStockDeltas(fresh, variants)) {
          tx.set(doc(collection(db, "stockMovements")), {
            ...ledgerBase,
            variantId: delta.variantId,
            colorName: delta.colorName,
            size: delta.size,
            qtyBefore: delta.qtyBefore,
            qtyChange: delta.qtyChange,
            qtyAfter: delta.qtyAfter,
            createdAt: serverTimestamp(),
          });
        }

        // Branch stock: only the cells typed into are written (absent = 0).
        const branchIds = isNew ? locations.filter((l) => l.id !== ONLINE_LOCATION).map((l) => l.id) : editedBranchIds;
        branchIds.forEach((branchId, i) => {
          const snap = branchSnaps[i];
          const current = ((snap?.exists() ? snap.get("stockByCell") : undefined) ?? {}) as BranchStockDoc["stockByCell"];
          const next = { ...current };
          let changed = false;
          for (const c of colors) {
            for (const size of sizes) {
              const key = stockCellKey(c.id, size);
              const e = edits[key]?.[branchId];
              if (!e) continue;
              const qty = Math.max(0, Math.round(e.qty ?? 0));
              const stored = typeof current[key]?.qty === "number" ? (current[key].qty as number) : 0;
              if (qty === stored) continue;
              if (e.expected !== undefined && stored !== e.expected) throw new StockConflictError();
              next[key] = { qty };
              changed = true;
              tx.set(doc(collection(db, "stockMovements")), {
                ...ledgerBase,
                variantId: c.id,
                colorName: c.colorName,
                size,
                qtyBefore: stored,
                qtyChange: qty - stored,
                qtyAfter: qty,
                branchId,
                createdAt: serverTimestamp(),
              });
            }
          }
          if (!changed) return;
          const ref = doc(db, "branchStock", branchStockId(branchId, productRef.id));
          if (snap?.exists()) tx.update(ref, { stockByCell: next, updatedAt: serverTimestamp() });
          else tx.set(ref, { branchId, productId: productRef.id, stockByCell: next, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
        });
      });

      setEdits({});
      if (isNew) {
        await logActivity(profile, "product.created", name);
        writeSticky({ category: draft.category, sizes: draft.sizes, status: draft.status });
        if (after === "next") {
          toast.success(t("admin.productForm.quickAdd.savedNext").replace("{name}", name));
          setLastSaved({ id: productRef.id, name });
          setDraft((prev) => ({ ...newProductDraft(), category: prev.category, sizes: prev.sizes, status: prev.status }));
          setErrors({});
          setSkuOwner(null);
          requestAnimationFrame(() => document.getElementById(FIELD_IDS.name)?.focus());
        } else {
          toast.success(t("admin.productForm.created"));
          navigate(`/admin/products/${productRef.id}`);
        }
      } else {
        await logActivity(profile, "product.updated", name);
        toast.success(t("admin.productForm.saved"));
        setDraft((prev) => ({ ...prev, slug }));
        // Fire-and-forget, after the save has already succeeded.
        void notifyLowStock({ id: productRef.id, name }, before, variants);
      }
    } catch (err) {
      if (err instanceof StockConflictError) {
        // Re-base every typed count on what's stored now, so the next save
        // goes through once the admin has checked the numbers.
        setEdits((prev) =>
          Object.fromEntries(Object.entries(prev).map(([key, cell]) => [key, Object.fromEntries(Object.entries(cell).map(([loc, e]) => [loc, { ...e, expected: baseQty(key, loc) }]))]))
        );
        toast.error(t("admin.productForm.quickAdd.stockConflict"));
      } else {
        toast.error(t("admin.productForm.saveFailed"));
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  // Enter moves to the next field (a barcode scanner ends every scan with
  // Enter, so it lands on the next field instead of submitting).
  // Ctrl/Cmd+Enter: save & add next (edit page: save). Ctrl/Cmd+S: save.
  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;
    // Modals render in portals: their key events bubble here through React but aren't ours.
    if (!formRef.current?.contains(target) && !target.closest?.("[data-product-bar]")) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key === "Enter") {
      e.preventDefault();
      void save(isNew ? "next" : "stay");
    } else if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void save(isNew ? "open" : "stay");
    } else if (e.key === "Enter" && !mod && !e.shiftKey && target.tagName === "INPUT") {
      e.preventDefault();
      const fields = Array.from(formRef.current!.querySelectorAll<HTMLElement>("input:not([type=file]):not([type=color]):not(:disabled), select:not(:disabled), textarea:not(:disabled)"));
      const next = fields[fields.indexOf(target) + 1];
      next?.focus();
      if (next instanceof HTMLInputElement) next.select();
    }
  }

  if (loading) return <PageLoading />;
  if (missing) {
    return (
      <div className="py-16 text-center text-ink-soft">
        <p>{t("admin.productForm.saveFailed")}</p>
        <AdminLinkButton to="/admin/products" className="mt-4">
          {t("admin.common.cancel")}
        </AdminLinkButton>
      </div>
    );
  }

  const title = isNew ? t("admin.productForm.addProduct") : localizedName(draft.name, draft.nameAr, lang) || t("admin.productForm.editProduct");
  const extraSizes = draft.sizes.filter((s) => !SIZE_OPTIONS.includes(s));
  const sizeGroups = [
    { label: t("admin.productForm.quickAdd.apparel"), sizes: APPAREL_SIZES },
    { label: t("admin.productForm.quickAdd.shoes"), sizes: SHOE_SIZES },
    ...(extraSizes.length ? [{ label: t("admin.productForm.quickAdd.otherSizes"), sizes: extraSizes }] : []),
  ];
  const wide = "col-span-2 lg:col-span-1";

  return (
    <div onKeyDown={handleKeyDown}>
      <PageHeader
        title={title}
        actions={
          <>
            {!isNew && (
              <AdminLinkButton
                to={`/admin/stock-ledger?productId=${id}&productName=${encodeURIComponent(localizedName(draft.name, draft.nameAr, lang))}`}
                variant="ghost"
                size="sm"
                icon="history"
              >
                {t("admin.inventory.viewHistory")}
              </AdminLinkButton>
            )}
            <AdminButton variant="secondary" size="sm" onClick={() => navigate("/admin/products")}>
              {t("admin.common.cancel")}
            </AdminButton>
          </>
        }
      />
      {lastSaved && (
        <p className="-mt-2 mb-3 flex items-center gap-2 text-sm text-ink-soft">
          <AdminIcon name="check" className="h-4 w-4 text-olive" />
          {t("admin.productForm.quickAdd.lastSaved")} <span className="font-semibold text-ink">{lastSaved.name}</span>
          <Link to={`/admin/products/${lastSaved.id}`} className="font-semibold text-wine hover:underline">
            {t("admin.productForm.quickAdd.open")}
          </Link>
        </p>
      )}

      <fieldset ref={formRef} disabled={!canWrite} className="flex min-w-0 flex-col gap-4">
        {/* ---- Product info ---- */}
        <Card className="p-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div className={wide}>
              <Field label={t("admin.productForm.quickAdd.nameEn")} required error={errors.name}>
                <AdminInput id={FIELD_IDS.name} autoFocus={isNew} className="!py-2" value={draft.name} onChange={(e) => set("name", e.target.value)} placeholder={t("admin.productForm.namePlaceholder")} />
              </Field>
            </div>
            <div className={wide}>
              <Field label={t("admin.productForm.quickAdd.nameAr")} required error={errors.nameAr}>
                <AdminInput id={FIELD_IDS.nameAr} dir="rtl" className="!py-2" value={draft.nameAr} onChange={(e) => set("nameAr", e.target.value)} />
              </Field>
            </div>
            <div className={wide}>
              <Field label={t("admin.productForm.quickAdd.barcode")} hint={skuOwner || !isNew ? undefined : t("admin.productForm.quickAdd.barcodeHint")}>
                <div className="flex items-stretch gap-2">
                  <AdminInput
                    dir="ltr"
                    className="!py-2 min-w-0 flex-1 font-mono"
                    value={draft.sku}
                    onChange={(e) => {
                      set("sku", e.target.value);
                      setSkuOwner(null);
                    }}
                    onBlur={(e) => void checkBarcode(e.target.value)}
                    placeholder={isNew ? t("admin.productForm.quickAdd.barcodePlaceholder") : draft.slug}
                  />
                  <button
                    type="button"
                    onClick={() => setScannerOpen(true)}
                    title={t("admin.productForm.quickAdd.scan")}
                    aria-label={t("admin.productForm.quickAdd.scan")}
                    className="flex w-10 shrink-0 items-center justify-center rounded-lg border border-line text-ink-soft transition-colors hover:bg-cream-dim hover:text-ink"
                  >
                    <AdminIcon name="barcode" className="h-4.5 w-4.5" />
                  </button>
                </div>
                {skuOwner && (
                  <span className="mt-1 block text-xs font-semibold text-wine">
                    {t("admin.productForm.quickAdd.barcodeExists").replace("{name}", "")}
                    <Link to={`/admin/products/${skuOwner.id}`} className="underline">
                      {skuOwner.name}
                    </Link>
                  </span>
                )}
              </Field>
            </div>
            <div className={wide}>
              <Field label={t("admin.productForm.category")} required error={errors.category}>
                <div className="flex items-stretch gap-2">
                  <AdminSelect id={FIELD_IDS.category} className="!py-2 min-w-0 flex-1" value={draft.category} onChange={(e) => set("category", e.target.value)}>
                    {!draft.category && (
                      <option value="" disabled>
                        {categories.length ? t("admin.productForm.selectCategory") : t("admin.productForm.noCategories")}
                      </option>
                    )}
                    {/* A product whose category was deleted keeps its slug — show it rather than silently displaying another category. */}
                    {draft.category && categories.length > 0 && !categories.some((c) => c.slug === draft.category) && <option value={draft.category}>{draft.category}</option>}
                    {flattenTree(categories).map(({ cat: c, depth }) => (
                      <option key={c.slug} value={c.slug}>
                        {"   ".repeat(depth)}
                        {depth > 0 ? "└ " : ""}
                        {localizedName(c.name, c.nameAr, lang)}
                      </option>
                    ))}
                  </AdminSelect>
                  <button
                    type="button"
                    onClick={() => setNewCatOpen(true)}
                    title={t("admin.productForm.newCategory")}
                    aria-label={t("admin.productForm.newCategory")}
                    className="flex w-10 shrink-0 items-center justify-center rounded-lg border border-line text-wine transition-colors hover:bg-wine-light"
                  >
                    <AdminIcon name="plus" className="h-4.5 w-4.5" />
                  </button>
                </div>
              </Field>
            </div>

            <Field label={`${t("admin.productForm.quickAdd.originalPrice")} (${t("common.currency")})`} required error={errors.originalPrice}>
              <AdminNumberInput id={FIELD_IDS.originalPrice} dir="ltr" inputMode="decimal" min={0} nullable className="!py-2" value={draft.originalPrice} onChange={(v) => set("originalPrice", v)} />
            </Field>
            <Field label={`${t("admin.productForm.quickAdd.discountedPrice")} (${t("common.currency")})`} error={errors.discountPrice} hint={discount ? undefined : t("admin.productForm.quickAdd.discountedHint")}>
              <AdminNumberInput id={FIELD_IDS.discountPrice} dir="ltr" inputMode="decimal" min={0} nullable className="!py-2" value={draft.discountPrice} onChange={(v) => set("discountPrice", v)} />
              {discount && !errors.discountPrice && (
                <span className="mt-1 inline-block rounded-md bg-olive/15 px-2 py-0.5 text-xs font-bold text-olive">
                  {t("admin.productForm.quickAdd.discountBadge").replace("{pct}", String(discount.pct)).replace("{amount}", formatPrice(discount.amount))}
                </span>
              )}
            </Field>
            <div className="col-span-2 lg:row-span-2">
              <Field label={t("admin.productForm.descriptionAr")}>
                <AdminTextarea dir="rtl" rows={4} className="!py-2" value={draft.descriptionAr} onChange={(e) => set("descriptionAr", e.target.value)} />
              </Field>
            </div>
            <div className="col-span-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <ImagesTile
                label={t("admin.productForm.quickAdd.images")}
                urls={draft.images}
                busy={uploading === "images"}
                onFiles={(files) => void uploadImages(files)}
                onLibrary={() => setImagesLibraryOpen(true)}
                onRemove={(i) => set("images", draft.images.filter((_, idx) => idx !== i))}
              />
              <MediaTile
                label={t("admin.productForm.quickAdd.video")}
                url={draft.videoUrl}
                busy={uploading === "video"}
                onFile={(f) => void uploadFile(f, "video", (url) => set("videoUrl", url), "video")}
                onLibrary={() => setVideoLibraryOpen(true)}
                onRemove={() => set("videoUrl", "")}
              />
            </div>
          </div>

          {!isNew && (
            <details className="group mt-3 rounded-lg border border-line">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm font-semibold text-ink">
                <AdminIcon name="chevronDown" className="h-4 w-4 text-ink-faint transition-transform group-open:rotate-180" />
                {t("admin.productForm.quickAdd.more")}
                <span className="text-xs font-normal text-ink-faint">{t("admin.productForm.quickAdd.moreHint")}</span>
              </summary>
              <div className="grid grid-cols-1 gap-3 border-t border-line p-3 lg:grid-cols-2">
                <Field label={t("admin.productForm.description")}>
                  <AdminTextarea rows={3} className="!py-2" value={draft.description} onChange={(e) => set("description", e.target.value)} />
                </Field>
                <div className="flex flex-col gap-3">
                  <Field label={t("admin.categories.slug")} hint={t("admin.productForm.slugHint")}>
                    <AdminInput dir="ltr" className="!py-2" value={draft.slug} onChange={(e) => set("slug", slugify(e.target.value))} />
                  </Field>
                  <div>
                    <span className="mb-1.5 block text-sm font-semibold text-ink">{t("admin.productForm.tags")}</span>
                    <div className="flex flex-wrap gap-1.5">
                      {ALL_TAGS.map((tag) => {
                        const on = draft.tags.includes(tag);
                        return (
                          <button
                            key={tag}
                            type="button"
                            aria-pressed={on}
                            onClick={() => set("tags", on ? draft.tags.filter((x) => x !== tag) : [...draft.tags, tag])}
                            className={`h-8 rounded-md border px-2.5 text-sm font-semibold transition-colors ${on ? "border-ink bg-ink text-paper" : "border-line text-ink-soft hover:border-ink"}`}
                          >
                            {t(`admin.productForm.tag.${tag}`)}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
                <div className="lg:col-span-2">
                  <span className="mb-1.5 block text-sm font-semibold text-ink">{t("admin.productForm.details")}</span>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {draft.details.map((detail, i) => (
                      <div key={i} className="flex gap-2">
                        <AdminInput
                          className="!py-2"
                          value={detail}
                          onChange={(e) => set("details", draft.details.map((x, idx) => (idx === i ? e.target.value : x)))}
                          placeholder={t("admin.productForm.detailPlaceholder")}
                        />
                        <button
                          type="button"
                          onClick={() => set("details", draft.details.filter((_, idx) => idx !== i))}
                          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-ink-faint hover:bg-cream-dim hover:text-wine"
                        >
                          <AdminIcon name="x" className="h-4 w-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                  <AdminButton variant="ghost" size="sm" icon="plus" className="mt-1" onClick={() => set("details", [...draft.details, ""])}>
                    {t("admin.productForm.addDetail")}
                  </AdminButton>
                </div>
              </div>
            </details>
          )}
        </Card>

        {/* ---- Colors, sizes & stock per location ---- */}
        <Card className="p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-display text-sm font-bold text-ink">{t("admin.productForm.quickAdd.colorsStock")}</h2>
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-xs text-ink-faint">{t("admin.productForm.quickAdd.stockHint")}</span>
              {locations.length > 1 && draft.sizes.length > 0 && (
                <AdminButton variant="secondary" size="sm" icon="copy" onClick={() => copyOnlineToBranches()}>
                  {t("admin.productForm.quickAdd.copyToBranches")}
                </AdminButton>
              )}
            </div>
          </div>
          <div className="flex flex-col gap-2">
            {sizeGroups.map((group) => (
              <div key={group.label} className="flex flex-wrap items-center gap-1.5">
                <span className="w-14 shrink-0 text-xs font-semibold text-ink-faint">{group.label}</span>
                {group.sizes.map((size) => {
                  const on = draft.sizes.includes(size);
                  return (
                    <button
                      key={size}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggleSize(size)}
                      className={`h-8 min-w-9 rounded-md border px-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                        on ? "border-ink bg-ink text-paper" : "border-line text-ink-soft hover:border-ink"
                      }`}
                    >
                      {size}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          {errors.colors && <p className="mt-3 text-xs font-semibold text-wine">{errors.colors}</p>}

          <div className="mt-3 flex flex-col gap-3">
            {draft.colors.map((color) => {
              const colorTotal = draft.sizes.reduce((sum, size) => sum + locations.reduce((x, l) => x + countOf(stockCellKey(color.id, size), l.id), 0), 0);
              const nameMissing = !!errors.colors && !color.colorName.trim();
              return (
                <div key={color.id} className="overflow-hidden rounded-lg border border-line">
                  <div className="flex flex-wrap items-center gap-2 bg-cream-dim/50 p-2">
                    <ColorPhoto
                      url={color.imageUrl ?? ""}
                      busy={uploading === color.id}
                      onFile={(f) => void uploadFile(f, "image", (url) => updateColor(color.id, { imageUrl: url, imageId: "" }), color.id)}
                      onLibrary={() => setImagePickerColor(color.id)}
                      onRemove={() => updateColor(color.id, { imageUrl: "", imageId: "" })}
                    />
                    <input
                      type="color"
                      value={color.colorHex}
                      onChange={(e) => updateColor(color.id, { colorHex: e.target.value })}
                      title={t("admin.productForm.hex")}
                      className="h-9 w-9 shrink-0 cursor-pointer rounded-lg border border-line bg-paper"
                    />
                    <AdminInput
                      value={color.colorName}
                      onChange={(e) => updateColor(color.id, { colorName: e.target.value })}
                      placeholder={t("admin.productForm.colorName")}
                      aria-label={t("admin.productForm.colorName")}
                      className={`!py-1.5 min-w-[7rem] flex-1 sm:max-w-[13rem] ${nameMissing ? "!border-wine" : ""}`}
                    />
                    <AdminInput
                      dir="rtl"
                      value={color.colorNameAr ?? ""}
                      onChange={(e) => updateColor(color.id, { colorNameAr: e.target.value })}
                      placeholder={t("admin.productForm.colorNameAr")}
                      aria-label={t("admin.productForm.colorNameAr")}
                      className="!py-1.5 min-w-[7rem] flex-1 sm:max-w-[13rem]"
                    />
                    <AdminSelect value="" onChange={(e) => e.target.value && pickSwatch(color.id, e.target.value)} aria-label={t("admin.productForm.presetSwatch")} className="!py-1.5 !w-auto max-w-[11rem] flex-none">
                      <option value="">{t("admin.productForm.choosePreset")}</option>
                      {Object.values(SWATCHES).map((s) => (
                        <option key={s.name} value={s.name}>
                          {lang === "ar" ? AR_COLORS[s.name] ?? s.name : s.name}
                        </option>
                      ))}
                    </AdminSelect>
                    {draft.colors.length > 1 && locations.length > 1 && draft.sizes.length > 0 && (
                      <button
                        type="button"
                        onClick={() => copyOnlineToBranches(color.id)}
                        title={t("admin.productForm.quickAdd.copyToBranches")}
                        className="inline-flex items-center gap-1 rounded-lg border border-line bg-paper px-2 py-1.5 text-xs font-semibold text-ink-soft transition-colors hover:border-wine hover:text-wine"
                      >
                        <AdminIcon name="copy" className="h-3.5 w-3.5" />
                        {t("admin.productForm.quickAdd.copyToBranchesShort")}
                      </button>
                    )}
                    <span className="ms-auto whitespace-nowrap text-xs text-ink-soft">
                      {t("admin.productForm.quickAdd.colorTotal")}: <span className="font-bold tabular-nums text-ink">{colorTotal}</span>
                    </span>
                    {draft.colors.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeColor(color.id)}
                        title={t("admin.productForm.quickAdd.removeColor")}
                        aria-label={t("admin.productForm.quickAdd.removeColor")}
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-ink-faint hover:bg-wine-light hover:text-wine"
                      >
                        <AdminIcon name="trash" className="h-4 w-4" />
                      </button>
                    )}
                  </div>

                  <StockTable
                    colorId={color.id}
                    sizes={draft.sizes}
                    locations={locations}
                    shownQty={shownQty}
                    countOf={countOf}
                    isEdited={(key, loc) => !!edits[key]?.[loc]}
                    isUnknown={(key, loc) => loc === ONLINE_LOCATION && !edits[key]?.[loc] && baseQty(key, loc) === null}
                    onChange={setQty}
                  />
                </div>
              );
            })}
          </div>
          <AdminButton variant="secondary" size="sm" icon="plus" className="mt-3" onClick={addColor}>
            {t("admin.productForm.addColor")}
          </AdminButton>
        </Card>
      </fieldset>

      {canWrite && (
        <div data-product-bar className="sticky bottom-0 z-10 -mx-1 mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-paper/95 px-4 py-2.5 shadow-sm backdrop-blur">
          {isNew ? (
            <label className="flex items-center gap-2 text-sm font-semibold text-ink">
              <Toggle checked={draft.status === "active"} onChange={(on) => set("status", on ? "active" : "draft")} />
              {t("admin.productForm.quickAdd.publish")}
            </label>
          ) : (
            <label className="flex items-center gap-2 text-sm font-semibold text-ink">
              {t("admin.products.colStatus")}
              <AdminSelect className="!py-1.5 !w-auto" value={draft.status} onChange={(e) => set("status", e.target.value as AdminProduct["status"])}>
                <option value="draft">{t("admin.products.status.draft")}</option>
                <option value="active">{t("admin.products.status.active")}</option>
                <option value="archived">{t("admin.products.status.archived")}</option>
              </AdminSelect>
            </label>
          )}
          {!isNew && <ProductCodeActions sku={draft.sku} slug={draft.slug} name={localizedName(draft.name, draft.nameAr, lang)} price={discount ? draft.discountPrice! : draft.originalPrice ?? 0} />}
          {isNew && <span className="hidden text-xs text-ink-faint xl:inline">{t("admin.productForm.quickAdd.shortcuts")}</span>}
          <div className="ms-auto flex gap-2">
            {isNew && (
              <AdminButton variant="secondary" icon="plus" disabled={saving} onClick={() => void save("next")}>
                {t("admin.productForm.quickAdd.saveAndNext")}
              </AdminButton>
            )}
            <AdminButton variant="primary" loading={saving} onClick={() => void save(isNew ? "open" : "stay")}>
              {isNew ? t("admin.productForm.quickAdd.saveProduct") : t("admin.productForm.quickAdd.saveChanges")}
            </AdminButton>
          </div>
        </div>
      )}

      <MediaPicker
        open={!!imagePickerColor}
        onClose={() => setImagePickerColor(null)}
        accept="image/*"
        onSelect={(asset) => {
          if (imagePickerColor) updateColor(imagePickerColor, { imageUrl: asset.url, imageId: "" });
          setImagePickerColor(null);
        }}
      />
      <MediaPicker
        open={imagesLibraryOpen}
        onClose={() => setImagesLibraryOpen(false)}
        accept="image/*"
        onSelect={(asset) => {
          addImage(asset.url);
          setImagesLibraryOpen(false);
        }}
      />
      <ProductVideoPicker
        open={videoLibraryOpen}
        onClose={() => setVideoLibraryOpen(false)}
        onSelect={(item) => {
          set("videoUrl", item.url);
          setVideoLibraryOpen(false);
        }}
      />
      {scannerOpen && (
        <CameraScannerModal
          onScan={(data) => {
            set("sku", data.trim());
            setScannerOpen(false);
            void checkBarcode(data);
            requestAnimationFrame(() => document.getElementById(FIELD_IDS.category)?.focus());
          }}
          onClose={() => setScannerOpen(false)}
        />
      )}
      <NewCategoryModal
        open={newCatOpen}
        onClose={() => setNewCatOpen(false)}
        categories={categories}
        beforeCreate={persistStarterCategoriesIfNeeded}
        onCreated={(cat) => {
          setCategories((cats) => (cats.some((c) => c.slug === cat.slug) ? cats : [...cats, cat]));
          set("category", cat.slug);
        }}
      />
    </div>
  );
}


function useFileDrop(onFile: (file: File | undefined) => void) {
  const [over, setOver] = useState(false);
  return {
    over,
    handlers: {
      onDragOver: (e: DragEvent) => {
        e.preventDefault();
        setOver(true);
      },
      onDragLeave: () => setOver(false),
      onDrop: (e: DragEvent) => {
        e.preventDefault();
        setOver(false);
        onFile(e.dataTransfer.files[0]);
      },
    },
  };
}

// A color's photo: click (or drop a file on) the thumbnail to upload.
function ColorPhoto({ url, busy, onFile, onLibrary, onRemove }: { url: string; busy: boolean; onFile: (file: File | undefined) => void; onLibrary: () => void; onRemove: () => void }) {
  const { t } = useLanguage();
  const inputRef = useRef<HTMLInputElement>(null);
  const { over, handlers } = useFileDrop(onFile);
  return (
    <div className="flex shrink-0 items-center gap-1" {...handlers}>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        title={`${t("admin.productForm.quickAdd.upload")} ${t("admin.productForm.quickAdd.image")}`}
        aria-label={`${t("admin.productForm.quickAdd.upload")} ${t("admin.productForm.quickAdd.image")}`}
        className={`relative flex h-10 w-10 items-center justify-center overflow-hidden rounded-md border bg-paper text-ink-faint ${over ? "border-wine" : "border-dashed border-line"}`}
      >
        {busy ? (
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
        ) : url ? (
          <img src={url} alt="" className="h-full w-full object-cover" />
        ) : (
          <AdminIcon name="upload" className="h-4 w-4" />
        )}
      </button>
      <div className="flex flex-col">
        <button type="button" onClick={onLibrary} className="text-[11px] font-semibold leading-4 text-wine hover:underline">
          {t("admin.productForm.quickAdd.library")}
        </button>
        {url && (
          <button type="button" onClick={onRemove} className="text-[11px] font-semibold leading-4 text-ink-faint hover:text-wine">
            {t("admin.productForm.quickAdd.remove")}
          </button>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          onFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </div>
  );
}

// The product's extra photos, next to the video: click or drop files to
// upload (several at once), or pick from the media library.
function ImagesTile({ label, urls, busy, onFiles, onLibrary, onRemove }: { label: string; urls: string[]; busy: boolean; onFiles: (files: File[]) => void; onLibrary: () => void; onRemove: (index: number) => void }) {
  const { t } = useLanguage();
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const link = "text-xs font-semibold text-wine hover:underline disabled:opacity-50";
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        onFiles(Array.from(e.dataTransfer.files));
      }}
      className={`flex items-center gap-3 rounded-lg border p-2 transition-colors ${over ? "border-wine bg-wine-light/40" : "border-dashed border-line"}`}
    >
      <button
        type="button"
        tabIndex={-1}
        onClick={() => inputRef.current?.click()}
        className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-md bg-cream-dim text-ink-faint"
        aria-label={`${t("admin.productForm.quickAdd.upload")} ${label}`}
      >
        {busy ? <span className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" /> : <AdminIcon name="upload" className="h-5 w-5" />}
      </button>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-ink">
          {label}
          {urls.length > 0 && <span className="ms-1 text-xs font-normal text-ink-faint">({urls.length})</span>}
        </p>
        <div className="mt-0.5 flex flex-wrap gap-x-3">
          <button type="button" disabled={busy} onClick={() => inputRef.current?.click()} className={link}>
            {t("admin.productForm.quickAdd.upload")}
          </button>
          <button type="button" disabled={busy} onClick={onLibrary} className={link}>
            {t("admin.productForm.quickAdd.library")}
          </button>
        </div>
        {urls.length > 0 && (
          <div className="thin-scrollbar mt-1.5 flex gap-1.5 overflow-x-auto">
            {urls.map((url, i) => (
              <div key={`${url}-${i}`} className="group relative h-10 w-10 shrink-0 overflow-hidden rounded-md border border-line">
                <img src={url} alt="" className="h-full w-full object-cover" />
                <button
                  type="button"
                  onClick={() => onRemove(i)}
                  title={t("admin.productForm.quickAdd.remove")}
                  aria-label={t("admin.productForm.quickAdd.remove")}
                  className="absolute inset-0 flex items-center justify-center bg-ink/50 text-paper opacity-0 transition-opacity hover:opacity-100 focus:opacity-100"
                >
                  <AdminIcon name="x" className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          onFiles(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
    </div>
  );
}

// The product video slot: click or drop a file to upload, or pick one from
// the video library. Same small size with or without a video.
function MediaTile({ label, url, busy, onFile, onLibrary, onRemove }: { label: string; url: string; busy: boolean; onFile: (file: File | undefined) => void; onLibrary: () => void; onRemove: () => void }) {
  const { t } = useLanguage();
  const inputRef = useRef<HTMLInputElement>(null);
  const { over, handlers } = useFileDrop(onFile);
  const link = "text-xs font-semibold text-wine hover:underline disabled:opacity-50";
  return (
    <div {...handlers} className={`flex items-center gap-3 rounded-lg border p-2 transition-colors ${over ? "border-wine bg-wine-light/40" : "border-dashed border-line"}`}>
      <button
        type="button"
        tabIndex={-1}
        onClick={() => inputRef.current?.click()}
        className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-md bg-cream-dim text-ink-faint"
        aria-label={`${t("admin.productForm.quickAdd.upload")} ${label}`}
      >
        {busy ? (
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" />
        ) : url ? (
          <video src={url} muted playsInline preload="metadata" className="h-full w-full object-cover" />
        ) : (
          <AdminIcon name="video" className="h-5 w-5" />
        )}
      </button>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-ink">{label}</p>
        <div className="mt-0.5 flex flex-wrap gap-x-3">
          <button type="button" disabled={busy} onClick={() => inputRef.current?.click()} className={link}>
            {t("admin.productForm.quickAdd.upload")}
          </button>
          <button type="button" disabled={busy} onClick={onLibrary} className={link}>
            {t("admin.productForm.quickAdd.library")}
          </button>
          {url && (
            <button type="button" onClick={onRemove} className="text-xs font-semibold text-ink-faint hover:text-wine">
              {t("admin.productForm.quickAdd.remove")}
            </button>
          )}
        </div>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        className="hidden"
        onChange={(e) => {
          onFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </div>
  );
}
