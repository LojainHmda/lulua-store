import { orderBy, limit } from "../../db/firestore";
import { useEffect, useMemo, useState } from "react";
import { activityLogApi } from "../../firebase/collections";
import { useLanguage } from "../../context/LanguageContext";
import { activityActionLabel } from "../activityActions";
import DataTable, { type DataTableColumn } from "../components/DataTable";
import { EmptyState, PageHeader, SearchInput } from "../components/ui";
import type { ActivityLogEntry } from "../types";

function formatDate(value: unknown): string {
  const ts = value as { toDate?: () => Date } | undefined;
  const date = ts?.toDate ? ts.toDate() : null;
  return date ? date.toLocaleString() : "";
}

export default function ActivityLog() {
  const { t } = useLanguage();
  const [entries, setEntries] = useState<ActivityLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    const unsub = activityLogApi.subscribe(
      (data) => {
        setEntries(data);
        setLoading(false);
      },
      [orderBy("createdAt", "desc"), limit(300)]
    );
    return unsub;
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(
      (e) =>
        e.actorName.toLowerCase().includes(q) ||
        activityActionLabel(t, e.action).toLowerCase().includes(q) ||
        e.target.toLowerCase().includes(q)
    );
  }, [entries, search, t]);

  const columns: DataTableColumn<ActivityLogEntry>[] = [
    { key: "actor", header: t("admin.activityLog.admin"), render: (e) => <span className="font-semibold text-ink">{e.actorName}</span> },
    { key: "action", header: t("admin.activityLog.action"), render: (e) => activityActionLabel(t, e.action) },
    { key: "target", header: t("admin.activityLog.target"), render: (e) => <span className="text-ink-soft">{e.target}</span> },
    { key: "when", header: t("admin.activityLog.when"), render: (e) => <span className="text-xs text-ink-faint">{formatDate(e.createdAt)}</span> },
  ];

  return (
    <div>
      <PageHeader title={t("admin.nav.activity")} description={t("admin.activityLog.subtitle")} />
      <div className="mb-4">
        <SearchInput value={search} onChange={setSearch} placeholder={t("admin.activityLog.searchPlaceholder")} />
      </div>
      <DataTable columns={columns} rows={filtered} getId={(e) => e.id} loading={loading} emptyState={<EmptyState icon="history" title={t("admin.activityLog.noneYet")} body={t("admin.activityLog.emptyBody")} />} />
    </div>
  );
}
