import { useEffect, useState } from "react";
import { useUiRootFontSize } from "../hooks/useUiRootFontSize";
import { Navigate, Route, Routes, useLocation, useParams, useSearchParams } from "react-router-dom";
import { AdminAuthProvider, useAdminAuth } from "../admin/AdminAuthContext";
import { useLanguage } from "../context/LanguageContext";
import AccessDenied from "../admin/pages/AccessDenied";
import Login from "../admin/pages/Login";
import { PageLoading } from "../admin/components/ui";
import { isBackendConfigured } from "../firebase/config";
import FirebaseSetupNeeded from "../admin/pages/FirebaseSetupNeeded";
import type { RegisterSession } from "../admin/types";
import { findOpenSession } from "../firebase/registerSession";
import { POS_TOKEN_RE } from "../firebase/posLinks";
import { ToastProvider } from "../admin/components/ToastContext";
import PosLinkGate from "./PosLinkGate";
import PosLinkPicker from "./PosLinkPicker";
import DeviceStartShift from "./DeviceStartShift";
import CloseRegister from "./CloseRegister";
import OpenRegister from "./OpenRegister";
import PosLayout from "./PosLayout";
import { OfflineProvider } from "./offline/OfflineContext";
import { tillBase, tillUrl } from "./posPaths";
import Returns from "./Returns";
import Terminal from "./Terminal";
import TodaySales from "./TodaySales";

// No open session: the start screen, pre-selecting whatever the URL names
// (/pos, /pos/<branchCode>, /pos/<branchCode>/<registerId>?cashier=<uid>).
// An open session always lives at its own till URL instead -- see TillRoute.
function StartScreen({ session, onOpened }: { session: RegisterSession | null; onOpened: (s: RegisterSession) => void }) {
  const { branchCode, registerId } = useParams();
  const [params] = useSearchParams();
  const { profile } = useAdminAuth();
  if (session) return <Navigate to={tillUrl(session)} replace />;
  // A POS device (opened from its register's link): name + float only.
  if (profile?.posLink) return <DeviceStartShift onOpened={onOpened} />;
  return <OpenRegister preset={{ branchCode: branchCode ?? null, registerId: registerId ?? null, cashierId: params.get("cashier") }} onOpened={onOpened} />;
}

// /pos/<branchCode>/<registerId>[/sales|/returns|/close]: only ever shows the
// signed-in user's own open session; any other till URL redirects to it (or
// to the start screen, pre-selected, when nothing is open yet).
function TillRoute({
  session,
  screen,
  onOpened,
  onSessionUpdate,
  onClosed,
}: {
  session: RegisterSession | null;
  screen: "till" | "sales" | "returns" | "close";
  onOpened: (s: RegisterSession) => void;
  onSessionUpdate: () => void;
  onClosed: () => void;
}) {
  const location = useLocation();
  if (!session) return <StartScreen session={null} onOpened={onOpened} />;
  const base = tillBase(session);
  const expected = screen === "till" ? base : `${base}/${screen}`;
  if (decodeURIComponent(location.pathname) !== decodeURIComponent(expected)) {
    return <Navigate to={screen === "till" ? tillUrl(session) : expected} replace />;
  }
  if (screen === "sales") return <TodaySales session={session} />;
  if (screen === "returns") return <Returns session={session} onSessionUpdate={onSessionUpdate} />;
  if (screen === "close") return <CloseRegister session={session} onClosed={onClosed} />;
  return <Terminal session={session} onSessionUpdate={onSessionUpdate} />;
}

function PosRoutes() {
  const { loading, firebaseUser, profile, hasRole } = useAdminAuth();
  const { dir, t } = useLanguage();
  const location = useLocation();
  // /pos/<token>: a POS device link -- no staff login involved.
  const linkToken = location.pathname.split("/")[2] ?? "";
  const [session, setSession] = useState<RegisterSession | null | undefined>(undefined);

  useEffect(() => {
    if (!profile) return;
    findOpenSession(profile.id)
      // A session just opened on this screen may not be visible to this
      // query yet (e.g. right after switching cashier): never let a stale
      // "nothing open" wipe out the session we already hold for this user.
      .then((found) => setSession((prev) => found ?? (prev && prev.cashierId === profile.id ? prev : null)))
      .catch(() => setSession(null));
  }, [profile]);

  if (POS_TOKEN_RE.test(linkToken)) return <PosLinkGate token={linkToken} />;

  if (loading) {
    return (
      <div dir={dir} className="admin-root flex min-h-screen items-center justify-center bg-cream">
        <PageLoading />
      </div>
    );
  }

  if (!firebaseUser) return <Login />;
  // A POS device whose link was revoked: say so, rather than a generic
  // "access denied" the person at the till can't act on.
  if (profile?.posLink && !profile.active) {
    return (
      <div dir={dir} className="admin-root flex min-h-screen items-center justify-center bg-cream p-6 text-center text-ink">
        <div className="max-w-sm">
          <h1 className="font-display text-xl font-bold">{t("pos.link.invalidTitle")}</h1>
          <p className="mt-2 text-sm text-ink-soft">{t("pos.link.revokedBody")}</p>
        </div>
      </div>
    );
  }
  if (!profile || !hasRole(["owner", "admin", "cashier"])) return <AccessDenied />;

  // Owner/admin never sell on a till themselves: /pos is where they pick a
  // branch and a POS and copy its link for the cashier's device.
  if (hasRole(["owner", "admin"])) {
    return (
      <PosLayout session={null}>
        <Routes>
          <Route path="/" element={<PosLinkPicker />} />
          <Route path="/:branchCode" element={<PosLinkPicker />} />
          <Route path="/:branchCode/:registerId" element={<PosLinkPicker />} />
          <Route path="*" element={<Navigate to="/pos" replace />} />
        </Routes>
      </PosLayout>
    );
  }

  if (session === undefined) {
    return (
      <PosLayout session={null}>
        <div className="flex h-full items-center justify-center">
          <PageLoading />
        </div>
      </PosLayout>
    );
  }

  const refresh = () =>
    findOpenSession(profile.id)
      .then(setSession)
      .catch(() => {});
  const till = (screen: "till" | "sales" | "returns" | "close") => (
    <TillRoute session={session} screen={screen} onOpened={setSession} onSessionUpdate={refresh} onClosed={() => setSession(null)} />
  );

  return (
    <OfflineProvider session={session} onSynced={refresh}>
    <PosLayout session={session} onSessionUpdate={refresh}>
      <Routes>
        <Route path="/" element={<StartScreen session={session} onOpened={setSession} />} />
        <Route path="/:branchCode" element={<StartScreen session={session} onOpened={setSession} />} />
        <Route path="/:branchCode/:registerId" element={till("till")} />
        <Route path="/:branchCode/:registerId/sales" element={till("sales")} />
        <Route path="/:branchCode/:registerId/returns" element={till("returns")} />
        <Route path="/:branchCode/:registerId/close" element={till("close")} />
        <Route path="*" element={<Navigate to="/pos" replace />} />
      </Routes>
    </PosLayout>
    </OfflineProvider>
  );
}

export default function PosApp() {
  useUiRootFontSize();
  if (!isBackendConfigured) return <FirebaseSetupNeeded />;

  return (
    <AdminAuthProvider>
      <ToastProvider>
        <PosRoutes />
      </ToastProvider>
    </AdminAuthProvider>
  );
}
