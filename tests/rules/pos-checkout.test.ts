import { assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, runTransaction, setDoc } from "firebase/firestore";
import { afterAll, beforeEach, describe, it } from "vitest";
import { clearFirestore, getTestEnv, teardownTestEnv } from "./setup";
import { seedBranchSetup, seedBranchStock } from "./branchFixtures";

// Regression coverage for a real production outage: a cashier could never
// complete ANY POS sale (every payment method 403'd). The existing
// checkout.test.ts only exercised a cashier creating a bare order doc with
// no accompanying stock decrement — it never reproduced the actual POS
// transaction shape (checkoutClaims + N product decrements + order create +
// register session update, all in one atomic transaction), which is what
// actually broke. This file locks in the real shape so this class of bug
// can't silently come back.

const IDENTIFIED = { firebase: { sign_in_provider: "password" as const } };

interface SizeStock {
  size: string;
  qty: number;
}
interface ColorVariant {
  id: string;
  colorName: string;
  colorHex: string;
  sizeStock: SizeStock[];
}

const PRODUCT_A = {
  name: "POS Test Dress",
  slug: "pos-test-dress",
  price: 59.99,
  status: "active",
  colorVariants: [
    { id: "white", colorName: "White", colorHex: "#ffffff", sizeStock: [{ size: "S", qty: 5 }, { size: "M", qty: 3 }] },
    { id: "black", colorName: "Black", colorHex: "#000000", sizeStock: [{ size: "S", qty: 2 }, { size: "M", qty: 0 }] },
  ] as ColorVariant[],
};

const PRODUCT_B = {
  name: "POS Test Scarf",
  slug: "pos-test-scarf",
  price: 29.99,
  status: "active",
  colorVariants: [{ id: "default", colorName: "Only", colorHex: "#111111", sizeStock: [{ size: "One Size", qty: 4 }] }] as ColorVariant[],
};

function decrement(variants: ColorVariant[], variantId: string, size: string, qty: number): ColorVariant[] {
  return variants.map((v) =>
    v.id === variantId ? { ...v, sizeStock: v.sizeStock.map((s) => (s.size === size ? { ...s, qty: s.qty - qty } : s)) } : v
  );
}

async function seedAdmin(uid: string, role: string) {
  const env = await getTestEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `admins/${uid}`), { email: `${uid}@example.com`, displayName: uid, role, active: true });
  });
}

async function seedProducts() {
  const env = await getTestEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "products/posA"), PRODUCT_A);
    await setDoc(doc(ctx.firestore(), "products/posB"), PRODUCT_B);
  });
}

describe("POS: full real-shape sale transaction", () => {
  beforeEach(async () => {
    await clearFirestore();
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  // Multi-branch POS: the real sale shape is claim + BRANCH stock decrement
  // (branchStock/{branchId}__{productId}, flat cells) + order carrying the
  // branch + register session update, all in one transaction. The product
  // documents (online stock) are read for prices but never written.
  async function seedBranchStockForProducts() {
    await seedBranchStock("b1", "posA", { "white::S": { qty: 5 }, "white::M": { qty: 3 }, "black::S": { qty: 2 }, "black::M": { qty: 0 } });
    await seedBranchStock("b1", "posB", { "default::One Size": { qty: 4 } });
  }

  function decrementCells(cells: Record<string, { qty: number }>, key: string, qty: number) {
    return { ...cells, [key]: { qty: cells[key].qty - qty } };
  }

  it("lets a cashier complete a real multi-line POS sale (claim + 2 branch-stock decrements + order + register session, one transaction)", async () => {
    await seedBranchSetup({ uid: "cashier1", sessionId: "sess1" });
    await seedProducts();
    await seedBranchStockForProducts();
    const env = await getTestEnv();
    const cashier = env.authenticatedContext("cashier1", IDENTIFIED);
    const fs = cashier.firestore();

    await assertSucceeds(
      runTransaction(fs, async (tx) => {
        const aRef = doc(fs, "products/posA");
        const bRef = doc(fs, "products/posB");
        const aStockRef = doc(fs, "branchStock/b1__posA");
        const bStockRef = doc(fs, "branchStock/b1__posB");
        const sessionRef = doc(fs, "registerSessions/sess1");
        const [aSnap, bSnap, aStock, bStock, sessionSnap] = await Promise.all([tx.get(aRef), tx.get(bRef), tx.get(aStockRef), tx.get(bStockRef), tx.get(sessionRef)]);
        const a = aSnap.data() as typeof PRODUCT_A;
        const b = bSnap.data() as typeof PRODUCT_B;

        tx.set(doc(fs, "checkoutClaims/cashier1"), {
          lines: [
            { productId: "posA", variantId: "white", size: "S", qty: 2, price: a.price },
            { productId: "posB", variantId: "default", size: "One Size", qty: 1, price: b.price },
          ],
        });
        tx.update(aStockRef, { stockByCell: decrementCells(aStock.data()!.stockByCell, "white::S", 2), updatedAt: new Date() });
        tx.update(bStockRef, { stockByCell: decrementCells(bStock.data()!.stockByCell, "default::One Size", 1), updatedAt: new Date() });

        const total = a.price * 2 + b.price;
        tx.set(doc(collection(fs, "orders")), {
          orderNumber: "SIS-POS-TEST",
          customerName: "Walk-in customer",
          customerEmail: "",
          lines: [
            { productId: "posA", variantId: "white", name: a.name, qty: 2, price: a.price, size: "S", color: "White" },
            { productId: "posB", variantId: "default", name: b.name, qty: 1, price: b.price, size: "One Size", color: "Only" },
          ],
          subtotal: total, discount: 0, shipping: 0, total,
          status: "completed", source: "pos", paymentMethod: "split",
          cashAmount: total - 5, cardAmount: 5, registerSessionId: "sess1",
          branchId: "b1", branchName: "Branch b1", registerId: "b1-r1", registerName: "Register 1",
          cashierUid: "cashier1",
          createdAt: new Date(), updatedAt: new Date(),
        });

        const s = sessionSnap.data() as { salesCount?: number; cashTotal?: number; cardTotal?: number; discountTotal?: number; grossTotal?: number };
        tx.update(sessionRef, {
          salesCount: (s.salesCount ?? 0) + 1,
          cashTotal: (s.cashTotal ?? 0) + (total - 5),
          cardTotal: (s.cardTotal ?? 0) + 5,
          discountTotal: s.discountTotal ?? 0,
          grossTotal: (s.grossTotal ?? 0) + total,
          updatedAt: new Date(),
        });
      })
    );

    const afterStock = await getDoc(doc(cashier.firestore(), "branchStock/b1__posA"));
    const whiteS = afterStock.data()?.stockByCell["white::S"];
    if (whiteS?.qty !== 3) throw new Error(`expected b1 posA white/S qty 3, got ${JSON.stringify(whiteS)}`);
    // Online stock on the product itself is untouched by a branch sale.
    const afterA = await getDoc(doc(cashier.firestore(), "products/posA"));
    const onlineWhiteS = (afterA.data()?.colorVariants as ColorVariant[]).find((v) => v.id === "white")?.sizeStock.find((x) => x.size === "S");
    if (onlineWhiteS?.qty !== 5) throw new Error(`expected online posA white/S qty 5, got ${JSON.stringify(onlineWhiteS)}`);
  });

  it("lets a cashier complete a single-item cash sale with no discount", async () => {
    await seedBranchSetup({ uid: "cashier2", sessionId: "sess2" });
    await seedProducts();
    await seedBranchStockForProducts();
    const env = await getTestEnv();
    const cashier = env.authenticatedContext("cashier2", IDENTIFIED);
    const fs = cashier.firestore();

    await assertSucceeds(
      runTransaction(fs, async (tx) => {
        const aRef = doc(fs, "products/posA");
        const stockRef = doc(fs, "branchStock/b1__posA");
        const sessionRef = doc(fs, "registerSessions/sess2");
        const [aSnap, stockSnap, sessionSnap] = await Promise.all([tx.get(aRef), tx.get(stockRef), tx.get(sessionRef)]);
        const a = aSnap.data() as typeof PRODUCT_A;

        tx.set(doc(fs, "checkoutClaims/cashier2"), {
          lines: [{ productId: "posA", variantId: "black", size: "S", qty: 1, price: a.price }],
        });
        tx.update(stockRef, { stockByCell: decrementCells(stockSnap.data()!.stockByCell, "black::S", 1), updatedAt: new Date() });
        tx.set(doc(collection(fs, "orders")), {
          orderNumber: "SIS-POS-TEST-2",
          customerName: "Walk-in customer",
          customerEmail: "",
          lines: [{ productId: "posA", variantId: "black", name: a.name, qty: 1, price: a.price, size: "S", color: "Black" }],
          subtotal: a.price, discount: 0, shipping: 0, total: a.price,
          status: "completed", source: "pos", paymentMethod: "cash",
          cashAmount: a.price, cardAmount: 0, registerSessionId: "sess2", branchId: "b1",
          createdAt: new Date(), updatedAt: new Date(),
        });
        const s = sessionSnap.data() as { salesCount?: number; cashTotal?: number; grossTotal?: number };
        tx.update(sessionRef, {
          salesCount: (s.salesCount ?? 0) + 1,
          cashTotal: (s.cashTotal ?? 0) + a.price,
          cardTotal: 0,
          discountTotal: 0,
          grossTotal: (s.grossTotal ?? 0) + a.price,
          updatedAt: new Date(),
        });
      })
    );
  });

  it("rejects a cashier's sale with a discount (owner/admin only)", async () => {
    await seedBranchSetup({ uid: "cashier5", sessionId: "sess5" });
    await seedProducts();
    await seedBranchStockForProducts();
    const env = await getTestEnv();
    const fs = env.authenticatedContext("cashier5", IDENTIFIED).firestore();
    await assertFails(
      runTransaction(fs, async (tx) => {
        const stockRef = doc(fs, "branchStock/b1__posA");
        const stockSnap = await tx.get(stockRef);
        tx.set(doc(fs, "checkoutClaims/cashier5"), { lines: [{ productId: "posA", variantId: "white", size: "S", qty: 1, price: 59.99 }] });
        tx.update(stockRef, { stockByCell: decrementCells(stockSnap.data()!.stockByCell, "white::S", 1), updatedAt: new Date() });
        tx.set(doc(collection(fs, "orders")), {
          orderNumber: "SIS-POS-DISC",
          customerName: "Walk-in customer",
          customerEmail: "",
          lines: [{ productId: "posA", variantId: "white", name: "x", qty: 1, price: 59.99, size: "S", color: "White" }],
          subtotal: 59.99, discount: 9.99, shipping: 0, total: 50,
          status: "completed", source: "pos", paymentMethod: "cash",
          cashAmount: 50, cardAmount: 0, registerSessionId: "sess5", branchId: "b1",
          createdAt: new Date(), updatedAt: new Date(),
        });
      })
    );
  });

  it("still rejects a non-cashier signed-in user from riding the checkoutClaims bypass to vandalize stock", async () => {
    await seedProducts();
    const env = await getTestEnv();
    const mallory = env.authenticatedContext("mallory", IDENTIFIED);
    const fs = mallory.firestore();
    await assertFails(
      runTransaction(fs, async (tx) => {
        const aRef = doc(fs, "products/posA");
        const snap = await tx.get(aRef);
        const a = snap.data() as typeof PRODUCT_A;
        tx.set(doc(fs, "checkoutClaims/mallory"), {
          lines: [{ productId: "posA", variantId: "white", size: "S", qty: 100, price: 0.01 }],
        });
        tx.update(aRef, { colorVariants: decrement(a.colorVariants, "white", "S", 100), updatedAt: new Date() });
      })
    );
  });

  it("still rejects a cashier writing a checkoutClaims doc for someone else's uid", async () => {
    await seedAdmin("cashier3", "cashier");
    const env = await getTestEnv();
    const cashier = env.authenticatedContext("cashier3", IDENTIFIED);
    await assertFails(
      setDoc(doc(cashier.firestore(), "checkoutClaims/someone-else"), { lines: [{ productId: "posA", variantId: "white", size: "S", qty: 1, price: 59.99 }] })
    );
  });
});
