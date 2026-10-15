import { AnimatePresence } from "motion/react";
import { lazy, Suspense, useEffect } from "react";
import { Route, Routes, useLocation } from "react-router-dom";
import CartDrawer from "./components/layout/CartDrawer";
import Footer from "./components/layout/Footer";
import Header from "./components/layout/Header";
import PageTransition from "./components/layout/PageTransition";
import PromoBar from "./components/layout/PromoBar";
import SignInDrawer from "./components/layout/SignInDrawer";
import { CatalogProvider } from "./context/CatalogContext";
import { CustomerAuthProvider } from "./context/CustomerAuthContext";
import { useLenis } from "./hooks/useLenis";
import PageScrollbar from "./components/layout/PageScrollbar";
import { startPresenceHeartbeat, trackPageview } from "./analytics/track";
import GlobalOrdersSidebar from "./components/admin/GlobalOrdersSidebar";
import { ToastProvider } from "./admin/components/ToastContext";
import About from "./pages/About";
import Account from "./pages/Account";
import AccountAddresses from "./pages/AccountAddresses";
import AccountOrderDetail from "./pages/AccountOrderDetail";
import AccountOrders from "./pages/AccountOrders";
import Checkout from "./pages/Checkout";
import Home from "./pages/Home";
import NotFound from "./pages/NotFound";
import ProductDetail from "./pages/ProductDetail";
import Shop from "./pages/Shop";
import Wishlist from "./pages/Wishlist";

const AdminApp = lazy(() => import("./admin/AdminApp"));
const PosApp = lazy(() => import("./pos/PosApp"));
const OrderConfirmation = lazy(() => import("./pages/OrderConfirmation"));

function Storefront() {
  useLenis();
  const location = useLocation();

  // Live "active visitors" presence + daily visit/pageview counters for
  // the admin Analytics dashboard — storefront-only (never mounted under
  // /admin or /pos), so admin/POS usage never counts as visitor traffic.
  useEffect(() => startPresenceHeartbeat(), []);
  useEffect(() => {
    trackPageview();
  }, [location.pathname]);

  return (
    <CatalogProvider>
    <CustomerAuthProvider>
    <div className="flex min-h-screen flex-col">
      <PromoBar />
      <Header />
      <PageScrollbar />
      <main className="flex-1">
        <AnimatePresence mode="wait" initial={false}>
          <Routes location={location} key={location.pathname}>
            <Route
              path="/"
              element={
                <PageTransition>
                  <Home />
                </PageTransition>
              }
            />
            <Route
              path="/shop"
              element={
                <PageTransition>
                  <Shop />
                </PageTransition>
              }
            />
            <Route
              path="/shop/:category"
              element={
                <PageTransition>
                  <Shop />
                </PageTransition>
              }
            />
            <Route
              path="/product/:slug"
              element={
                <PageTransition>
                  <ProductDetail />
                </PageTransition>
              }
            />
            <Route
              path="/checkout"
              element={
                <PageTransition>
                  <Checkout />
                </PageTransition>
              }
            />
            {/* A real URL for the post-checkout thank-you screen, so a reload
                or back-button no longer destroys the order number (there's no
                backend or confirmation email to recover it from). */}
            <Route
              path="/checkout/confirmation/:orderId"
              element={
                <PageTransition>
                  <Suspense fallback={<div className="min-h-[60vh]" />}>
                    <OrderConfirmation />
                  </Suspense>
                </PageTransition>
              }
            />
            <Route
              path="/wishlist"
              element={
                <PageTransition>
                  <Wishlist />
                </PageTransition>
              }
            />
            <Route
              path="/account"
              element={
                <PageTransition>
                  <Account />
                </PageTransition>
              }
            />
            <Route
              path="/account/orders"
              element={
                <PageTransition>
                  <AccountOrders />
                </PageTransition>
              }
            />
            <Route
              path="/account/orders/:id"
              element={
                <PageTransition>
                  <AccountOrderDetail />
                </PageTransition>
              }
            />
            <Route
              path="/account/addresses"
              element={
                <PageTransition>
                  <AccountAddresses />
                </PageTransition>
              }
            />
            <Route
              path="/about"
              element={
                <PageTransition>
                  <About />
                </PageTransition>
              }
            />
            <Route
              path="/404"
              element={
                <PageTransition>
                  <NotFound />
                </PageTransition>
              }
            />
            <Route
              path="*"
              element={
                <PageTransition>
                  <NotFound />
                </PageTransition>
              }
            />
          </Routes>
        </AnimatePresence>
      </main>
      <Footer />
      <CartDrawer />
      <SignInDrawer />
    </div>
    </CustomerAuthProvider>
    </CatalogProvider>
  );
}

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
        <Route path="/*" element={<Storefront />} />
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
