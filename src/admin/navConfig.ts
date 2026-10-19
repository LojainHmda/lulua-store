import type { AdminRole, NotificationKind } from "./types";

export interface NavItem {
  labelKey: string;
  path: string;
  icon: string;
  minRole?: AdminRole[];
}

export interface NavGroup {
  labelKey: string;
  items: NavItem[];
}

const ALL: AdminRole[] = ["owner", "admin", "editor", "viewer"];
const CONTENT: AdminRole[] = ["owner", "admin", "editor"];
const OPS: AdminRole[] = ["owner", "admin"];
const OWNER_ONLY: AdminRole[] = ["owner"];

// The admin menu is scoped to POS + inventory operations. Storefront-only
// pages are listed in STORE_NAV_GROUPS below instead: they are not rendered
// in the sidebar or the command palette, but their routes (AdminApp.tsx),
// pages, data and rules are untouched and still reachable by URL / deep link
// (e.g. order notifications). Move a group back into NAV_GROUPS to restore it.
export const NAV_GROUPS: NavGroup[] = [
  {
    labelKey: "admin.nav.groupOverview",
    items: [{ labelKey: "admin.nav.dashboard", path: "/admin", icon: "grid", minRole: ALL }],
  },
  {
    labelKey: "admin.nav.groupPos",
    items: [
      // Sales, shifts (opening/closing cash, reconciliation) and per-register/cashier filters.
      { labelKey: "admin.nav.posSales", path: "/admin/pos-sales", icon: "chart", minRole: OPS },
      // Manual discounts at the till: the cashier limit and every discount given.
      { labelKey: "admin.nav.posDiscounts", path: "/admin/pos-discounts", icon: "tag", minRole: OPS },
      // In-store returns (refunds) across branches/registers, with details and receipts.
      { labelKey: "admin.nav.posReturns", path: "/admin/pos-returns", icon: "refresh", minRole: OPS },
      // Branches, registers, POS links and register status/history.
      { labelKey: "admin.nav.branches", path: "/admin/branches", icon: "map", minRole: OPS },
    ],
  },
  {
    labelKey: "admin.nav.groupReports",
    items: [
      // Drill-down reports: branch -> till -> day -> shift -> the shift's sales.
      { labelKey: "admin.nav.posReports", path: "/admin/pos-reports", icon: "layers", minRole: OPS },
    ],
  },
  {
    labelKey: "admin.nav.groupCatalog",
    items: [
      { labelKey: "admin.nav.products", path: "/admin/products", icon: "shirt", minRole: CONTENT },
      { labelKey: "admin.nav.categories", path: "/admin/categories", icon: "layers", minRole: CONTENT },
      { labelKey: "admin.nav.unsellableProducts", path: "/admin/unsellable-products", icon: "eyeOff", minRole: CONTENT },
    ],
  },
  {
    labelKey: "admin.nav.groupInventory",
    items: [
      // Online-store stock (/admin/inventory) is hidden from the menu: stock
      // is managed per branch. The route still works by URL.
      { labelKey: "admin.nav.branchStock", path: "/admin/branch-stock", icon: "box", minRole: ALL },
      { labelKey: "admin.nav.stockLedger", path: "/admin/stock-ledger", icon: "refresh", minRole: ALL },
    ],
  },
  {
    labelKey: "admin.nav.groupSystem",
    items: [
      // Admin + cashier accounts and their register access.
      { labelKey: "admin.nav.team", path: "/admin/team", icon: "shield", minRole: OWNER_ONLY },
      { labelKey: "admin.nav.notifications", path: "/admin/notifications", icon: "bell", minRole: ALL },
      { labelKey: "admin.nav.activity", path: "/admin/activity", icon: "history", minRole: OPS },
      { labelKey: "admin.nav.backup", path: "/admin/backup", icon: "database", minRole: OWNER_ONLY },
      { labelKey: "admin.nav.settings", path: "/admin/settings/general", icon: "settings", minRole: OPS },
    ],
  },
];

// Hidden from the menu (see note above NAV_GROUPS). Not imported anywhere on purpose.
export const STORE_NAV_GROUPS: NavGroup[] = [
  {
    labelKey: "admin.nav.groupSales",
    items: [
      { labelKey: "admin.nav.orders", path: "/admin/orders", icon: "bag", minRole: OPS },
      { labelKey: "admin.nav.returns", path: "/admin/returns", icon: "archive", minRole: OPS },
      { labelKey: "admin.nav.customers", path: "/admin/customers", icon: "users", minRole: OPS },
      { labelKey: "admin.nav.discounts", path: "/admin/discounts", icon: "tag", minRole: CONTENT },
      { labelKey: "admin.nav.deliveryZones", path: "/admin/delivery-zones", icon: "map", minRole: CONTENT },
    ],
  },
  {
    labelKey: "admin.nav.groupContent",
    items: [
      { labelKey: "admin.nav.homepage", path: "/admin/homepage", icon: "layout", minRole: CONTENT },
      { labelKey: "admin.nav.media", path: "/admin/media", icon: "image", minRole: CONTENT },
      { labelKey: "admin.nav.reviews", path: "/admin/reviews", icon: "star", minRole: CONTENT },
    ],
  },
  {
    labelKey: "admin.nav.groupInsights",
    items: [
      { labelKey: "admin.nav.analytics", path: "/admin/analytics", icon: "eye", minRole: OPS },
      // Online-order reports only (ordersApi); POS reporting lives in POS Sales.
      { labelKey: "admin.nav.reports", path: "/admin/reports", icon: "chart", minRole: OPS },
    ],
  },
];

// Storefront notification kinds (online orders, product reviews). Still
// written and stored as before; just not listed in the POS-focused admin's
// bell or notifications page.
export const STORE_NOTIFICATION_KINDS: NotificationKind[] = ["new_order", "new_review"];

export const SETTINGS_TABS = [
  { labelKey: "admin.settingsTabs.general", path: "general" },
  { labelKey: "admin.settingsTabs.appearance", path: "appearance" },
  { labelKey: "admin.settingsTabs.language", path: "language" },
  { labelKey: "admin.settingsTabs.posReturns", path: "posReturns" },
];

// Storefront-only settings (SEO, footer contact, shipping/checkout, store
// search, checkout exchange policy). Hidden from the settings menu like
// STORE_NAV_GROUPS; each tab still renders at /admin/settings/<path>.
export const STORE_SETTINGS_TABS = [
  { labelKey: "admin.settingsTabs.seo", path: "seo" },
  { labelKey: "admin.settingsTabs.contact", path: "contact" },
  { labelKey: "admin.settingsTabs.shipping", path: "shipping" },
  { labelKey: "admin.settingsTabs.search", path: "search" },
  { labelKey: "admin.settingsTabs.exchangePolicy", path: "exchangePolicy" },
];
