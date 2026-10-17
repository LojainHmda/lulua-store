import { Navigate, Route, Routes } from "react-router-dom";
import { isBackendConfigured } from "../firebase/config";
import { useUiRootFontSize } from "../hooks/useUiRootFontSize";
import { useLanguage } from "../context/LanguageContext";
import { AdminAuthProvider, useAdminAuth } from "./AdminAuthContext";
import AccessDenied from "./pages/AccessDenied";
import ComingSoon from "./pages/ComingSoon";
import FirebaseSetupNeeded from "./pages/FirebaseSetupNeeded";
import Login from "./pages/Login";
import RequireRole from "./components/RequireRole";
import { ToastProvider } from "./components/ToastContext";
import { PageLoading } from "./components/ui";
import AdminLayout from "./layout/AdminLayout";

import Dashboard from "./pages/Dashboard";
import PosDashboard from "./pages/PosDashboard";
import ProductList from "./pages/products/ProductList";
import ProductEditor from "./pages/products/ProductEditor";
import UnsellableProducts from "./pages/products/UnsellableProducts";
import CategoryList from "./pages/categories/CategoryList";
import Inventory from "./pages/Inventory";
import StockLedger from "./pages/StockLedger";
import BranchStock from "./pages/BranchStock";
import Branches from "./pages/Branches";
import PosSales from "./pages/PosSales";
import MediaLibrary from "./pages/MediaLibrary";
import Team from "./pages/Team";
import OrderList from "./pages/orders/OrderList";
import OrderDetail from "./pages/orders/OrderDetail";
import OrderCustomerShipping from "./pages/orders/OrderCustomerShipping";
import OrderCustomerHistory from "./pages/orders/OrderCustomerHistory";
import OrderInternalInfo from "./pages/orders/OrderInternalInfo";
import ReturnsList from "./pages/returns/ReturnsList";
import ReturnDetail from "./pages/returns/ReturnDetail";
import CustomerList from "./pages/CustomerList";
import CustomerDetail from "./pages/CustomerDetail";
import DiscountList from "./pages/DiscountList";
import DeliveryZones from "./pages/DeliveryZones";
import ReviewList from "./pages/ReviewList";
import HomepageContent from "./pages/HomepageContent";
import Analytics from "./pages/Analytics";
import Reports from "./pages/Reports";
import Notifications from "./pages/Notifications";
import ActivityLog from "./pages/ActivityLog";
import Backup from "./pages/Backup";
import Settings from "./pages/settings/Settings";
import AssistantPage from "./assistant/AssistantPage";

function AdminRoutes() {
  const { loading, firebaseUser, profile } = useAdminAuth();
  const { dir, t } = useLanguage();

  if (loading) {
    return (
      <div dir={dir} className="admin-root flex min-h-screen items-center justify-center bg-cream">
        <PageLoading />
      </div>
    );
  }

  if (!firebaseUser) return <Login />;
  if (!profile) return <AccessDenied />;
  if (profile.role === "cashier") return <Navigate to="/pos" replace />;

  return (
    <Routes>
      <Route element={<AdminLayout />}>
        {/* The admin is a POS management console: it lands on the POS
            Dashboard. The original store dashboard (web orders, customers,
            reviews) is kept, unlinked from the menu, at /admin/store-dashboard. */}
        <Route index element={<PosDashboard />} />
        <Route path="store-dashboard" element={<Dashboard />} />

        {/* CONTENT roles (owner/admin/editor) can write; viewer can also
            reach these routes read-only (each page's own canWrite gates
            the actual editing controls) — only cashier is excluded, and
            that's already handled by the redirect above. Wrapping every
            content route in RequireRole here (not just the ones that
            happened to remember their own internal role check) is the
            structural fix for the ProductForm gap: a future new page can't
            silently ship with no gating at all. */}
        <Route
          path="products"
          element={
            <RequireRole roles={["owner", "admin", "editor", "viewer"]}>
              <ProductList />
            </RequireRole>
          }
        />
        <Route
          path="products/new"
          element={
            <RequireRole roles={["owner", "admin", "editor", "viewer"]}>
              <ProductEditor />
            </RequireRole>
          }
        />
        <Route
          path="products/:id"
          element={
            <RequireRole roles={["owner", "admin", "editor", "viewer"]}>
              <ProductEditor />
            </RequireRole>
          }
        />

        {/* Same role gate as the product list it sits beside: viewing is
            allowed for owner/admin/editor/viewer, and the page is read-only
            (no edit/delete controls), so no permission is widened. */}
        <Route
          path="unsellable-products"
          element={
            <RequireRole roles={["owner", "admin", "editor", "viewer"]}>
              <UnsellableProducts />
            </RequireRole>
          }
        />

        <Route
          path="categories"
          element={
            <RequireRole roles={["owner", "admin", "editor", "viewer"]}>
              <CategoryList />
            </RequireRole>
          }
        />
        <Route
          path="inventory"
          element={
            <RequireRole roles={["owner", "admin", "editor", "viewer"]}>
              <Inventory />
            </RequireRole>
          }
        />
        <Route
          path="stock-ledger"
          element={
            <RequireRole roles={["owner", "admin", "editor", "viewer"]}>
              <StockLedger />
            </RequireRole>
          }
        />

        <Route
          path="branch-stock"
          element={
            <RequireRole roles={["owner", "admin", "editor", "viewer"]}>
              <BranchStock />
            </RequireRole>
          }
        />
        <Route
          path="branches"
          element={
            <RequireRole roles={["owner", "admin"]}>
              <Branches />
            </RequireRole>
          }
        />
        <Route
          path="pos-sales"
          element={
            <RequireRole roles={["owner", "admin"]}>
              <PosSales />
            </RequireRole>
          }
        />
        <Route
          path="orders"
          element={
            <RequireRole roles={["owner", "admin"]}>
              <OrderList />
            </RequireRole>
          }
        />
        <Route
          path="orders/:id"
          element={
            // Widened from owner/admin to also admit editor/cashier SOLELY
            // so they can reach the Branch Stock Note interaction on this
            // page (OrderDetail.tsx's own canEditBranchNote gate, separate
            // from canWrite) -- every other control here (status change,
            // line editing, cancellation, etc.) still checks canWrite
            // (owner/admin only), completely unaffected by this route
            // change. The three sub-pages below (customer/history/internal)
            // deliberately stay owner/admin-only: none of them carry the
            // branch note feature.
            <RequireRole roles={["owner", "admin", "editor", "cashier"]}>
              <OrderDetail />
            </RequireRole>
          }
        />
        {/* Dedicated Customer & Shipping / Customer History / Internal
            Information pages for one order -- reached from OrderDetail's
            header icons. Same route param name, same role gate as
            orders/:id itself, so anyone who can view Order Detail retains
            exactly the same access to these and no one else gains any. */}
        <Route
          path="orders/:id/customer"
          element={
            <RequireRole roles={["owner", "admin"]}>
              <OrderCustomerShipping />
            </RequireRole>
          }
        />
        <Route
          path="orders/:id/history"
          element={
            <RequireRole roles={["owner", "admin"]}>
              <OrderCustomerHistory />
            </RequireRole>
          }
        />
        <Route
          path="orders/:id/internal"
          element={
            <RequireRole roles={["owner", "admin"]}>
              <OrderInternalInfo />
            </RequireRole>
          }
        />
        <Route
          path="returns"
          element={
            <RequireRole roles={["owner", "admin"]}>
              <ReturnsList />
            </RequireRole>
          }
        />
        <Route
          path="returns/:id"
          element={
            <RequireRole roles={["owner", "admin"]}>
              <ReturnDetail />
            </RequireRole>
          }
        />
        <Route
          path="customers"
          element={
            <RequireRole roles={["owner", "admin"]}>
              <CustomerList />
            </RequireRole>
          }
        />
        <Route
          path="customers/:id"
          element={
            <RequireRole roles={["owner", "admin"]}>
              <CustomerDetail />
            </RequireRole>
          }
        />
        <Route
          path="discounts"
          element={
            <RequireRole roles={["owner", "admin", "editor", "viewer"]}>
              <DiscountList />
            </RequireRole>
          }
        />
        <Route
          path="delivery-zones"
          element={
            <RequireRole roles={["owner", "admin", "editor", "viewer"]}>
              <DeliveryZones />
            </RequireRole>
          }
        />

        <Route
          path="homepage"
          element={
            <RequireRole roles={["owner", "admin", "editor", "viewer"]}>
              <HomepageContent />
            </RequireRole>
          }
        />
        <Route
          path="media"
          element={
            <RequireRole roles={["owner", "admin", "editor", "viewer"]}>
              <MediaLibrary />
            </RequireRole>
          }
        />
        <Route
          path="reviews"
          element={
            <RequireRole roles={["owner", "admin", "editor", "viewer"]}>
              <ReviewList />
            </RequireRole>
          }
        />

        {/* Sisely AI -- same owner/admin boundary as Order Detail/Customer
            Detail; reached only via the header's "AI" trigger
            (AdminLayout.tsx). Read-only, deterministic assistant engine --
            see src/admin/assistant/. */}
        <Route
          path="assistant"
          element={
            <RequireRole roles={["owner", "admin"]}>
              <AssistantPage />
            </RequireRole>
          }
        />
        <Route
          path="analytics"
          element={
            <RequireRole roles={["owner", "admin"]}>
              <Analytics />
            </RequireRole>
          }
        />
        <Route
          path="reports"
          element={
            <RequireRole roles={["owner", "admin"]}>
              <Reports />
            </RequireRole>
          }
        />
        <Route path="notifications" element={<Notifications />} />
        <Route
          path="activity"
          element={
            <RequireRole roles={["owner", "admin"]}>
              <ActivityLog />
            </RequireRole>
          }
        />

        <Route
          path="team"
          element={
            <RequireRole roles={["owner"]}>
              <Team />
            </RequireRole>
          }
        />
        <Route
          path="backup"
          element={
            <RequireRole roles={["owner"]}>
              <Backup />
            </RequireRole>
          }
        />
        <Route
          path="settings/:tab"
          element={
            <RequireRole roles={["owner", "admin"]}>
              <Settings />
            </RequireRole>
          }
        />

        <Route path="*" element={<ComingSoon title={t("admin.notFound.title")} description={t("admin.notFound.description")} />} />
      </Route>
    </Routes>
  );
}

export default function AdminApp() {
  useUiRootFontSize();
  if (!isBackendConfigured) return <FirebaseSetupNeeded />;

  return (
    <AdminAuthProvider>
      <ToastProvider>
        <AdminRoutes />
      </ToastProvider>
    </AdminAuthProvider>
  );
}
