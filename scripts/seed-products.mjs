// `npm run seed:products`: writes the sample products from
// src/admin/productSeed.ts into the LOCAL Firestore emulator.
//
// - Products only. Categories are read (to validate each product's
//   category) and never written.
// - Idempotent: fixed document ids, and a product is skipped when its id or
//   its slug already exists, so re-running never duplicates or overwrites.
// - Each product is written exactly like ProductForm's create path: one
//   transaction holding the product doc (flat colorVariants + stockByCell,
//   server timestamps) plus one `initial_stock` stockMovements entry per
//   stocked size, followed by a `product.created` activity log entry.
//
// Requires the emulators to be running (`npm run emulators` or `npm run dev`).
import { readFileSync } from "node:fs";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, query, runTransaction, serverTimestamp, where } from "firebase/firestore";
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

// "demo-" project ids can only ever exist in the emulator — refuse anything else.
if (!projectId?.startsWith("demo-")) {
  console.error(`[seed:products] Refusing to run: project "${projectId}" is not a demo-* emulator project.`);
  process.exit(1);
}

// The app's Firestore is initialized with ignoreUndefinedProperties (see
// src/firebase/config.ts), so undefined optional fields are simply omitted.
// The test-environment instance isn't, so drop them here the same way.
function dropUndefined(value) {
  if (Array.isArray(value)) return value.map(dropUndefined);
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, dropUndefined(v)]));
  }
  return value;
}

const ACTOR ={ uid: "seed-script", email: "seed@lulua.local", name: "Product seed script" };

const load = (path) => runnerImport(new URL(path, root).pathname.replace(/^\/([A-Za-z]:)/, "$1"), { configFile: false, logLevel: "error" }).then((r) => r.module);
const { SEED_PRODUCTS } = await load("src/admin/productSeed.ts");
const { splitProductFields } = await load("src/admin/productVariants.ts");
const { computeStockDeltas } = await load("src/admin/stockMovements.ts");

const testEnv = await initializeTestEnvironment({ projectId, firestore: { host: "127.0.0.1", port } });
const counts = { created: 0, skipped: 0, branchSeeded: 0, branchSkipped: 0 };

// Deterministic, realistic per-size branch quantity: 2–8 units, with about
// one size in eight sold out at that branch; "One Size" items 2–5. Derived
// from a hash of branch/product/color/size so re-runs are stable.
function branchQty(key, size) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619) >>> 0;
  if (size === "One Size") return 2 + (h % 4);
  if (h % 8 === 0) return 0;
  return 2 + ((h >>> 3) % 7);
}

try {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();

    const categorySlugs = new Set((await getDocs(collection(db, "categories"))).docs.map((d) => d.data().slug));
    if (categorySlugs.size === 0) throw new Error("No categories in the database — create categories first (this script never creates them).");

    for (const product of SEED_PRODUCTS) {
      const { id, ...form } = product;
      if (!categorySlugs.has(form.category)) {
        console.warn(`  skip ${id} "${form.name}": category "${form.category}" does not exist`);
        counts.skipped++;
        continue;
      }
      const sameSlug = await getDocs(query(collection(db, "products"), where("slug", "==", form.slug)));
      if (sameSlug.docs.some((d) => d.id !== id)) {
        console.log(`  skip ${id} "${form.name}": slug "${form.slug}" already used by another product`);
        counts.skipped++;
        continue;
      }

      // ProductForm.handleSubmit, create branch.
      const { colorVariants: submittedVariants, ...payloadRest } = form;
      const { colorVariants: flatColorVariants, stockByCell } = splitProductFields(submittedVariants);
      const productRef = doc(db, "products", id);
      const created = await runTransaction(db, async (tx) => {
        if ((await tx.get(productRef)).exists()) return false;
        tx.set(productRef, { ...dropUndefined({ ...payloadRest, colorVariants: flatColorVariants, stockByCell }), createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
        for (const delta of computeStockDeltas([], submittedVariants)) {
          tx.set(doc(collection(db, "stockMovements")), {
            productId: id,
            productName: form.name,
            variantId: delta.variantId,
            colorName: delta.colorName,
            size: delta.size,
            qtyBefore: delta.qtyBefore,
            qtyChange: delta.qtyChange,
            qtyAfter: delta.qtyAfter,
            reason: "initial_stock",
            source: "admin",
            actorEmail: ACTOR.email,
            actorName: ACTOR.name,
            createdAt: serverTimestamp(),
          });
        }
        // logActivity(), written in the same transaction so a re-run can't log twice.
        tx.set(doc(collection(db, "activityLogs")), {
          actorUid: ACTOR.uid,
          actorEmail: ACTOR.email,
          actorName: ACTOR.name,
          action: "product.created",
          target: form.name,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        return true;
      });

      if (created) {
        console.log(`  created ${id} "${form.name}" (${form.category})`);
        counts.created++;
      } else {
        console.log(`  skip ${id} "${form.name}": already exists`);
        counts.skipped++;
      }
    }
    // --- Branch stock -------------------------------------------------------
    // Gives every seeded product opening stock at every active branch,
    // written exactly like the admin "Add stock" wizard (receiveStock in
    // src/firebase/stockReceipt.ts): the branchStock doc plus one
    // "stock_received" movement per color/size, sharing a receipt id. Online
    // stock is not touched. A branch that already holds stock for a product
    // is skipped (never overwritten), and the receipt id is deterministic,
    // so re-running adds nothing twice.
    const branches = (await getDocs(collection(db, "branches"))).docs.filter((d) => d.get("active") === true);
    if (branches.length === 0) console.log("  no active branches — branch stock skipped");
    for (const branchSnap of branches) {
      const branchId = branchSnap.id;
      for (const product of SEED_PRODUCTS) {
        const productSnap = await getDoc(doc(db, "products", product.id));
        if (!productSnap.exists()) continue;
        const receiptId = `SEED-${branchId}-${product.id}`;
        const stockRef = doc(db, "branchStock", `${branchId}__${product.id}`);
        const movementRef = (n) => doc(db, "stockMovements", `${receiptId}__${n}`);
        const result = await runTransaction(db, async (tx) => {
          if ((await tx.get(movementRef(0))).exists()) return "already seeded";
          if ((await tx.get(stockRef)).exists()) return "branch already has stock";
          const stockByCell = {};
          const movements = [];
          for (const v of product.colorVariants) {
            for (const s of v.sizeStock) {
              const qty = branchQty(`${branchId}|${product.id}|${v.id}|${s.size}`, s.size);
              stockByCell[`${v.id}::${s.size}`] = { qty };
              if (qty > 0) {
                movements.push({
                  productId: product.id,
                  productName: product.name,
                  variantId: v.id,
                  colorName: v.colorName,
                  size: s.size,
                  qtyBefore: 0,
                  qtyChange: qty,
                  qtyAfter: qty,
                  reason: "stock_received",
                  source: "admin",
                  actorEmail: ACTOR.email,
                  actorName: ACTOR.name,
                  branchId,
                  receiptId,
                  reference: "SEED-OPENING",
                  note: "Opening branch stock (seed)",
                  createdAt: serverTimestamp(),
                });
              }
            }
          }
          tx.set(stockRef, { branchId, productId: product.id, stockByCell, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
          movements.forEach((m, n) => tx.set(movementRef(n), m));
          return movements.reduce((sum, m) => sum + m.qtyChange, 0);
        });
        if (typeof result === "number") {
          console.log(`  branch ${branchSnap.get("code") || branchId}: ${product.id} +${result} units`);
          counts.branchSeeded++;
        } else {
          console.log(`  branch ${branchSnap.get("code") || branchId}: skip ${product.id} (${result})`);
          counts.branchSkipped++;
        }
      }
    }
  });
} finally {
  await testEnv.cleanup();
}

console.log(`[seed:products] done — ${counts.created} created, ${counts.skipped} skipped (of ${SEED_PRODUCTS.length}).`);
console.log(`[seed:products] branch stock — ${counts.branchSeeded} product/branch pairs stocked, ${counts.branchSkipped} skipped.`);
