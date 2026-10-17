import { useEffect, useState } from "react";
import { where } from "../db/firestore";
import { ordersApi } from "../firebase/collections";
import { countPendingOrders, PENDING_ORDER_STATUSES } from "../admin/orderStatusCounts";
import type { AdminOrder } from "../admin/types";

// Live count of orders still in the preparation workflow (see
// orderStatusCounts.ts for exactly which canonical statuses that means and
// why), for the small badge next to "الطلبات" in AdminLayout.tsx.
//
// Reuses the app's one existing real-time order source -- ordersApi
// (createCollectionApi<AdminOrder>("orders"), the same object OrderList.tsx
// and GlobalOrdersSidebarPanel.tsx already subscribe through) via its
// .subscribe() -> onSnapshot() path. No new Firestore architecture, no
// polling. The where("status","in",PENDING_ORDER_STATUSES) constraint keeps
// the read itself narrow -- only matching documents are ever transferred --
// and countPendingOrders() re-filters what comes back so the displayed
// number stays correct even if that constraint is ever loosened. Same
// "subscribe narrow, derive the shown count via a pure filter" shape as
// NotificationBell.tsx's unreadCount.
//
// `enabled` lets a caller skip opening this listener at all for a session
// that has no reason to see the badge (AdminLayout only passes true when
// the signed-in admin can actually see the /admin/orders nav item) --
// avoids an unnecessary Firestore read for roles that would never use the
// count, without touching who is *allowed* to read orders (that stays
// entirely up to firestore.rules, untouched by this feature).
export function usePendingOrdersCount(enabled: boolean): number {
  const [orders, setOrders] = useState<AdminOrder[]>([]);

  useEffect(() => {
    if (!enabled) {
      setOrders([]);
      return;
    }
    return ordersApi.subscribe(setOrders, [where("status", "in", PENDING_ORDER_STATUSES)]);
  }, [enabled]);

  return countPendingOrders(orders);
}
