import { useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import Logo from "../components/ui/Logo";
import LanguageToggle from "../components/ui/LanguageToggle";
import { useLanguage } from "../context/LanguageContext";
import type { RegisterSession } from "../admin/types";
import { useAdminAuth } from "../admin/AdminAuthContext";
import AdminIcon from "../admin/components/AdminIcons";
import { formatPrice } from "../utils/currency";
import CashWithdrawal from "./CashWithdrawal";
import { OfflineBanner } from "./offline/OfflineBanner";
import { useOffline } from "./offline/OfflineContext";
import { tillBase, tillUrl } from "./posPaths";

// A compact till header: where this till is (with the language switch next
// to it), the shift's running total, and the till's own actions (Today's
// sales, Returns, cash withdrawal, Close register). No menu: nothing here leads out
// of the till to the storefront.
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
  const onReturnsScreen = !!session && location.pathname.endsWith("/returns");
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  // Online-only actions are disabled offline; signing out is blocked while
  // this user's offline sales are still waiting (they'd stay unsent).
  const { online, pendingCount } = useOffline();

  const pill = "whitespace-nowrap rounded-full border border-line px-3.5 py-1.5 text-sm font-semibold text-wine hover:bg-cream-dim";

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
        <LanguageToggle className="!h-8 shrink-0 px-2.5 text-xs" />

        <div className="ms-auto flex shrink-0 items-center gap-2">
          {session && !onCloseScreen && (
            <span className="hidden whitespace-nowrap text-xs text-ink-soft xl:inline">
              {t("pos.layout.salesCount").replace("{count}", String(session.salesCount))} · <b className="text-ink">{formatPrice(session.grossTotal)}</b>
            </span>
          )}
          {/* The till's three screens as one fixed switch: the buttons never
              move or change their text, the current one is highlighted. */}
          {session && !onCloseScreen && (
            <nav className="flex rounded-full border border-line bg-paper p-0.5">
              {[
                { href: tillHref, label: t("pos.layout.saleTab"), active: !onReturnsScreen && !onSalesScreen },
                { href: `${base}/returns`, label: t("pos.returns.title"), active: onReturnsScreen },
                { href: `${base}/sales`, label: t("pos.branch.todaysSales"), active: onSalesScreen },
              ].map((tab) => (
                <Link
                  key={tab.label}
                  to={tab.href}
                  aria-current={tab.active ? "page" : undefined}
                  className={`whitespace-nowrap rounded-full px-3.5 py-1 text-sm font-semibold transition-colors ${
                    tab.active ? "bg-wine text-on-accent" : "text-ink-soft hover:text-wine"
                  }`}
                >
                  {tab.label}
                </Link>
              ))}
            </nav>
          )}
          {session && !onCloseScreen && (
            <Link to={`${base}/close`} className={`${pill} hidden sm:inline-flex`}>
              {t("pos.layout.closeRegister")}
            </Link>
          )}

          {session && !onCloseScreen && (
            <button
              disabled={!online}
              title={online ? undefined : t("pos.offline.onlineOnly")}
              onClick={() => setWithdrawOpen(true)}
              className={`${pill} hidden disabled:cursor-not-allowed disabled:opacity-40 sm:inline-flex`}
            >
              {t("pos.cashOut.title")}
            </button>
          )}
          <span className="flex items-center gap-2 rounded-full border border-line py-1 pe-3 ps-1 text-sm font-semibold text-ink">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-wine text-xs font-bold text-on-accent">
              {(userName ?? "?").slice(0, 1).toUpperCase()}
            </span>
            <span className="hidden max-w-[8rem] truncate md:inline">{userName}</span>
          </span>
          {/* A POS device's identity is anonymous: signing out would just
              orphan it, so devices have no sign-out. */}
          {!profile?.posLink && (
            <button
              disabled={pendingCount > 0}
              onClick={() => void signOutAdmin()}
              aria-label={t("admin.nav.signOut")}
              title={t("admin.nav.signOut")}
              className="flex h-8 w-8 items-center justify-center rounded-full text-ink-faint hover:bg-cream-dim hover:text-wine"
            >
              <AdminIcon name="logout" className="h-4 w-4" />
            </button>
          )}
        </div>
      </header>
      {session && <OfflineBanner />}
      <main className="min-h-0 flex-1">{children}</main>
      {session && <CashWithdrawal session={session} open={withdrawOpen} onClose={() => setWithdrawOpen(false)} onDone={() => onSessionUpdate?.()} />}
    </div>
  );
}
