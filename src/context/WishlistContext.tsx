import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

// Same shape/philosophy as CartContext: a plain JSON array in localStorage,
// no Firestore and no account sync. Lifting it into a context (rather than
// per-card useState) is the actual fix — every ProductCard rendering the same
// product now reads one shared source of truth, so the heart can't disagree
// with itself between the shop grid, a home rail and the "you might also
// like" rail on the product page.
const WISHLIST_STORAGE_KEY = "lulua:wishlist";

function loadStoredIds(): string[] {
  try {
    const raw = localStorage.getItem(WISHLIST_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

interface WishlistContextValue {
  ids: string[];
  has: (productId: string) => boolean;
  toggle: (productId: string) => void;
  remove: (productId: string) => void;
  clear: () => void;
  count: number;
}

const WishlistContext = createContext<WishlistContextValue | null>(null);

export function WishlistProvider({ children }: { children: ReactNode }) {
  const [ids, setIds] = useState<string[]>(loadStoredIds);

  useEffect(() => {
    localStorage.setItem(WISHLIST_STORAGE_KEY, JSON.stringify(ids));
  }, [ids]);

  const toggle = useCallback((productId: string) => {
    setIds((prev) => (prev.includes(productId) ? prev.filter((id) => id !== productId) : [...prev, productId]));
  }, []);

  const remove = useCallback((productId: string) => {
    setIds((prev) => prev.filter((id) => id !== productId));
  }, []);

  const clear = useCallback(() => setIds([]), []);

  const value = useMemo<WishlistContextValue>(
    () => ({
      ids,
      has: (productId: string) => ids.includes(productId),
      toggle,
      remove,
      clear,
      count: ids.length,
    }),
    [ids, toggle, remove, clear]
  );

  return <WishlistContext.Provider value={value}>{children}</WishlistContext.Provider>;
}

export function useWishlist() {
  const ctx = useContext(WishlistContext);
  if (!ctx) throw new Error("useWishlist must be used within WishlistProvider");
  return ctx;
}
