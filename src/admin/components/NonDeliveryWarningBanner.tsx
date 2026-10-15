import { useEffect, useMemo, useState } from "react";
import { where } from "firebase/firestore";
import { ordersApi } from "../../firebase/collections";
import { useLanguage } from "../../context/LanguageContext";
import AdminIcon from "./AdminIcons";
import { findNonDeliveryMatches } from "../nonDeliveryMatch";
import type { AdminOrder } from "../types";

function formatOrderDate(value: unknown): string {
  const ts = value as { toDate?: () => Date } | undefined;
  const date = ts?.toDate ? ts.toDate() : null;
  // Explicit locale, not the browser/OS default: toLocaleDateString() with
  // no locale argument can inject invisible bidi control characters (seen
  // in this environment even for the English admin UI), which then
  // visually garbles the digit order once embedded in a narrow container.
  // en-GB gives a plain, unambiguous D/M/YYYY with no directional marks.
  return date ? date.toLocaleDateString("en-GB") : "";
}

// Mounted inside OrderList.tsx's "New Order" modal. Fetches the (small,
// bounded) set of orders ever flagged non-delivery once when the modal
// opens, then matches purely client-side as the employee types — so
// keystrokes never trigger a Firestore read, and completeness doesn't
// depend on a "most recent N" cap the way GlobalOrdersSidebarPanel's
// general order search does.
export default function NonDeliveryWarningBanner({ name, phone }: { name: string; phone: string }) {
  const { t } = useLanguage();
  const [flagged, setFlagged] = useState<AdminOrder[]>([]);

  useEffect(() => {
    let cancelled = false;
    ordersApi.list([where("nonDeliveryFlagged", "==", true)]).then((orders) => {
      if (!cancelled) setFlagged(orders);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const matches = useMemo(() => findNonDeliveryMatches(flagged, name, phone), [flagged, name, phone]);

  if (matches.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-wine/30 bg-wine-light px-3.5 py-3">
      <div className="flex items-center gap-2">
        <AdminIcon name="alertTriangle" className="h-4 w-4 shrink-0 text-wine" />
        <p className="text-sm font-bold text-wine">{t("admin.orders.nonDelivery.warningTitle")}</p>
      </div>
      <ul className="flex flex-col gap-2">
        {matches.map(({ order, matchType }) => (
          <li key={order.id} className="text-xs text-wine">
            <p className="font-semibold">
              {matchType === "phone" ? t("admin.orders.nonDelivery.warningPhoneMatch") : t("admin.orders.nonDelivery.warningNameMatch")}
            </p>
            <p className="mt-0.5 text-wine/80">
              {t("admin.orders.nonDelivery.orderRef").replace("{n}", order.orderNumber).replace("{date}", formatOrderDate(order.createdAt))}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
