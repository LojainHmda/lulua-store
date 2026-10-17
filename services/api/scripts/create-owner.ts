// Creates (or resets the password of) an owner account — the only way to
// get the first admin into a fresh database, since the admin page has no
// sign-up. Usage (DATABASE_URL set):
//   node scripts/create-owner.ts <login> <password> [display name]
// A bare login without "@" becomes <login>@lulua.local (the admin page's
// own convention), and passwords under 6 characters are padded with "~"
// exactly as the login page does, so "admin"/"admin" works.
import { randomBytes } from "node:crypto";
import { hashPassword } from "../src/auth.ts";
import { openDb } from "../src/db.ts";

const [login, password, name] = process.argv.slice(2);
if (!login || !password) {
  console.error("Usage: node scripts/create-owner.ts <login> <password> [display name]");
  process.exit(1);
}
const email = (login.includes("@") ? login : `${login}@lulua.local`).toLowerCase();
const hash = await hashPassword(password.length < 6 ? password.padEnd(6, "~") : password);

const db = await openDb();
await db.tx(async (sql) => {
  const { rows } = await sql.query<{ uid: string }>("SELECT uid FROM app.users WHERE email = $1", [email]);
  const uid = rows[0]?.uid ?? randomBytes(14).toString("hex").slice(0, 28);
  if (rows[0]) await sql.query("UPDATE app.users SET password_hash = $2, disabled = false WHERE uid = $1", [uid, hash]);
  else await sql.query("INSERT INTO app.users (uid, email, password_hash, display_name) VALUES ($1, $2, $3, $4)", [uid, email, hash, name ?? login]);
  const now = { $ts: new Date().toISOString() };
  const admin = { email, displayName: name ?? login, role: "owner", active: true, createdAt: now, updatedAt: now };
  await sql.query(
    `INSERT INTO app.docs (collection, id, data) VALUES ('admins', $1, $2)
     ON CONFLICT (collection, id) DO UPDATE SET data = app.docs.data || jsonb_build_object('role', 'owner', 'active', true), version = app.docs.version + 1`,
    [uid, JSON.stringify(admin)]
  );
  console.log(`Owner ready: ${email} (uid ${uid})`);
});
await db.close();
