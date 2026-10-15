import { useEffect } from "react";

// The storefront sets html { font-size: 19px } for its editorial look, and
// every Tailwind size is rem-based -- so the admin dashboard and POS (whose
// .admin-root only resets its own font-size, not the rem base) rendered ~19%
// oversized. Staff apps run at the normal 16px UI scale while mounted and
// hand the storefront its own size back on the way out.
export function useUiRootFontSize() {
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.style.fontSize;
    root.style.fontSize = "16px";
    return () => {
      root.style.fontSize = previous;
    };
  }, []);
}
