import { assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, limit, orderBy, query, runTransaction, setDoc, updateDoc, where, writeBatch } from "firebase/firestore";
import type { Firestore } from "firebase/firestore";
import { afterAll, beforeEach, describe, it } from "vitest";
import { seedBranchSetup, seedBranchStock } from "./branchFixtures";
import { clearFirestore, getTestEnv, teardownTestEnv } from "./setup";

// Multi-branch POS rules: branches/registers/branchStock collections, the
// register lock, branch-scoped sales and the cashier's order read scope.
// Mirrors the real write shapes in src/firebase/registerSession.ts and
// src/firebase/orderTransaction.ts (branch mode).

const IDENTIFIED = { firebase: { sign_in_provider: "password" as const } };

interface Line {
  productId: string;
  variantId: string;
  size: string;
  qty: number;
  price: number;
}

async function seedProduct(id: string, price = 50) {
  const env = await getTestEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `products/${id}`), { name: id, slug: id, price, status: "active", colorVariants: {}, stockByCell: {} });
  });
}

async function seedStaff(uid: string, role: string, branchIds: string[] = []) {
  const env = await getTestEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `admins/${uid}`), { email: `${uid}@example.com`, displayName: uid, role, active: true, branchIds });
  });
}

// The branch-mode sale transaction placeOrder() performs.
function branchSale(
  fs: Firestore,
  uid: string,
  opts: { branchId: string; sessionId: string; lines: Line[]; stockBranchId?: string; discount?: number; mutate?: (cells: Record<string, { qty: number }>) => void }
) {
  const stockBranch = opts.stockBranchId ?? opts.branchId;
  const productIds = [...new Set(opts.lines.map((l) => l.productId))];
  return runTransaction(fs, async (tx) => {
    const sessionRef = doc(fs, "registerSessions", opts.sessionId);
    const sessionSnap = await tx.get(sessionRef);
    const stockSnaps = await Promise.all(productIds.map((pid) => tx.get(doc(fs, "branchStock", `${stockBranch}__${pid}`))));
    tx.set(doc(fs, "checkoutClaims", uid), { lines: opts.lines });
    productIds.forEach((pid, i) => {
      const cells = { ...(stockSnaps[i].data()!.stockByCell as Record<string, { qty: number }>) };
      for (const l of opts.lines.filter((x) => x.productId === pid)) {
        const key = `${l.variantId}::${l.size}`;
        cells[key] = { qty: cells[key].qty - l.qty };
      }
      opts.mutate?.(cells);
      tx.update(doc(fs, "branchStock", `${stockBranch}__${pid}`), { stockByCell: cells, updatedAt: new Date() });
    });
    const subtotal = opts.lines.reduce((s, l) => s + l.qty * l.price, 0);
    const discount = opts.discount ?? 0;
    tx.set(doc(collection(fs, "orders")), {
      orderNumber: "SIS-BR-TEST",
      customerName: "Walk-in customer",
      customerEmail: "",
      lines: opts.lines.map((l) => ({ ...l, name: l.productId, color: l.variantId })),
      subtotal,
      discount,
      shipping: 0,
      total: subtotal - discount,
      status: "completed",
      source: "pos",
      paymentMethod: "cash",
      cashAmount: subtotal - discount,
      cardAmount: 0,
      registerSessionId: opts.sessionId,
      branchId: opts.branchId,
      cashierUid: uid,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const s = sessionSnap.data() as { salesCount: number; cashTotal: number; grossTotal: number };
    tx.update(sessionRef, { salesCount: s.salesCount + 1, cashTotal: s.cashTotal + subtotal, grossTotal: s.grossTotal + subtotal, updatedAt: new Date() });
  });
}

describe("multi-branch POS: registers and sessions", () => {
  beforeEach(async () => {
    await clearFirestore();
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  it("lets a cashier open a session on a free register of their branch (taking its lock), and blocks a second one", async () => {
    await seedBranchSetup({ uid: "c1", withSession: false });
    await seedBranchSetup({ uid: "c2", withSession: false, registerId: "b1-r1" });
    const env = await getTestEnv();
    const fs1 = env.authenticatedContext("c1", IDENTIFIED).firestore();
    const b1 = writeBatch(fs1);
    b1.set(doc(fs1, "registerSessions/s1"), { cashierId: "c1", cashierName: "c1", branchId: "b1", registerId: "b1-r1", status: "open", startingCash: 0, salesCount: 0, cashTotal: 0, cardTotal: 0, discountTotal: 0, grossTotal: 0 });
    b1.update(doc(fs1, "registers/b1-r1"), { openSessionId: "s1" });
    await assertSucceeds(b1.commit());

    // Same register, second cashier: the lock is taken.
    const fs2 = env.authenticatedContext("c2", IDENTIFIED).firestore();
    const b2 = writeBatch(fs2);
    b2.set(doc(fs2, "registerSessions/s2"), { cashierId: "c2", cashierName: "c2", branchId: "b1", registerId: "b1-r1", status: "open", startingCash: 0, salesCount: 0, cashTotal: 0, cardTotal: 0, discountTotal: 0, grossTotal: 0 });
    b2.update(doc(fs2, "registers/b1-r1"), { openSessionId: "s2" });
    await assertFails(b2.commit());
  });

  it("denies a cashier opening a register at a branch they aren't assigned to", async () => {
    await seedBranchSetup({ uid: "c1", withSession: false });
    await seedBranchSetup({ uid: "other", branchId: "b2", withSession: false });
    const env = await getTestEnv();
    const fs = env.authenticatedContext("c1", IDENTIFIED).firestore();
    const b = writeBatch(fs);
    b.set(doc(fs, "registerSessions/s1"), { cashierId: "c1", cashierName: "c1", branchId: "b2", registerId: "b2-r1", status: "open", startingCash: 0, salesCount: 0, cashTotal: 0, cardTotal: 0, discountTotal: 0, grossTotal: 0 });
    b.update(doc(fs, "registers/b2-r1"), { openSessionId: "s1" });
    await assertFails(b.commit());
  });

  it("lets the session's cashier close it and release the register, but not someone else", async () => {
    await seedBranchSetup({ uid: "c1", sessionId: "s1" });
    await seedStaff("c2", "cashier", ["b1"]);
    const env = await getTestEnv();
    const fs2 = env.authenticatedContext("c2", IDENTIFIED).firestore();
    await assertFails(updateDoc(doc(fs2, "registers/b1-r1"), { openSessionId: null }));

    const fs1 = env.authenticatedContext("c1", IDENTIFIED).firestore();
    const b = writeBatch(fs1);
    b.update(doc(fs1, "registerSessions/s1"), { status: "closed", countedCash: 0, expectedCash: 0, variance: 0, closedByUid: "c1" });
    b.update(doc(fs1, "registers/b1-r1"), { openSessionId: null });
    await assertSucceeds(b.commit());
  });

  it("freezes a session's branch and register once opened", async () => {
    await seedBranchSetup({ uid: "c1", sessionId: "s1", extraBranchIds: ["b2"] });
    const env = await getTestEnv();
    const fs = env.authenticatedContext("c1", IDENTIFIED).firestore();
    await assertFails(updateDoc(doc(fs, "registerSessions/s1"), { branchId: "b2" }));
    await assertFails(updateDoc(doc(fs, "registerSessions/s1"), { registerId: "x" }));
  });

  it("keeps branches/registers admin-managed: cashier can read but not create or rename", async () => {
    await seedBranchSetup({ uid: "c1" });
    await seedStaff("a1", "admin");
    const env = await getTestEnv();
    const cashier = env.authenticatedContext("c1", IDENTIFIED).firestore();
    await assertSucceeds(getDoc(doc(cashier, "branches/b1")));
    await assertFails(setDoc(doc(cashier, "branches/b9"), { name: "x", code: "X", active: true }));
    await assertFails(updateDoc(doc(cashier, "registers/b1-r1"), { name: "renamed" }));
    const admin = env.authenticatedContext("a1", IDENTIFIED).firestore();
    await assertSucceeds(setDoc(doc(admin, "branches/b9"), { name: "x", code: "X", active: true }));
    await assertSucceeds(setDoc(doc(admin, "registers/b9-r1"), { branchId: "b9", name: "Till", active: true, openSessionId: null }));
  });
});

describe("multi-branch POS: selling from branch stock", () => {
  beforeEach(async () => {
    await clearFirestore();
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  it("lets a cashier sell from their branch's stock (multi-product)", async () => {
    await seedBranchSetup({ uid: "c1", sessionId: "s1" });
    await seedProduct("p1");
    await seedProduct("p2");
    await seedBranchStock("b1", "p1", { "black::S": { qty: 5 }, "black::M": { qty: 2 } });
    await seedBranchStock("b1", "p2", { "one::OS": { qty: 1 } });
    const env = await getTestEnv();
    const fs = env.authenticatedContext("c1", IDENTIFIED).firestore();
    await assertSucceeds(
      branchSale(fs, "c1", {
        branchId: "b1",
        sessionId: "s1",
        lines: [
          { productId: "p1", variantId: "black", size: "S", qty: 2, price: 50 },
          { productId: "p1", variantId: "black", size: "M", qty: 1, price: 50 },
          { productId: "p2", variantId: "one", size: "OS", qty: 1, price: 50 },
        ],
      })
    );
    const after = await getDoc(doc(fs, "branchStock/b1__p1"));
    if (after.data()?.stockByCell["black::S"].qty !== 3) throw new Error("expected black::S 3");
  });

  it("handles the worst case: a full 8-line claim across 8 colors of one 18-color product, in branch stock", async () => {
    await seedBranchSetup({ uid: "c1", sessionId: "s1" });
    await seedProduct("big");
    const cells: Record<string, { qty: number }> = {};
    for (let c = 0; c < 18; c++) for (const size of ["S", "M"]) cells[`v${c}::${size}`] = { qty: 10 };
    for (let c = 18; c < 20; c++) cells[`v${c}::S`] = { qty: 10 };
    await seedBranchStock("b1", "big", cells);
    const env = await getTestEnv();
    const fs = env.authenticatedContext("c1", IDENTIFIED).firestore();
    await assertSucceeds(
      branchSale(fs, "c1", {
        branchId: "b1",
        sessionId: "s1",
        lines: Array.from({ length: 8 }, (_, i) => ({ productId: "big", variantId: `v${i}`, size: "S", qty: 1, price: 50 })),
      })
    );
  });

  it("denies selling another branch's stock, even with a valid claim", async () => {
    await seedBranchSetup({ uid: "c1", sessionId: "s1" });
    await seedBranchSetup({ uid: "c2", branchId: "b2", sessionId: "s2" });
    await seedProduct("p1");
    await seedBranchStock("b2", "p1", { "black::S": { qty: 5 } });
    const env = await getTestEnv();
    const fs = env.authenticatedContext("c1", IDENTIFIED).firestore();
    await assertFails(
      branchSale(fs, "c1", { branchId: "b1", sessionId: "s1", stockBranchId: "b2", lines: [{ productId: "p1", variantId: "black", size: "S", qty: 1, price: 50 }] })
    );
  });

  it("denies decrementing more than claimed, or bumping another cell up", async () => {
    await seedBranchSetup({ uid: "c1", sessionId: "s1" });
    await seedProduct("p1");
    await seedBranchStock("b1", "p1", { "black::S": { qty: 5 }, "black::M": { qty: 5 } });
    const env = await getTestEnv();
    const fs = env.authenticatedContext("c1", IDENTIFIED).firestore();
    const line = { productId: "p1", variantId: "black", size: "S", qty: 1, price: 50 };
    await assertFails(branchSale(fs, "c1", { branchId: "b1", sessionId: "s1", lines: [line], mutate: (c) => (c["black::S"] = { qty: 0 }) }));
    await assertFails(branchSale(fs, "c1", { branchId: "b1", sessionId: "s1", lines: [line], mutate: (c) => (c["black::M"] = { qty: 50 }) }));
  });

  it("denies a cashier a discount but allows an admin one", async () => {
    await seedBranchSetup({ uid: "c1", sessionId: "s1" });
    await seedBranchSetup({ uid: "boss", role: "admin", sessionId: "s9", registerId: "b1-r2" });
    await seedProduct("p1");
    await seedBranchStock("b1", "p1", { "black::S": { qty: 5 } });
    const env = await getTestEnv();
    const line = { productId: "p1", variantId: "black", size: "S", qty: 1, price: 50 };
    const cashierFs = env.authenticatedContext("c1", IDENTIFIED).firestore();
    await assertFails(branchSale(cashierFs, "c1", { branchId: "b1", sessionId: "s1", lines: [line], discount: 5 }));
    const adminFs = env.authenticatedContext("boss", IDENTIFIED).firestore();
    await assertSucceeds(branchSale(adminFs, "boss", { branchId: "b1", sessionId: "s9", lines: [line], discount: 5 }));
  });

  it("lets an editor set branch counts directly, but never a cashier", async () => {
    await seedBranchSetup({ uid: "c1" });
    await seedStaff("ed", "editor");
    await seedBranchStock("b1", "p1", { "black::S": { qty: 5 } });
    const env = await getTestEnv();
    const cashier = env.authenticatedContext("c1", IDENTIFIED).firestore();
    await assertFails(updateDoc(doc(cashier, "branchStock/b1__p1"), { stockByCell: { "black::S": { qty: 50 } } }));
    await assertFails(setDoc(doc(cashier, "branchStock/b1__p2"), { branchId: "b1", productId: "p2", stockByCell: { "x::S": { qty: 5 } } }));
    const editor = env.authenticatedContext("ed", IDENTIFIED).firestore();
    await assertSucceeds(updateDoc(doc(editor, "branchStock/b1__p1"), { stockByCell: { "black::S": { qty: 50 } } }));
    await assertSucceeds(setDoc(doc(editor, "branchStock/b1__p2"), { branchId: "b1", productId: "p2", stockByCell: { "x::S": { qty: 5 } } }));
    // The doc id must match its own branch/product.
    await assertFails(setDoc(doc(editor, "branchStock/b1__p3"), { branchId: "b2", productId: "p3", stockByCell: {} }));
    // Branch/product can't be swapped on an existing doc.
    await assertFails(updateDoc(doc(editor, "branchStock/b1__p1"), { branchId: "b2" }));
  });
});

describe("multi-branch POS: cashier order queries", () => {
  beforeEach(async () => {
    await clearFirestore();
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  async function seedOrders() {
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore();
      const base = { orderNumber: "X", customerName: "x", lines: [], subtotal: 0, shipping: 0, total: 0, status: "completed", createdAt: new Date() };
      await setDoc(doc(fs, "orders/web1"), { ...base, source: "web" });
      await setDoc(doc(fs, "orders/man1"), { ...base, source: "manual" });
      await setDoc(doc(fs, "orders/b1sale"), { ...base, source: "pos", branchId: "b1" });
      await setDoc(doc(fs, "orders/b2sale"), { ...base, source: "pos", branchId: "b2" });
    });
  }

  it("allows the sidebar's two cashier queries and the Today's Sales query", async () => {
    await seedBranchSetup({ uid: "c1" });
    await seedOrders();
    const env = await getTestEnv();
    const fs = env.authenticatedContext("c1", IDENTIFIED).firestore();
    const online = await assertSucceeds(getDocs(query(collection(fs, "orders"), where("source", "in", ["web", "manual"]), orderBy("createdAt", "desc"), limit(50))));
    if (online.size !== 2) throw new Error(`expected 2 online orders, got ${online.size}`);
    const mine = await assertSucceeds(getDocs(query(collection(fs, "orders"), where("branchId", "in", ["b1"]), orderBy("createdAt", "desc"), limit(50))));
    if (mine.size !== 1) throw new Error(`expected 1 branch order, got ${mine.size}`);
    await assertSucceeds(getDocs(query(collection(fs, "orders"), where("branchId", "==", "b1"), where("createdAt", ">=", new Date(0)), orderBy("createdAt", "desc"))));
  });

  it("denies a cashier an unfiltered order list and another branch's sales", async () => {
    await seedBranchSetup({ uid: "c1" });
    await seedOrders();
    const env = await getTestEnv();
    const fs = env.authenticatedContext("c1", IDENTIFIED).firestore();
    await assertFails(getDocs(query(collection(fs, "orders"), orderBy("createdAt", "desc"), limit(50))));
    await assertFails(getDocs(query(collection(fs, "orders"), where("branchId", "==", "b2"))));
    await assertFails(getDoc(doc(fs, "orders/b2sale")));
  });

  it("still gives owner/admin every order", async () => {
    await seedStaff("a1", "admin");
    await seedOrders();
    const env = await getTestEnv();
    const fs = env.authenticatedContext("a1", IDENTIFIED).firestore();
    const all = await assertSucceeds(getDocs(query(collection(fs, "orders"), orderBy("createdAt", "desc"))));
    if (all.size !== 4) throw new Error(`expected 4 orders, got ${all.size}`);
  });
});
