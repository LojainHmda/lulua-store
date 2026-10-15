// Fired by the POS header to open the app-wide online-orders panel, whose
// own floating tab is hidden on /pos so it never sits on top of the till
// (see GlobalOrdersSidebarPanel.tsx). Kept in its own module so the panel
// doesn't import any POS code.
export const OPEN_ORDERS_PANEL_EVENT = "lulua:open-orders-panel";
