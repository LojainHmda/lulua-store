// Accounts and sessions (replaces Firebase Auth).
//
// A session is a short-lived access token (JWT, HS256, sent as
// "Authorization: Bearer ...") plus a long-lived refresh token (random,
// stored hashed in app.refresh_tokens, rotated on every refresh).
//
// Passwords: new ones are scrypt-hashed here. Accounts imported from
// Firebase Auth keep Firebase's own hash (its modified scrypt, verified with
// the project's hash parameters, FIREBASE_HASH_* env) and are re-hashed to
// ours on their first successful sign-in, so nobody has to reset a password.
import { createCipheriv, createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { createRemoteJWKSet, jwtVerify, SignJWT } from "jose";
import type { Sql } from "./db.ts";
import type { Auth } from "./rules/types.ts";

const scrypt = promisify(scryptCb) as (pw: string | Buffer, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

const ACCESS_TTL_S = 60 * 60;
const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export class AuthError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function secret() {
  const s = process.env.JWT_SECRET;
  if (!s && process.env.NODE_ENV === "production") throw new Error("JWT_SECRET is not set");
  return new TextEncoder().encode(s || "dev-only-insecure-secret-change-me");
}

// --- Passwords -------------------------------------------------------------

const N = 16384, R = 8, P = 1, KEYLEN = 64;

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

// Firebase's modified scrypt: scrypt(pw, salt + separator) as an AES-256-CTR
// key (zero IV) that encrypts the project's signer key; that ciphertext is
// the stored hash.
async function verifyFirebaseScrypt(pw: string, saltB64: string, hashB64: string): Promise<boolean> {
  const signer = process.env.FIREBASE_HASH_SIGNER_KEY;
  if (!signer) return false;
  const sep = Buffer.from(process.env.FIREBASE_HASH_SALT_SEPARATOR ?? "Bw==", "base64");
  const rounds = Number(process.env.FIREBASE_HASH_ROUNDS ?? 8);
  const memCost = Number(process.env.FIREBASE_HASH_MEM_COST ?? 14);
  const key = await scrypt(pw, Buffer.concat([Buffer.from(saltB64, "base64"), sep]), 32, {
    N: 2 ** memCost,
    r: rounds,
    p: 1,
    maxmem: 256 * 1024 * 1024,
  });
  const cipher = createCipheriv("aes-256-ctr", key, Buffer.alloc(16, 0));
  const out = Buffer.concat([cipher.update(Buffer.from(signer, "base64")), cipher.final()]);
  const want = Buffer.from(hashB64, "base64");
  return out.length === want.length && timingSafeEqual(out, want);
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts[0] === "scrypt") {
    const [, n, r, p, salt, hash] = parts;
    const want = Buffer.from(hash, "base64");
    const got = await scrypt(pw, Buffer.from(salt, "base64"), want.length, { N: Number(n), r: Number(r), p: Number(p) });
    return timingSafeEqual(got, want);
  }
  if (parts[0] === "fbscrypt") return verifyFirebaseScrypt(pw, parts[1], parts[2]);
  return false;
}

// --- Tokens ------------------------------------------------------------------

export interface UserRow {
  uid: string;
  email: string | null;
  password_hash: string | null;
  google_sub: string | null;
  anonymous: boolean;
  display_name: string | null;
  photo_url: string | null;
  disabled: boolean;
}

const provider = (u: UserRow) => (u.anonymous ? "anonymous" : u.password_hash ? "password" : u.google_sub ? "google.com" : "password");

export function publicUser(u: UserRow) {
  return {
    uid: u.uid,
    email: u.email,
    displayName: u.display_name,
    photoURL: u.photo_url,
    isAnonymous: u.anonymous,
    providerId: provider(u),
  };
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function signAccessToken(a: Auth): Promise<string> {
  return new SignJWT({ email: a.email, provider: a.provider })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(a.uid)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TTL_S}s`)
    .sign(secret());
}

export async function issueSession(sql: Sql, u: UserRow) {
  const accessToken = await signAccessToken({ uid: u.uid, email: u.email, provider: provider(u) });
  const refreshToken = randomBytes(32).toString("base64url");
  await sql.query("INSERT INTO app.refresh_tokens (token_hash, uid, expires_at) VALUES ($1, $2, $3)", [
    sha256(refreshToken),
    u.uid,
    new Date(Date.now() + REFRESH_TTL_MS),
  ]);
  await sql.query("UPDATE app.users SET last_login_at = now() WHERE uid = $1", [u.uid]);
  return { user: publicUser(u), accessToken, refreshToken, expiresIn: ACCESS_TTL_S };
}

export async function verifyAccessToken(token: string): Promise<Auth | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: ["HS256"] });
    if (!payload.sub) return null;
    return { uid: payload.sub, email: (payload.email as string | null) ?? null, provider: String(payload.provider ?? "password") };
  } catch {
    return null;
  }
}

// --- Account operations --------------------------------------------------------

const newUid = () => randomBytes(21).toString("base64url").replace(/[-_]/g, "").slice(0, 28).padEnd(28, "0");
const normEmail = (e: unknown) => String(e ?? "").trim().toLowerCase();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function userBy(sql: Sql, col: "uid" | "email" | "google_sub", v: string) {
  const { rows } = await sql.query<UserRow>(`SELECT * FROM app.users WHERE ${col} = $1`, [v]);
  return rows[0];
}

export async function getUser(sql: Sql, uid: string) {
  return userBy(sql, "uid", uid);
}

function checkPassword(pw: unknown): string {
  // Firebase's minimum was 6; the app pads short ones (e.g. "admin") itself.
  if (typeof pw !== "string" || pw.length < 6) throw new AuthError("auth/weak-password", "Password should be at least 6 characters");
  return pw;
}

// Creates an email/password account, or — when `upgrade` is an anonymous
// session's uid — turns that guest account into one (linkWithCredential).
export async function signUp(sql: Sql, emailIn: unknown, pwIn: unknown, upgrade?: Auth | null) {
  const email = normEmail(emailIn);
  if (!EMAIL_RE.test(email)) throw new AuthError("auth/invalid-email", "The email address is badly formatted");
  const hash = await hashPassword(checkPassword(pwIn));
  if (await userBy(sql, "email", email)) throw new AuthError("auth/email-already-in-use", "The email address is already in use");
  if (upgrade) {
    const cur = await getUser(sql, upgrade.uid);
    if (!cur?.anonymous) throw new AuthError("auth/provider-already-linked", "Account already has a sign-in method");
    await sql.query("UPDATE app.users SET email = $2, password_hash = $3, anonymous = false WHERE uid = $1", [cur.uid, email, hash]);
    return getUser(sql, cur.uid);
  }
  const uid = newUid();
  await sql.query("INSERT INTO app.users (uid, email, password_hash) VALUES ($1, $2, $3)", [uid, email, hash]);
  return getUser(sql, uid);
}

export async function signIn(sql: Sql, emailIn: unknown, pw: unknown) {
  const u = await userBy(sql, "email", normEmail(emailIn));
  if (!u || !u.password_hash || typeof pw !== "string" || !(await verifyPassword(pw, u.password_hash))) {
    throw new AuthError("auth/invalid-credential", "Wrong email or password", 401);
  }
  if (u.disabled) throw new AuthError("auth/user-disabled", "This account has been disabled", 403);
  if (!u.password_hash.startsWith("scrypt$")) {
    await sql.query("UPDATE app.users SET password_hash = $2 WHERE uid = $1", [u.uid, await hashPassword(pw)]);
  }
  return u;
}

export async function signInAnonymous(sql: Sql) {
  const uid = newUid();
  await sql.query("INSERT INTO app.users (uid, anonymous) VALUES ($1, true)", [uid]);
  return (await getUser(sql, uid))!;
}

const googleJwks = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

// Sign in (or link, for an anonymous `upgrade` session) with a Google ID
// token from the browser's Google sign-in popup.
export async function signInGoogle(sql: Sql, idToken: unknown, nonce: unknown, upgrade?: Auth | null) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) throw new AuthError("auth/operation-not-allowed", "Google sign-in is not configured");
  let p;
  try {
    ({ payload: p } = await jwtVerify(String(idToken), googleJwks, {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: clientId,
    }));
  } catch {
    throw new AuthError("auth/invalid-credential", "Invalid Google sign-in", 401);
  }
  if (!nonce || p.nonce !== nonce) throw new AuthError("auth/invalid-credential", "Invalid Google sign-in", 401);
  const sub = String(p.sub);
  const email = p.email_verified ? normEmail(p.email) : null;
  const name = (p.name as string) ?? null;
  const photo = (p.picture as string) ?? null;

  const bySub = await userBy(sql, "google_sub", sub);
  if (upgrade) {
    if (bySub && bySub.uid !== upgrade.uid) throw new AuthError("auth/credential-already-in-use", "This Google account is already used by another account");
    await sql.query(
      `UPDATE app.users SET google_sub = $2, anonymous = false,
         email = COALESCE(email, $3), display_name = COALESCE(display_name, $4), photo_url = COALESCE(photo_url, $5)
       WHERE uid = $1`,
      [upgrade.uid, sub, email && !(await userBy(sql, "email", email)) ? email : null, name, photo]
    );
    return (await getUser(sql, upgrade.uid))!;
  }
  if (bySub) return bySub;
  // An existing email/password account with the same verified email: same
  // person, attach Google to it (Firebase's default "one account per email").
  const byEmail = email ? await userBy(sql, "email", email) : undefined;
  if (byEmail) {
    await sql.query("UPDATE app.users SET google_sub = $2 WHERE uid = $1", [byEmail.uid, sub]);
    return (await getUser(sql, byEmail.uid))!;
  }
  const uid = newUid();
  await sql.query("INSERT INTO app.users (uid, email, google_sub, display_name, photo_url) VALUES ($1, $2, $3, $4, $5)", [
    uid,
    email,
    sub,
    name,
    photo,
  ]);
  return (await getUser(sql, uid))!;
}

export async function refreshSession(sql: Sql, refreshToken: unknown) {
  const h = sha256(String(refreshToken ?? ""));
  const { rows } = await sql.query<{ uid: string; expires_at: Date }>(
    "DELETE FROM app.refresh_tokens WHERE token_hash = $1 RETURNING uid, expires_at",
    [h]
  );
  const row = rows[0];
  if (!row || new Date(row.expires_at) < new Date()) throw new AuthError("auth/user-token-expired", "Session expired, sign in again", 401);
  const u = await getUser(sql, row.uid);
  if (!u || u.disabled) throw new AuthError("auth/user-disabled", "This account has been disabled", 401);
  return issueSession(sql, u);
}

export async function revokeRefresh(sql: Sql, refreshToken: unknown) {
  await sql.query("DELETE FROM app.refresh_tokens WHERE token_hash = $1", [sha256(String(refreshToken ?? ""))]);
}

export async function updateProfile(sql: Sql, auth: Auth, body: { displayName?: unknown; photoURL?: unknown }) {
  const sets: string[] = [];
  const params: unknown[] = [auth.uid];
  if ("displayName" in body) sets.push(`display_name = $${params.push(body.displayName == null ? null : String(body.displayName))}`);
  if ("photoURL" in body) sets.push(`photo_url = $${params.push(body.photoURL == null ? null : String(body.photoURL))}`);
  if (sets.length) await sql.query(`UPDATE app.users SET ${sets.join(", ")} WHERE uid = $1`, params);
  return (await getUser(sql, auth.uid))!;
}

export async function updatePassword(sql: Sql, auth: Auth, pw: unknown) {
  const u = await getUser(sql, auth.uid);
  if (!u || u.anonymous) throw new AuthError("auth/operation-not-allowed", "Guest accounts have no password");
  await sql.query("UPDATE app.users SET password_hash = $2 WHERE uid = $1", [auth.uid, await hashPassword(checkPassword(pw))]);
  // Sign out every other session.
  await sql.query("DELETE FROM app.refresh_tokens WHERE uid = $1", [auth.uid]);
  return issueSession(sql, u);
}
