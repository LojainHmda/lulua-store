import { doc, serverTimestamp, updateDoc, where } from "../db/firestore";
import { useEffect, useState } from "react";
import type { CustomerAddress, DeliveryZone } from "../admin/types";
import AccountShell from "../components/account/AccountShell";
import Button from "../components/ui/Button";
import { StoreModal } from "../components/ui/InfoModals";
import { useCustomerAuth } from "../context/CustomerAuthContext";
import { useLanguage } from "../context/LanguageContext";
import { localizedName } from "../data/localize";
import { db } from "../firebase/config";
import { deliveryZonesApi } from "../firebase/collections";

function newAddressId(): string {
  return typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `addr_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

export default function AccountAddresses() {
  const { firebaseUser, profile } = useCustomerAuth();
  const { lang, t } = useLanguage();
  const addresses = profile?.addresses ?? [];

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [deliveryZoneId, setDeliveryZoneId] = useState("");
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Same "active zones only, fetched once" shape Checkout.tsx uses -- an
  // address saved against a since-deactivated zone still keeps its stored
  // id (never rewritten here), it just won't show up as a re-selectable
  // option, matching "never expose inactive zones to customers".
  const [zones, setZones] = useState<DeliveryZone[]>([]);
  useEffect(() => {
    deliveryZonesApi.list([where("active", "==", true)]).then((data) => {
      setZones([...data].sort((a, b) => a.sortOrder - b.sortOrder));
    });
  }, []);

  function openAdd() {
    setEditingId(null);
    setText("");
    setDeliveryZoneId("");
    setModalOpen(true);
  }

  function openEdit(a: CustomerAddress) {
    setEditingId(a.id);
    setText(a.address);
    // Older addresses saved before this feature existed have no zone yet --
    // this surfaces as an empty, required selection the customer must fill
    // in before the edit can be saved (see the Save button's disabled
    // condition below), rather than silently guessing one for them.
    setDeliveryZoneId(a.deliveryZoneId ?? "");
    setModalOpen(true);
  }

  async function persist(next: CustomerAddress[]) {
    if (!firebaseUser) return;
    await updateDoc(doc(db, "customers", firebaseUser.uid), { addresses: next, updatedAt: serverTimestamp() });
  }

  async function handleSave() {
    const trimmed = text.trim();
    if (!trimmed || !deliveryZoneId || !firebaseUser) return;
    setSaving(true);
    try {
      const next = editingId
        ? addresses.map((a) => (a.id === editingId ? { ...a, address: trimmed, deliveryZoneId } : a))
        : [...addresses, { id: newAddressId(), address: trimmed, deliveryZoneId, isDefault: addresses.length === 0 }];
      await persist(next);
      setModalOpen(false);
    } finally {
      setSaving(false);
    }
  }

  function zoneLabel(a: CustomerAddress): string | null {
    const zone = zones.find((z) => z.id === a.deliveryZoneId);
    return zone ? localizedName(zone.name, zone.nameAr, lang) : null;
  }

  async function handleDelete(id: string) {
    setBusyId(id);
    try {
      const removingDefault = addresses.find((a) => a.id === id)?.isDefault ?? false;
      let next = addresses.filter((a) => a.id !== id);
      // A default address that gets deleted hands the title to whatever's
      // left, rather than leaving addresses with no default at all.
      if (removingDefault && next.length > 0) next = next.map((a, i) => ({ ...a, isDefault: i === 0 }));
      await persist(next);
    } finally {
      setBusyId(null);
    }
  }

  async function handleSetDefault(id: string) {
    setBusyId(id);
    try {
      await persist(addresses.map((a) => ({ ...a, isDefault: a.id === id })));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <AccountShell title={t("account.myAccount")}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-ink-soft">{t("account.addressesSub")}</p>
          <Button variant="primary" size="sm" onClick={openAdd}>
            {t("account.addAddress")}
          </Button>
        </div>

        {addresses.length === 0 ? (
          <div className="rounded-2xl bg-paper p-8 text-center shadow-soft">
            <p className="font-display text-xl font-bold text-ink">{t("account.noAddresses")}</p>
            <p className="mt-1.5 text-base text-ink-soft">{t("account.noAddressesSub")}</p>
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {addresses.map((a) => (
              <li key={a.id} className="flex flex-col gap-3 rounded-2xl bg-paper p-5 shadow-soft sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 flex-1">
                  {a.isDefault && (
                    <span className="mb-2 inline-block rounded-full bg-sand px-2.5 py-1 text-xs font-bold uppercase tracking-wide text-wine-dark">
                      {t("account.defaultAddress")}
                    </span>
                  )}
                  <p className="whitespace-pre-line text-sm text-ink">{a.address}</p>
                  {zoneLabel(a) && <p className="mt-1 text-xs text-ink-soft">{zoneLabel(a)}</p>}
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-4 text-sm font-semibold">
                  {!a.isDefault && (
                    <button
                      type="button"
                      disabled={busyId === a.id}
                      onClick={() => void handleSetDefault(a.id)}
                      className="text-wine underline-offset-2 hover:underline disabled:opacity-50"
                    >
                      {t("account.setDefault")}
                    </button>
                  )}
                  <button type="button" onClick={() => openEdit(a)} className="text-ink-soft underline-offset-2 hover:text-wine hover:underline">
                    {t("account.editAddress")}
                  </button>
                  <button
                    type="button"
                    disabled={busyId === a.id}
                    onClick={() => void handleDelete(a.id)}
                    className="text-ink-soft underline-offset-2 hover:text-wine hover:underline disabled:opacity-50"
                  >
                    {t("cart.remove")}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <StoreModal open={modalOpen} onClose={() => setModalOpen(false)} title={editingId ? t("account.editAddress") : t("account.addAddress")}>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold text-ink">{t("checkout.address")}</span>
          <textarea
            autoFocus
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t("checkout.addressPlaceholder")}
            className="rounded-xl border border-line bg-paper px-4 py-3 text-base outline-none placeholder:text-ink-faint focus:border-wine"
          />
        </label>

        <label className="mt-4 flex flex-col gap-1.5">
          <span className="text-sm font-semibold text-ink">{t("checkout.deliveryZone")}</span>
          {zones.length === 0 ? (
            <p className="rounded-xl bg-cream-dim px-4 py-3.5 text-sm text-ink-soft">{t("checkout.noDeliveryZones")}</p>
          ) : (
            <select
              required
              value={deliveryZoneId}
              onChange={(e) => setDeliveryZoneId(e.target.value)}
              className="rounded-xl border border-line bg-paper px-4 py-3 text-base outline-none focus:border-wine"
            >
              <option value="" disabled>
                {t("checkout.deliveryZonePlaceholder")}
              </option>
              {zones.map((zone) => (
                <option key={zone.id} value={zone.id}>
                  {localizedName(zone.name, zone.nameAr, lang)}
                </option>
              ))}
            </select>
          )}
        </label>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setModalOpen(false)}
            className="rounded-full px-4 py-2.5 text-sm font-semibold text-ink-soft hover:bg-cream-dim"
          >
            {t("account.cancel")}
          </button>
          <Button variant="primary" disabled={saving || !text.trim() || !deliveryZoneId} onClick={() => void handleSave()}>
            {t("account.saveChanges")}
          </Button>
        </div>
      </StoreModal>
    </AccountShell>
  );
}
