// Dedicated Cloud Run service: the sole purpose of this service is to sit
// between the Sisely browser and United/Olivery's Create Order API
// (https://unitedexp.olivery.io), which sends no Access-Control-Allow-Origin
// header at all (CONFIRMED LIVE 2026-09-30) and so unconditionally blocks a
// direct browser call. This replaces the earlier Google Apps Script PoC
// proxy with a real, fully-controllable HTTP server -- proper CORS/OPTIONS
// handling, real least-privilege IAM via Secret Manager, and real caller
// authentication (a genuine Firebase ID token checked against this app's own
// `admins/{uid}` collection -- the SAME authorization boundary Firestore's
// own security rules already enforce for admin actions), not a static
// frontend "secret" masquerading as access control.
//
// This service does exactly three things and nothing else:
//   1. verify the caller is a real, active Sisely admin/owner (Firebase ID token)
//   2. forward ONE of three explicitly allow-listed actions to United, with
//      the real United credentials injected server-side from Secret Manager
//   3. relay United's response back, never echoing any credential

import express from "express";
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || "sisely-e7223";
const UNITED_SECRET_NAME = process.env.UNITED_SECRET_NAME || "united-credentials";
const UNITED_BASE_URL = "https://unitedexp.olivery.io";

// Exact 1:1 allow-list -- the browser can never influence which URL this
// service calls beyond selecting one of these three names. There is no
// "arbitrary path" concept anywhere in this file.
const ACTION_TO_PATH = {
  get_areas: "/get_areas",
  get_sub_areas: "/get_sub_areas",
  create_order: "/create_order",
};

const ALLOWED_ORIGINS = new Set([
  "https://sisely-e7223.web.app",
  "https://sisely-e7223.firebaseapp.com",
  "http://localhost:5175",
]);

// ---------------------------------------------------------------------------
// Firebase Admin (auth verification + the one Firestore read this service
// needs) -- lazy singleton, uses Cloud Run's attached service account via
// Application Default Credentials. No key file, ever.
let firebaseAppPromise = null;
async function getFirebaseApp() {
  if (!firebaseAppPromise) {
    firebaseAppPromise = import("firebase-admin/app").then(({ initializeApp, applicationDefault, getApps }) => {
      const existing = getApps()[0];
      return existing || initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID });
    });
  }
  return firebaseAppPromise;
}

async function verifyIdToken(idToken) {
  const { getAuth } = await import("firebase-admin/auth");
  const app = await getFirebaseApp();
  return getAuth(app).verifyIdToken(idToken);
}

async function getAdminProfile(uid) {
  const { getFirestore } = await import("firebase-admin/firestore");
  const app = await getFirebaseApp();
  const snap = await getFirestore(app).collection("admins").doc(uid).get();
  return snap.exists ? snap.data() : null;
}

// ---------------------------------------------------------------------------
// Secret Manager -- fetched once per container instance, cached in memory.
// Never logged, never included in any response, never written to disk.
let credentialsPromise = null;
async function getUnitedCredentials() {
  if (!credentialsPromise) {
    credentialsPromise = (async () => {
      const client = new SecretManagerServiceClient();
      const [version] = await client.accessSecretVersion({
        name: `projects/${PROJECT_ID}/secrets/${UNITED_SECRET_NAME}/versions/latest`,
      });
      const parsed = JSON.parse(version.payload.data.toString("utf8"));
      if (!parsed.login || !parsed.password || !parsed.db) {
        throw new Error("United credentials secret is missing required fields.");
      }
      return parsed;
    })();
  }
  return credentialsPromise;
}

// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "256kb" }));

// CORS -- explicit allow-list, real preflight handling. Unlike the Apps
// Script PoC this replaces, this is a real HTTP server with full control
// over its own response headers, so there is no "simple request" workaround
// needed anywhere in this integration.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Max-Age", "3600");
  }
  if (req.method === "OPTIONS") {
    // Preflight for an unrecognized origin is answered with no ACAO header
    // above, which is enough for the browser to reject it -- no need to
    // special-case rejection further here.
    return res.status(204).end();
  }
  next();
});

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true, service: "sisely-united-proxy" });
});

app.post("/api/united/proxy", async (req, res) => {
  // 1) Real caller authentication -- a genuine Firebase ID token, checked
  // against this app's own admins/{uid} collection. Never logged.
  const authHeader = req.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  if (!match) {
    return res.status(401).json({ ok: false, error: "Missing Authorization bearer token." });
  }

  let uid;
  try {
    const decoded = await verifyIdToken(match[1]);
    uid = decoded.uid;
  } catch {
    // Sanitized on purpose -- never echo the token-verification library's
    // internal error text back to the caller.
    return res.status(401).json({ ok: false, error: "Invalid or expired session." });
  }

  let adminProfile;
  try {
    adminProfile = await getAdminProfile(uid);
  } catch (err) {
    console.error("[united-proxy] admin profile lookup failed:", err?.message || err);
    return res.status(503).json({ ok: false, error: "Could not verify admin status." });
  }
  if (!adminProfile || adminProfile.active !== true || !["owner", "admin"].includes(adminProfile.role)) {
    return res.status(403).json({ ok: false, error: "This account is not authorized for the delivery integration." });
  }

  // 2) Validate the request shape and the requested action against the
  // fixed allow-list -- never construct a URL from caller input.
  const { action, params } = req.body || {};
  if (typeof action !== "string" || !Object.prototype.hasOwnProperty.call(ACTION_TO_PATH, action)) {
    return res.status(400).json({ ok: false, error: "Unsupported action." });
  }
  if (params !== undefined && (typeof params !== "object" || params === null || Array.isArray(params))) {
    return res.status(400).json({ ok: false, error: "params must be an object." });
  }

  // 3) Forward to United, server-side, with the real credentials injected
  // last so nothing the caller sends can ever override them.
  let creds;
  try {
    creds = await getUnitedCredentials();
  } catch (err) {
    console.error("[united-proxy] credential fetch failed:", err?.message || err);
    return res.status(503).json({ ok: false, error: "Delivery credentials are not currently available." });
  }

  const fullParams = { ...(params || {}), ...creds };

  try {
    const upstream = await fetch(UNITED_BASE_URL + ACTION_TO_PATH[action], {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", params: fullParams }),
    });
    const rawText = await upstream.text();
    let unitedResponse;
    try {
      unitedResponse = JSON.parse(rawText);
    } catch {
      unitedResponse = null;
    }

    // Same wrapper shape the Apps Script PoC used, kept intentionally so
    // src/firebase/deliveryOrder.ts's already-verified parsing logic needed
    // no changes beyond the transport layer.
    res.status(200).json({ ok: upstream.status === 200, unitedHttpStatus: upstream.status, unitedResponse });
  } catch (err) {
    console.error(`[united-proxy] upstream request failed (action=${action}):`, err?.message || err);
    res.status(502).json({ ok: false, error: "Delivery company request failed." });
  }
});

// Everything else: no arbitrary proxying, no other surface at all.
app.use((_req, res) => res.status(404).json({ ok: false, error: "Not found." }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`sisely-united-proxy listening on :${PORT}`));
