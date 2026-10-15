import { useEffect, useState } from "react";
import { deliveryZonesApi } from "../../firebase/collections";
import { useLanguage } from "../../context/LanguageContext";
import { useAdminAuth } from "../AdminAuthContext";
import DataTable, { BulkActionBar, type DataTableColumn } from "../components/DataTable";
import { Modal } from "../components/Modal";
import { useToast } from "../components/ToastContext";
import { AdminButton, AdminInput, AdminNumberInput, Badge, EmptyState, Field, PageHeader, Toggle } from "../components/ui";
import { logActivity } from "../logActivity";
import type { DeliveryZone } from "../types";
import { formatPrice } from "../../utils/currency";

// Mirrors DiscountList.tsx's list/modal pattern (DataTable, Modal,
// bulk-action bar, canWrite gate) -- with one deliberate difference: there
// is NO delete here, by design. A zone must be managed through
// activate/deactivate only (firestore.rules has no delete rule for
// deliveryZones/{id} at all, not even for owner) so a historical order's
// denormalized deliveryZoneId/Name/NameAr can never end up pointing at a
// removed document.
const BLANK = { name: "", nameAr: "", fee: 0, active: true, sortOrder: 0 };

export default function DeliveryZones() {
  const toast = useToast();
  const { t } = useLanguage();
  const { profile, hasRole } = useAdminAuth();
  const canWrite = hasRole(["owner", "admin", "editor"]);
  const [zones, setZones] = useState<DeliveryZone[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<DeliveryZone | null>(null);
  const [form, setForm] = useState(BLANK);
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    const unsub = deliveryZonesApi.subscribe((data) => {
      setZones(data);
      setLoading(false);
    });
    return unsub;
  }, []);

  function openCreate() {
    setEditing(null);
    setForm({ ...BLANK, sortOrder: zones.length });
    setShowForm(true);
  }

  function openEdit(z: DeliveryZone) {
    setEditing(z);
    setForm({ name: z.name, nameAr: z.nameAr, fee: z.fee, active: z.active, sortOrder: z.sortOrder });
    setShowForm(true);
  }

  async function handleSave() {
    if (!form.name.trim()) {
      toast.error(t("admin.deliveryZones.errNameRequired"));
      return;
    }
    if (!form.nameAr.trim()) {
      toast.error(t("admin.deliveryZones.errNameArRequired"));
      return;
    }
    if (!(Number.isFinite(form.fee) && form.fee >= 0)) {
      toast.error(t("admin.deliveryZones.errFeeInvalid"));
      return;
    }
    setSaving(true);
    try {
      const payload = { name: form.name.trim(), nameAr: form.nameAr.trim(), fee: form.fee, active: form.active, sortOrder: form.sortOrder };
      if (editing) {
        await deliveryZonesApi.update(editing.id, payload);
        if (profile) await logActivity(profile, "deliveryZone.updated", payload.name);
      } else {
        await deliveryZonesApi.create(payload);
        if (profile) await logActivity(profile, "deliveryZone.created", payload.name);
      }
      toast.success(t("admin.deliveryZones.saved"));
      setShowForm(false);
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(z: DeliveryZone) {
    await deliveryZonesApi.update(z.id, { active: !z.active });
  }

  async function performDeactivate(targets: DeliveryZone[]) {
    await Promise.all(targets.filter((z) => z.active).map((z) => deliveryZonesApi.update(z.id, { active: false })));
    if (profile) await logActivity(profile, "deliveryZone.updated", targets.map((z) => z.name).join(", "));
    toast.success(`${targets.length} ${t("admin.deliveryZones.deactivatedPlural")}`);
    setSelected(new Set());
  }

  const columns: DataTableColumn<DeliveryZone>[] = [
    { key: "sortOrder", header: t("admin.deliveryZones.colSortOrder"), sortValue: (z) => z.sortOrder, render: (z) => z.sortOrder },
    { key: "name", header: t("admin.deliveryZones.colName"), sortValue: (z) => z.name, render: (z) => <span className="font-semibold text-ink">{z.name}</span> },
    { key: "nameAr", header: t("admin.deliveryZones.nameAr"), sortValue: (z) => z.nameAr, render: (z) => <span dir="rtl">{z.nameAr}</span> },
    { key: "fee", header: t("admin.deliveryZones.colFee"), sortValue: (z) => z.fee, render: (z) => formatPrice(z.fee) },
    {
      key: "active",
      header: t("admin.products.colStatus"),
      render: (z) => (
        <div onClick={(e) => e.stopPropagation()}>
          {canWrite ? (
            <Toggle checked={z.active} onChange={() => toggleActive(z)} />
          ) : (
            <Badge tone={z.active ? "success" : "neutral"}>{z.active ? t("admin.deliveryZones.active") : t("admin.deliveryZones.inactive")}</Badge>
          )}
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title={t("admin.nav.deliveryZones")}
        description={`${zones.length} ${t("admin.products.total")}`}
        actions={canWrite && <AdminButton variant="primary" icon="plus" onClick={openCreate}>{t("admin.deliveryZones.addZone")}</AdminButton>}
      />

      {canWrite && (
        <BulkActionBar count={selected.size} onClear={() => setSelected(new Set())}>
          <AdminButton
            size="sm"
            variant="ghost"
            className="!text-paper hover:!bg-paper/15"
            onClick={() => performDeactivate(zones.filter((z) => selected.has(z.id)))}
          >
            {t("admin.deliveryZones.deactivateSelected")}
          </AdminButton>
        </BulkActionBar>
      )}

      <DataTable
        columns={columns}
        rows={zones}
        getId={(z) => z.id}
        loading={loading}
        selectable={canWrite}
        selected={selected}
        onSelectionChange={setSelected}
        onRowClick={canWrite ? openEdit : undefined}
        defaultSort="sortOrder"
        emptyState={<EmptyState icon="map" title={t("admin.deliveryZones.noneYet")} body={t("admin.deliveryZones.emptyBody")} action={canWrite && <AdminButton variant="primary" icon="plus" onClick={openCreate}>{t("admin.deliveryZones.addZone")}</AdminButton>} />}
      />

      <Modal open={showForm} onClose={() => setShowForm(false)} title={editing ? t("admin.deliveryZones.editZone") : t("admin.deliveryZones.addZone")} width="sm">
        <div className="flex flex-col gap-4">
          <Field label={t("admin.deliveryZones.name")} required>
            <AdminInput value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Nablus" />
          </Field>
          <Field label={t("admin.deliveryZones.nameAr")} required>
            <AdminInput dir="rtl" value={form.nameAr} onChange={(e) => setForm((f) => ({ ...f, nameAr: e.target.value }))} placeholder="نابلس" />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label={t("admin.deliveryZones.fee")} required>
              <AdminNumberInput min={0} value={form.fee} onChange={(v) => v !== null && setForm((f) => ({ ...f, fee: v }))} />
            </Field>
            <Field label={t("admin.deliveryZones.sortOrder")}>
              <AdminNumberInput integerOnly value={form.sortOrder} onChange={(v) => v !== null && setForm((f) => ({ ...f, sortOrder: v }))} />
            </Field>
          </div>
          <label className="flex items-center justify-between rounded-lg border border-line px-3.5 py-2.5">
            <span className="text-sm font-semibold text-ink">{t("admin.deliveryZones.active")}</span>
            <Toggle checked={form.active} onChange={(v) => setForm((f) => ({ ...f, active: v }))} />
          </label>
          <AdminButton variant="primary" loading={saving} className="w-full justify-center" onClick={handleSave}>
            {editing ? t("admin.settings.save") : t("admin.deliveryZones.createZone")}
          </AdminButton>
        </div>
      </Modal>
    </div>
  );
}
