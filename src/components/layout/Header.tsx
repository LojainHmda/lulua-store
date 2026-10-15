import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { useCart } from "../../context/CartContext";
import { useCatalog } from "../../context/CatalogContext";
import { useCustomerAuth } from "../../context/CustomerAuthContext";
import { useLanguage } from "../../context/LanguageContext";
import { useWishlist } from "../../context/WishlistContext";
import { getLocalizedCategories } from "../../data/localize";
import Logo from "../ui/Logo";
import LanguageToggle from "../ui/LanguageToggle";
import ThemeToggle from "../ui/ThemeToggle";

export default function Header() {
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { count, open: openCart, lastAdded } = useCart();
  const wishlist = useWishlist();
  const { lang, dir, t } = useLanguage();
  const catalog = useCatalog();
  const { isSignedIn, openSignIn } = useCustomerAuth();
  const navigate = useNavigate();

  const categories = useMemo(() => getLocalizedCategories(catalog.categories, lang), [catalog.categories, lang]);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    setMobileOpen(false);
  }, []);

  function submitSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    navigate(`/shop?q=${encodeURIComponent(query.trim())}`);
    setSearchOpen(false);
    setQuery("");
  }

  return (
    <header
      className={`sticky top-0 z-50 border-b transition-all duration-500 ${
        scrolled ? "border-transparent bg-cream/90 backdrop-blur-md" : "border-transparent bg-cream"
      }`}
    >
      <div className="container-page flex h-16 items-center gap-2 sm:h-18 sm:gap-3">
        <Link to="/" className="shrink-0">
          <Logo className="h-11 sm:h-12" onLight />
        </Link>

        <nav className="ms-8 hidden items-center gap-5 lg:flex">
          {categories.map((cat) => (
            <NavLink
              key={cat.slug}
              to={`/shop/${cat.slug}`}
              className={({ isActive }) =>
                `group relative py-2 text-xs font-semibold tracking-tight transition-colors ${
                  isActive ? "text-wine-dark" : "text-wine hover:text-wine-dark"
                }`
              }
            >
              {cat.name}
              <span className="absolute -bottom-0.5 start-0 h-[2px] w-full origin-left scale-x-0 bg-wine transition-transform duration-300 rtl:origin-right group-hover:scale-x-100" />
            </NavLink>
          ))}
          <NavLink
            to="/about"
            className={({ isActive }) => `group relative py-2 text-xs font-semibold tracking-tight transition-colors ${isActive ? "text-wine-dark" : "text-wine hover:text-wine-dark"}`}
          >
            {t("header.ourStory")}
            <span className="absolute -bottom-0.5 start-0 h-[2px] w-full origin-left scale-x-0 bg-wine transition-transform duration-300 rtl:origin-right group-hover:scale-x-100" />
          </NavLink>
        </nav>

        <div className="ms-auto flex items-center gap-0.5">
          <div className="relative hidden items-center sm:flex">
            <AnimatePresence>
              {searchOpen && (
                <motion.form
                  onSubmit={submitSearch}
                  initial={{ width: 0, opacity: 0 }}
                  animate={{ width: 220, opacity: 1 }}
                  exit={{ width: 0, opacity: 0 }}
                  transition={{ duration: 0.25, ease: "easeOut" }}
                  className="overflow-hidden"
                >
                  <input
                    autoFocus
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t("header.searchPlaceholder")}
                    className="w-full rounded-full border border-line bg-paper px-4 py-2 text-sm outline-none placeholder:text-ink-faint focus:border-wine"
                  />
                </motion.form>
              )}
            </AnimatePresence>
            <button
              onClick={() => setSearchOpen((s) => !s)}
              aria-label={t("header.search")}
              className="flex h-[36px] w-[36px] shrink-0 items-center justify-center rounded-full text-wine transition-colors hover:bg-cream-dim"
            >
              <SearchIcon />
            </button>
          </div>

          <LanguageToggle className="hidden !h-[36px] !gap-1 !px-2 text-xs sm:flex" iconClassName="h-4 w-4 sm:h-[18px] sm:w-[18px]" />
          <ThemeToggle className="!h-[36px] !w-[36px]" iconClassName="h-4 w-4 sm:h-[18px] sm:w-[18px]" />

          <button
            onClick={() => (isSignedIn ? navigate("/account") : openSignIn())}
            aria-label={t("account.openAccount")}
            className="flex h-[36px] w-[36px] items-center justify-center rounded-full text-wine transition-colors hover:bg-cream-dim"
          >
            <AccountIcon />
          </button>

          <Link
            to="/wishlist"
            aria-label={t("header.openWishlist")}
            className="relative flex h-[36px] w-[36px] items-center justify-center rounded-full text-wine transition-colors hover:bg-cream-dim"
          >
            <HeartIcon />
            <AnimatePresence>
              {wishlist.count > 0 && (
                <motion.span
                  key={wishlist.count}
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  exit={{ scale: 0 }}
                  className="animate-pop absolute -end-1 -top-1 flex h-4.5 w-4.5 items-center justify-center rounded-full bg-wine text-[10px] font-bold text-on-accent sm:h-5 sm:w-5 sm:text-[10px]"
                >
                  {wishlist.count}
                </motion.span>
              )}
            </AnimatePresence>
          </Link>

          <button
            onClick={openCart}
            aria-label={t("header.openCart")}
            className="relative flex h-[36px] w-[36px] items-center justify-center rounded-full text-wine transition-colors hover:bg-cream-dim"
          >
            <BagIcon />
            <AnimatePresence>
              {count > 0 && (
                <motion.span
                  key={lastAdded}
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  exit={{ scale: 0 }}
                  className="animate-pop absolute -end-1 -top-1 flex h-4.5 w-4.5 items-center justify-center rounded-full bg-wine text-[10px] font-bold text-on-accent sm:h-5 sm:w-5 sm:text-[10px]"
                >
                  {count}
                </motion.span>
              )}
            </AnimatePresence>
          </button>

          <button
            onClick={() => setMobileOpen(true)}
            aria-label={t("header.openMenu")}
            className="flex h-[36px] w-[36px] items-center justify-center rounded-full text-wine hover:bg-cream-dim lg:hidden"
          >
            <MenuIcon />
          </button>
        </div>
      </div>

      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] flex flex-col bg-cream lg:hidden"
          >
            <div className="container-page flex h-16 items-center justify-between">
              <Logo className="h-9" onLight />
              <div className="flex items-center gap-1">
                <LanguageToggle className="sm:hidden" />
                <button
                  onClick={() => setMobileOpen(false)}
                  aria-label={t("header.closeMenu")}
                  className="flex h-9 w-9 items-center justify-center rounded-full text-wine hover:bg-cream-dim"
                >
                  <CloseIcon />
                </button>
              </div>
            </div>
            <form onSubmit={submitSearch} className="container-page mt-2">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("header.searchPlaceholder")}
                className="w-full rounded-full border border-line bg-paper px-5 py-3.5 text-base outline-none focus:border-wine"
              />
            </form>
            <nav data-lenis-prevent className="container-page mt-8 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overscroll-contain pb-6">
              {categories.map((cat, i) => (
                <motion.div
                  key={cat.slug}
                  initial={{ opacity: 0, x: dir === "rtl" ? -24 : 24 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.05 * i, duration: 0.35, ease: "easeOut" }}
                >
                  <Link
                    to={`/shop/${cat.slug}`}
                    onClick={() => setMobileOpen(false)}
                    className="flex items-center justify-between border-b border-line py-5 font-display text-3xl font-bold text-wine"
                  >
                    {cat.name}
                    <span className="text-wine rtl:-scale-x-100">→</span>
                  </Link>
                </motion.div>
              ))}
              <motion.div
                initial={{ opacity: 0, x: dir === "rtl" ? -24 : 24 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.05 * categories.length, duration: 0.35, ease: "easeOut" }}
              >
                <Link
                  to="/about"
                  onClick={() => setMobileOpen(false)}
                  className="flex items-center justify-between border-b border-line py-5 font-display text-3xl font-bold"
                >
                  {t("header.ourStory")}
                  <span className="text-wine rtl:-scale-x-100">→</span>
                </Link>
              </motion.div>
              <motion.div
                initial={{ opacity: 0, x: dir === "rtl" ? -24 : 24 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.05 * (categories.length + 1), duration: 0.35, ease: "easeOut" }}
              >
                {isSignedIn ? (
                  <Link
                    to="/account"
                    onClick={() => setMobileOpen(false)}
                    className="flex items-center justify-between border-b border-line py-5 font-display text-3xl font-bold text-wine"
                  >
                    {t("account.myAccount")}
                    <span className="text-wine rtl:-scale-x-100">→</span>
                  </Link>
                ) : (
                  <button
                    onClick={() => {
                      setMobileOpen(false);
                      openSignIn();
                    }}
                    className="flex w-full items-center justify-between border-b border-line py-5 font-display text-3xl font-bold text-wine"
                  >
                    {t("account.signIn")}
                    <span className="text-wine rtl:-scale-x-100">→</span>
                  </button>
                )}
              </motion.div>
            </nav>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}

function SearchIcon() {
  return (
    <svg className="h-4 w-4 sm:h-[18px] sm:w-[18px]" viewBox="0 0 19 19" fill="none">
      <circle cx="8.5" cy="8.5" r="6.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M13.5 13.5L17.5 17.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function AccountIcon() {
  return (
    <svg className="h-4 w-4 sm:h-[18px] sm:w-[18px]" viewBox="0 0 20 20" fill="none">
      <circle cx="10" cy="6.5" r="3.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3 17c1.2-3.6 4.1-5.5 7-5.5s5.8 1.9 7 5.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function HeartIcon() {
  return (
    <svg className="h-4 w-4 sm:h-[18px] sm:w-[18px]" viewBox="0 0 20 20" fill="none">
      <path
        d="M10 17.5s-6.7-4.1-9-8.4C-0.4 5.5 2 2 5.4 2c2 0 3.6 1.2 4.6 2.7C11 3.2 12.6 2 14.6 2 18 2 20.4 5.5 19 9.1c-2.3 4.3-9 8.4-9 8.4z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function BagIcon() {
  return (
    <svg className="h-4 w-4 sm:h-[18px] sm:w-[18px]" viewBox="0 0 20 20" fill="none">
      <path d="M5 7h10l0.8 10.5a1 1 0 01-1 1.1H5.2a1 1 0 01-1-1.1L5 7z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M7.2 7V5.5a2.8 2.8 0 015.6 0V7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function MenuIcon() {
  return (
    <svg className="h-4 w-4 sm:h-[18px] sm:w-[18px]" viewBox="0 0 20 20" fill="none">
      <path d="M2 5h16M2 10h16M2 15h16" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 18 18" fill="none">
      <path d="M1 1L17 17M17 1L1 17" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}
