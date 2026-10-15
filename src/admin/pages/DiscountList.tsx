import { useEffect, useState } from "react";
import { discountsApi } from "../../firebase/collections";
import { useLanguage } from "../../context/LanguageContext";
import { useAdminAuth } from "../AdminAuthContext";
import DataTable, { BulkActionBar, type DataTableColumn } from "../components/DataTable";
import { ConfirmDialog, Modal } from "../components/Modal";
import { useToast } from "../components/ToastContext";
import { AdminButton, AdminInput, AdminNumberInput, AdminSelect, Badge, EmptyState, Field, PageHeader, Toggle } from "../components/ui";
import { logActivity } from "../logActivity";
import type { AdminDiscount, DiscountType } from "../types";
import { formatPrice } from "../../utils/currency";

const BLANK = { code: "", type: "percent" as DiscountType, value: 10, active: true, expiresAt: "", usageLimit: undefined as number | undefined, minSubtotal: undefined as number | undefined };

export default function DiscountList() {
  const toast = useToast();
  const { t } = useLanguage();
  const { profile, hasRole } = useAdminAuth();
  const canWrite = hasRole(["owner", "admin", "editor"]);
  const [discounts, setDiscounts] = useState<AdminDiscount[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<AdminDiscount | null>(null);
  const [form, setForm] = useState(BLANK);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<AdminDiscount | AdminDiscount[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    const unsub = discountsApi.subscribe((data) => {
      setDiscounts(data);
      setLoading(false);
    });
    return unsub;
  }, []);

  function openCreate() {
    setEditing(null);
    setForm(BLANK);
    setShowForm(true);
  }

  function openEdit(d: AdminDiscount) {
    setEditing(d);
    setForm({ code: d.code, type: d.type, value: d.value, active: d.active, expiresAt: d.expiresAt ?? "", usageLimit: d.usageLimit, minSubtotal: d.minSubtotal });
    setShowForm(true);
  }

  async function handleSave() {
    if (!form.code.trim()) {
      toast.error(t("admin.discounts.errRequired"));
      return;
    }
    if (!(form.value > 0)) {
      toast.error(t("admin.discounts.errValuePositive"));
      return;
    }
    if (form.type === "percent" && form.value > 100) {
      toast.error(t("admin.discounts.errPercentRange"));
      return;
    }
    if (form.expiresAt) {
      const today = new Date().toISOString().slice(0, 10);
      if (form.expiresAt < today) {
        toast.error(t("admin.discounts.errExpiresPast"));
        return;
      }
    }
    setSaving(true);
    try {
      const payload = { ...form, code: form.code.trim().toUpperCase() };
      if (editing) {
        await discountsApi.update(editing.id, payload);
        if (profile) await logActivity(profile, "discount.updated", payload.code);
      } else {
        await discountsApi.create({ ...payload, usageCount: 0 });
        if (profile) await logActivity(profile, "discount.created", payload.code);
      }
      toast.success(t("admin.discounts.saved"));
      setShowForm(false);
    } finally {
      setSaving(false);
    }
  }

  async function performDelete(targets: AdminDiscount[]) {
    await Promise.all(targets.map((d) => discountsApi.remove(d.id)));
    if (profile) await logActivity(profile, "discount.deleted", targets.map((d) => d.code).join(", "));
    toast.success(targets.length > 1 ? `${targets.length} ${t("admin.discounts.deletedPlural")}` : t("admin.discounts.deleted"));
    setSelected(new Set());
    setConfirmDelete(null);
  }

  async function toggleActive(d: AdminDiscount) {
    await discountsApi.update(d.id, { active: !d.active });
  }

  async function performDeactivate(targets: AdminDiscount[]) {
    await Promise.all(targets.filter((d) => d.active).map((d) => discountsApi.update(d.id, { active: false })));
    if (profile) await logActivity(profile, "discount.updated", targets.map((d) => d.code).join(", "));
    toast.success(`${targets.length} ${t("admin.discounts.deactivatedPlural")}`);
    setSelected(new Set());
  }

  const columns: DataTableColumn<AdminDiscount>[] = [
    { key: "code", header: t("admin.discounts.code"), sortValue: (d) => d.code, render: (d) => <span className="font-mono font-bold text-ink">{d.code}</span> },
    { key: "value", header: t("admin.discounts.discountCol"), sortValue: (d) => d.value, render: (d) => (d.type === "percent" ? `${d.value}%` : formatPrice(d.value)) },
    { key: "usage", header: t("admin.discounts.used"), sortValue: (d) => d.usageCount, render: (d) => `${d.usageCount}${d.usageLimit != null ? ` / ${d.usageLimit}` : ""}` },
    { key: "expires", header: t("admin.discounts.expires"), render: (d) => d.expiresAt || t("admin.discounts.never") },
    {
      key: "active",
      header: t("admin.products.colStatus"),
      render: (d) => (
        <div onClick={(e) => e.stopPropagation()}>
          {canWrite ? (
            <Toggle checked={d.active} onChange={() => toggleActive(d)} />
          ) : (
            <Badge tone={d.active ? "success" : "neutral"}>{d.active ? t("admin.discounts.active") : t("admin.discounts.inactive")}</Badge>
          )}
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title={t("admin.nav.discounts")}
        description={`${discounts.length} ${t("admin.products.total")}`}
        actions={canWrite && <AdminButton variant="primary" icon="plus" onClick={openCreate}>{t("admin.discounts.addDiscount")}</AdminButton>}
      />

      {canWrite && (
        <BulkActionBar count={selected.size} onClear={() => setSelected(new Set())}>
          <AdminButton
            size="sm"
            variant="ghost"
            className="!text-paper hover:!bg-paper/15"
            onClick={() => performDeactivate(discounts.filter((d) => selected.has(d.id)))}
          >
            {t("admin.discounts.deactivateSelected")}
          </AdminButton>
          <AdminButton
            size="sm"
            variant="ghost"
            className="!text-paper hover:!bg-paper/15"
            onClick={() => setConfirmDelete(discounts.filter((d) => selected.has(d.id)))}
          >
            {t("admin.discounts.deleteSelected")}
          </AdminButton>
        </BulkActionBar>
      )}

      <DataTable
        columns={columns}
        rows={discounts}
        getId={(d) => d.id}
        loading={loading}
        selectable={canWrite}
        selected={selected}
        onSelectionChange={setSelected}
        onRowClick={canWrite ? openEdit : undefined}
        defaultSort="code"
        emptyState={<EmptyState icon="tag" title={t("admin.discounts.noneYet")} body={t("admin.discounts.emptyBody")} action={canWrite && <AdminButton variant="primary" icon="plus" onClick={openCreate}>{t("admin.discounts.addDiscount")}</AdminButton>} />}
      />

      <Modal open={showForm} onClose={() => setShowForm(false)} title={editing ? t("admin.discounts.editDiscount") : t("admin.discounts.addDiscount")} width="sm">
        <div className="flex flex-col gap-4">
          <Field label={t("admin.discounts.code")} required hint={t("admin.discounts.codeHint")}>
            <AdminInput value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))} placeholder="SUMMER20" />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label={t("admin.discounts.type")}>
              <AdminSelect value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as DiscountType }))}>
                <option value="percent">{t("admin.discounts.percentOff")}</option>
                <option value="fixed">{t("admin.discounts.fixedAmount")}</option>
              </AdminSelect>
            </Field>
            <Field label={t("admin.discounts.value")} required>
              <AdminNumberInput min={0} value={form.value} onChange={(v) => v !== null && setForm((f) => ({ ...f, value: v }))} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Field label={t("admin.discounts.usageLimit")} hint={t("admin.discounts.usageLimitHint")}>
              <AdminNumberInput
                min={0}
                integerOnly
                nullable
                value={form.usageLimit ?? null}
                onChange={(v) => setForm((f) => ({ ...f, usageLimit: v ?? undefined }))}
              />
            </Field>
            <Field label={t("admin.discounts.minSubtotal")}>
              <AdminNumberInput
                min={0}
                nullable
                value={form.minSubtotal ?? null}
                onChange={(v) => setForm((f) => ({ ...f, minSubtotal: v ?? undefined }))}
              />
            </Field>
          </div>
          <Field label={t("admin.discounts.expires")} hint={t("admin.discounts.expiresHint")}>
            <AdminInput type="date" value={form.expiresAt} onChange={(e) => setForm((f) => ({ ...f, expiresAt: e.target.value }))} />
          </Field>
          <label className="flex items-center justify-between rounded-lg border border-line px-3.5 py-2.5">
            <span className="text-sm font-semibold text-ink">{t("admin.discounts.active")}</span>
            <Toggle checked={form.active} onChange={(v) => setForm((f) => ({ ...f, active: v }))} />
          </label>
          <AdminButton variant="primary" loading={saving} className="w-full justify-center" onClick={handleSave}>
            {editing ? t("admin.settings.save") : t("admin.discounts.createDiscount")}
          </AdminButton>
          {editing && (
            <AdminButton variant="danger" className="w-full justify-center" onClick={() => setConfirmDelete(editing)}>
              {t("admin.discounts.deleteDiscount")}
            </AdminButton>
          )}
        </div>
      </Modal>

      <ConfirmDialog
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => {
          if (confirmDelete) performDelete(Array.isArray(confirmDelete) ? confirmDelete : [confirmDelete]);
          setShowForm(false);
        }}
        title={t("admin.discounts.deleteDiscount")}
        body={
          Array.isArray(confirmDelete)
            ? `${confirmDelete.length} ${t("admin.discounts.deleteBodyPlural")}`
            : `"${confirmDelete?.code}" ${t("admin.discounts.deleteBody")}`
        }
        confirmLabel={t("admin.products.delete")}
        danger
      />
    </div>
  );
}
