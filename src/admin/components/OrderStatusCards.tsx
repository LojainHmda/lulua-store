import { useLanguage } from "../../context/LanguageContext";
import { ALL_ORDER_STATUSES } from "../orderStatusCounts";
import type { OrderStatus } from "../types";

// Square, per-status live-count cards for the /admin/orders page
// (OrderList.tsx). Purely presentational -- it takes an already-computed
// `counts` map (see countOrdersByStatus in orderStatusCounts.ts) rather than
// subscribing to Firestore itself, so this component adds zero new listeners:
// it displays whatever OrderList.tsx's own existing orders subscription
// already has in memory.
//
// Colors -- REVISION 2 (deliberate departure from this app's existing
// order-status color language, replacing REVISION 1's approach below).
//
// REVISION 1 (superseded) tried to reuse this app's existing STATUS_TONE/
// BADGE_TONE tones (neutral/warning/success/danger/info -- see OrderList.tsx,
// ui.tsx) wherever they already gave a status a distinct look, adding just
// two new muted colors where they didn't. That kept things close to the
// existing Badge palette, but it was explicitly rejected as too pale/muted,
// and it still left ready+delivered+completed sharing one identical green
// (mirroring STATUS_TONE's own grouping) -- not "each status its own clearly
// different color."
//
// REVISION 2 (current) drops that constraint entirely, per explicit
// instruction: these cards don't need to match Sisely's wine/burgundy
// branding or reuse STATUS_TONE at all -- the priority is 8 strong, fully
// saturated, unmistakably different colors, spread around the color wheel
// so no two are close enough to confuse (verified pairwise, not just
// against immediate neighbors in the grid). Each uses a solid, fully-
// saturated Tailwind shade + high-contrast text -- the same "solid
// saturated fill + light text" contrast formula this app's own primary
// wine button/active nav item already use (bg-wine text-on-accent), just
// extended across 8 hues instead of 1. Because every one of these is a
// solid, opaque, non-pastel fill, none of them need a dark-mode-specific
// override the way REVISION 1's pale backgrounds did -- a fully saturated
// card reads the same against either the light or dark page background.
// The one exception to "white text" is delivered: amber/yellow stays light
// even at high Tailwind shade numbers, so white text on it fails contrast
// (this is exactly why the previous refunded/shipped blues needed 100-shade
// pastels + dark: overrides to stay legible -- vivid yellow has the mirror
// problem). Dark text on a bright amber fill (the same convention hazard
// signage and every yellow "warning" badge already use) keeps it both
// vivid and readable.
const ORDER_STATUS_CARD_CLASSES: Record<OrderStatus, string> = {
  pending: "bg-purple-600 text-white",
  processing: "bg-orange-600 text-white",
  ready: "bg-green-600 text-white",
  shipped: "bg-blue-600 text-white",
  delivered: "bg-amber-500 text-amber-950",
  cancelled: "bg-red-600 text-white",
  refunded: "bg-fuchsia-600 text-white",
  completed: "bg-teal-600 text-white",
};

// "completed" is the one status the existing status-filter dropdown
// (OrderList.tsx) deliberately never offers -- it's the POS in-store
// terminal state, kept out of that dropdown on purpose (see OrderList.tsx's
// own comment above it) because it sits outside the shipping/preparation
// workflow the other 7 options walk through. Its card here stays
// display-only (count, no click-to-filter) so this feature never quietly
// reopens a filtering surface the app's own dropdown deliberately doesn't
// have -- clicking it would set statusFilter to a value that dropdown has no
// matching <option> for.
const CLICK_TO_FILTER: Record<OrderStatus, boolean> = {
  pending: true,
  processing: true,
  ready: true,
  shipped: true,
  delivered: true,
  cancelled: true,
  refunded: true,
  completed: false,
};

export default function OrderStatusCards({
  counts,
  activeStatus,
  onSelectStatus,
}: {
  counts: Record<OrderStatus, number>;
  activeStatus: string;
  onSelectStatus: (status: OrderStatus | "all") => void;
}) {
  const { t } = useLanguage();

  return (
    <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
      {ALL_ORDER_STATUSES.map((status) => {
        const clickable = CLICK_TO_FILTER[status];
        const isActive = activeStatus === status;
        const shared = `flex aspect-square flex-col items-center justify-center gap-1 rounded-2xl border border-line p-2 text-center transition-transform ${ORDER_STATUS_CARD_CLASSES[status]} ${
          isActive ? "ring-2 ring-wine ring-offset-2 ring-offset-cream" : ""
        } ${clickable ? "hover:-translate-y-0.5 hover:shadow-card" : ""}`;
        const content = (
          <>
            <p className="text-2xl font-extrabold tabular-nums sm:text-3xl">{counts[status]}</p>
            <p className="text-[11px] font-bold leading-tight">{t(`admin.orderStatus.${status}`)}</p>
          </>
        );
        return clickable ? (
          <button
            key={status}
            type="button"
            aria-pressed={isActive}
            onClick={() => onSelectStatus(isActive ? "all" : status)}
            className={shared}
          >
            {content}
          </button>
        ) : (
          <div key={status} className={shared} title={t("admin.orders.statusCardNotFilterable")}>
            {content}
          </div>
        );
      })}
    </div>
  );
}
