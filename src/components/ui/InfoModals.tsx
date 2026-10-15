import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";
import { where } from "firebase/firestore";
import type { DeliveryZone, ShippingSettingsDoc } from "../../admin/types";
import { useLanguage } from "../../context/LanguageContext";
import { SHIPPING_DEFAULTS } from "../../data/deliveryZones";
import { localizedName } from "../../data/localize";
import { deliveryZonesApi } from "../../firebase/collections";
import { getSingletonDoc } from "../../firebase/firestore";
import { formatPrice } from "../../utils/currency";

// Storefront counterpart to src/admin/components/Modal.tsx (which lives
// behind the admin bundle and pulls in admin-only UI), kept deliberately
// small: overlay + centered panel + close button, same motion/Tailwind
// vocabulary as the rest of the storefront.
export function StoreModal({
  open,
  onClose,
  title,
  children,
  preventClose = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  // Blocks the backdrop click / Escape / × close while some in-flight action
  // (e.g. order submission) shouldn't be interrupted — the caller still owns
  // its own explicit Cancel button, if any, and decides whether that stays
  // enabled. Defaults to false so every existing caller is unaffected.
  preventClose?: boolean;
}) {
  const { t } = useLanguage();

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !preventClose) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, preventClose]);

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[150] flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="absolute inset-0 bg-ink/40 backdrop-blur-[2px]"
            onClick={() => {
              if (!preventClose) onClose();
            }}
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={title}
            initial={{ opacity: 0, y: 16, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.98 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            data-lenis-prevent
            className="relative z-10 max-h-[88dvh] w-full max-w-lg overflow-y-auto rounded-2xl bg-paper text-ink shadow-lift"
          >
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-paper px-6 py-4">
              <h2 className="font-display text-lg font-bold text-ink">{title}</h2>
              <button
                onClick={onClose}
                disabled={preventClose}
                aria-label={t("guides.close")}
                className="flex h-9 w-9 items-center justify-center rounded-full text-xl leading-none text-ink-soft hover:bg-cream-dim hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
              >
                ×
              </button>
            </div>
            <div className="px-6 py-5">{children}</div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

// Static, clearly-labelled general guide — measurements in cm. Not
// per-product data (the catalog doesn't carry any), which is exactly why the
// intro copy says "a general guide only".
const SIZE_CHART = [
  { size: "S", bust: "86–90", waist: "68–72", hips: "92–96" },
  { size: "M", bust: "91–95", waist: "73–77", hips: "97–101" },
  { size: "L", bust: "96–101", waist: "78–83", hips: "102–107" },
  { size: "XL", bust: "102–108", waist: "84–90", hips: "108–114" },
];

export function SizeGuideModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useLanguage();

  return (
    <StoreModal open={open} onClose={onClose} title={t("guides.sizeGuideTitle")}>
      <p className="text-sm text-ink-soft">{t("guides.sizeGuideIntro")}</p>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[22rem] border-collapse text-sm">
          <thead>
            <tr className="border-b border-line text-start text-ink-soft">
              <th className="py-2 pe-3 text-start font-semibold">{t("guides.colSize")}</th>
              <th className="py-2 pe-3 text-start font-semibold">{t("guides.colBust")}</th>
              <th className="py-2 pe-3 text-start font-semibold">{t("guides.colWaist")}</th>
              <th className="py-2 text-start font-semibold">{t("guides.colHips")}</th>
            </tr>
          </thead>
          <tbody>
            {SIZE_CHART.map((row) => (
              <tr key={row.size} className="border-b border-line last:border-0">
                <td className="py-2.5 pe-3 font-bold text-ink">{row.size}</td>
                <td className="py-2.5 pe-3 text-ink-soft">{row.bust}</td>
                <td className="py-2.5 pe-3 text-ink-soft">{row.waist}</td>
                <td className="py-2.5 text-ink-soft">{row.hips}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-4 text-xs leading-relaxed text-ink-faint">{t("guides.sizeGuideNote")}</p>
    </StoreModal>
  );
}

export function ShippingReturnsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { lang, t } = useLanguage();
  const [shipping, setShipping] = useState<ShippingSettingsDoc>(SHIPPING_DEFAULTS);
  const [zones, setZones] = useState<DeliveryZone[]>([]);

  // Real numbers straight from the admin's Delivery Zones + Shipping
  // settings, the same collections Checkout.tsx reads. Fetched lazily on
  // first open so the footer never pays for it on every page load. Only
  // active zones -- an inactive one is never shown to a customer anywhere.
  // Deliberately does NOT mention the free-shipping threshold here (or
  // anywhere else customer-facing) -- see Checkout.tsx's own note on why
  // that setting stays admin-only for now.
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!open || loaded) return;
    setLoaded(true);
    getSingletonDoc<ShippingSettingsDoc>("settings", "shipping").then((doc) => {
      if (doc) setShipping({ ...SHIPPING_DEFAULTS, ...doc });
    });
    deliveryZonesApi.list([where("active", "==", true)]).then((data) => {
      setZones([...data].sort((a, b) => a.sortOrder - b.sortOrder));
    });
  }, [open, loaded]);

  return (
    <StoreModal open={open} onClose={onClose} title={t("guides.shippingReturnsTitle")}>
      <h3 className="font-display text-base font-bold text-ink">{t("guides.shippingHeading")}</h3>
      {zones.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-2 text-sm text-ink-soft">
          {zones.map((zone) => (
            <li key={zone.id} className="flex flex-wrap items-baseline justify-between gap-2">
              <span>{localizedName(zone.name, zone.nameAr, lang)}</span>
              <span className="font-semibold text-ink">{formatPrice(zone.fee)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-ink-soft">{t("checkout.noDeliveryZones")}</p>
      )}

      <h3 className="mt-6 font-display text-base font-bold text-ink">{t("guides.returnsHeading")}</h3>
      <p className="mt-2 flex flex-wrap items-baseline justify-between gap-2 text-sm text-ink-soft">
        <span>{t("guides.returnsWindow")}</span>
        <span className="font-semibold text-ink">
          {shipping.returnWindowDays} {t("guides.returnsDays")}
        </span>
      </p>
      <p className="mt-2 text-sm leading-relaxed text-ink-soft">{t("guides.returnsBody")}</p>
    </StoreModal>
  );
}
