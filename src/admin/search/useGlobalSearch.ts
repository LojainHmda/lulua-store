import { orderBy, limit as fsLimit } from "../../db/firestore";
import { useEffect, useMemo, useState } from "react";
import { categoriesApi, customersApi, ordersApi, productsApi } from "../../firebase/collections";
import { buildCategoryLookup, buildProductLookup } from "../../components/admin/orderSearch";
import { normalizeProduct } from "../productVariants";
import { useAdminAuth } from "../AdminAuthContext";
import { useLanguage } from "../../context/LanguageContext";
import type { AdminCategory, AdminCustomer, AdminOrder, AdminProduct, AdminRole } from "../types";
import { buildCustomerEntries, buildOrderEntries, buildProductEntries, matchAndRank, type SearchEntry } from "./buildIndex";

// Same idea as GlobalOrdersSidebarPanel's own MAX_ORDERS cap: orders grow
// without bound over time in a way products/customers don't at this
// store's scale, so search only indexes the most recent slice rather than
// the entire history.
const SEARCH_ORDER_LIMIT = 300;
const MAX_RESULTS_PER_GROUP = 5;

// Mirrors navConfig.ts's CONTENT group exactly — the roles that can reach
// /admin/products in the sidebar. Kept as its own list here rather than
// importing navConfig's CONTENT so this file doesn't force navConfig to
// export internals it doesn't otherwise need to; the two must still be
// changed together if either ever does (see the code comment on
// PRODUCT_SEARCH_ROLES's sibling below).
export const PRODUCT_SEARCH_ROLES: AdminRole[] = ["owner", "admin", "editor"];

// Matches the real Firestore permission for orders/customers
// (isCashierOrAbove() in firestore.rules) — NOT navConfig's OPS constant,
// which is narrower (owner/admin only) because it only controls sidebar
// *visibility*, not data access. This is deliberately the wider, correct
// answer for "who is allowed to read this data at all."
//
// In today's app this is still only ever exercised by owner/admin in
// practice: CommandPalette only renders inside AdminLayout, and a cashier
// is redirected to /pos before AdminLayout ever mounts (AdminApp.tsx) — so
// there is currently no UI path for a cashier to open this search at all.
// Including "cashier" here is about correctness, not reachability: if a
// future change ever surfaces this search from POS, the permission logic
// underneath it is already right without needing rework. See the search
// feature's test suite for a direct check of this.
export const ORDER_CUSTOMER_SEARCH_ROLES: AdminRole[] = ["owner", "admin", "cashier"];

export interface SearchResults {
  products: SearchEntry[];
  productsTotal: number;
  orders: SearchEntry[];
  ordersTotal: number;
  customers: SearchEntry[];
  customersTotal: number;
}

const EMPTY_RESULTS: SearchResults = { products: [], productsTotal: 0, orders: [], ordersTotal: 0, customers: [], customersTotal: 0 };

// Role-aware, lazily-loaded, in-memory search over products/orders/
// customers. `active` should be the palette's own open state and `query`
// its current input value: nothing is fetched from Firestore until the
// first time `active` is true, and never again after that — every read
// here happens at most once per admin session (see the `loaded` guard
// below). Every keystroke after the initial load only re-runs `useMemo`
// below, which is pure client-side filtering over already-fetched data.
export function useGlobalSearch(active: boolean, query: string, { includeOrdersCustomers = true }: { includeOrdersCustomers?: boolean } = {}) {
  const { profile } = useAdminAuth();
  const { lang, t } = useLanguage();
  const role = profile?.role;
  const canSearchProducts = !!role && PRODUCT_SEARCH_ROLES.includes(role);
  const canSearchOrdersCustomers = includeOrdersCustomers && !!role && ORDER_CUSTOMER_SEARCH_ROLES.includes(role);

  const [products, setProducts] = useState<AdminProduct[]>([]);
  const [categories, setCategories] = useState<AdminCategory[]>([]);
  const [orders, setOrders] = useState<AdminOrder[]>([]);
  const [customers, setCustomers] = useState<AdminCustomer[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!active || loaded) return;
    let cancelled = false;
    setLoading(true);
    const tasks: Promise<unknown>[] = [];
    if (canSearchProducts) {
      tasks.push(
        Promise.all([productsApi.list(), categoriesApi.list()]).then(([p, c]) => {
          if (cancelled) return;
          setProducts(p.map(normalizeProduct));
          setCategories(c);
        })
      );
    }
    if (canSearchOrdersCustomers) {
      tasks.push(ordersApi.list([orderBy("createdAt", "desc"), fsLimit(SEARCH_ORDER_LIMIT)]).then((o) => !cancelled && setOrders(o)));
      tasks.push(customersApi.list().then((c) => !cancelled && setCustomers(c)));
    }
    Promise.all(tasks).finally(() => {
      if (cancelled) return;
      setLoading(false);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [active, loaded, canSearchProducts, canSearchOrdersCustomers]);

  // The index itself: rebuilt only when the underlying data or language
  // changes, never per keystroke.
  const entries = useMemo(() => {
    const categoryLookup = buildCategoryLookup(categories);
    const productLookup = buildProductLookup(products);
    return {
      products: canSearchProducts ? buildProductEntries(products, categoryLookup, lang, t) : [],
      orders: canSearchOrdersCustomers ? buildOrderEntries(orders, productLookup, categoryLookup, t) : [],
      customers: canSearchOrdersCustomers ? buildCustomerEntries(customers, t) : [],
    };
  }, [products, categories, orders, customers, canSearchProducts, canSearchOrdersCustomers, lang, t]);

  const results = useMemo((): SearchResults => {
    if (!loaded || !query.trim()) return EMPTY_RESULTS;
    const p = matchAndRank(entries.products, query, MAX_RESULTS_PER_GROUP);
    const o = matchAndRank(entries.orders, query, MAX_RESULTS_PER_GROUP);
    const c = matchAndRank(entries.customers, query, MAX_RESULTS_PER_GROUP);
    return { products: p.items, productsTotal: p.total, orders: o.items, ordersTotal: o.total, customers: c.items, customersTotal: c.total };
  }, [loaded, entries, query]);

  return { results, loading: loading && !loaded };
}
