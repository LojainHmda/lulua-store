import { doc, getDoc, increment, serverTimestamp, setDoc, Timestamp } from "firebase/firestore";
import { onAuthStateChanged } from "firebase/auth";
import { db, isFirebaseConfigured } from "../firebase/config";
import { auth } from "../firebase/auth";

// Lightweight, privacy-conscious visitor analytics for the storefront only
// (this module is only ever imported from storefront pages — never from
// /admin or /pos). No personal data is ever recorded: just an anonymous,
// random per-tab session id (sessionStorage only, never persisted beyond
// the browser tab and never tied to an account) plus counters. Staff
// signed into the admin dashboard are excluded so their own testing never
// pollutes the owner's real visitor numbers.

const SESSION_KEY = "lulua-analytics-sid";
const VISIT_FLAG_KEY = "lulua-analytics-visited";
const HEARTBEAT_MS = 25_000;
const PRESENCE_TTL_MS = 90_000;

let cachedSessionId: string | null = null;
function getSessionId(): string {
  if (cachedSessionId) return cachedSessionId;
  let id = sessionStorage.getItem(SESSION_KEY);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(SESSION_KEY, id);
  }
  cachedSessionId = id;
  return id;
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

async function isStaffSession(uid: string): Promise<boolean> {
  try {
    const snap = await getDoc(doc(db, "admins", uid));
    return snap.exists();
  } catch {
    return false;
  }
}

let readyPromise: Promise<boolean> | null = null;
// Resolves once per browser session to whether tracking is allowed: false
// if Firebase isn't configured or the signed-in user turns out to be
// staff. Anonymous and fully signed-out visitors (the vast majority) are
// always trackable.
function trackingAllowed(): Promise<boolean> {
  if (readyPromise) return readyPromise;
  readyPromise = new Promise((resolve) => {
    if (!isFirebaseConfigured) {
      resolve(false);
      return;
    }
    const unsub = onAuthStateChanged(auth, async (user) => {
      unsub();
      if (user && !user.isAnonymous) {
        resolve(!(await isStaffSession(user.uid)));
      } else {
        resolve(true);
      }
    });
  });
  return readyPromise;
}

async function touchPresence() {
  if (!(await trackingAllowed())) return;
  await setDoc(
    doc(db, "presence", getSessionId()),
    { lastSeen: serverTimestamp(), expiresAt: Timestamp.fromMillis(Date.now() + PRESENCE_TTL_MS) },
    { merge: true }
  ).catch(() => {});
}

// Call once from the storefront root. Fires an immediate presence beacon
// plus a recurring heartbeat, and refreshes right away whenever the tab
// becomes visible again after being backgrounded. Returns a cleanup fn.
export function startPresenceHeartbeat(): () => void {
  touchPresence();
  const timer = window.setInterval(touchPresence, HEARTBEAT_MS);
  const onVisible = () => {
    if (document.visibilityState === "visible") touchPresence();
  };
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

export async function trackPageview(): Promise<void> {
  // Decide + record "is this a new visit" synchronously, before the first
  // await — React StrictMode double-invokes this effect in dev, and rapid
  // route changes can fire it again before the first call's async work
  // resolves. Reading/writing the flag before any await makes the first
  // caller win deterministically instead of racing on promise-resolution
  // order.
  const isNewVisit = !sessionStorage.getItem(VISIT_FLAG_KEY);
  if (isNewVisit) sessionStorage.setItem(VISIT_FLAG_KEY, "1");

  if (!(await trackingAllowed())) return;
  const date = todayKey();
  await setDoc(
    doc(db, "analyticsDaily", date),
    { date, pageviews: increment(1), ...(isNewVisit ? { visits: increment(1) } : {}) },
    { merge: true }
  ).catch(() => {});
}

export async function trackProductView(productId: string, category?: string): Promise<void> {
  if (!(await trackingAllowed())) return;
  const date = todayKey();
  const writes = [
    setDoc(doc(db, "productStats", productId), { views: increment(1) }, { merge: true }),
    setDoc(doc(db, "productViewsDaily", `${date}_${productId}`), { date, productId, views: increment(1) }, { merge: true }),
  ];
  if (category) {
    writes.push(
      setDoc(doc(db, "categoryStats", category), { views: increment(1) }, { merge: true }),
      setDoc(doc(db, "categoryViewsDaily", `${date}_${category}`), { date, category, views: increment(1) }, { merge: true })
    );
  }
  await Promise.all(writes).catch(() => {});
}

export async function trackProductQuickAdd(productId: string): Promise<void> {
  if (!(await trackingAllowed())) return;
  const date = todayKey();
  await Promise.all([
    setDoc(doc(db, "productStats", productId), { quickAdds: increment(1) }, { merge: true }),
    setDoc(doc(db, "productViewsDaily", `${date}_${productId}`), { date, productId, quickAdds: increment(1) }, { merge: true }),
  ]).catch(() => {});
}

export async function trackCategoryView(category: string): Promise<void> {
  if (!(await trackingAllowed())) return;
  const date = todayKey();
  await Promise.all([
    setDoc(doc(db, "categoryStats", category), { views: increment(1) }, { merge: true }),
    setDoc(doc(db, "categoryViewsDaily", `${date}_${category}`), { date, category, views: increment(1) }, { merge: true }),
  ]).catch(() => {});
}
