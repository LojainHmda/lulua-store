// `npm run seed:base`: the minimum a fresh LOCAL emulator database needs
// before `npm run seed:products` — the store's default categories and one
// branch with a POS register. Only creates what's missing (fixed ids, skip
// if present); never changes or deletes existing data.
//
// Requires the emulators to be running (`npm run emulators` or `npm run dev`).
import { readFileSync } from "node:fs";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, serverTimestamp, setDoc } from "firebase/firestore";
import { runnerImport } from "vite";

const root = new URL("..", import.meta.url);
const env = Object.fromEntries(
  readFileSync(new URL(".env.local", root), "utf8")
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]])
);
const projectId = env.VITE_FIREBASE_PROJECT_ID;
const port = Number(env.VITE_EMULATOR_FIRESTORE_PORT) || 8080;
if (!projectId?.startsWith("demo-")) {
  console.error(`[seed:base] Refusing to run: project "${projectId}" is not a demo-* emulator project.`);
  process.exit(1);
}

const load = (path) => runnerImport(new URL(path, root).pathname.replace(/^\/([A-Za-z]:)/, "$1"), { configFile: false, logLevel: "error" }).then((r) => r.module);
const { CATEGORIES } = await load("src/data/products.ts");
const { AR_CATEGORIES } = await load("src/i18n/arData.ts");

// Same shape the admin's "Import store's default categories" writes
// (src/admin/seedCatalog.ts → starterCategories()), doc id = slug.
const categories = CATEGORIES.map((c, i) => ({
  id: c.slug,
  data: {
    slug: c.slug,
    name: c.name,
    nameAr: c.nameAr ?? AR_CATEGORIES[c.slug]?.name ?? "",
    tagline: c.tagline,
    taglineAr: c.taglineAr ?? AR_CATEGORIES[c.slug]?.tagline ?? "",
    imageId: c.imageId,
    imageUrl: c.imageUrl ?? "",
    icon: c.icon ?? "",
    order: i,
  },
}));

const BRANCH = { id: "branch-first", data: { name: "first", nameAr: "الفرغ الاول", code: "1", address: "طولكرم", phone: "059999", active: true } };
const REGISTER = { id: "register-first-1", data: { branchId: BRANCH.id, name: "نقطة البيع 1", active: true, openSessionId: null } };

const testEnv = await initializeTestEnvironment({ projectId, firestore: { host: "127.0.0.1", port } });
try {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const createIfMissing = async (col, id, data, label) => {
      const ref = doc(db, col, id);
      if ((await getDoc(ref)).exists()) return console.log(`  skip ${label} (exists)`);
      await setDoc(ref, { ...data, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      console.log(`  created ${label}`);
    };

    // Categories: only when the collection is empty, so a store that already
    // has its own categories is never mixed with the defaults.
    if ((await getDocs(collection(db, "categories"))).empty) {
      for (const c of categories) await createIfMissing("categories", c.id, c.data, `category ${c.id}`);
    } else {
      console.log("  categories already exist — left as they are");
    }

    // Branch + register: only when there is no branch at all.
    if ((await getDocs(collection(db, "branches"))).empty) {
      await createIfMissing("branches", BRANCH.id, BRANCH.data, `branch ${BRANCH.data.name}`);
      await createIfMissing("registers", REGISTER.id, REGISTER.data, `register ${REGISTER.data.name}`);
    } else {
      console.log("  branches already exist — left as they are");
    }
  });
} finally {
  await testEnv.cleanup();
}
console.log("[seed:base] done.");
