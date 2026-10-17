import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import GlobalOrdersSidebar from "./components/admin/GlobalOrdersSidebar";
import { ToastProvider } from "./admin/components/ToastContext";

const AdminApp = lazy(() => import("./admin/AdminApp"));
const PosApp = lazy(() => import("./pos/PosApp"));

export default function App() {
  return (
    <>
      <Routes>
        <Route
          path="/admin/*"
          element={
            <Suspense fallback={<div className="min-h-screen bg-cream" />}>
              <AdminApp />
            </Suspense>
          }
        />
        <Route
          path="/pos/*"
          element={
            <Suspense fallback={<div className="min-h-screen bg-cream" />}>
              <PosApp />
            </Suspense>
          }
        />
        {/* No storefront: this app is only the admin and the POS. Any other
            URL (including /) opens the admin. */}
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Routes>
      {/* Mounted on every route (storefront, /admin, /pos alike) — renders
          nothing unless the signed-in visitor is a real, active admin. See
          GlobalOrdersSidebar.tsx for the auth gate. Own ToastProvider: this
          sits outside both AdminApp's and PosApp's route trees (and their
          own separate ToastProviders), so anything it renders that calls
          useToast() — e.g. ProcessReturnModal, opened from here for a
          cashier who can't reach /admin at all — needs its own instance,
          or it throws and blanks the whole panel. */}
      <ToastProvider>
        <GlobalOrdersSidebar />
      </ToastProvider>
    </>
  );
}
