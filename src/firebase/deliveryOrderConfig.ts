export interface DeliveryProxyConfig {
  proxyUrl: string;
}

// ---------------------------------------------------------------------------
// ARCHITECTURE (2026-09-30, superseding the Apps Script PoC):
// Sisely browser -> dedicated Cloud Run service (sisely-e7223) -> United.
//
// WHY: CONFIRMED LIVE 2026-09-30 that United's API
// (https://unitedexp.olivery.io) sends no Access-Control-Allow-Origin header
// on any response -- a direct browser fetch() to United is unconditionally
// CORS-blocked. The Apps Script proxy this replaces proved the architecture
// works (a real get_areas round-trip was read back by a real browser at
// https://sisely-e7223.web.app), but had two real limitations a dedicated
// backend doesn't: Apps Script can't answer an OPTIONS preflight at all (it
// only supports doGet/doPost), forcing the `text/plain` "simple request"
// workaround; and it has no way to verify the CALLER is a real Sisely
// admin/owner, only a static value shipped in the client bundle.
//
// CREDENTIAL SAFETY: the United login/password live ONLY in Secret Manager
// (`united-credentials`), read server-side by the Cloud Run service's own
// dedicated, least-privilege service account. This app never reads, sends,
// or has ANY way to see them -- there is no United-related value anywhere
// in this app's env vars at all.
//
// CALLER AUTHENTICATION: this is the one thing the Apps Script version got
// wrong and this version fixes properly. Rather than a static frontend
// "secret" (which is just a spam deterrent, not real access control -- any
// VITE_* value is readable in devtools by definition), every request to the
// Cloud Run proxy carries the CALLER'S OWN real Firebase ID token
// (`firebaseUser.getIdToken()` -- see deliveryOrder.ts), which the proxy
// verifies server-side against Firebase Auth and then checks against this
// app's own `admins/{uid}` collection for an active owner/admin role -- the
// exact same authorization boundary Firestore's own security rules already
// enforce (see firestore.rules' isAdminOrAbove()). A stolen/copied ID token
// is short-lived and tied to a real signed-in identity, unlike a static
// secret that works forever for anyone who has it.
//
// This is why VITE_UNITED_PROXY_URL is the ONLY delivery-related env var
// this app needs: it's just an endpoint address, not a credential.
export function getDeliveryProxyConfig(): DeliveryProxyConfig | null {
  const proxyUrl = import.meta.env.VITE_UNITED_PROXY_URL;
  if (!proxyUrl) return null;
  return { proxyUrl };
}
