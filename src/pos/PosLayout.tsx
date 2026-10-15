import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import Logo from "../components/ui/Logo";
import LanguageToggle from "../components/ui/LanguageToggle";
import ThemeToggle from "../components/ui/ThemeToggle";
import { useLanguage } from "../context/LanguageContext";
import type { RegisterSession } from "../admin/types";
import { useAdminAuth } from "../admin/AdminAuthContext";
import AdminIcon from "../admin/components/AdminIcons";
import { formatPrice } from "../utils/currency";
import CashWithdrawal from "./CashWithdrawal";
import { OPEN_ORDERS_PANEL_EVENT } from "./ordersPanelEvent";
import { tillBase, tillUrl } from "./posPaths";

// A compact till header: where this till is, the shift's running total, the
// two actions a cashier uses all day (Today's sales, Close register), and
// everything else tucked into one account menu.
export default function PosLayout({
  session,
  onSessionUpdate,
  children,
}: {
  session: RegisterSession | null;
  onSessionUpdate?: () => void;
  children: ReactNode;
}) {
  const { profile, hasRole, signOutAdmin } = useAdminAuth();
  // On a POS device the signed-in identity is the till itself; show the
  // cashier who started the shift instead.
  const userName = profile?.posLink ? (session?.cashierName ?? profile.displayName) : profile?.displayName;
  const { dir, t } = useLanguage();
  const location = useLocation();
  // Till URLs are /pos/<branchCode>/<registerId>[/sales|/close] (posPaths.ts).
  const base = session ? tillBase(session) : "/pos";
  const tillHref = session ? tillUrl(session) : "/pos";
  const onCloseScreen = !!session && location.pathname.endsWith("/close");
  const onSalesScreen = !!session && location.pathname.endsWith("/sales");
  const [menuOpen, setMenuOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onDown(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  useEffect(() => setMenuOpen(false), [location.pathname]);

  const pill = "whitespace-nowrap rounded-full border border-line px-3.5 py-1.5 text-sm font-semibold text-wine hover:bg-cream-dim";
  const menuItem = "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-start text-sm font-medium text-ink hover:bg-cream-dim";

  return (
    <div dir={dir} className="admin-root flex h-screen flex-col bg-cream text-ink">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-3 sm:px-4">
        {/* Owner/admin outside a shift (the POS links screens): a way back to
            the dashboard in the leading corner. A running till never shows
            it -- the dashboard stays in the account menu there. */}
        {!session && hasRole(["owner", "admin"]) && (
          <>
            <Link
              to="/admin"
              aria-label={t("pos.layout.adminDashboard")}
              title={t("pos.layout.adminDashboard")}
              className="flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-line bg-paper pe-3.5 ps-2.5 text-sm font-semibold text-ink transition-colors hover:border-wine hover:text-wine active:scale-[0.97]"
            >
              {/* Points "back" in reading direction (right in Arabic). */}
              <svg className="h-4 w-4 rtl:-scale-x-100" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12.5 4l-6 6 6 6" />
              </svg>
              <span className="hidden sm:inline">{t("pos.layout.adminDashboard")}</span>
            </Link>
            <span className="h-6 w-px shrink-0 bg-line" aria-hidden />
          </>
        )}
        <Link to={tillHref} className="shrink-0">
          <Logo className="h-6" onLight />
        </Link>
        {/* Where this till is: always visible, so a sale is never rung up on
            the wrong branch/register by mistake. */}
        {session?.branchName && (
          <span className="flex min-w-0 items-center gap-1.5 rounded-full bg-cream-dim px-3 py-1 text-xs font-semibold text-ink">
            {session.branchCode && <span className="font-mono text-wine">{session.branchCode}</span>}
            <span className="hidden truncate sm:inline">{session.branchName}</span>
            <span className="text-ink-faint">·</span>
            <span className="truncate">{session.registerName}</span>
          </span>
        )}

        <div className="ms-auto flex shrink-0 items-center gap-2">
          {session && !onCloseScreen && (
            <span className="hidden whitespace-nowrap text-xs text-ink-soft xl:inline">
              {t("pos.layout.salesCount").replace("{count}", String(session.salesCount))} · <b className="text-ink">{formatPrice(session.grossTotal)}</b>
            </span>
          )}
          {session && !onCloseScreen && (
            <Link to={onSalesScreen ? tillHref : `${base}/sales`} className={pill}>
              {onSalesScreen ? t("pos.branch.backToTill") : t("pos.branch.todaysSales")}
            </Link>
          )}
          {session && !onCloseScreen && (
            <Link to={`${base}/close`} className={`${pill} hidden sm:inline-flex`}>
              {t("pos.layout.closeRegister")}
            </Link>
          )}

          <div ref={menuRef} className="relative">
            <button
              onClick={() => setMenuOpen((o) => !o)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              className="flex items-center gap-2 rounded-full border border-line py-1 pe-2.5 ps-1 text-sm font-semibold text-ink hover:bg-cream-dim"
            >
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-wine text-xs font-bold text-on-accent">
                {(userName ?? "?").slice(0, 1).toUpperCase()}
              </span>
              <span className="hidden max-w-[8rem] truncate md:inline">{userName}</span>
              <AdminIcon name="chevronDown" className="h-3.5 w-3.5 text-ink-faint" />
            </button>
            {menuOpen && (
              <div role="menu" className="absolute end-0 top-full z-50 mt-2 w-60 rounded-xl border border-line bg-paper p-1.5 shadow-lift">
                {session && !onCloseScreen && (
                  <Link to={`${base}/close`} className={`${menuItem} sm:hidden`}>
                    <AdminIcon name="archive" className="h-4 w-4 text-ink-faint" />
                    {t("pos.layout.closeRegister")}
                  </Link>
                )}
                {session && !onCloseScreen && (
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      setWithdrawOpen(true);
                    }}
                    className={menuItem}
                  >
                    <AdminIcon name="download" className="h-4 w-4 text-ink-faint" />
                    {t("pos.cashOut.title")}
                  </button>
                )}
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    window.dispatchEvent(new Event(OPEN_ORDERS_PANEL_EVENT));
                  }}
                  className={menuItem}
                >
                  <AdminIcon name="bag" className="h-4 w-4 text-ink-faint" />
                  {t("admin.globalOrders.open")}
                </button>
                {hasRole(["owner", "admin"]) && (
                  <Link to="/admin" className={menuItem}>
                    <AdminIcon name="grid" className="h-4 w-4 text-ink-faint" />
                    {t("pos.layout.adminDashboard")}
                  </Link>
                )}
                <Link to="/" className={menuItem}>
                  <AdminIcon name="home" className="h-4 w-4 text-ink-faint" />
                  {t("pos.layout.viewStore")}
                </Link>
                <div className="my-1 flex items-center justify-between gap-2 border-t border-line px-2 pt-2">
                  <LanguageToggle className="!h-9 px-2.5 text-xs" />
                  <ThemeToggle />
                </div>
                {/* A POS device's identity is anonymous: signing out would
                    just orphan it, so devices have no sign-out. */}
                {!profile?.posLink && (
                  <button onClick={() => void signOutAdmin()} className={`${menuItem} text-wine`}>
                    <AdminIcon name="logout" className="h-4 w-4" />
                    {t("admin.nav.signOut")}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </header>
      <main className="min-h-0 flex-1">{children}</main>
      {session && <CashWithdrawal session={session} open={withdrawOpen} onClose={() => setWithdrawOpen(false)} onDone={() => onSessionUpdate?.()} />}
    </div>
  );
}
