import { assertFails, assertSucceeds } from "./testing";
import { collection, doc, getDoc, getDocs, query, runTransaction, setDoc, where } from "../../src/db/firestore";
import type { Firestore } from "../../src/db/firestore";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { findLowStockCrossings } from "../../src/admin/lowStockNotify";
import { computeStockDeltas } from "../../src/admin/stockMovements";
import { clearFirestore, getTestEnv, teardownTestEnv } from "./setup";

// Phase 3 focused tests: Inventory.tsx's saveRow() and ProductForm.tsx's
// handleSubmit() converted from a plain productsApi.update()/.create() into
// a runTransaction() that reads fresh, writes stock, and writes ledger
// entries atomically. Same methodology as Phase 2's
// stock-movements-transactions.test.ts: hand-rolled helpers mirroring the
// REAL updated component logic exactly (including calling the real,
// imported computeStockDeltas() and findLowStockCrossings() — never a
// re-derived copy), since the real components are bound to the app's own
// `db` singleton and can't be invoked directly against this harness.

const IDENTIFIED = { firebase: { sign_in_provider: "password" as const } };

interface SizeStock {
  size: string;
  qty: number | null;
}
interface ColorVariant {
  id: string;
  colorName: string;
  colorHex: string;
  sizeStock: SizeStock[];
}
interface ProductDoc {
  name: string;
  slug: string;
  price: number;
  status: string;
  colorVariants: ColorVariant[];
}

function product(colorVariants: ColorVariant[], overrides: Record<string, unknown> = {}): ProductDoc {
  return { name: "Ledger Test Product", slug: "ledger-test-product", price: 50, status: "active", colorVariants, ...(overrides as object) } as ProductDoc;
}

async function seedAdmin(uid: string, role: string) {
  const env = await getTestEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `admins/${uid}`), { email: `${uid}@example.com`, displayName: uid, role, active: true });
  });
}

async function seedProduct(id: string, data: ProductDoc) {
  const env = await getTestEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `products/${id}`), data);
  });
}

// Simulates an unrelated concurrent write landing on the server (e.g. a
// checkout sale, or a different admin) between when a form/row loaded and
// when it saves — a direct write bypassing the transaction entirely, same
// as any other real concurrent actor would.
async function concurrentServerWrite(id: string, colorVariants: ColorVariant[]) {
  const env = await getTestEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `products/${id}`), { colorVariants }, { merge: true });
  });
}

async function allMovements(productId?: string): Promise<Record<string, unknown>[]> {
  const env = await getTestEnv();
  let result: Record<string, unknown>[] = [];
  await env.withSecurityRulesDisabled(async (ctx) => {
    const fs = ctx.firestore();
    const q = productId ? query(collection(fs, "stockMovements"), where("productId", "==", productId)) : collection(fs, "stockMovements");
    const snap = await getDocs(q);
    result = snap.docs.map((d) => d.data());
  });
  return result;
}

async function readProduct(productId: string): Promise<ProductDoc> {
  const env = await getTestEnv();
  let result: ProductDoc | null = null;
  await env.withSecurityRulesDisabled(async (ctx) => {
    const snap = await getDoc(doc(ctx.firestore(), "products", productId));
    result = snap.data() as ProductDoc;
  });
  return result!;
}

// Mirrors Inventory.tsx's real saveRow(): reads fresh, merges ONLY the
// drafted (explicitly admin-typed) cells over the fresh state — every
// untouched cell falls back to the FRESH server value, never the caller's
// stale snapshot — then writes stock + ledger atomically.
function inventorySaveWithLedger(
  fs: Firestore,
  opts: { productId: string; rowDraft: Record<string, Record<string, number>>; actorEmail: string; actorName: string }
) {
  return runTransaction(fs, async (tx) => {
    const ref = doc(fs, "products", opts.productId);
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error("This product no longer exists.");
    const fresh = snap.data() as ProductDoc;
    const nextVariants = fresh.colorVariants.map((v) => ({
      ...v,
      sizeStock: v.sizeStock.map((s) => ({ size: s.size, qty: opts.rowDraft[v.id]?.[s.size] ?? s.qty })),
    }));
    tx.update(ref, { colorVariants: nextVariants, updatedAt: new Date() });
    for (const d of computeStockDeltas(fresh.colorVariants, nextVariants)) {
      tx.set(doc(collection(fs, "stockMovements")), {
        productId: opts.productId,
        productName: fresh.name,
        variantId: d.variantId,
        colorName: d.colorName,
        size: d.size,
        qtyBefore: d.qtyBefore,
        qtyChange: d.qtyChange,
        qtyAfter: d.qtyAfter,
        reason: "manual_adjustment",
        source: "admin",
        actorEmail: opts.actorEmail,
        actorName: opts.actorName,
        createdAt: new Date(),
      });
    }
    return { before: fresh.colorVariants, after: nextVariants };
  });
}

// Mirrors ProductForm.tsx's real handleSubmit() for an EXISTING product:
// reads fresh (used only to compute honest ledger deltas — the write
// itself is always the admin's full submitted payload, unchanged
// full-replace behavior, matching "preserve existing behavior for all
// non-stock fields").
function productFormEditWithLedger(
  fs: Firestore,
  opts: { productId: string; payload: ProductDoc; actorEmail: string; actorName: string }
) {
  return runTransaction(fs, async (tx) => {
    const ref = doc(fs, "products", opts.productId);
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error("This product no longer exists.");
    const fresh = snap.data() as ProductDoc;
    tx.update(ref, { ...opts.payload, updatedAt: new Date() });
    for (const d of computeStockDeltas(fresh.colorVariants, opts.payload.colorVariants)) {
      tx.set(doc(collection(fs, "stockMovements")), {
        productId: opts.productId,
        productName: opts.payload.name,
        variantId: d.variantId,
        colorName: d.colorName,
        size: d.size,
        qtyBefore: d.qtyBefore,
        qtyChange: d.qtyChange,
        qtyAfter: d.qtyAfter,
        reason: "manual_adjustment",
        source: "admin",
        actorEmail: opts.actorEmail,
        actorName: opts.actorName,
        createdAt: new Date(),
      });
    }
    return fresh.colorVariants;
  });
}

// Mirrors ProductForm.tsx's real handleSubmit() for a NEW product: no prior
// document, before=[] for every cell, reason "initial_stock".
function productFormCreateWithLedger(fs: Firestore, opts: { payload: ProductDoc; actorEmail: string; actorName: string }) {
  return runTransaction(fs, async (tx) => {
    const newRef = doc(collection(fs, "products"));
    tx.set(newRef, { ...opts.payload, createdAt: new Date(), updatedAt: new Date() });
    for (const d of computeStockDeltas([], opts.payload.colorVariants)) {
      tx.set(doc(collection(fs, "stockMovements")), {
        productId: newRef.id,
        productName: opts.payload.name,
        variantId: d.variantId,
        colorName: d.colorName,
        size: d.size,
        qtyBefore: d.qtyBefore,
        qtyChange: d.qtyChange,
        qtyAfter: d.qtyAfter,
        reason: "initial_stock",
        source: "admin",
        actorEmail: opts.actorEmail,
        actorName: opts.actorName,
        createdAt: new Date(),
      });
    }
    return newRef.id;
  });
}

describe("stock movement ledger: Inventory.tsx (manual_adjustment)", () => {
  beforeEach(async () => {
    await clearFirestore();
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  it("manual increase creates one correct positive movement", async () => {
    await seedAdmin("admin1", "admin");
    await seedProduct("p1", product([{ id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 3 }] }]));
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await assertSucceeds(
      inventorySaveWithLedger(admin.firestore(), {
        productId: "p1", rowDraft: { black: { S: 8 } }, actorEmail: "admin1@example.com", actorName: "admin1",
      })
    );
    const movements = await allMovements("p1");
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ qtyBefore: 3, qtyChange: 5, qtyAfter: 8, reason: "manual_adjustment", source: "admin", actorEmail: "admin1@example.com" });
  });

  it("manual decrease creates one correct negative movement", async () => {
    await seedAdmin("admin1", "admin");
    await seedProduct("p1", product([{ id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 10 }] }]));
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await assertSucceeds(
      inventorySaveWithLedger(admin.firestore(), {
        productId: "p1", rowDraft: { black: { S: 4 } }, actorEmail: "admin1@example.com", actorName: "admin1",
      })
    );
    const movements = await allMovements("p1");
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ qtyBefore: 10, qtyChange: -6, qtyAfter: 4 });
  });

  it("re-typing the same value (zero real change) creates no movement", async () => {
    await seedAdmin("admin1", "admin");
    await seedProduct("p1", product([{ id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 5 }] }]));
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await assertSucceeds(
      inventorySaveWithLedger(admin.firestore(), {
        productId: "p1", rowDraft: { black: { S: 5 } }, actorEmail: "admin1@example.com", actorName: "admin1",
      })
    );
    expect(await allMovements("p1")).toHaveLength(0);
  });

  it("a stale UI snapshot cannot overwrite a newer server quantity on an untouched cell", async () => {
    await seedAdmin("admin1", "admin");
    // Admin's row loads with S=10, M=2 in view.
    await seedProduct(
      "p1",
      product([{ id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 10 }, { size: "M", qty: 2 }] }])
    );
    // A concurrent sale (or another admin) changes S to 6 on the server
    // while this admin's row is still showing the stale S=10 they loaded.
    await concurrentServerWrite("p1", [{ id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 6 }, { size: "M", qty: 2 }] }]);
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    // Admin only ever touched M in their draft — S was never in rowDraft,
    // so it must fall back to the FRESH server value (6), not the stale
    // page-load value (10) their row prop still holds.
    const result = await inventorySaveWithLedger(admin.firestore(), {
      productId: "p1", rowDraft: { black: { M: 7 } }, actorEmail: "admin1@example.com", actorName: "admin1",
    });
    expect(result).toBeDefined();
    const finalProduct = await readProduct("p1");
    const sSize = finalProduct.colorVariants[0].sizeStock.find((s) => s.size === "S")!;
    expect(sSize.qty).toBe(6); // NOT reverted to the stale 10
    const movements = await allMovements("p1");
    expect(movements).toHaveLength(1); // only the M cell the admin actually touched
    expect(movements[0]).toMatchObject({ size: "M", qtyBefore: 2, qtyChange: 5, qtyAfter: 7 });
  });

  it("two concurrent inventory edits to different cells of the same product both land correctly", async () => {
    await seedAdmin("adminA", "admin");
    await seedAdmin("adminB", "admin");
    await seedProduct(
      "p1",
      product([{ id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 10 }, { size: "M", qty: 10 }] }])
    );
    const env = await getTestEnv();
    const adminA = env.authenticatedContext("adminA", IDENTIFIED);
    const adminB = env.authenticatedContext("adminB", IDENTIFIED);
    await Promise.all([
      inventorySaveWithLedger(adminA.firestore(), { productId: "p1", rowDraft: { black: { S: 3 } }, actorEmail: "a@example.com", actorName: "A" }),
      inventorySaveWithLedger(adminB.firestore(), { productId: "p1", rowDraft: { black: { M: 4 } }, actorEmail: "b@example.com", actorName: "B" }),
    ]);
    const finalProduct = await readProduct("p1");
    const sSize = finalProduct.colorVariants[0].sizeStock.find((s) => s.size === "S")!;
    const mSize = finalProduct.colorVariants[0].sizeStock.find((s) => s.size === "M")!;
    expect(sSize.qty).toBe(3);
    expect(mSize.qty).toBe(4);
    const movements = await allMovements("p1");
    expect(movements).toHaveLength(2);
  });

  it("a failed transaction (product deleted concurrently) commits neither a stock change nor a ledger entry", async () => {
    await seedAdmin("admin1", "admin");
    await seedProduct("p1", product([{ id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 5 }] }]));
    // Product removed before the save runs.
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const { deleteDoc } = await import("../../src/db/firestore");
      await deleteDoc(doc(ctx.firestore(), "products/p1"));
    });
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await expect(
      inventorySaveWithLedger(admin.firestore(), { productId: "p1", rowDraft: { black: { S: 99 } }, actorEmail: "admin1@example.com", actorName: "admin1" })
    ).rejects.toThrow();
    expect(await allMovements("p1")).toHaveLength(0);
  });
});

describe("stock movement ledger: ProductForm.tsx (manual_adjustment + initial_stock)", () => {
  beforeEach(async () => {
    await clearFirestore();
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  it("an existing product's quantity change creates the correct movement", async () => {
    await seedAdmin("admin1", "admin");
    await seedProduct("p1", product([{ id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 5 }] }]));
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    const payload = product([{ id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 9 }] }]);
    await assertSucceeds(productFormEditWithLedger(admin.firestore(), { productId: "p1", payload, actorEmail: "admin1@example.com", actorName: "admin1" }));
    const movements = await allMovements("p1");
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ qtyBefore: 5, qtyChange: 4, qtyAfter: 9, reason: "manual_adjustment", source: "admin" });
  });

  it("multiple color/size changes in one save create the correct individual movement rows", async () => {
    await seedAdmin("admin1", "admin");
    await seedProduct(
      "p1",
      product([
        { id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 5 }, { size: "M", qty: 5 }] },
        { id: "red", colorName: "Red", colorHex: "#f00", sizeStock: [{ size: "S", qty: 5 }] },
      ])
    );
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    const payload = product([
      { id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 2 }, { size: "M", qty: 5 }] }, // S changed, M unchanged
      { id: "red", colorName: "Red", colorHex: "#f00", sizeStock: [{ size: "S", qty: 8 }] }, // changed
    ]);
    await assertSucceeds(productFormEditWithLedger(admin.firestore(), { productId: "p1", payload, actorEmail: "admin1@example.com", actorName: "admin1" }));
    const movements = await allMovements("p1");
    expect(movements).toHaveLength(2);
    const byKey = new Map(movements.map((m) => [`${m.variantId}::${m.size}`, m]));
    expect(byKey.get("black::S")).toMatchObject({ qtyBefore: 5, qtyChange: -3, qtyAfter: 2 });
    expect(byKey.get("red::S")).toMatchObject({ qtyBefore: 5, qtyChange: 3, qtyAfter: 8 });
    expect(byKey.has("black::M")).toBe(false);
  });

  it("a non-stock-only edit (name/price changed, quantities identical) creates no movement", async () => {
    await seedAdmin("admin1", "admin");
    const variants: ColorVariant[] = [{ id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 5 }] }];
    await seedProduct("p1", product(variants, { name: "Old Name", price: 50 }));
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    const payload = product(variants, { name: "New Name", price: 65 });
    await assertSucceeds(productFormEditWithLedger(admin.firestore(), { productId: "p1", payload, actorEmail: "admin1@example.com", actorName: "admin1" }));
    expect(await allMovements("p1")).toHaveLength(0);
    const finalProduct = await readProduct("p1");
    expect(finalProduct.name).toBe("New Name");
    expect(finalProduct.price).toBe(65);
  });

  it("a brand-new product creates correct initial-stock movements, skipping zero-stock cells", async () => {
    await seedAdmin("admin1", "admin");
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    const payload = product([
      { id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 5 }, { size: "M", qty: 0 }] },
    ]);
    const newId = await assertSucceeds(productFormCreateWithLedger(admin.firestore(), { payload, actorEmail: "admin1@example.com", actorName: "admin1" }));
    const movements = await allMovements(newId as string);
    expect(movements).toHaveLength(1); // M (qty 0) correctly skipped -- no fake "0 -> 0" history
    expect(movements[0]).toMatchObject({ size: "S", qtyBefore: 0, qtyChange: 5, qtyAfter: 5, reason: "initial_stock", source: "admin" });
  });

  it("creating a product with no stock anywhere creates no movements at all", async () => {
    await seedAdmin("admin1", "admin");
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    const payload = product([{ id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 0 }] }]);
    const newId = await assertSucceeds(productFormCreateWithLedger(admin.firestore(), { payload, actorEmail: "admin1@example.com", actorName: "admin1" }));
    expect(await allMovements(newId as string)).toHaveLength(0);
  });

  it("the ledger reflects the true fresh state, not a stale form snapshot, when another change lands first", async () => {
    await seedAdmin("admin1", "admin");
    await seedAdmin("admin2", "admin");
    // Both "admins" load the product with S=10.
    await seedProduct("p1", product([{ id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 10 }] }]));
    const env = await getTestEnv();
    const admin2 = env.authenticatedContext("admin2", IDENTIFIED);
    // Admin 2 saves first, genuinely changing S from 10 -> 15.
    await productFormEditWithLedger(admin2.firestore(), {
      productId: "p1",
      payload: product([{ id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 15 }] }]),
      actorEmail: "admin2@example.com",
      actorName: "admin2",
    });
    // Admin 1 now saves, still submitting their original form's S=10 (they
    // never saw admin 2's change). The write does set S back to 10 (full-
    // replace form, unchanged pre-existing behavior) -- but the LEDGER must
    // honestly show what actually happened: 15 -> 10, not a stale-baseline
    // "10 -> 10, nothing happened" that a naive (non-fresh-read)
    // implementation would have produced.
    const admin1 = env.authenticatedContext("admin1", IDENTIFIED);
    await productFormEditWithLedger(admin1.firestore(), {
      productId: "p1",
      payload: product([{ id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 10 }] }]),
      actorEmail: "admin1@example.com",
      actorName: "admin1",
    });
    const movements = await allMovements("p1");
    expect(movements).toHaveLength(2);
    const admin1Movement = movements.find((m) => m.actorEmail === "admin1@example.com")!;
    expect(admin1Movement).toMatchObject({ qtyBefore: 15, qtyChange: -5, qtyAfter: 10 });
    const finalProduct = await readProduct("p1");
    expect(finalProduct.colorVariants[0].sizeStock[0].qty).toBe(10);
  });
});

describe("stock movement ledger: low-stock notification wiring", () => {
  beforeEach(async () => {
    await clearFirestore();
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  it("Inventory's committed before/after (not a stale prop) correctly detects a real low-stock crossing and avoids a spurious duplicate one", async () => {
    await seedAdmin("admin1", "admin");
    // Admin's row renders from this: S=10 (safe), M=10 (safe).
    const staleSnapshotAdminLoaded: ColorVariant[] = [
      { id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 10 }, { size: "M", qty: 10 }] },
    ];
    await seedProduct("p1", product(staleSnapshotAdminLoaded));
    // Between page-load and save, a concurrent sale already dropped S to 3
    // (below the threshold=5 used below) -- a crossing that already
    // happened, caused by that sale, not by this admin's save.
    await concurrentServerWrite("p1", [{ id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 3 }, { size: "M", qty: 10 }] }]);

    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    // Admin only touches M in their draft (10 -> 2, a genuine new crossing
    // caused BY this save). S is left alone and must carry through at its
    // fresh value (3), not revert to the stale 10 the row was rendered with.
    const result = await inventorySaveWithLedger(admin.firestore(), {
      productId: "p1", rowDraft: { black: { M: 2 } }, actorEmail: "admin1@example.com", actorName: "admin1",
    });

    const threshold = 5;
    const crossingsFromCommitted = findLowStockCrossings(result.before, result.after, threshold);
    // Correct: M's real, save-caused crossing (10 -> 2) is detected.
    expect(crossingsFromCommitted).toEqual([{ colorName: "Black", size: "M", qty: 2 }]);
    // S does NOT appear -- it was already below threshold before this
    // save (3 -> 3, no real transition happened here), so no duplicate
    // notification is raised for an event this save didn't cause.
    expect(crossingsFromCommitted.some((c) => c.size === "S")).toBe(false);

    // Contrast: if the stale page-load snapshot had been used as "before"
    // instead of the transaction's real committed value, S would show a
    // fabricated crossing (10 -> 3) attributed to a save that never
    // touched it, on top of still correctly catching M -- a real
    // discrepancy, and exactly what committedBefore/committedAfter in the
    // actual Inventory.tsx code now prevents by construction.
    const crossingsFromStaleBefore = findLowStockCrossings(staleSnapshotAdminLoaded, result.after, threshold);
    expect(crossingsFromStaleBefore.some((c) => c.size === "S")).toBe(true);
  });
});
