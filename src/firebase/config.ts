import { createAuth } from "../db/auth";
import { _notifyAuthChanged, Firestore } from "../db/firestore";
import { createTransport } from "../db/transport";

// The Lulua API (services/api) — the app's only backend, on Neon Postgres.
// VITE_API_URL is its base URL, e.g. https://lulua-api-xxxx.run.app.
export const apiUrl: string = import.meta.env.VITE_API_URL ?? "";
export const isBackendConfigured = Boolean(apiUrl);

// A browser tab opened from a POS link (/pos/<token>) runs as that POS: it
// keeps its own sign-in (an anonymous device session), persisted per link,
// so staff signed in on the same browser are never signed out by it and
// several tabs can each run a different POS. The token is remembered for
// the tab (sessionStorage), so a reload or the till's own /pos/... URLs keep
// the same POS identity. Must match POS_TOKEN_RE in posLinks.ts.
const POS_TAB_KEY = "lulua-pos-token";
function posTabToken(): string | null {
  if (typeof window === "undefined") return null;
  const parts = window.location.pathname.split("/");
  if (parts[1] !== "pos") return null;
  try {
    if (/^[A-Za-z0-9_-]{32,}$/.test(parts[2] ?? "")) {
      sessionStorage.setItem(POS_TAB_KEY, parts[2]);
      return parts[2];
    }
    return sessionStorage.getItem(POS_TAB_KEY);
  } catch {
    return /^[A-Za-z0-9_-]{32,}$/.test(parts[2] ?? "") ? parts[2] : null;
  }
}
export const posTabTokenAtLoad = posTabToken();

export const auth = createAuth({
  baseUrl: apiUrl,
  storageKey: posTabTokenAtLoad ? `lulua-auth:pos:${posTabTokenAtLoad}` : "lulua-auth",
  googleClientId: import.meta.env.VITE_GOOGLE_CLIENT_ID,
});

export const db = new Firestore(createTransport({ baseUrl: apiUrl, getToken: () => auth._getToken() }));

// Signing in/out changes what the security rules let listeners see.
auth.onAuthStateChanged(() => _notifyAuthChanged());
