import { useEffect, useMemo, useState } from "react";
import { resolveImageSrc } from "../admin/imageSrc";
import type { AdminProduct, Branch, BranchStockDoc } from "../admin/types";
import { useLanguage } from "../context/LanguageContext";
import { localizedName } from "../data/localize";
import { branchCellQty, subscribeProductBranchStock } from "../firebase/branchStock";
import { formatPrice } from "../utils/currency";

export interface PickedLine {
  productId: string;
  variantId: string;
  size: string;
  qty: number;
  name: string;
  color: string;
  price: number;
  imageId?: string;
  imageUrl?: string;
}

function cellKey(variantId: string, size: string): string {
  return `${variantId}::${size}`;
}

// `product` arrives with this till's stock already applied (branch counts on
// a branch register -- see Terminal.tsx's withBranchStock).
//
// Several sizes (and colors) can be picked in one go: tapping a size toggles
// it in the selection, each selected cell gets its own quantity, and "Add"
// hands every selected line to the sale at once. The selection survives
// switching colors, so "M in white + L in black" is one trip through here.
//
// On a branch till, sizes that are out of stock HERE stay tappable so the
// cashier can see which other branch has that exact color/size ("Other
// branches" follows the last size tapped), but they're never added.
export function ProductPicker({
  product,
  branchId,
  branches = [],
  onAdd,
  onClose,
}: {
  product: AdminProduct;
  branchId?: string;
  branches?: Branch[];
  onAdd: (lines: PickedLine[]) => void;
  onClose: () => void;
}) {
  const { t, lang } = useLanguage();
  const [variantId, setVariantId] = useState(product.colorVariants[0]?.id ?? "");
  // cellKey -> qty, only for cells that can actually be sold here.
  const [selected, setSelected] = useState<Record<string, number>>({});
  // The size whose other-branch availability is shown (last one tapped).
  const [focusSize, setFocusSize] = useState<string | null>(null);
  const [otherStock, setOtherStock] = useState<BranchStockDoc[]>([]);

  useEffect(() => {
    if (!branchId) return;
    return subscribeProductBranchStock(product.id, setOtherStock);
  }, [branchId, product.id]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const activeVariant = product.colorVariants.find((v) => v.id === variantId) ?? product.colorVariants[0];
  const displayName = localizedName(product.name, product.nameAr, lang);

  function stockOf(vId: string, size: string): number | null {
    const s = product.colorVariants.find((v) => v.id === vId)?.sizeStock.find((x) => x.size === size);
    return s ? s.qty : 0;
  }

  // null = never counted (online stock on a pre-branch session): not sellable.
  const sellable = (qty: number | null) => qty !== null && qty > 0;

  function toggleSize(size: string) {
    if (!activeVariant) return;
    setFocusSize(size);
    const key = cellKey(activeVariant.id, size);
    if (!sellable(stockOf(activeVariant.id, size))) return;
    setSelected((prev) => {
      const next = { ...prev };
      if (key in next) delete next[key];
      else next[key] = 1;
      return next;
    });
  }

  function changeQty(key: string, delta: number) {
    const [vId, size] = key.split("::");
    const max = stockOf(vId, size) ?? 0;
    setSelected((prev) => {
      const q = (prev[key] ?? 0) + delta;
      const next = { ...prev };
      if (q <= 0) delete next[key];
      else next[key] = Math.min(q, max);
      return next;
    });
  }

  // Selected cells in product order (color, then size), for display + add.
  const selectedLines = useMemo(
    () =>
      product.colorVariants.flatMap((v) =>
        v.sizeStock
          .filter((s) => cellKey(v.id, s.size) in selected)
          .map((s) => ({ variant: v, size: s.size, key: cellKey(v.id, s.size), qty: selected[cellKey(v.id, s.size)], max: s.qty ?? 0 }))
      ),
    [product.colorVariants, selected]
  );
  const totalUnits = selectedLines.reduce((n, l) => n + l.qty, 0);

  // Other active branches' count for the selected color (and focused size).
  // Branches with nothing are listed too, as 0 -- "nobody has it" is an
  // answer the cashier needs as much as "branch X has 2".
  const otherBranches = branches
    .filter((b) => b.active && b.id !== branchId)
    .map((b) => {
      const doc = otherStock.find((d) => d.branchId === b.id);
      const qtyThere =
        activeVariant && focusSize
          ? branchCellQty(doc, activeVariant.id, focusSize)
          : activeVariant
            ? activeVariant.sizeStock.reduce((sum, s) => sum + branchCellQty(doc, activeVariant.id, s.size), 0)
            : 0;
      return { branch: b, qty: qtyThere };
    })
    .sort((a, b) => b.qty - a.qty);

  function handleAdd() {
    if (selectedLines.length === 0) return;
    onAdd(
      selectedLines.map((l) => ({
        productId: product.id,
        variantId: l.variant.id,
        size: l.size,
        qty: l.qty,
        name: displayName,
        color: localizedName(l.variant.colorName, l.variant.colorNameAr, lang),
        price: product.price,
        imageId: l.variant.imageId,
        imageUrl: l.variant.imageUrl,
      }))
    );
  }

  const stepBtn = "flex h-8 w-8 items-center justify-center rounded-lg border border-line text-base font-bold text-ink hover:bg-cream-dim disabled:opacity-40";

  return (
    <div className="fixed inset-0 z-[150] flex items-center justify-center bg-ink/40 p-4 backdrop-blur-[2px]" onClick={onClose}>
      <div className="max-h-full w-full max-w-sm overflow-y-auto rounded-2xl bg-paper p-5 shadow-lift" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3">
          <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-cream-dim">
            {resolveImageSrc(activeVariant ?? {}) && <img src={resolveImageSrc(activeVariant ?? {})} alt={displayName} className="h-full w-full object-cover" />}
          </div>
          <div>
            <p className="font-display text-base font-bold text-ink">{displayName}</p>
            <p className="text-sm text-ink-faint">{formatPrice(product.price)}</p>
          </div>
        </div>

        {product.colorVariants.length > 1 && (
          <div className="mt-4">
            <p className="mb-2 text-sm font-semibold text-ink">{t("admin.inventory.color")}</p>
            <div className="flex flex-wrap gap-2">
              {product.colorVariants.map((v) => {
                const picked = selectedLines.filter((l) => l.variant.id === v.id).reduce((n, l) => n + l.qty, 0);
                return (
                  <button
                    key={v.id}
                    onClick={() => {
                      setVariantId(v.id);
                      setFocusSize(null);
                    }}
                    className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm ${
                      variantId === v.id ? "border-wine bg-wine-light text-wine-dark" : "border-line text-ink-soft"
                    }`}
                  >
                    <span className="h-4 w-4 rounded-full border border-line/60" style={{ backgroundColor: v.colorHex }} />
                    {localizedName(v.colorName, v.colorNameAr, lang)}
                    {picked > 0 && <span className="rounded-full bg-wine px-1.5 text-[10px] font-bold text-on-accent">{picked}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {activeVariant && (
          <div className="mt-4">
            <p className="mb-2 flex items-baseline justify-between text-sm font-semibold text-ink">
              {t("admin.orderDetail.size")}
              <span className="text-xs font-normal text-ink-faint">{t("pos.branch.pickSizesHint")}</span>
            </p>
            <div className="flex flex-wrap gap-2">
              {activeVariant.sizeStock.map((s) => {
                const on = cellKey(activeVariant.id, s.size) in selected;
                const canSell = sellable(s.qty);
                return (
                  <button
                    key={s.size}
                    aria-pressed={on}
                    disabled={!branchId && !canSell}
                    title={s.qty === null ? t("admin.inventory.unknownHint") : undefined}
                    onClick={() => toggleSize(s.size)}
                    className={`relative flex min-w-[3.25rem] flex-col items-center rounded-lg border px-3 py-1.5 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${
                      on ? "border-wine bg-wine text-on-accent" : focusSize === s.size ? "border-wine/60 text-ink" : "border-line text-ink-soft"
                    } ${branchId && !canSell ? "opacity-50" : ""}`}
                  >
                    <span>
                      {s.size}
                      {s.qty === null && "?"}
                    </span>
                    {branchId && <span className="text-[10px] font-medium">{s.qty ?? "?"}</span>}
                  </button>
                );
              })}
            </div>
            {focusSize && !sellable(stockOf(activeVariant.id, focusSize)) && branchId && (
              <p className="mt-2 text-xs font-semibold text-wine">{t("pos.branch.outHereLong")}</p>
            )}
          </div>
        )}

        {selectedLines.length > 0 && (
          <ul className="mt-4 flex flex-col divide-y divide-line rounded-xl border border-line">
            {selectedLines.map((l) => (
              <li key={l.key} className="flex items-center gap-2 px-3 py-2">
                <span className="h-3.5 w-3.5 shrink-0 rounded-full border border-line/60" style={{ backgroundColor: l.variant.colorHex }} />
                <span className="min-w-0 flex-1 truncate text-sm text-ink">
                  {product.colorVariants.length > 1 && <>{localizedName(l.variant.colorName, l.variant.colorNameAr, lang)} · </>}
                  <b>{l.size}</b>
                  <span className="ms-1.5 text-xs text-ink-faint">/ {l.max}</span>
                </span>
                <button onClick={() => changeQty(l.key, -1)} aria-label={t("pos.terminal.decreaseQty")} className={stepBtn}>
                  −
                </button>
                <span className="w-6 text-center text-sm font-semibold text-ink">{l.qty}</span>
                <button onClick={() => changeQty(l.key, 1)} disabled={l.qty >= l.max} aria-label={t("pos.terminal.increaseQty")} className={stepBtn}>
                  +
                </button>
              </li>
            ))}
          </ul>
        )}

        {branchId && otherBranches.length > 0 && (
          <div className="mt-4 rounded-xl bg-cream-dim p-3">
            <p className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-faint">
              {t("pos.branch.otherBranches")}
              {activeVariant && ` · ${localizedName(activeVariant.colorName, activeVariant.colorNameAr, lang)}`}
              {focusSize && ` · ${focusSize}`}
            </p>
            <ul className="flex flex-col gap-1">
              {otherBranches.map(({ branch, qty: q }) => (
                <li key={branch.id} className="flex items-center justify-between text-sm">
                  <span className="text-ink">
                    <span className="me-1.5 font-mono text-xs text-ink-faint">{branch.code}</span>
                    {localizedName(branch.name, branch.nameAr, lang)}
                  </span>
                  <span className={`font-semibold ${q > 0 ? "text-olive" : "text-ink-faint"}`}>{q}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-5 flex items-center justify-end gap-2">
          <button onClick={onClose} className="rounded-full px-5 py-2.5 text-sm font-semibold text-ink-soft hover:bg-cream-dim">
            {t("admin.common.cancel")}
          </button>
          <button
            onClick={handleAdd}
            disabled={totalUnits === 0}
            className="rounded-full bg-wine px-6 py-2.5 text-sm font-semibold text-on-accent hover:bg-wine-dark disabled:cursor-not-allowed disabled:opacity-40"
          >
            {totalUnits > 0
              ? `${t("pos.terminal.addToSale")} · ${totalUnits} · ${formatPrice(totalUnits * product.price)}`
              : t("pos.terminal.addToSale")}
          </button>
        </div>
      </div>
    </div>
  );
}
