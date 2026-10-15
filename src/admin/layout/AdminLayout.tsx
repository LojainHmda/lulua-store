import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, NavLink, Outlet } from "react-router-dom";
import LanguageToggle from "../../components/ui/LanguageToggle";
import ThemeToggle from "../../components/ui/ThemeToggle";
import { useLanguage } from "../../context/LanguageContext";
import { useAdminAuth } from "../AdminAuthContext";
import AdminIcon from "../components/AdminIcons";
import CommandPalette from "../components/CommandPalette";
import NotificationBell from "../components/NotificationBell";
import { usePendingOrdersCount } from "../../hooks/usePendingOrdersCount";
import { NAV_GROUPS } from "../navConfig";

// Desktop menu: an icon rail that expands while hovered (or focused), unless
// the user pins it open. "1" = pinned.
const SIDEBAR_PINNED_KEY = "lulua-admin-sidebar-pinned";
// Small delays so the menu doesn't flicker open when the pointer merely
// crosses the rail on its way somewhere else, or snap shut on a brief exit.
const HOVER_OPEN_DELAY_MS = 120;
const HOVER_CLOSE_DELAY_MS = 220;
// The one nav item this layout special-cases to show a live count badge on
// (see usePendingOrdersCount) -- kept as a single named constant so the
// "is this nav item even visible" check and the two badge render sites
// below can't drift out of sync with each other or with navConfig.ts.
const ORDERS_NAV_PATH = "/admin/orders";
// Header "AI" assistant link (see below). Flip to true to show it again.
const SHOW_STORE_ASSISTANT = false;

export default function AdminLayout() {
  const { profile, signOutAdmin, hasRole } = useAdminAuth();
  const { dir, t } = useLanguage();
  const [pinned, setPinned] = useState(() => {
    try {
      return window.localStorage.getItem(SIDEBAR_PINNED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [hovered, setHovered] = useState(false);
  const hoverTimer = useRef<number | undefined>(undefined);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_PINNED_KEY, pinned ? "1" : "0");
    } catch {
      // Storage unavailable (private mode etc.): the choice just isn't remembered.
    }
  }, [pinned]);

  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);

  function hoverTo(next: boolean) {
    window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => setHovered(next), next ? HOVER_OPEN_DELAY_MS : HOVER_CLOSE_DELAY_MS);
  }

  const desktopExpanded = pinned || hovered;

  const visibleGroups = useMemo(
    () =>
      NAV_GROUPS.map((g) => ({
        ...g,
        items: g.items.filter((item) => !item.minRole || (profile && item.minRole.includes(profile.role))),
      })).filter((g) => g.items.length > 0),
    [profile]
  );

  // Only ever true for the same roles that can already see the "الطلبات"
  // nav item itself (currently owner/admin, via navConfig.ts's own
  // minRole) -- derived from visibleGroups rather than re-stating a role
  // list here, so this can never drift into showing/reading more than the
  // nav item itself already allows. Firestore access is unchanged either
  // way: this only decides whether the live listener opens at all.
  const ordersNavVisible = useMemo(() => visibleGroups.some((g) => g.items.some((item) => item.path === ORDERS_NAV_PATH)), [visibleGroups]);
  const pendingOrdersCount = usePendingOrdersCount(ordersNavVisible);

  const initials = (profile?.displayName || profile?.email || "?").slice(0, 1).toUpperCase();

  // `collapsed` = icon-only rendering. The mobile drawer always renders
  // expanded; the desktop rail follows desktopExpanded.
  const renderSidebar = (collapsed: boolean, isDesktop: boolean) => (
    <div className="flex h-full flex-col whitespace-nowrap">
      <div className={`flex items-center gap-2.5 px-4 py-5 ${collapsed ? "justify-center" : ""}`}>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-wine text-on-accent">
          <AdminIcon name="shield" className="h-4.5 w-4.5" />
        </div>
        {!collapsed && <span className="font-display text-lg font-bold text-ink">{t("admin.brand")}</span>}
      </div>

      <nav className="thin-scrollbar flex-1 overflow-y-auto px-3 pb-4">
        {visibleGroups.map((group) => (
          <div key={group.labelKey} className="mb-4">
            {!collapsed && <p className="mb-1.5 px-2.5 text-xs font-bold uppercase tracking-wide text-ink-faint">{t(group.labelKey)}</p>}
            <div className="flex flex-col gap-0.5">
              {group.items.map((item) => {
                const showOrdersBadge = item.path === ORDERS_NAV_PATH && pendingOrdersCount > 0;
                const badgeCount = pendingOrdersCount > 9 ? "9+" : pendingOrdersCount;
                return (
                  <NavLink
                    key={item.path}
                    to={item.path}
                    end={item.path === "/admin"}
                    onClick={() => setMobileOpen(false)}
                    className={({ isActive }) =>
                      `flex items-center gap-3 rounded-lg px-2.5 py-2.5 text-sm font-semibold transition-colors ${
                        isActive ? "bg-wine text-on-accent" : "text-wine/70 hover:bg-cream-dim hover:text-wine"
                      } ${collapsed ? "justify-center" : ""}`
                    }
                    title={collapsed ? t(item.labelKey) : undefined}
                  >
                    {({ isActive }) => (
                      <>
                        <span className="relative flex shrink-0">
                          <AdminIcon name={item.icon} className="h-4.5 w-4.5" />
                          {/* Collapsed sidebar: no label to badge, so the count
                              overlays the icon's corner instead -- same spot
                              NotificationBell overlays its own icon. */}
                          {showOrdersBadge && collapsed && (
                            <span
                              className={`absolute -end-1.5 -top-1.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[9px] font-bold ${
                                isActive ? "bg-on-accent/25 text-on-accent" : "bg-wine text-on-accent"
                              }`}
                            >
                              {badgeCount}
                            </span>
                          )}
                        </span>
                        {!collapsed && (
                          <>
                            <span>{t(item.labelKey)}</span>
                            {showOrdersBadge && (
                              <span
                                className={`ms-auto flex h-4.5 min-w-[1.125rem] items-center justify-center rounded-full px-1 text-[10px] font-bold ${
                                  isActive ? "bg-on-accent/25 text-on-accent" : "bg-wine text-on-accent"
                                }`}
                              >
                                {badgeCount}
                              </span>
                            )}
                          </>
                        )}
                      </>
                    )}
                  </NavLink>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* The storefront "View store" link is hidden here: the menu is scoped
          to POS operations (see navConfig.ts). The "/" route is unchanged. */}
      {isDesktop && (
        <div className="border-t border-line p-3">
          <button
            onClick={() => setPinned((p) => !p)}
            aria-pressed={pinned}
            title={pinned ? t("admin.nav.unpinMenu") : t("admin.nav.pinMenu")}
            className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2.5 text-sm font-semibold hover:bg-cream-dim hover:text-wine ${
              pinned ? "text-wine" : "text-wine/70"
            } ${collapsed ? "justify-center" : ""}`}
          >
            <AdminIcon name={pinned ? (dir === "rtl" ? "chevronRight" : "chevronLeft") : "layout"} className="h-4.5 w-4.5 shrink-0" />
            {!collapsed && <span>{pinned ? t("admin.nav.unpinMenu") : t("admin.nav.pinMenu")}</span>}
          </button>
        </div>
      )}
    </div>
  );

  return (
    <div dir={dir} className="admin-root flex min-h-screen bg-cream">
      {/* Desktop sidebar: the aside reserves the rail's width in the layout
          (or the full width when pinned); the panel inside expands over the
          page on hover/focus, so the content never shifts under the pointer. */}
      <aside className={`relative z-40 hidden shrink-0 lg:block ${pinned ? "w-64" : "w-[76px]"}`}>
        <div
          onMouseEnter={() => hoverTo(true)}
          onMouseLeave={() => hoverTo(false)}
          onFocus={() => hoverTo(true)}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) hoverTo(false);
          }}
          className={`sticky top-0 h-screen overflow-hidden border-e border-line bg-paper transition-[width,box-shadow] duration-200 ease-out ${
            desktopExpanded ? "w-64" : "w-[76px]"
          } ${desktopExpanded && !pinned ? "shadow-lift" : ""}`}
        >
          {renderSidebar(!desktopExpanded, true)}
        </div>
      </aside>

      {/* Mobile sidebar */}
      <AnimatePresence>
        {mobileOpen && (
          <div className="fixed inset-0 z-[120] lg:hidden">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 bg-ink/40" onClick={() => setMobileOpen(false)} />
            <motion.aside
              initial={{ x: dir === "rtl" ? "100%" : "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: dir === "rtl" ? "100%" : "-100%" }}
              transition={{ type: "spring", stiffness: 320, damping: 34 }}
              className="relative z-10 h-full w-72 bg-paper shadow-lift"
            >
              {renderSidebar(false, false)}
            </motion.aside>
          </div>
        )}
      </AnimatePresence>

      {/* min-w-0 is load-bearing: without it this flex child's automatic
          min-width lets it grow to its content's min-content width (a wide
          admin table pushed it to ~1300px inside a 375px viewport), which is
          what put a real horizontal scrollbar on every admin page. */}
      <div className="flex min-h-screen min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-3 border-b border-line bg-paper/90 px-4 backdrop-blur-sm sm:px-6">
          <button onClick={() => setMobileOpen(true)} className="flex h-9 w-9 items-center justify-center rounded-lg text-wine hover:bg-cream-dim lg:hidden">
            <AdminIcon name="menu" className="h-5 w-5" />
          </button>

          <div className="flex-1" />

          <CommandPalette />
          {/* Sisely AI entry point -- owner/admin only, same boundary as
              Order Detail/Customer Detail (see AdminApp.tsx's route gates),
              not the broader set of roles CommandPalette/
              GlobalOrdersSidebarPanel allow. Navigates to the dedicated
              /admin/assistant page (AssistantPage.tsx) rather than opening
              an overlay -- the "AI" text is the primary visual, the sparkle
              icon is a small accent, never a chat-bubble glyph. */}
          {/* Hidden while the admin is scoped to POS operations: the
              assistant is built around online orders, customers and
              delivery zones. The /admin/assistant route is unchanged. */}
          {SHOW_STORE_ASSISTANT && hasRole(["owner", "admin"]) && (
            <Link
              to="/admin/assistant"
              aria-label={t("admin.assistant.triggerLabel")}
              title={t("admin.assistant.triggerLabel")}
              className="flex h-9 items-center gap-1 rounded-lg bg-gradient-to-br from-blue-600 to-blue-500 px-2.5 text-sm font-extrabold tracking-wide text-white shadow-sm transition-colors hover:from-blue-500 hover:to-blue-400"
            >
              <AdminIcon name="sparkle" className="h-3.5 w-3.5" />
              AI
            </Link>
          )}
          <LanguageToggle className="!h-9 px-2.5 text-xs" />
          <NotificationBell />
          <ThemeToggle className="!h-9 !w-9" />

          <div className="relative">
            <button onClick={() => setProfileOpen((o) => !o)} className="flex items-center gap-2 rounded-full py-1 ps-1 pe-2 hover:bg-cream-dim">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-wine text-sm font-bold text-on-accent">{initials}</span>
              <AdminIcon name="chevronDown" className="hidden h-3.5 w-3.5 text-wine/60 sm:block" />
            </button>
            <AnimatePresence>
              {profileOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setProfileOpen(false)} />
                  <motion.div
                    initial={{ opacity: 0, y: -6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    transition={{ duration: 0.15 }}
                    className="absolute end-0 z-50 mt-2 w-56 rounded-xl border border-line bg-paper p-2 shadow-lift"
                  >
                    <div className="px-2.5 py-2">
                      <p className="truncate text-sm font-semibold text-ink">{profile?.displayName}</p>
                      <p className="truncate text-xs text-ink-faint">{profile?.email}</p>
                      <span className="mt-1.5 inline-flex rounded-full bg-cream-dim px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-ink-soft">
                        {profile?.role}
                      </span>
                    </div>
                    <div className="my-1 h-px bg-line" />
                    <button
                      onClick={() => signOutAdmin()}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-semibold text-wine hover:bg-wine-light"
                    >
                      <AdminIcon name="logout" className="h-4 w-4" />
                      {t("admin.nav.signOut")}
                    </button>
                  </motion.div>
                </>
              )}
            </AnimatePresence>
          </div>
        </header>

        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
