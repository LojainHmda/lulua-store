import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { customersApi } from "../../firebase/collections";
import { useLanguage } from "../../context/LanguageContext";
import { useAdminAuth } from "../AdminAuthContext";
import DataTable, { BulkActionBar, type DataTableColumn } from "../components/DataTable";
import { ConfirmDialog, Modal } from "../components/Modal";
import { useToast } from "../components/ToastContext";
import { AdminButton, AdminInput, AdminTextarea, EmptyState, Field, PageHeader, SearchInput } from "../components/ui";
import { logActivity } from "../logActivity";
import type { AdminCustomer } from "../types";
import { formatPrice } from "../../utils/currency";

const BLANK = { name: "", email: "", phone: "", notes: "" };

export default function CustomerList() {
  const toast = useToast();
  const navigate = useNavigate();
  const { t } = useLanguage();
  const { profile, hasRole } = useAdminAuth();
  const canWrite = hasRole(["owner", "admin"]);
  const [customers, setCustomers] = useState<AdminCustomer[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<AdminCustomer | null>(null);
  const [form, setForm] = useState(BLANK);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<AdminCustomer | AdminCustomer[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    const unsub = customersApi.subscribe((data) => {
      setCustomers(data);
      setLoading(false);
    });
    return unsub;
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return customers;
    return customers.filter((c) => c.name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q));
  }, [customers, search]);

  function openCreate() {
    setEditing(null);
    setForm(BLANK);
    setShowForm(true);
  }

  function openEdit(c: AdminCustomer) {
    setEditing(c);
    setForm({ name: c.name, email: c.email, phone: c.phone ?? "", notes: c.notes ?? "" });
    setShowForm(true);
  }

  async function handleSave() {
    if (!form.name.trim() || !form.email.trim()) {
      toast.error(t("admin.customers.errRequired"));
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        await customersApi.update(editing.id, form);
        if (profile) await logActivity(profile, "customer.updated", form.name);
      } else {
        await customersApi.create({ ...form, ordersCount: 0, totalSpent: 0 });
        if (profile) await logActivity(profile, "customer.added", form.name);
      }
      toast.success(t("admin.customers.saved"));
      setShowForm(false);
    } finally {
      setSaving(false);
    }
  }

  async function performDelete(targets: AdminCustomer[]) {
    await Promise.all(targets.map((c) => customersApi.remove(c.id)));
    if (profile) await logActivity(profile, "customer.deleted", targets.map((c) => c.name).join(", "));
    toast.success(targets.length > 1 ? `${targets.length} ${t("admin.customers.deletedPlural")}` : t("admin.customers.deleted"));
    setSelected(new Set());
    setConfirmDelete(null);
  }

  const columns: DataTableColumn<AdminCustomer>[] = [
    { key: "name", header: t("admin.categories.name"), sortValue: (c) => c.name, render: (c) => (
      <div>
        <p className="font-semibold text-ink">{c.name}</p>
        <p className="text-xs text-ink-faint">{c.email}</p>
      </div>
    ) },
    { key: "orders", header: t("admin.nav.orders"), sortValue: (c) => c.ordersCount, render: (c) => c.ordersCount },
    { key: "spent", header: t("admin.customers.totalSpent"), sortValue: (c) => c.totalSpent, render: (c) => formatPrice(c.totalSpent) },
    { key: "phone", header: t("admin.settings.phone"), render: (c) => c.phone || "—" },
    canWrite
      ? {
          key: "actions",
          header: "",
          render: (c) => (
            <div className="flex justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
              <button onClick={() => openEdit(c)} className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-ink-soft hover:bg-cream-dim hover:text-ink">
                {t("admin.customers.edit")}
              </button>
              <button onClick={() => setConfirmDelete(c)} className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-wine hover:bg-wine-light">
                {t("admin.products.delete")}
              </button>
            </div>
          ),
          headerClassName: "text-end",
          className: "text-end",
        }
      : { key: "spacer", header: "", render: () => null },
  ];

  return (
    <div>
      <PageHeader
        title={t("admin.nav.customers")}
        description={`${customers.length} ${t("admin.products.total")} — ${t("admin.customers.registeredOnlyNote")}`}
        actions={canWrite && <AdminButton variant="primary" icon="plus" onClick={openCreate}>{t("admin.customers.addCustomer")}</AdminButton>}
      />

      <div className="mb-4">
        <SearchInput value={search} onChange={setSearch} placeholder={t("admin.customers.searchPlaceholder")} />
      </div>

      {canWrite && (
        <BulkActionBar count={selected.size} onClear={() => setSelected(new Set())}>
          <AdminButton
            size="sm"
            variant="ghost"
            className="!text-paper hover:!bg-paper/15"
            onClick={() => setConfirmDelete(customers.filter((c) => selected.has(c.id)))}
          >
            {t("admin.customers.deleteSelected")}
          </AdminButton>
        </BulkActionBar>
      )}

      <DataTable
        columns={columns}
        rows={filtered}
        getId={(c) => c.id}
        loading={loading}
        selectable={canWrite}
        selected={selected}
        onSelectionChange={setSelected}
        defaultSort="name"
        onRowClick={(c) => navigate(`/admin/customers/${c.id}`)}
        emptyState={<EmptyState icon="users" title={t("admin.customers.noneYet")} body={t("admin.customers.emptyBody")} />}
      />

      <Modal open={showForm} onClose={() => setShowForm(false)} title={editing ? t("admin.customers.editCustomer") : t("admin.customers.addCustomer")} width="sm">
        <div className="flex flex-col gap-4">
          <Field label={t("admin.categories.name")} required>
            <AdminInput value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
          </Field>
          <Field label={t("admin.login.email")} required>
            <AdminInput type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
          </Field>
          <Field label={t("admin.settings.phone")}>
            <AdminInput value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} />
          </Field>
          <Field label={t("admin.customers.notes")}>
            <AdminTextarea rows={3} value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
          </Field>
          <AdminButton variant="primary" loading={saving} className="w-full justify-center" onClick={handleSave}>
            {editing ? t("admin.settings.save") : t("admin.customers.addCustomer")}
          </AdminButton>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && performDelete(Array.isArray(confirmDelete) ? confirmDelete : [confirmDelete])}
        title={t("admin.customers.deleteCustomer")}
        body={
          Array.isArray(confirmDelete)
            ? `${confirmDelete.length} ${t("admin.customers.deleteBodyPlural")}`
            : `"${confirmDelete?.name}" ${t("admin.customers.deleteBody")}`
        }
        confirmLabel={t("admin.products.delete")}
        danger
      />
    </div>
  );
}
