import { assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { collection, deleteDoc, doc, runTransaction, serverTimestamp, setDoc, updateDoc, writeBatch } from "firebase/firestore";
import { afterAll, beforeEach, describe, it } from "vitest";
import { clearFirestore, getTestEnv, teardownTestEnv } from "./setup";
import { seedBranchSetup, seedBranchStock } from "./branchFixtures";

// POS device shifts: the staff member picked at "Start shift" (operatorId)
// must be a real, active person allowed at the branch, is frozen for the
// shift, and is carried onto every sale. Cash withdrawals during a shift
// are immutable and must move the session's cashOutTotal in the same write.

const IDENTIFIED = { firebase: { sign_in_provider: "password" as const } };
const ANON = { firebase: { sign_in_provider: "anonymous" as const } };

async function seedStaff(uid: string, data: Record<string, unknown>) {
  const env = await getTestEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `admins/${uid}`), { email: `${uid}@example.com`, displayName: uid, role: "cashier", active: true, branchIds: ["b1"], ...data });
  });
}

async function patch(path: string, data: Record<string, unknown>) {
  const env = await getTestEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await updateDoc(doc(ctx.firestore(), path), data);
  });
}

function sessionDoc(cashierId: string, extra: Record<string, unknown> = {}) {
  return {
    cashierId,
    cashierName: "Lojain",
    branchId: "b1",
    registerId: "b1-r1",
    startingCash: 500,
    status: "open",
    salesCount: 0,
    cashTotal: 0,
    cardTotal: 0,
    discountTotal: 0,
    grossTotal: 0,
    cashOutTotal: 0,
    ...extra,
  };
}

async function openAsDevice(operatorId: string) {
  const env = await getTestEnv();
  const fs = env.authenticatedContext("device1", ANON).firestore();
  const batch = writeBatch(fs);
  batch.set(doc(fs, "registerSessions/s1"), sessionDoc("device1", { operatorId }));
  batch.update(doc(fs, "registers/b1-r1"), { openSessionId: "s1" });
  return batch.commit();
}

describe("POS device shifts: operator", () => {
  beforeEach(async () => {
    await clearFirestore();
    // The device: a cashier identity pinned to b1 (see posLinks.ts).
    await seedBranchSetup({ uid: "device1", withSession: false });
    await patch("admins/device1", { posLink: "x".repeat(40), email: "" });
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  it("lets a device start a shift for an active cashier of the branch", async () => {
    await seedStaff("lojain", {});
    await assertSucceeds(openAsDevice("lojain"));
  });

  it("rejects an owner, an inactive cashier, a cashier of another branch, or another device as operator", async () => {
    await seedStaff("inactive", { active: false });
    await seedStaff("elsewhere", { branchIds: ["b2"] });
    await seedStaff("device2", { posLink: "y".repeat(40) });
    await seedStaff("owner1", { role: "owner", branchIds: [] });
    await assertFails(openAsDevice("owner1"));
    await assertFails(openAsDevice("inactive"));
    await assertFails(openAsDevice("elsewhere"));
    await assertFails(openAsDevice("device2"));
    await assertFails(openAsDevice("nobody"));
  });

  it("freezes the operator for the rest of the shift", async () => {
    await seedStaff("lojain", {});
    await seedStaff("ahmad", {});
    await openAsDevice("lojain");
    const env = await getTestEnv();
    const fs = env.authenticatedContext("device1", ANON).firestore();
    await assertFails(updateDoc(doc(fs, "registerSessions/s1"), { operatorId: "ahmad" }));
    await assertSucceeds(updateDoc(doc(fs, "registerSessions/s1"), { salesCount: 1 }));
  });

  it("requires every sale on the shift to carry the shift's operator", async () => {
    await seedStaff("lojain", {});
    await seedStaff("ahmad", {});
    await openAsDevice("lojain");
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "products/p1"), {
        name: "Scarf",
        slug: "scarf",
        price: 20,
        status: "active",
        colorVariants: [{ id: "v", colorName: "Only", colorHex: "#111", sizeStock: [{ size: "One Size", qty: 9 }] }],
      });
    });
    await seedBranchStock("b1", "p1", { "v::One Size": { qty: 9 } });
    const fs = env.authenticatedContext("device1", ANON).firestore();

    const sale = (operatorId: string | undefined) =>
      runTransaction(fs, async (tx) => {
        const stockRef = doc(fs, "branchStock/b1__p1");
        const sessionRef = doc(fs, "registerSessions/s1");
        const [stock, session] = await Promise.all([tx.get(stockRef), tx.get(sessionRef)]);
        tx.set(doc(fs, "checkoutClaims/device1"), { lines: [{ productId: "p1", variantId: "v", size: "One Size", qty: 1, price: 20 }] });
        tx.update(stockRef, { stockByCell: { "v::One Size": { qty: stock.data()!.stockByCell["v::One Size"].qty - 1 } }, updatedAt: new Date() });
        tx.set(doc(collection(fs, "orders")), {
          orderNumber: "SIS-T",
          customerName: "Walk-in customer",
          customerEmail: "",
          lines: [{ productId: "p1", variantId: "v", name: "Scarf", qty: 1, price: 20, size: "One Size", color: "Only" }],
          subtotal: 20,
          discount: 0,
          shipping: 0,
          total: 20,
          status: "completed",
          source: "pos",
          paymentMethod: "cash",
          cashAmount: 20,
          cardAmount: 0,
          registerSessionId: "s1",
          branchId: "b1",
          registerId: "b1-r1",
          cashierUid: "device1",
          cashierName: "Lojain",
          ...(operatorId ? { operatorId } : {}),
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        const s = session.data()!;
        tx.update(sessionRef, { salesCount: s.salesCount + 1, cashTotal: s.cashTotal + 20, grossTotal: s.grossTotal + 20, updatedAt: new Date() });
      });

    await assertFails(sale("ahmad"));
    await assertFails(sale(undefined));
    await assertSucceeds(sale("lojain"));
  });
});

describe("POS shifts: cash withdrawals", () => {
  beforeEach(async () => {
    await clearFirestore();
    await seedBranchSetup({ uid: "cashier1", sessionId: "s1" });
    await patch("registerSessions/s1", { startingCash: 500, cashOutTotal: 0 });
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  function withdrawal(amount: number, extra: Record<string, unknown> = {}) {
    return { sessionId: "s1", branchId: "b1", registerId: "b1-r1", type: "withdrawal", amount, reason: "Bank drop", actorUid: "cashier1", actorName: "cashier1", createdAt: serverTimestamp(), ...extra };
  }

  async function withdraw(uid: string, amount: number, newTotal: number, extra: Record<string, unknown> = {}) {
    const env = await getTestEnv();
    const fs = env.authenticatedContext(uid, IDENTIFIED).firestore();
    const batch = writeBatch(fs);
    batch.set(doc(fs, "cashMovements/m1"), withdrawal(amount, extra));
    batch.update(doc(fs, "registerSessions/s1"), { cashOutTotal: newTotal });
    return batch.commit();
  }

  it("lets the shift's cashier record a withdrawal together with the session total", async () => {
    await assertSucceeds(withdraw("cashier1", 50, 50));
  });

  it("rejects a withdrawal that doesn't move cashOutTotal by exactly its amount", async () => {
    await assertFails(withdraw("cashier1", 50, 40));
    const env = await getTestEnv();
    const fs = env.authenticatedContext("cashier1", IDENTIFIED).firestore();
    await assertFails(setDoc(doc(fs, "cashMovements/m2"), withdrawal(50)));
  });

  it("rejects zero/negative amounts, foreign actors and another cashier's shift", async () => {
    await assertFails(withdraw("cashier1", 0, 0));
    await assertFails(withdraw("cashier1", -5, -5));
    await assertFails(withdraw("cashier1", 50, 50, { actorUid: "someoneElse" }));
    await seedStaff("cashier2", {});
    await assertFails(withdraw("cashier2", 50, 50, { actorUid: "cashier2" }));
  });

  it("rejects a withdrawal on a closed shift", async () => {
    await patch("registerSessions/s1", { status: "closed" });
    await assertFails(withdraw("cashier1", 50, 50));
  });

  it("never lets a withdrawal be edited or deleted", async () => {
    await withdraw("cashier1", 50, 50);
    await seedStaff("owner1", { role: "owner" });
    const env = await getTestEnv();
    const fs = env.authenticatedContext("owner1", IDENTIFIED).firestore();
    await assertFails(updateDoc(doc(fs, "cashMovements/m1"), { amount: 1 }));
    await assertFails(deleteDoc(doc(fs, "cashMovements/m1")));
  });
});
