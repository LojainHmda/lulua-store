import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { getVariant } from "../data/variants";
import type { Product } from "../types";

const CART_STORAGE_KEY = "lulua:cart";

function loadStoredLines(): CartLine[] {
  try {
    const raw = localStorage.getItem(CART_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export interface CartLine {
  key: string;
  productId: string;
  variantId: string;
  slug: string;
  name: string;
  price: number;
  imageId?: string;
  imageUrl?: string;
  color: string;
  size: string;
  qty: number;
  // Optional, per-line customer note (e.g. "gift wrap please") -- always
  // scoped to this exact product/variant/size line via `key`, never shared
  // across lines. Kept as the raw, untrimmed string while the customer is
  // still editing it; placeOrder() trims and omits it entirely if blank
  // when the order is actually created, so persistence here doesn't need
  // to duplicate that logic.
  note?: string;
}

// Pure so it's independently testable without a component-testing library
// (this project doesn't have one) -- exercised directly by
// tests/unit/cartContext.test.ts. Only ever touches the single line whose
// key matches; every other line's note (or any other field) is returned
// unchanged, by construction of a plain .map().
export function setLineNote(lines: CartLine[], key: string, note: string): CartLine[] {
  return lines.map((l) => (l.key === key ? { ...l, note } : l));
}

interface CartContextValue {
  lines: CartLine[];
  isOpen: boolean;
  open: () => void;
  close: () => void;
  addItem: (product: Product, variantId: string, size: string, qty?: number) => void;
  removeLine: (key: string) => void;
  setQty: (key: string, qty: number) => void;
  setNote: (key: string, note: string) => void;
  clearCart: () => void;
  count: number;
  subtotal: number;
  lastAdded: string | null;
}

const CartContext = createContext<CartContextValue | null>(null);

export function CartProvider({ children }: { children: ReactNode }) {
  const [lines, setLines] = useState<CartLine[]>(loadStoredLines);
  const [isOpen, setIsOpen] = useState(false);
  const [lastAdded, setLastAdded] = useState<string | null>(null);

  useEffect(() => {
    localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(lines));
  }, [lines]);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);

  const addItem = useCallback((product: Product, variantId: string, size: string, qty = 1) => {
    const key = `${product.id}-${variantId}-${size}`;
    const variant = getVariant(product, variantId);
    setLines((prev) => {
      const existing = prev.find((l) => l.key === key);
      if (existing) {
        return prev.map((l) => (l.key === key ? { ...l, qty: l.qty + qty } : l));
      }
      return [
        ...prev,
        {
          key,
          productId: product.id,
          variantId: variant?.id ?? variantId,
          slug: product.slug,
          name: product.name,
          price: product.price,
          imageId: variant?.imageId,
          imageUrl: variant?.imageUrl,
          color: variant?.colorName ?? "",
          size,
          qty,
        },
      ];
    });
    setLastAdded(key);
    setIsOpen(true);
  }, []);

  const removeLine = useCallback((key: string) => {
    setLines((prev) => prev.filter((l) => l.key !== key));
  }, []);

  const setQty = useCallback((key: string, qty: number) => {
    setLines((prev) =>
      qty <= 0 ? prev.filter((l) => l.key !== key) : prev.map((l) => (l.key === key ? { ...l, qty } : l))
    );
  }, []);

  const setNote = useCallback((key: string, note: string) => {
    setLines((prev) => setLineNote(prev, key, note));
  }, []);

  const clearCart = useCallback(() => setLines([]), []);

  const count = useMemo(() => lines.reduce((sum, l) => sum + l.qty, 0), [lines]);
  const subtotal = useMemo(() => lines.reduce((sum, l) => sum + l.qty * l.price, 0), [lines]);

  const value: CartContextValue = {
    lines,
    isOpen,
    open,
    close,
    addItem,
    removeLine,
    setQty,
    setNote,
    clearCart,
    count,
    subtotal,
    lastAdded,
  };

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart() {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error("useCart must be used within CartProvider");
  return ctx;
}
