import { assertFails, assertSucceeds } from "./testing";
import { collection, doc, getDoc, getDocs, limit, orderBy, query, runTransaction, serverTimestamp, setDoc, Timestamp, updateDoc, where, writeBatch } from "../../src/db/firestore";
import type { Firestore } from "../../src/db/firestore";
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
  opts: {
    branchId: string;
    sessionId: string;
    lines: Line[];
    stockBranchId?: string;
    discount?: number;
    // Defaults to "manual" whenever there is a discount (what placeOrder writes).
    discountSource?: string | null;
    // Overrides the order's subtotal (to try to inflate the discount base).
    subtotal?: number;
    // Extra order fields (promotions) and per-line fields (promoDiscount...).
    orderExtra?: Record<string, unknown>;
    lineExtra?: (l: Line) => Record<string, unknown>;
    mutate?: (cells: Record<string, { qty: number }>) => void;
    // Extra claim fields (offline: true for a sale replayed from a till).
    claimExtra?: Record<string, unknown>;
  }
) {
  const stockBranch = opts.stockBranchId ?? opts.branchId;
  const productIds = [...new Set(opts.lines.map((l) => l.productId))];
  return runTransaction(fs, async (tx) => {
    const sessionRef = doc(fs, "registerSessions", opts.sessionId);
    const sessionSnap = await tx.get(sessionRef);
    const stockSnaps = await Promise.all(productIds.map((pid) => tx.get(doc(fs, "branchStock", `${stockBranch}__${pid}`))));
    tx.set(doc(fs, "checkoutClaims", uid), { lines: opts.lines, ...(opts.claimExtra ?? {}) });
    productIds.forEach((pid, i) => {
      const cells = { ...(stockSnaps[i].data()!.stockByCell as Record<string, { qty: number }>) };
      for (const l of opts.lines.filter((x) => x.productId === pid)) {
        const key = `${l.variantId}::${l.size}`;
        cells[key] = { qty: cells[key].qty - l.qty };
      }
      opts.mutate?.(cells);
      tx.update(doc(fs, "branchStock", `${stockBranch}__${pid}`), { stockByCell: cells, updatedAt: new Date() });
    });
    const subtotal = opts.subtotal ?? opts.lines.reduce((s, l) => s + l.qty * l.price, 0);
    const discount = opts.discount ?? 0;
    const source = opts.discountSource === undefined ? (discount > 0 ? "manual" : null) : opts.discountSource;
    tx.set(doc(collection(fs, "orders")), {
      orderNumber: "SIS-BR-TEST",
      customerName: "Walk-in customer",
      customerEmail: "",
      lines: opts.lines.map((l) => ({ ...l, name: l.productId, color: l.variantId, ...(opts.lineExtra?.(l) ?? {}) })),
      subtotal,
      discount,
      ...(source ? { discountSource: source } : {}),
      ...(opts.orderExtra ?? {}),
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

  it("lets a cashier give a manual discount only up to the configured limit; an admin isn't limited", async () => {
    await seedBranchSetup({ uid: "c1", sessionId: "s1" });
    await seedBranchSetup({ uid: "boss", role: "admin", sessionId: "s9", registerId: "b1-r2" });
    await seedProduct("p1");
    await seedBranchStock("b1", "p1", { "black::S": { qty: 50 } });
    const env = await getTestEnv();
    const line = { productId: "p1", variantId: "black", size: "S", qty: 1, price: 50 };
    const cashierFs = env.authenticatedContext("c1", IDENTIFIED).firestore();
    const sale = (o: { discount: number; discountSource?: string | null; subtotal?: number }) => branchSale(cashierFs, "c1", { branchId: "b1", sessionId: "s1", lines: [line], ...o });
    // Default limit: 10% of the sale.
    await assertSucceeds(sale({ discount: 5 }));
    await assertFails(sale({ discount: 5.01 }));
    // Must be marked as a manual discount.
    await assertFails(sale({ discount: 5, discountSource: null }));
    // Inflating the subtotal to widen the 10% doesn't work: the claim's real prices count.
    await assertFails(sale({ discount: 10, subtotal: 100 }));
    // The admin-set limit applies (20% here), and 0 switches cashier discounts off.
    await env.withSecurityRulesDisabled(async (ctx) => setDoc(doc(ctx.firestore(), "settings/posDiscounts"), { cashierMaxPercent: 20 }));
    await assertSucceeds(sale({ discount: 10 }));
    await assertFails(sale({ discount: 10.5 }));
    await env.withSecurityRulesDisabled(async (ctx) => setDoc(doc(ctx.firestore(), "settings/posDiscounts"), { cashierMaxPercent: 0 }));
    await assertFails(sale({ discount: 1 }));
    await assertSucceeds(sale({ discount: 0 }));
    // Owner/admin: no limit.
    const adminFs = env.authenticatedContext("boss", IDENTIFIED).firestore();
    await assertSucceeds(branchSale(adminFs, "boss", { branchId: "b1", sessionId: "s9", lines: [line], discount: 40 }));
  });

  it("accepts a cashier sale only with the promotion amounts the server works out itself", async () => {
    await seedBranchSetup({ uid: "c1", sessionId: "s1" });
    await seedBranchSetup({ uid: "c9", branchId: "b2", sessionId: "s2" });
    await seedProduct("p1", 100);
    await seedBranchStock("b1", "p1", { "black::S": { qty: 50 } });
    await seedBranchStock("b2", "p1", { "black::S": { qty: 50 } });
    const env = await getTestEnv();
    const day = 86400000;
    await env.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore();
      const base = { active: true, type: "percent", scope: "products", value: 20, productIds: ["p1"], branchIds: ["b1"] };
      await setDoc(doc(fs, "promotions/live"), { name: "20% dresses", ...base });
      await setDoc(doc(fs, "promotions/ended"), { name: "Old", ...base, endsAt: Timestamp.fromMillis(Date.now() - day) });
    });
    const line = { productId: "p1", variantId: "black", size: "S", qty: 2, price: 100 };
    const fs = env.authenticatedContext("c1", IDENTIFIED).firestore();
    const promoSale = (id: string, amount: number, extra: Record<string, unknown> = {}) =>
      branchSale(fs, "c1", {
        branchId: "b1",
        sessionId: "s1",
        lines: [line],
        discount: amount,
        discountSource: "promotion",
        orderExtra: { promoDiscount: amount, promotions: [{ id, name: "x", amount }], ...extra },
        lineExtra: () => ({ promoDiscount: amount, promotionId: id }),
      });
    await assertSucceeds(promoSale("live", 40));
    await assertFails(promoSale("live", 60)); // more than 20% of the real prices
    await assertFails(promoSale("ended", 40)); // promotion no longer live
    await assertFails(promoSale("missing", 40)); // no such promotion
    // Same promotion, wrong branch.
    const fs9 = env.authenticatedContext("c9", IDENTIFIED).firestore();
    await assertFails(
      branchSale(fs9, "c9", {
        branchId: "b2",
        sessionId: "s2",
        lines: [line],
        discount: 40,
        discountSource: "promotion",
        orderExtra: { promoDiscount: 40, promotions: [{ id: "live", name: "x", amount: 40 }] },
        lineExtra: () => ({ promoDiscount: 40, promotionId: "live" }),
      })
    );
    // Promotion + manual: manual is limited to 10% of what's left (160 -> 16).
    const mixed = (manual: number) =>
      branchSale(fs, "c1", {
        branchId: "b1",
        sessionId: "s1",
        lines: [line],
        discount: 40 + manual,
        discountSource: "mixed",
        orderExtra: { promoDiscount: 40, manualDiscount: manual, promotions: [{ id: "live", name: "x", amount: 40 }] },
        lineExtra: () => ({ promoDiscount: 40, promotionId: "live" }),
      });
    await assertSucceeds(mixed(16));
    await assertFails(mixed(16.5));
  });

  it("lets only owner/admin create or change promotions; tills can read them", async () => {
    await seedBranchSetup({ uid: "c1", sessionId: "s1" });
    await seedStaff("a1", "admin");
    const env = await getTestEnv();
    const promo = { name: "P", active: true, type: "percent", scope: "sale", value: 10 };
    await assertFails(setDoc(doc(env.authenticatedContext("c1", IDENTIFIED).firestore(), "promotions/x"), promo));
    const admin = env.authenticatedContext("a1", IDENTIFIED).firestore();
    await assertSucceeds(setDoc(doc(admin, "promotions/x"), promo));
    await assertFails(setDoc(doc(admin, "promotions/y"), { ...promo, value: 150 })); // > 100%
    await assertFails(setDoc(doc(admin, "promotions/z"), { ...promo, type: "bundle" })); // bundle needs items, not the whole sale
    await assertSucceeds(getDoc(doc(env.authenticatedContext("c1", IDENTIFIED).firestore(), "promotions/x")));
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

  it("denies a cashier an unfiltered order list and a list of another branch's sales", async () => {
    await seedBranchSetup({ uid: "c1" });
    await seedOrders();
    const env = await getTestEnv();
    const fs = env.authenticatedContext("c1", IDENTIFIED).firestore();
    await assertFails(getDocs(query(collection(fs, "orders"), orderBy("createdAt", "desc"), limit(50))));
    await assertFails(getDocs(query(collection(fs, "orders"), where("branchId", "==", "b2"))));
    // By id it opens (a cross-branch return needs it): see pos-returns.test.ts.
    await assertSucceeds(getDoc(doc(fs, "orders/b2sale")));
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

// Feature 5: sales made while a till was offline, sent later.
describe("offline till sales", () => {
  beforeEach(async () => {
    await clearFirestore();
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  const line = { productId: "p1", variantId: "black", size: "S", qty: 3, price: 100 };
  const minutesAgo = (m: number) => Timestamp.fromMillis(Date.now() - m * 60_000);

  it("lets branch stock go below zero only for a sale replayed from offline", async () => {
    await seedBranchSetup({ uid: "c1", sessionId: "s1" });
    await seedProduct("p1", 100);
    await seedBranchStock("b1", "p1", { "black::S": { qty: 1 } });
    const fs = (await getTestEnv()).authenticatedContext("c1", IDENTIFIED).firestore();
    const sale = (offline: boolean) =>
      branchSale(fs, "c1", {
        branchId: "b1",
        sessionId: "s1",
        lines: [line],
        ...(offline ? { claimExtra: { offline: true }, orderExtra: { offline: true, offlineCreatedAt: minutesAgo(30) } } : {}),
      });
    await assertFails(sale(false)); // online: 3 from 1 is refused
    await assertSucceeds(sale(true)); // offline: recorded, stock -2 (flagged for review)
    // An admin marks the shortage reviewed; a cashier can't, nor can it touch other fields.
    await seedStaff("a1", "admin");
    const env = await getTestEnv();
    const id = (await getDocs(query(collection(env.authenticatedContext("a1", IDENTIFIED).firestore(), "orders")))).docs[0].id;
    const review = { shortageReviewedAt: serverTimestamp(), shortageReviewedByName: "A", shortageReviewNote: "counted" };
    await assertFails(updateDoc(doc(fs, "orders", id), review));
    const admin = env.authenticatedContext("a1", IDENTIFIED).firestore();
    await assertFails(updateDoc(doc(admin, "orders", id), { ...review, total: 0 }));
    await assertSucceeds(updateDoc(doc(admin, "orders", id), review));
  });

  it("lets a cashier check whether a sale id was already recorded (missing doc)", async () => {
    await seedBranchSetup({ uid: "c1", sessionId: "s1" });
    const fs = (await getTestEnv()).authenticatedContext("c1", IDENTIFIED).firestore();
    const snap = await assertSucceeds(getDoc(doc(fs, "orders/not-yet-sent")));
    if (snap.exists()) throw new Error("expected missing");
  });

  it("judges promotions at the time the sale was made, at most 7 days back", async () => {
    await seedBranchSetup({ uid: "c1", sessionId: "s1" });
    await seedProduct("p1", 100);
    await seedBranchStock("b1", "p1", { "black::S": { qty: 50 } });
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      // Ended 10 minutes ago: live for a sale made an hour ago offline.
      await setDoc(doc(ctx.firestore(), "promotions/p"), {
        name: "20%",
        active: true,
        type: "percent",
        scope: "products",
        value: 20,
        productIds: ["p1"],
        branchIds: ["b1"],
        endsAt: minutesAgo(10),
      });
    });
    const fs = env.authenticatedContext("c1", IDENTIFIED).firestore();
    const sale = (offline: boolean, at: Timestamp) =>
      branchSale(fs, "c1", {
        branchId: "b1",
        sessionId: "s1",
        lines: [line],
        discount: 60,
        discountSource: "promotion",
        orderExtra: { promoDiscount: 60, promotions: [{ id: "p", name: "20%", amount: 60 }], ...(offline ? { offline: true, offlineCreatedAt: at } : {}) },
        lineExtra: () => ({ promoDiscount: 60, promotionId: "p" }),
        ...(offline ? { claimExtra: { offline: true } } : {}),
      });
    await assertFails(sale(false, minutesAgo(0))); // online now: ended
    await assertFails(sale(true, minutesAgo(5))); // made after it ended
    await assertFails(sale(true, minutesAgo(8 * 24 * 60))); // too old to replay
    await assertFails(sale(true, minutesAgo(-30))); // in the future
    await assertSucceeds(sale(true, minutesAgo(60)));
  });

  it("sync issues: the till reports its own, branch staff and admins read, only admins resolve", async () => {
    await seedBranchSetup({ uid: "c1", sessionId: "s1" });
    await seedBranchSetup({ uid: "c9", branchId: "b2", sessionId: "s9" });
    await seedStaff("a1", "admin");
    const env = await getTestEnv();
    const fs1 = env.authenticatedContext("c1", IDENTIFIED).firestore();
    const issue = { orderNumber: "SIS-1", status: "open", reason: "rejected", message: "x", branchId: "b1", cashierUid: "c1", reportedAt: serverTimestamp(), total: 10 };
    await assertFails(setDoc(doc(fs1, "posSyncIssues/x0"), { ...issue, cashierUid: "c9" })); // not as someone else
    await assertFails(setDoc(doc(fs1, "posSyncIssues/x0"), { ...issue, branchId: "b2" })); // not for another branch
    await assertFails(setDoc(doc(fs1, "posSyncIssues/x0"), { ...issue, status: "resolved" }));
    await assertSucceeds(setDoc(doc(fs1, "posSyncIssues/x1"), issue));
    await assertSucceeds(getDoc(doc(fs1, "posSyncIssues/x1")));
    await assertFails(getDoc(doc(env.authenticatedContext("c9", IDENTIFIED).firestore(), "posSyncIssues/x1")));
    await assertFails(updateDoc(doc(fs1, "posSyncIssues/x1"), { status: "resolved", resolvedByUid: "c1" }));
    const admin = env.authenticatedContext("a1", IDENTIFIED).firestore();
    await assertFails(updateDoc(doc(admin, "posSyncIssues/x1"), { status: "resolved", resolvedByUid: "a1", total: 0 }));
    await assertSucceeds(updateDoc(doc(admin, "posSyncIssues/x1"), { status: "resolved", resolvedByUid: "a1", resolvedByName: "A", resolvedAt: serverTimestamp(), resolution: "re-rung" }));
  });
});
