import { notificationsApi } from "../firebase/collections";
import { getSingletonDoc } from "../firebase/firestore";
import type { AdminColorVariant, NotificationPrefsDoc } from "./types";

const DEFAULT_PREFS: NotificationPrefsDoc = { lowStockAlerts: true, lowStockThreshold: 3, newOrderAlerts: true, newReviewAlerts: true };

interface LowStockCrossing {
  colorName: string;
  size: string;
  qty: number;
}

// A slot "crosses" into low stock only when its PRIOR quantity was known
// and at/above the threshold, and its NEW quantity is known and below it.
// qty: null (never confirmed) is never treated as a crossing in either
// direction — there's no real "before" to compare against, matching the
// same null-handling caution used everywhere else in this codebase (see
// productVariants.ts). This single condition is what keeps the whole
// feature duplicate-safe without any separately-persisted "already
// notified" flag — see notifyLowStock's own comment below.
export function findLowStockCrossings(
  before: AdminColorVariant[],
  after: AdminColorVariant[],
  threshold: number
): LowStockCrossing[] {
  const crossings: LowStockCrossing[] = [];
  for (const afterVariant of after) {
    const beforeVariant = before.find((v) => v.id === afterVariant.id);
    if (!beforeVariant) continue;
    for (const afterStock of afterVariant.sizeStock) {
      const beforeStock = beforeVariant.sizeStock.find((s) => s.size === afterStock.size);
      if (!beforeStock || beforeStock.qty === null || afterStock.qty === null) continue;
      if (beforeStock.qty >= threshold && afterStock.qty < threshold) {
        crossings.push({ colorName: afterVariant.colorName, size: afterStock.size, qty: afterStock.qty });
      }
    }
  }
  return crossings;
}

// Best-effort, fire-and-forget: call this AFTER a stock-decreasing write has
// already committed successfully — never from inside the same transaction.
// A bug here must never be able to fail a checkout, a POS sale, or an admin
// save; every failure is swallowed, not surfaced to the caller.
//
// Every caller already has both the pre-write and post-write colorVariants
// in hand from its own write, at no extra Firestore read cost — see the
// call sites in orderTransaction.ts (shared by web checkout and POS),
// adminOrderEdit.ts, Inventory.tsx, and ProductForm.tsx.
//
// Duplicate-safety: the crossing condition (before >= threshold, after <
// threshold) can only be true once per slot per genuine downward crossing —
// a later sale that decreases an already-low slot further always has
// before < threshold already, so it never re-fires; no separate "already
// notified" flag is needed. For the two transactional callers (checkout,
// admin order edit), "before" is the value read at the START of that same
// Firestore transaction, which Firestore's own optimistic-concurrency retry
// already guarantees is accurate relative to serialized execution order.
// The two direct-write admin callers (Inventory's quick edit, ProductForm's
// full save) accept the same last-write-wins consistency the underlying
// stock write itself already has today — not a new risk this feature
// introduces, just the same one already accepted for the stock value itself.
export async function notifyLowStock(
  product: { id: string; name: string },
  before: AdminColorVariant[],
  after: AdminColorVariant[]
): Promise<void> {
  try {
    const prefs = (await getSingletonDoc<NotificationPrefsDoc>("settings", "notifications")) ?? DEFAULT_PREFS;
    if (!prefs.lowStockAlerts) return;
    const crossings = findLowStockCrossings(before, after, prefs.lowStockThreshold);
    for (const c of crossings) {
      await notificationsApi.create({
        kind: "low_stock",
        title: "Low stock",
        body: `${product.name} (${c.colorName}, ${c.size}) has ${c.qty} left.`,
        link: "/admin/inventory",
        read: false,
      });
    }
  } catch {
    // Best-effort only.
  }
}
