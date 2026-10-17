// Sign-in for the app, backed by the Lulua API (/v1/auth/*). Same function
// names and shapes as the Firebase Auth SDK the app was written against
// (onAuthStateChanged, signInWithEmailAndPassword, signInAnonymously, ...),
// so the login screens and contexts work unchanged.
//
// A session = short-lived access token + refresh token, kept in
// localStorage (per storage key, so a POS-link tab keeps its own device
// identity), refreshed automatically, and synced across tabs.

export interface UserInfo {
  providerId: string;
}

export interface User {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  isAnonymous: boolean;
  providerData: UserInfo[];
  getIdToken(): Promise<string>;
}

export interface UserCredential {
  user: User;
}

export class AuthError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "FirebaseError";
    this.code = code;
  }
}

interface WireUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  isAnonymous: boolean;
  providerId: string;
}

interface Session {
  user: WireUser;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface AuthOptions {
  baseUrl: string;
  // localStorage key; null = memory only (a throwaway session that never
  // touches the signed-in user's own, e.g. creating a staff account).
  storageKey: string | null;
  googleClientId?: string;
}

export class Auth {
  currentUser: User | null = null;
  _opts: AuthOptions;
  _session: Session | null = null;
  _listeners = new Set<(u: User | null) => void>();
  _refreshing: Promise<string | null> | null = null;

  constructor(opts: AuthOptions) {
    this._opts = opts;
    this._load();
    if (opts.storageKey && typeof window !== "undefined") {
      window.addEventListener("storage", (e) => {
        if (e.key === opts.storageKey) {
          this._load();
          this._emit();
        }
      });
    }
  }

  _load() {
    let s: Session | null = null;
    try {
      const raw = this._opts.storageKey ? localStorage.getItem(this._opts.storageKey) : null;
      s = raw ? (JSON.parse(raw) as Session) : null;
    } catch {
      s = null;
    }
    this._session = s;
    this.currentUser = s ? toUser(this, s.user) : null;
  }

  _set(s: Session | null) {
    this._session = s;
    this.currentUser = s ? toUser(this, s.user) : null;
    try {
      if (this._opts.storageKey) {
        if (s) localStorage.setItem(this._opts.storageKey, JSON.stringify(s));
        else localStorage.removeItem(this._opts.storageKey);
      }
    } catch {
      /* private mode: session lives in memory only */
    }
    this._emit();
  }

  _emit() {
    this._listeners.forEach((l) => l(this.currentUser));
  }

  async _post<T>(path: string, body: unknown, withToken = false): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (withToken) {
      const t = await this._getToken();
      if (t) headers.Authorization = `Bearer ${t}`;
    }
    let res: Response;
    try {
      res = await fetch(`${this._opts.baseUrl.replace(/\/$/, "")}/v1/auth/${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    } catch {
      throw new AuthError("auth/network-request-failed", "Network error");
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new AuthError(json.error?.code ?? "auth/internal-error", json.error?.message ?? `HTTP ${res.status}`);
    return json as T;
  }

  async _signedIn(path: string, body: unknown, withToken = false): Promise<UserCredential> {
    const r = await this._post<{ user: WireUser; accessToken: string; refreshToken: string; expiresIn: number }>(path, body, withToken);
    // Signing in replaces any previous session: revoke its refresh token.
    const old = this._session?.refreshToken;
    if (old && old !== r.refreshToken) void this._post("logout", { refreshToken: old }).catch(() => {});
    this._set({ user: r.user, accessToken: r.accessToken, refreshToken: r.refreshToken, expiresAt: Date.now() + r.expiresIn * 1000 });
    return { user: this.currentUser! };
  }

  // A valid access token, refreshing it first when it's about to expire.
  async _getToken(): Promise<string | null> {
    const s = this._session;
    if (!s) return null;
    if (s.expiresAt - Date.now() > 60_000) return s.accessToken;
    if (!this._refreshing) {
      this._refreshing = (async () => {
        try {
          const r = await this._post<{ user: WireUser; accessToken: string; refreshToken: string; expiresIn: number }>("refresh", {
            refreshToken: s.refreshToken,
          });
          this._set({ user: r.user, accessToken: r.accessToken, refreshToken: r.refreshToken, expiresAt: Date.now() + r.expiresIn * 1000 });
          return r.accessToken;
        } catch (e) {
          // Another tab may have rotated the token already: use its session.
          this._load();
          if (this._session && this._session.refreshToken !== s.refreshToken) return this._session.accessToken;
          if (e instanceof AuthError && e.code !== "auth/network-request-failed") this._set(null);
          return null;
        } finally {
          this._refreshing = null;
        }
      })();
    }
    return this._refreshing;
  }

  // Sessions load synchronously from storage, so this is always ready.
  authStateReady(): Promise<void> {
    return Promise.resolve();
  }

  onAuthStateChanged(cb: (u: User | null) => void) {
    return onAuthStateChanged(this, cb);
  }

  signOut() {
    return signOut(this);
  }
}

function toUser(auth: Auth, w: WireUser): User {
  return {
    uid: w.uid,
    email: w.email,
    displayName: w.displayName,
    photoURL: w.photoURL,
    isAnonymous: w.isAnonymous,
    providerData: w.isAnonymous ? [] : [{ providerId: w.providerId }],
    getIdToken: async () => (await auth._getToken()) ?? "",
    _auth: auth,
  } as User;
}

const authOf = (u: User): Auth => {
  const a = (u as User & { _auth?: Auth })._auth;
  if (!a) throw new AuthError("auth/invalid-user-token", "Unknown user");
  return a;
};

// --- Firebase-Auth-shaped API ----------------------------------------------

export function onAuthStateChanged(auth: Auth, cb: (u: User | null) => void): () => void {
  auth._listeners.add(cb);
  // Like Firebase: fires once right away with the current state.
  queueMicrotask(() => {
    if (auth._listeners.has(cb)) cb(auth.currentUser);
  });
  return () => {
    auth._listeners.delete(cb);
  };
}

export function signInWithEmailAndPassword(auth: Auth, email: string, password: string) {
  return auth._signedIn("login", { email, password });
}

export function createUserWithEmailAndPassword(auth: Auth, email: string, password: string) {
  return auth._signedIn("signup", { email, password });
}

export function signInAnonymously(auth: Auth) {
  return auth._signedIn("anonymous", {});
}

export async function signOut(auth: Auth): Promise<void> {
  const rt = auth._session?.refreshToken;
  auth._set(null);
  if (rt) await auth._post("logout", { refreshToken: rt }).catch(() => {});
}

export async function updateProfile(user: User, p: { displayName?: string | null; photoURL?: string | null }): Promise<void> {
  const auth = authOf(user);
  const r = await auth._post<{ user: WireUser }>("profile", p, true);
  if (auth._session && auth._session.user.uid === r.user.uid) auth._set({ ...auth._session, user: r.user });
}

export async function updatePassword(user: User, password: string): Promise<void> {
  await authOf(user)._signedIn("password", { password }, true);
}

export const EmailAuthProvider = {
  PROVIDER_ID: "password",
  credential: (email: string, password: string) => ({ providerId: "password", email, password }),
};

export class GoogleAuthProvider {
  readonly providerId = "google.com";
}

// Turns the current anonymous (guest) account into an email/password one,
// keeping its uid, so a guest's orders stay theirs.
export function linkWithCredential(user: User, cred: { email: string; password: string }) {
  return authOf(user)._signedIn("signup", { email: cred.email, password: cred.password, link: true }, true);
}

// Google sign-in: Google's own OAuth popup returns an ID token to
// /auth/google-callback.html, which hands it back here; the API verifies it.
async function googleIdToken(auth: Auth): Promise<{ idToken: string; nonce: string }> {
  const clientId = auth._opts.googleClientId;
  if (!clientId) throw new AuthError("auth/operation-not-allowed", "Google sign-in is not configured");
  const nonce = crypto.randomUUID();
  const state = crypto.randomUUID();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${window.location.origin}/auth/google-callback.html`,
    response_type: "id_token",
    scope: "openid email profile",
    nonce,
    state,
    prompt: "select_account",
  });
  const popup = window.open(`https://accounts.google.com/o/oauth2/v2/auth?${params}`, "google-signin", "width=500,height=640");
  if (!popup) throw new AuthError("auth/popup-blocked", "The sign-in popup was blocked");
  return new Promise((resolve, reject) => {
    const done = (fn: () => void) => {
      window.removeEventListener("message", onMsg);
      clearInterval(poll);
      fn();
    };
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || e.data?.type !== "google-signin") return;
      const p = new URLSearchParams(String(e.data.hash ?? "").replace(/^#/, ""));
      if (p.get("state") !== state || !p.get("id_token")) {
        done(() => reject(new AuthError("auth/popup-closed-by-user", p.get("error") ?? "Sign-in cancelled")));
        return;
      }
      done(() => resolve({ idToken: p.get("id_token")!, nonce }));
    };
    window.addEventListener("message", onMsg);
    const poll = setInterval(() => {
      if (popup.closed) done(() => reject(new AuthError("auth/popup-closed-by-user", "The popup was closed")));
    }, 500);
  });
}

export async function signInWithPopup(auth: Auth, _provider: GoogleAuthProvider) {
  return auth._signedIn("google", await googleIdToken(auth));
}

export async function linkWithPopup(user: User, _provider: GoogleAuthProvider) {
  const auth = authOf(user);
  return auth._signedIn("google", { ...(await googleIdToken(auth)), link: true }, true);
}

export function createAuth(opts: AuthOptions) {
  return new Auth(opts);
}
