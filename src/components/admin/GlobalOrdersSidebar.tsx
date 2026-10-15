import { lazy, Suspense } from "react";
import { useAdminSession } from "../../hooks/useAdminSession";

// Mounted once, unconditionally, at the App root — but this file only ever
// does a cheap auth/role check. The actual sidebar UI (order list, live
// data, everything) lives in a separate module that's only ever
// dynamically imported once that check confirms a real, active admin is
// signed in, so regular customers and anonymous visitors never download
// so much as a byte of it.
const GlobalOrdersSidebarPanel = lazy(() => import("./GlobalOrdersSidebarPanel"));

export default function GlobalOrdersSidebar() {
  const session = useAdminSession();
  if (!session) return null;

  return (
    <Suspense fallback={null}>
      <GlobalOrdersSidebarPanel />
    </Suspense>
  );
}
