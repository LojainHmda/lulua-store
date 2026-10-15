import { type FirebaseApp, initializeApp } from "firebase/app";
import { connectFirestoreEmulator, type Firestore, initializeFirestore } from "firebase/firestore";

export const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export const isFirebaseConfigured = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);

// Opt-in, off by default -- set VITE_USE_FIREBASE_EMULATORS=true (as a
// shell/process env var, not committed to .env.local) to point this SAME
// project id (whatever VITE_FIREBASE_PROJECT_ID already is) at the local
// Firestore/Auth emulators instead of the real backend. Absent or anything
// else, behavior is byte-for-byte what it was before this existed: every
// existing local-dev-server-against-real-Firestore workflow (including the
// qa-screens/*-smoke.mjs scripts, which sign in with real credentials
// against the real project) keeps working unchanged.
export const useFirebaseEmulators = import.meta.env.VITE_USE_FIREBASE_EMULATORS === "true";

// Emulator ports, overridable so this app's emulators can run alongside
// another project's on the defaults.
export const emulatorPorts = {
  firestore: Number(import.meta.env.VITE_EMULATOR_FIRESTORE_PORT) || 8080,
  auth: Number(import.meta.env.VITE_EMULATOR_AUTH_PORT) || 9099,
  storage: Number(import.meta.env.VITE_EMULATOR_STORAGE_PORT) || 9199,
};

// A browser tab opened from a POS link (/pos/<token>) runs as that POS: it
// gets its own named Firebase app, so its own anonymous sign-in, persisted
// per link. Staff signed in on the same browser are never signed out by it,
// and several tabs can each run a different POS. The token is remembered
// for the tab (sessionStorage), so a reload or the till's own /pos/... URLs
// keep the same POS identity. Must match POS_TOKEN_RE in posLinks.ts.
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

let app: FirebaseApp | undefined;
let dbInstance: Firestore | undefined;

if (isFirebaseConfigured) {
  app = posTabTokenAtLoad ? initializeApp(firebaseConfig, `pos-${posTabTokenAtLoad}`) : initializeApp(firebaseConfig);
  // Many optional fields throughout this app (photoURL, compareAtPrice,
  // etc.) are legitimately `undefined` rather than omitted — without this,
  // the Firestore SDK throws on any write containing such a field instead
  // of just dropping it.
  // VITE_FIREBASE_DATABASE_ID: a named Firestore database, for a project
  // that hosts several apps each with its own database. Unset = (default).
  const databaseId = import.meta.env.VITE_FIREBASE_DATABASE_ID || undefined;
  dbInstance = databaseId
    ? initializeFirestore(app, { ignoreUndefinedProperties: true }, databaseId)
    : initializeFirestore(app, { ignoreUndefinedProperties: true });
  if (useFirebaseEmulators) {
    connectFirestoreEmulator(dbInstance, "127.0.0.1", emulatorPorts.firestore);
  }
}

// Auth and Storage are only needed by the admin dashboard, which is
// code-split from the storefront — see ./auth.ts and ./storageClient.ts.
// Keeping them out of this module keeps those SDKs out of the storefront's
// main bundle for shoppers who never visit /admin.
export const firebaseApp = app as FirebaseApp;
export const db = dbInstance as Firestore;
