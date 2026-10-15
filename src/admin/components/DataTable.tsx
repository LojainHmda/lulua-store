import { useMemo, useState, type ReactNode } from "react";
import { useLanguage } from "../../context/LanguageContext";
import AdminIcon from "./AdminIcons";
import { PageLoading } from "./ui";

export interface DataTableColumn<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  sortValue?: (row: T) => string | number;
  className?: string;
  headerClassName?: string;
}

interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  getId: (row: T) => string;
  selectable?: boolean;
  selected?: Set<string>;
  onSelectionChange?: (ids: Set<string>) => void;
  loading?: boolean;
  emptyState?: ReactNode;
  onRowClick?: (row: T) => void;
  defaultSort?: string;
}

export default function DataTable<T>({
  columns,
  rows,
  getId,
  selectable,
  selected,
  onSelectionChange,
  loading,
  emptyState,
  onRowClick,
  defaultSort,
}: DataTableProps<T>) {
  const [sortKey, setSortKey] = useState<string | undefined>(defaultSort);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const sortedRows = useMemo(() => {
    const col = columns.find((c) => c.key === sortKey);
    if (!col?.sortValue) return rows;
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = col.sortValue!(a);
      const bv = col.sortValue!(b);
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
    return copy;
  }, [rows, columns, sortKey, sortDir]);

  function toggleSort(key: string) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  function toggleAll() {
    if (!onSelectionChange) return;
    if (selected && selected.size === rows.length) {
      onSelectionChange(new Set());
    } else {
      onSelectionChange(new Set(rows.map(getId)));
    }
  }

  function toggleOne(id: string) {
    if (!onSelectionChange || !selected) return;
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectionChange(next);
  }

  if (loading) return <PageLoading />;
  if (rows.length === 0 && emptyState) return <>{emptyState}</>;

  return (
    <div className="thin-scrollbar overflow-x-auto rounded-2xl border border-line bg-paper">
      <table className="w-full min-w-[640px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-line bg-cream-dim/60 text-start">
            {selectable && (
              <th className="w-10 px-4 py-3">
                <input
                  type="checkbox"
                  checked={!!selected && rows.length > 0 && selected.size === rows.length}
                  onChange={toggleAll}
                  className="h-4 w-4 rounded border-line accent-wine"
                />
              </th>
            )}
            {columns.map((col) => (
              <th key={col.key} className={`px-4 py-3 text-xs font-bold uppercase tracking-wide text-ink-faint ${col.headerClassName ?? "text-start"}`}>
                {col.sortValue ? (
                  <button onClick={() => toggleSort(col.key)} className="inline-flex items-center gap-1 hover:text-ink">
                    {col.header}
                    <AdminIcon
                      name={sortKey === col.key && sortDir === "desc" ? "arrowDown" : "arrowUp"}
                      className={`h-3 w-3 ${sortKey === col.key ? "text-wine" : "text-ink-faint/50"}`}
                    />
                  </button>
                ) : (
                  col.header
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row) => {
            const id = getId(row);
            return (
              <tr
                key={id}
                onClick={() => onRowClick?.(row)}
                className={`border-b border-line last:border-0 ${onRowClick ? "cursor-pointer hover:bg-cream-dim/40" : ""}`}
              >
                {selectable && (
                  <td className="w-10 px-4 py-3" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={!!selected?.has(id)}
                      onChange={() => toggleOne(id)}
                      className="h-4 w-4 rounded border-line accent-wine"
                    />
                  </td>
                )}
                {columns.map((col) => (
                  <td key={col.key} className={`px-4 py-3 align-middle text-ink ${col.className ?? ""}`}>
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function BulkActionBar({ count, onClear, children }: { count: number; onClear: () => void; children: ReactNode }) {
  const { t } = useLanguage();
  if (count === 0) return null;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl bg-ink px-4 py-3 text-paper">
      <span className="text-sm font-semibold">{count} {t("admin.common.selected")}</span>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
      <button onClick={onClear} className="ms-auto text-sm text-paper/70 hover:text-paper">
        {t("admin.common.clear")}
      </button>
    </div>
  );
}
