import { useEffect, useRef, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { useAdminAuth } from "../admin/AdminAuthContext";
import { PageLoading } from "../admin/components/ui";
import { useLanguage } from "../context/LanguageContext";
import { claimPosLink, PosLinkError } from "../firebase/posLinks";

// /pos/<token>: opens this register's till on this device with no staff
// login (see src/firebase/posLinks.ts). Once the device is registered for
// the link it simply continues into the normal POS flow at /pos, already
// pinned to its branch and register; opening the link again later lands
// straight back on the till.
export default function PosLinkGate({ token }: { token: string }) {
  const { t, dir } = useLanguage();
  const { loading, firebaseUser, profile, signOutAdmin } = useAdminAuth();
  const [status, setStatus] = useState<"idle" | "claiming" | "invalid" | "revoked" | "inUse" | "failed">("idle");
  const started = useRef(false);

  const registered = !!profile && profile.posLink === token && profile.active;
  // A real staff account is signed in on this browser: never silently
  // replace it -- ask first.
  const staffSignedIn = !!firebaseUser && !!profile && !profile.posLink;

  async function claim() {
    started.current = true;
    setStatus("claiming");
    try {
      await claimPosLink(token);
      // A full load (not an in-app redirect): every listener then starts
      // fresh under the device's new identity, instead of racing it.
      window.location.replace("/pos");
    } catch (err) {
      setStatus(err instanceof PosLinkError ? err.code : "failed");
    }
  }

  useEffect(() => {
    if (loading || registered || staffSignedIn || started.current) return;
    void claim();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, registered, staffSignedIn]);

  if (registered) return <Navigate to="/pos" replace />;

  const box = (children: React.ReactNode) => (
    <div dir={dir} className="admin-root flex min-h-screen items-center justify-center bg-cream p-6 text-ink">
      <div className="flex w-full max-w-sm flex-col items-center gap-4 rounded-2xl border border-line bg-paper p-8 text-center shadow-soft">{children}</div>
    </div>
  );

  if (staffSignedIn && status === "idle") {
    return box(
      <>
        <h1 className="font-display text-xl font-bold">{t("pos.link.title")}</h1>
        <p className="text-sm text-ink-soft">{t("pos.link.staffSignedIn").replace("{name}", profile!.displayName)}</p>
        <button
          onClick={async () => {
            await signOutAdmin();
            void claim();
          }}
          className="w-full rounded-full bg-wine py-3 text-sm font-semibold text-on-accent hover:bg-wine-dark"
        >
          {t("pos.link.useAsPos")}
        </button>
        <Link to="/pos" className="text-sm font-semibold text-ink-soft hover:text-wine">
          {t("admin.common.cancel")}
        </Link>
      </>
    );
  }

  if (status === "invalid" || status === "revoked" || status === "inUse" || status === "failed") {
    const title = status === "failed" ? "pos.link.failedTitle" : status === "inUse" ? "pos.link.inUseTitle" : "pos.link.invalidTitle";
    return box(
      <>
        <h1 className="font-display text-xl font-bold">{t(title)}</h1>
        <p className="text-sm text-ink-soft">{t(`pos.link.${status}Body`)}</p>
        {status === "failed" && (
          <button onClick={() => void claim()} className="w-full rounded-full bg-wine py-3 text-sm font-semibold text-on-accent hover:bg-wine-dark">
            {t("pos.link.retry")}
          </button>
        )}
      </>
    );
  }

  return box(
    <>
      <PageLoading />
      <p className="text-sm text-ink-soft">{t("pos.link.opening")}</p>
    </>
  );
}
