import { orderBy } from "firebase/firestore";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { returnsApi } from "../../../firebase/collections";
import { useLanguage } from "../../../context/LanguageContext";
import DataTable, { type DataTableColumn } from "../../components/DataTable";
import { AdminSelect, Badge, EmptyState, PageHeader, SearchInput } from "../../components/ui";
import {
  RETURN_REASON_LABEL_KEY,
  RETURN_STATUS_LABEL_KEY,
  RETURN_STATUS_TONE,
  returnDispositionLabelKey,
  returnDispositionTone,
} from "../../returnsHelpers";
import type { AdminReturn, ReturnStatus } from "../../types";

function tsToDate(v: unknown): Date | null {
  const ts = v as { toDate?: () => Date } | undefined;
  return ts?.toDate ? ts.toDate() : null;
}

export default function ReturnsList() {
  const navigate = useNavigate();
  const { t, lang } = useLanguage();
  const [returns, setReturns] = useState<AdminReturn[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<ReturnStatus | "all">("all");

  useEffect(() => {
    // Single-field order, no where() combined with a different-field
    // orderBy — deliberately avoids needing a new Firestore composite
    // index; status/search filtering happens client-side below instead.
    const unsub = returnsApi.subscribe(
      (data) => {
        setReturns(data);
        setLoading(false);
      },
      [orderBy("createdAt", "desc")]
    );
    return unsub;
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return returns.filter((r) => {
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (
        q &&
        !r.orderNumber.toLowerCase().includes(q) &&
        !r.productName.toLowerCase().includes(q) &&
        !r.customerName.toLowerCase().includes(q) &&
        !r.customerEmail.toLowerCase().includes(q) &&
        !(r.sku ?? "").toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [returns, search, statusFilter]);

  const columns: DataTableColumn<AdminReturn>[] = [
    {
      key: "product",
      header: t("admin.returns.colProduct"),
      sortValue: (r) => r.productName,
      render: (r) => (
        <div>
          <p className="font-medium text-ink">{r.productName}</p>
          <p className="text-xs text-ink-faint">
            {r.colorName} · {r.size} · ×{r.qty}
            {r.sku ? ` · ${r.sku}` : ""}
          </p>
        </div>
      ),
    },
    {
      key: "order",
      header: t("admin.orders.colOrder"),
      sortValue: (r) => r.orderNumber,
      render: (r) => <span className="font-semibold text-ink">#{r.orderNumber}</span>,
    },
    {
      key: "customer",
      header: t("admin.orders.colCustomer"),
      sortValue: (r) => r.customerName,
      render: (r) => (
        <div>
          <p className="text-ink">{r.customerName}</p>
          <p className="text-xs text-ink-faint">{r.customerEmail}</p>
        </div>
      ),
    },
    {
      key: "reason",
      header: t("admin.returns.colReason"),
      sortValue: (r) => r.reason,
      render: (r) => <span className="text-ink-soft">{t(RETURN_REASON_LABEL_KEY[r.reason])}</span>,
    },
    {
      key: "status",
      header: t("admin.products.colStatus"),
      sortValue: (r) => r.status,
      render: (r) => {
        const dispositionKey = returnDispositionLabelKey(r.disposition);
        return (
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={RETURN_STATUS_TONE[r.status]}>{t(RETURN_STATUS_LABEL_KEY[r.status])}</Badge>
            {dispositionKey && <Badge tone={returnDispositionTone(r.disposition)}>{t(dispositionKey)}</Badge>}
          </div>
        );
      },
    },
    {
      key: "date",
      header: t("admin.returns.colDate"),
      sortValue: (r) => tsToDate(r.createdAt)?.getTime() ?? 0,
      render: (r) => {
        const d = tsToDate(r.createdAt);
        return <span className="text-xs text-ink-faint">{d ? d.toLocaleDateString(lang === "ar" ? "ar" : "en-US") : ""}</span>;
      },
    },
  ];

  return (
    <div>
      <PageHeader title={t("admin.nav.returns")} description={`${returns.length} ${t("admin.products.total")}`} />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SearchInput value={search} onChange={setSearch} placeholder={t("admin.returns.searchPlaceholder")} />
        <AdminSelect value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as ReturnStatus | "all")} className="w-auto">
          <option value="all">{t("admin.products.allStatuses")}</option>
          <option value="quarantine">{t(RETURN_STATUS_LABEL_KEY.quarantine)}</option>
          <option value="needs_repair">{t(RETURN_STATUS_LABEL_KEY.needs_repair)}</option>
          <option value="resolved">{t(RETURN_STATUS_LABEL_KEY.resolved)}</option>
        </AdminSelect>
      </div>

      <DataTable
        columns={columns}
        rows={filtered}
        getId={(r) => r.id}
        loading={loading}
        onRowClick={(r) => navigate(`/admin/returns/${r.id}`)}
        emptyState={<EmptyState icon="history" title={t("admin.returns.noneYet")} body={t("admin.returns.emptyBody")} />}
      />
    </div>
  );
}
