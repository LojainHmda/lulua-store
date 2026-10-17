// `npm run seed:categories`: writes the store's full category tree
// (src/data/storeCategories.ts — pajamas, underwear, bridal, home,
// kitchen and baby) to a LOCAL emulator database. Same result
// as the admin's "Add store categories" button on /admin/categories.
//
// Idempotent: a category whose slug already exists is skipped (doc id =
// slug, existing docs are never changed except for `order`), so it's safe
// to run any number of times and alongside `npm run seed:base`. After
// adding, `order` is renumbered across the whole collection so the flat
// order follows the tree (src/data/categoryTree.ts).
//
// Requires the emulators to be running (`npm run emulators` or `npm run dev`).
import { readFileSync } from "node:fs";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDocs, serverTimestamp, writeBatch } from "firebase/firestore";
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
  console.error(`[seed:categories] Refusing to run: project "${projectId}" is not a demo-* emulator project.`);
  process.exit(1);
}

const load = (path) => runnerImport(new URL(path, root).pathname.replace(/^\/([A-Za-z]:)/, "$1"), { configFile: false, logLevel: "error" }).then((r) => r.module);
const { STORE_CATEGORY_PRESET } = await load("src/data/storeCategories.ts");
const { flattenTree } = await load("src/data/categoryTree.ts");

const testEnv = await initializeTestEnvironment({ projectId, firestore: { host: "127.0.0.1", port } });
try {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const existing = (await getDocs(collection(db, "categories"))).docs.map((d) => ({ id: d.id, ...d.data() }));
    const bySlug = new Map(existing.map((c) => [c.slug, c]));
    let next = existing.reduce((m, c) => Math.max(m, typeof c.order === "number" ? c.order : 0), -1) + 1;

    const added = [];
    const walk = (nodes, parentId) => {
      for (const n of nodes) {
        const found = bySlug.get(n.slug);
        const id = found?.id ?? n.slug;
        if (found) console.log(`  skip ${n.slug} (exists)`);
        else
          added.push({
            id,
            slug: n.slug,
            name: n.name,
            nameAr: n.nameAr,
            tagline: "",
            taglineAr: "",
            imageId: "",
            imageUrl: "",
            icon: n.icon,
            parentId,
            isActive: true,
            order: next++,
          });
        if (n.children) walk(n.children, id);
      }
    };
    walk(STORE_CATEGORY_PRESET, null);

    const all = [...existing, ...added];
    const batch = writeBatch(db);
    const addedIds = new Set(added.map((c) => c.id));
    let reordered = 0;
    flattenTree(all).forEach(({ cat }, i) => {
      if (addedIds.has(cat.id)) {
        const { id, ...data } = cat;
        batch.set(doc(db, "categories", id), { ...data, order: i, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
        console.log(`  created ${cat.slug} (${cat.nameAr})`);
      } else if (cat.order !== i) {
        batch.update(doc(db, "categories", cat.id), { order: i });
        reordered++;
      }
    });
    await batch.commit();
    console.log(`  ${added.length} created, ${existing.length} already there${reordered ? `, ${reordered} reordered` : ""}`);
  });
} finally {
  await testEnv.cleanup();
}
console.log("[seed:categories] done.");
