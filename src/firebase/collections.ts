import { createCollectionApi } from "./firestore";
import type { BranchDaySnapshot } from "../admin/daySnapshot";
import type {
  AdminCategory,
  AdminCustomer,
  AdminDiscount,
  AdminNotification,
  AdminOrder,
  AdminProduct,
  AdminReview,
  AdminUser,
  Branch,
  CashMovement,
  BranchStockDoc,
  Register,
  ActivityLogEntry,
  AnalyticsDailyDoc,
  CategoryStatsDoc,
  CategoryViewDailyDoc,
  DeliveryZone,
  MediaAsset,
  ProductStatsDoc,
  ProductViewDailyDoc,
  RegisterSession,
  AdminReturn,
  PosReturn,
  PosSyncIssue,
  AdminPromotion,
  StockMovement,
} from "../admin/types";

export const adminsApi = createCollectionApi<AdminUser>("admins");
export const productsApi = createCollectionApi<AdminProduct>("products");
export const categoriesApi = createCollectionApi<AdminCategory>("categories");
export const ordersApi = createCollectionApi<AdminOrder>("orders");
export const customersApi = createCollectionApi<AdminCustomer>("customers");
export const discountsApi = createCollectionApi<AdminDiscount>("discounts");
export const deliveryZonesApi = createCollectionApi<DeliveryZone>("deliveryZones");
export const reviewsApi = createCollectionApi<AdminReview>("reviews");
export const mediaApi = createCollectionApi<MediaAsset>("media");
export const activityLogApi = createCollectionApi<ActivityLogEntry>("activityLogs");
export const notificationsApi = createCollectionApi<AdminNotification>("notifications");
export const branchesApi = createCollectionApi<Branch>("branches");
export const registersApi = createCollectionApi<Register>("registers");
export const branchStockApi = createCollectionApi<BranchStockDoc>("branchStock");
export const registerSessionsApi = createCollectionApi<RegisterSession>("registerSessions");
// Read-only by convention, like stockMovementsApi below: written only by
// recordCashWithdrawal()'s transaction, and immutable per firestore.rules.
export const cashMovementsApi = createCollectionApi<CashMovement>("cashMovements");
export const returnsApi = createCollectionApi<AdminReturn>("returns");
// In-store returns. Read-only here: written only by processPosReturn()'s
// transaction (firebase/posReturn.ts), immutable per the rules.
export const posReturnsApi = createCollectionApi<PosReturn>("posReturns");
// Automatic promotions (Admin → Discounts → Promotions); owner/admin write.
export const promotionsApi = createCollectionApi<AdminPromotion>("promotions");
// Offline till sales the server refused (Feature 5). Written by the till;
// admins resolve them with a raw updateDoc (the rules allow only the
// resolve fields, so the wrapper's updatedAt stamp would be refused).
export const posSyncIssuesApi = createCollectionApi<PosSyncIssue>("posSyncIssues");
// End-of-day snapshots (Admin → Branches → End of day). Written with a raw
// setDoc by BranchDay.tsx (the rules check closedAt/version exactly).
export const branchDaySnapshotsApi = createCollectionApi<BranchDaySnapshot>("branchDaySnapshots");
// Read-only by convention: the .create() this exposes stamps an `updatedAt`
// field that a genuinely immutable ledger shouldn't have (see StockMovement's
// own doc comment) and firestore.rules rejects .update()/.remove() outright
// regardless. Real writes happen as raw tx.set() calls inside the existing
// stock-changing transactions (Phase 2+), never through this wrapper.
export const stockMovementsApi = createCollectionApi<StockMovement>("stockMovements");

export const analyticsDailyApi = createCollectionApi<AnalyticsDailyDoc>("analyticsDaily");
export const productStatsApi = createCollectionApi<ProductStatsDoc>("productStats");
export const categoryStatsApi = createCollectionApi<CategoryStatsDoc>("categoryStats");
export const productViewsDailyApi = createCollectionApi<ProductViewDailyDoc>("productViewsDaily");
export const categoryViewsDailyApi = createCollectionApi<CategoryViewDailyDoc>("categoryViewsDaily");
