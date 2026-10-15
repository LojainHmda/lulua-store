import { useState, type PointerEvent as ReactPointerEvent } from "react";
import { useLanguage } from "../../context/LanguageContext";
import { stockCellKey } from "../productVariants";
import { AdminNumberInput } from "./ui";
// One color's stock: a row per size, a column per location (website, then
// each branch). The size column stays pinned while many branches scroll.
export default function StockTable({
  colorId,
  sizes,
  locations,
  shownQty,
  countOf,
  isEdited,
  isUnknown,
  onChange,
  reference,
}: {
  colorId: string;
  sizes: string[];
  locations: { id: string; label: string; title: string }[];
  shownQty: (key: string, locationId: string) => number | null;
  countOf: (key: string, locationId: string) => number;
  isEdited: (key: string, locationId: string) => boolean;
  // A website count that was never confirmed (stored as null).
  isUnknown: (key: string, locationId: string) => boolean;
  onChange: (key: string, locationId: string, qty: number | null) => void;
  // Optional read-only column before the editable ones (e.g. the website's
  // count shown next to branch counts).
  reference?: { label: string; title: string; qty: (key: string) => number | null };
}) {
  const { t } = useLanguage();
  const pinned = "sticky start-0 z-[1] bg-paper";
  const keyOf = (row: number) => stockCellKey(colorId, sizes[row]);

  // Excel-style fill handle: drag the small square on a cell's corner to copy
  // that cell's number into every cell of the dragged-over block.
  const [fill, setFill] = useState<{ row: number; col: number; toRow: number; toCol: number } | null>(null);

  function fillRange(f: { row: number; col: number; toRow: number; toCol: number }) {
    // The whole rectangle between the source cell and the pointer: down a
    // column, across a row, or diagonally over a block.
    return { r0: Math.min(f.row, f.toRow), r1: Math.max(f.row, f.toRow), c0: Math.min(f.col, f.toCol), c1: Math.max(f.col, f.toCol) };
  }

  function applyFill(row: number, col: number, range: { r0: number; r1: number; c0: number; c1: number }) {
    const value = shownQty(keyOf(row), locations[col].id);
    for (let r = range.r0; r <= range.r1; r++)
      for (let c = range.c0; c <= range.c1; c++) if (r !== row || c !== col) onChange(keyOf(r), locations[c].id, value);
  }

  function startFill(e: ReactPointerEvent, row: number, col: number) {
    e.preventDefault();
    e.stopPropagation();
    let current = { row, col, toRow: row, toCol: col };
    setFill(current);
    const move = (ev: PointerEvent) => {
      const cell = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>("td[data-fill-color]");
      if (!cell || cell.dataset.fillColor !== colorId) return;
      const toRow = Number(cell.dataset.row);
      const toCol = Number(cell.dataset.col);
      if (toRow === current.toRow && toCol === current.toCol) return;
      current = { ...current, toRow, toCol };
      setFill(current);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      applyFill(row, col, fillRange(current));
      setFill(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  const range = fill ? fillRange(fill) : null;
  const inRange = (r: number, c: number) => !!range && r >= range.r0 && r <= range.r1 && c >= range.c0 && c <= range.c1;

  return (
    <div className={`thin-scrollbar overflow-x-auto ${fill ? "select-none" : ""}`}>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-t border-line text-xs text-ink-soft">
            <th className={`${pinned} w-16 px-2 py-1.5 text-start font-semibold`}>{t("admin.productForm.quickAdd.size")}</th>
            {reference && (
              <th title={reference.title} className="px-2 py-1.5 text-center font-semibold text-ink-faint">
                {reference.label}
              </th>
            )}
            {locations.map((l) => (
              <th key={l.id} title={l.title} className="max-w-[9rem] truncate px-1 py-1.5 text-center font-semibold">
                {l.label}
              </th>
            ))}
            <th className="w-16 px-2 py-1.5 text-end font-semibold">{t("admin.productForm.quickAdd.total")}</th>
          </tr>
        </thead>
        <tbody>
          {sizes.length === 0 && (
            <tr className="border-t border-line">
              <td className={`${pinned} px-2 py-1 text-ink-faint`}>—</td>
              {reference && <td />}
              {locations.map((l) => (
                <td key={l.id} className="px-1 py-1">
                  <div className="h-[30px] min-w-[4.5rem] rounded-lg border border-dashed border-line bg-cream-dim/30" />
                </td>
              ))}
              <td className="px-2 py-1 text-end text-ink-faint">—</td>
            </tr>
          )}
          {sizes.length === 0 && (
            <tr>
              <td colSpan={locations.length + 2 + (reference ? 1 : 0)} className="px-3 pb-2 pt-1 text-center text-xs text-ink-faint">
                {t("admin.productForm.quickAdd.selectSizesFirst")}
              </td>
            </tr>
          )}
          {sizes.map((size, row) => {
            const key = stockCellKey(colorId, size);
            return (
              <tr key={size} className="border-t border-line">
                <td className={`${pinned} whitespace-nowrap px-2 py-1 font-semibold text-ink`}>{size}</td>
                {reference && <td className="px-2 py-1 text-center tabular-nums text-ink-faint">{reference.qty(key) ?? "—"}</td>}
                {locations.map((l, col) => {
                  const qty = shownQty(key, l.id);
                  const unknown = isUnknown(key, l.id);
                  const highlighted = inRange(row, col);
                  return (
                    <td key={l.id} data-fill-color={colorId} data-row={row} data-col={col} className="group/cell relative px-1 py-1">
                      <span
                        role="presentation"
                        title={t("admin.productForm.quickAdd.fillHandle")}
                        onPointerDown={(e) => startFill(e, row, col)}
                        onDoubleClick={() => applyFill(row, col, { r0: row, r1: sizes.length - 1, c0: col, c1: col })}
                        className={`absolute -bottom-0.5 end-0 z-[2] h-2.5 w-2.5 cursor-crosshair touch-none rounded-sm border border-paper bg-wine transition-opacity ${
                          fill && fill.row === row && fill.col === col ? "opacity-100" : "opacity-0 group-hover/cell:opacity-100 group-focus-within/cell:opacity-100"
                        }`}
                      />
                      <AdminNumberInput
                        dir="ltr"
                        inputMode="numeric"
                        min={0}
                        integerOnly
                        nullable
                        value={qty}
                        onChange={(v) => onChange(key, l.id, v)}
                        aria-label={`${size} · ${l.title}`}
                        placeholder={unknown ? "?" : "0"}
                        className={`!px-1.5 !py-1 min-w-[4.5rem] text-center tabular-nums ${isEdited(key, l.id) ? "!border-wine/60 bg-wine-light/30" : ""} ${highlighted ? "!border-wine ring-2 ring-wine/40" : ""}`}
                      />
                    </td>
                  );
                })}
                <td className="px-2 py-1 text-end font-semibold tabular-nums text-ink">{locations.reduce((sum, l) => sum + countOf(key, l.id), 0)}</td>
              </tr>
            );
          })}
        </tbody>
        {sizes.length > 1 && (
          <tfoot>
            <tr className="border-t border-line text-xs font-semibold text-ink-soft">
              <td className={`${pinned} px-2 py-1.5`}>{t("admin.productForm.quickAdd.total")}</td>
              {reference && <td className="px-2 py-1.5 text-center tabular-nums text-ink-faint">{sizes.reduce((sum, s) => sum + (reference.qty(stockCellKey(colorId, s)) ?? 0), 0)}</td>}
              {locations.map((l) => (
                <td key={l.id} className="px-1 py-1.5 text-center tabular-nums">
                  {sizes.reduce((sum, s) => sum + countOf(stockCellKey(colorId, s), l.id), 0)}
                </td>
              ))}
              <td className="px-2 py-1.5 text-end tabular-nums text-ink">{sizes.reduce((sum, s) => sum + locations.reduce((x, l) => x + countOf(stockCellKey(colorId, s), l.id), 0), 0)}</td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
