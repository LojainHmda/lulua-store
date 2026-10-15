import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useLanguage } from "../../context/LanguageContext";
import { normalizeSearchText } from "../../components/admin/orderSearch";
import { useAdminAuth } from "../AdminAuthContext";
import { NAV_GROUPS } from "../navConfig";
import { matchAndRank, type SearchEntry } from "../search/buildIndex";
import { useGlobalSearch } from "../search/useGlobalSearch";
import AdminIcon from "./AdminIcons";
import { Badge, Spinner } from "./ui";

const PAGE_RESULT_LIMIT = 6;

type ResultGroup = { type: SearchEntry["type"]; labelKey: string; items: SearchEntry[]; total: number };

// Single component so the header trigger button and the fixed-position
// overlay can share one bit of open state with no prop drilling — `fixed`
// positioning doesn't care where in the DOM this renders, so placing it
// inline in AdminLayout's header row is enough for both pieces.
export default function CommandPalette() {
  const { profile } = useAdminAuth();
  const { t, dir } = useLanguage();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Same role-filter shape as the sidebar itself (AdminLayout.tsx) — a page
  // never appears here that wouldn't also appear in the nav.
  const navItems = useMemo(
    () =>
      NAV_GROUPS.flatMap((g) => g.items.filter((item) => !item.minRole || (profile && item.minRole.includes(profile.role)))),
    [profile]
  );

  const pageEntries = useMemo<SearchEntry[]>(
    () =>
      navItems.map((item) => {
        const label = t(item.labelKey);
        return {
          id: `page:${item.path}`,
          type: "page",
          title: label,
          href: item.path,
          icon: item.icon,
          timestamp: 0,
          identifierMatches: [],
          titleMatches: [normalizeSearchText(label)],
          phones: [],
          blob: normalizeSearchText(label),
        };
      }),
    [navItems, t]
  );

  // Products/orders/customers: role-aware, lazily loaded once the palette
  // is opened, then searched entirely client-side — see useGlobalSearch.
  // Products only: online orders and customers are storefront data, hidden
  // from the POS-focused admin (their pages are still reachable by URL).
  const { results: dataResults, loading } = useGlobalSearch(open, query, { includeOrdersCustomers: false });

  const hasQuery = query.trim().length > 0;
  const pageMatch = useMemo(
    () => (hasQuery ? matchAndRank(pageEntries, query, PAGE_RESULT_LIMIT) : { items: pageEntries, total: pageEntries.length }),
    [pageEntries, query, hasQuery]
  );

  // Fixed, predictable group order. Pages only get their own header once
  // they're sharing space with data groups — the empty-query state (pages
  // only) stays exactly as plain a list as it always was.
  const groups = useMemo<ResultGroup[]>(() => {
    const list: ResultGroup[] = [];
    if (hasQuery) {
      if (dataResults.products.length) list.push({ type: "product", labelKey: "admin.nav.products", items: dataResults.products, total: dataResults.productsTotal });
      if (dataResults.orders.length) list.push({ type: "order", labelKey: "admin.nav.orders", items: dataResults.orders, total: dataResults.ordersTotal });
      if (dataResults.customers.length) list.push({ type: "customer", labelKey: "admin.nav.customers", items: dataResults.customers, total: dataResults.customersTotal });
    }
    if (pageMatch.items.length) list.push({ type: "page", labelKey: "admin.commandPalette.pages", items: pageMatch.items, total: pageMatch.total });
    return list;
  }, [hasQuery, dataResults, pageMatch]);

  const flatResults = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const showGroupHeaders = hasQuery;

  useEffect(() => {
    setActiveIndex(0);
  }, [query, open]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
        return;
      }
      if (!open) return;
      if (e.key === "Escape") {
        setOpen(false);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, flatResults.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const target = flatResults[activeIndex];
        if (target) go(target.href);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, flatResults, activeIndex]);

  useEffect(() => {
    if (open) {
      setQuery("");
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  function go(href: string) {
    navigate(href);
    setOpen(false);
  }

  let rowIndex = -1;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label={t("admin.commandPalette.open")}
        className="hidden items-center gap-2 rounded-lg border border-line bg-cream-dim px-3 py-2 text-sm text-ink-faint hover:border-ink-faint sm:flex"
      >
        <AdminIcon name="search" className="h-4 w-4" />
        <span>{t("admin.commandPalette.placeholder")}</span>
        <span className="ms-3 rounded border border-line bg-paper px-1.5 py-0.5 text-[11px] font-semibold text-ink-faint">
          {dir === "rtl" ? "K ⌘" : "⌘K"}
        </span>
      </button>

      <AnimatePresence>
        {open && (
          <div className="fixed inset-0 z-[200] flex justify-center px-4 pt-[12vh]">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="absolute inset-0 bg-ink/40 backdrop-blur-[2px]"
              onClick={() => setOpen(false)}
            />
            <motion.div
              role="dialog"
              aria-modal="true"
              aria-label={t("admin.commandPalette.open")}
              initial={{ opacity: 0, y: -8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.98 }}
              transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
              className="relative z-10 h-fit w-full max-w-xl overflow-hidden rounded-2xl bg-paper shadow-lift"
            >
              <div className="flex items-center gap-2.5 border-b border-line px-4 py-3">
                <AdminIcon name="search" className="h-4.5 w-4.5 shrink-0 text-ink-faint" />
                <input
                  ref={inputRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t("admin.commandPalette.placeholder")}
                  className="w-full bg-transparent text-base text-ink outline-none placeholder:text-ink-faint"
                />
                {loading && hasQuery && <Spinner className="h-4 w-4 shrink-0 text-ink-faint" />}
              </div>
              <div className="max-h-[65vh] overflow-y-auto p-2">
                {flatResults.length === 0 ? (
                  <p className="px-3 py-6 text-center text-sm text-ink-faint">{t("admin.commandPalette.noResults")}</p>
                ) : (
                  groups.map((group) => (
                    <div key={group.type} className="mb-1 last:mb-0">
                      {showGroupHeaders && (
                        <p className="px-3 pb-1 pt-2 text-[11px] font-bold uppercase tracking-wide text-ink-faint">{t(group.labelKey)}</p>
                      )}
                      {group.items.map((entry) => {
                        rowIndex += 1;
                        const i = rowIndex;
                        return (
                          <ResultRow
                            key={entry.id}
                            entry={entry}
                            active={i === activeIndex}
                            onClick={() => go(entry.href)}
                            onMouseEnter={() => setActiveIndex(i)}
                          />
                        );
                      })}
                      {group.total > group.items.length && (
                        <p className="px-3 pb-1 pt-1 text-xs text-ink-faint">
                          {t("admin.commandPalette.moreResults").replace("{n}", String(group.total - group.items.length))}
                        </p>
                      )}
                    </div>
                  ))
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </>
  );
}

function ResultRow({ entry, active, onClick, onMouseEnter }: { entry: SearchEntry; active: boolean; onClick: () => void; onMouseEnter: () => void }) {
  return (
    <button
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-start ${
        active ? "bg-wine text-on-accent" : "text-ink hover:bg-cream-dim"
      }`}
    >
      <ResultVisual entry={entry} active={active} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{entry.title}</p>
        {entry.subtitle && <p className={`truncate text-xs ${active ? "text-on-accent/80" : "text-ink-faint"}`}>{entry.subtitle}</p>}
      </div>
      {(entry.amountLabel || entry.badgeLabel) && (
        <div className="shrink-0 text-end">
          {entry.amountLabel && <p className="text-sm font-bold">{entry.amountLabel}</p>}
          {entry.badgeLabel && <Badge tone={entry.badgeTone ?? "neutral"}>{entry.badgeLabel}</Badge>}
        </div>
      )}
    </button>
  );
}

function ResultVisual({ entry, active }: { entry: SearchEntry; active: boolean }) {
  if (entry.type === "page") {
    return <AdminIcon name={entry.icon} className="h-4 w-4 shrink-0" />;
  }
  if (entry.thumbnail) {
    return <img src={entry.thumbnail} alt="" className="h-9 w-9 shrink-0 rounded-lg object-cover" />;
  }
  if (entry.avatarText) {
    return (
      <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold ${active ? "bg-paper/20" : "bg-wine text-on-accent"}`}>
        {entry.avatarText}
      </div>
    );
  }
  const toneClass =
    entry.type === "order"
      ? active
        ? "bg-paper/20"
        : "bg-wine-light text-wine"
      : active
        ? "bg-paper/20"
        : "bg-cream-dim text-ink-faint";
  return (
    <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${toneClass}`}>
      <AdminIcon name={entry.icon} className="h-4 w-4" />
    </div>
  );
}
