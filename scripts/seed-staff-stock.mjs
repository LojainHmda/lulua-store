// `node scripts/seed-staff-stock.mjs`: LOCAL emulator test data for the
// multi-branch POS -- three cashier logins per branch, and a stock count at
// every branch for every product size/color. Only creates what's missing:
// an existing login or an existing branch stock document is left as is.
//
// Requires the emulators to be running (`npm run emulators` or `npm run dev`).
import { readFileSync, writeFileSync } from "node:fs";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDocs, serverTimestamp, writeBatch } from "firebase/firestore";

const root = new URL("..", import.meta.url);
const env = Object.fromEntries(
  readFileSync(new URL(".env.local", root), "utf8")
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]])
);
const projectId = env.VITE_FIREBASE_PROJECT_ID;
const firestorePort = Number(env.VITE_EMULATOR_FIRESTORE_PORT) || 8080;
const authPort = Number(env.VITE_EMULATOR_AUTH_PORT) || 9099;
if (!projectId?.startsWith("demo-")) {
  console.error(`[seed:staff-stock] Refusing to run: project "${projectId}" is not a demo-* emulator project.`);
  process.exit(1);
}

const CASHIERS_PER_BRANCH = 3;
const PASSWORD = "123456";
const authUrl = (path) => `http://127.0.0.1:${authPort}/identitytoolkit.googleapis.com/v1/${path}?key=fake-api-key`;

// Same address the login screen builds from a username (toAuthEmail).
async function ensureAuthUser(username) {
  const email = `${username}@lulua.local`;
  const body = JSON.stringify({ email, password: PASSWORD, returnSecureToken: true });
  let res = await fetch(authUrl("accounts:signUp"), { method: "POST", headers: { "Content-Type": "application/json" }, body });
  let created = true;
  if (!res.ok) {
    created = false;
    res = await fetch(authUrl("accounts:signInWithPassword"), { method: "POST", headers: { "Content-Type": "application/json" }, body });
    if (!res.ok) throw new Error(`${username}: exists with a different password -- skipped`);
  }
  return { uid: (await res.json()).localId, email, created };
}

const testEnv = await initializeTestEnvironment({ projectId, firestore: { host: "127.0.0.1", port: firestorePort } });
const accounts = [];
try {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const branches = (await getDocs(collection(db, "branches"))).docs.map((d) => ({ id: d.id, ...d.data() })).filter((b) => b.active !== false);
    const admins = new Map((await getDocs(collection(db, "admins"))).docs.map((d) => [d.id, d.data()]));
    branches.sort((a, b) => String(a.code).localeCompare(String(b.code)));

    // --- Cashiers ---
    for (const b of branches) {
      const branchName = b.nameAr || b.name;
      for (let i = 1; i <= CASHIERS_PER_BRANCH; i++) {
        const username = `c${b.code}-${i}`.toLowerCase();
        try {
          const { uid, email, created } = await ensureAuthUser(username);
          if (!admins.has(uid)) {
            const batch = writeBatch(db);
            batch.set(doc(db, "admins", uid), {
              email,
              displayName: `كاشير ${i} - ${branchName}`,
              role: "cashier",
              active: true,
              branchIds: [b.id],
              registerIds: [],
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
            await batch.commit();
          }
          accounts.push({ branch: `${b.code} ${branchName}`, username, password: PASSWORD });
          console.log(`  ${created ? "created" : "kept   "} ${username} (${branchName})`);
        } catch (err) {
          console.log(`  skip ${username}: ${err.message}`);
        }
      }
    }

    // --- Branch stock: every cell of every product, at every branch ---
    const products = (await getDocs(collection(db, "products"))).docs;
    const existing = new Set((await getDocs(collection(db, "branchStock"))).docs.map((d) => d.id));
    let written = 0;
    let batch = writeBatch(db);
    let inBatch = 0;
    for (const p of products) {
      const cells = Object.keys(p.get("stockByCell") ?? {});
      if (cells.length === 0) continue;
      for (const b of branches) {
        const id = `${b.id}__${p.id}`;
        if (existing.has(id)) continue;
        // 0-9 per cell, deterministic per branch/product/cell so reruns match.
        const stockByCell = Object.fromEntries(
          cells.map((cell) => {
            let h = 0;
            for (const ch of `${id}|${cell}`) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
            return [cell, { qty: h % 10 }];
          })
        );
        batch.set(doc(db, "branchStock", id), { branchId: b.id, productId: p.id, stockByCell, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
        written++;
        if (++inBatch === 400) {
          await batch.commit();
          batch = writeBatch(db);
          inBatch = 0;
        }
      }
    }
    if (inBatch) await batch.commit();
    console.log(`  branch stock: ${written} new documents (${products.length} products x ${branches.length} branches, existing kept)`);
  });
} finally {
  await testEnv.cleanup();
}

// Logins for testing, next to the existing local accounts file.
const lines = ["", "Cashiers per branch (seed-staff-stock.mjs), password for all: " + PASSWORD, ...accounts.map((a) => `  ${a.username.padEnd(10)} branch ${a.branch}`)];
const file = new URL("local-test-accounts.txt", root);
const current = readFileSync(file, "utf8");
if (!current.includes("seed-staff-stock.mjs")) writeFileSync(file, current.trimEnd() + "\n" + lines.join("\n") + "\n");
