// One-time (re-runnable) copy of the live store from Firebase into Neon:
//   - every Firestore document -> app.docs (same collection/id/data),
//   - every Firebase Auth account -> app.users, same uid, with its Firebase
//     password hash (verified by the API with the project's hash parameters,
//     which are copied too, into app.meta), so everyone keeps their password.
//
// Read-only on the Firebase side. Idempotent: documents/users are upserted,
// so it can be re-run right before the switch-over to pick up anything new.
//
// Runs as a Cloud Run Job in the Firebase project (its service account can
// read Firestore and Auth):
//   gcloud run jobs deploy lulua-import --source services/api --region europe-west2 \
//     --command node --args scripts/import-from-firebase.ts \
//     --set-secrets DATABASE_URL=lulua-neon-database-url:latest \
//     --set-env-vars FIRESTORE_DATABASE=lulua-store
import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { DocumentReference, GeoPoint, getFirestore, Timestamp } from "firebase-admin/firestore";
import { openDb } from "../src/db.ts";

const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.FIREBASE_PROJECT || "kartacagenai";
initializeApp({ credential: applicationDefault(), projectId });
const fs = getFirestore(process.env.FIRESTORE_DATABASE || "lulua-store");
const db = await openDb();

// Firestore value -> the API's stored JSON (timestamps as { $ts }).
function plain(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Timestamp) return { $ts: v.toDate().toISOString() };
  if (v instanceof GeoPoint) return { latitude: v.latitude, longitude: v.longitude };
  if (v instanceof DocumentReference) return v.path;
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.from(v).toString("base64");
  if (Array.isArray(v)) return v.map(plain);
  if (typeof v === "object") return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, plain(x)]));
  if (typeof v === "number" && !Number.isFinite(v)) return null;
  return v;
}

// --- Documents ---------------------------------------------------------------
let docCount = 0;
async function copyCollection(col: FirebaseFirestore.CollectionReference) {
  const snap = await col.get();
  const rows = snap.docs.map((d) => [col.path, d.id, JSON.stringify(plain(d.data()))]);
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    await db.query(
      `INSERT INTO app.docs (collection, id, data)
       SELECT * FROM unnest($1::text[], $2::text[], $3::jsonb[])
       ON CONFLICT (collection, id) DO UPDATE
         SET data = EXCLUDED.data, version = app.docs.version + 1, updated_at = now()
         WHERE app.docs.data IS DISTINCT FROM EXCLUDED.data`,
      [chunk.map((r) => r[0]), chunk.map((r) => r[1]), chunk.map((r) => r[2])]
    );
  }
  docCount += rows.length;
  console.log(`  ${col.path}: ${rows.length}`);
  // Subcollections (none expected, copied if any exist).
  for (const d of snap.docs) for (const sub of await d.ref.listCollections()) await copyCollection(sub);
}

// Collections already curated in Neon that a re-run must not overwrite
// (comma-separated; default: categories, set by set-store-categories.ts).
const skip = new Set((process.env.IMPORT_SKIP ?? "categories").split(",").map((s) => s.trim()).filter(Boolean));

console.log("Copying Firestore documents...");
for (const col of await fs.listCollections()) {
  if (skip.has(col.id)) console.log(`  ${col.path}: skipped (IMPORT_SKIP)`);
  else await copyCollection(col);
}
console.log(`Documents: ${docCount}`);

// --- Accounts ------------------------------------------------------------------
console.log("Copying accounts...");
await db.exec("CREATE TABLE IF NOT EXISTS app.meta (key text PRIMARY KEY, value jsonb NOT NULL)");

// The project's password-hash parameters (needed to verify imported hashes).
const token = (await applicationDefault().getAccessToken()).access_token;
const cfgRes = await fetch(`https://identitytoolkit.googleapis.com/admin/v2/projects/${projectId}/config`, {
  headers: { Authorization: `Bearer ${token}`, "x-goog-user-project": projectId },
});
const cfg = (await cfgRes.json()) as { signIn?: { hashConfig?: Record<string, unknown> } };
const hashConfig = cfg.signIn?.hashConfig;
if (hashConfig?.signerKey) {
  await db.query("INSERT INTO app.meta (key, value) VALUES ('firebase_hash_config', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [
    JSON.stringify(hashConfig),
  ]);
  console.log("  password hash parameters: saved");
} else {
  console.warn(`  password hash parameters: NOT available (HTTP ${cfgRes.status}) — imported passwords won't verify`);
}

let users = 0;
let withPassword = 0;
let pageToken: string | undefined;
do {
  const page = await getAuth().listUsers(1000, pageToken);
  for (const u of page.users) {
    const google = u.providerData.find((p) => p.providerId === "google.com");
    const anonymous = u.providerData.length === 0 && !u.email;
    const hash = u.passwordHash && u.passwordSalt ? `fbscrypt$${u.passwordSalt}$${u.passwordHash}` : null;
    if (hash) withPassword++;
    await db.query(
      `INSERT INTO app.users (uid, email, password_hash, google_sub, anonymous, display_name, photo_url, disabled, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (uid) DO UPDATE SET
         email = EXCLUDED.email,
         -- keep a password already re-hashed (or changed) on the new system
         password_hash = CASE WHEN app.users.password_hash LIKE 'scrypt$%' THEN app.users.password_hash ELSE EXCLUDED.password_hash END,
         google_sub = EXCLUDED.google_sub, anonymous = EXCLUDED.anonymous,
         display_name = EXCLUDED.display_name, photo_url = EXCLUDED.photo_url, disabled = EXCLUDED.disabled`,
      [
        u.uid,
        u.email?.toLowerCase() ?? null,
        hash,
        google?.uid ?? null,
        anonymous,
        u.displayName ?? null,
        u.photoURL ?? null,
        u.disabled,
        new Date(u.metadata.creationTime),
      ]
    );
    users++;
  }
  pageToken = page.pageToken;
} while (pageToken);
console.log(`Accounts: ${users} (${withPassword} with a password)`);

await db.close();
console.log("Import done.");
