import { assertFails, assertSucceeds } from "./testing";
import { deleteDoc, doc, getDoc, setDoc, updateDoc, writeBatch } from "../../src/db/firestore";
import { afterAll, beforeEach, describe, it } from "vitest";
import { clearFirestore, getTestEnv, teardownTestEnv } from "./setup";
import { seedBranchSetup } from "./branchFixtures";

const IDENTIFIED = { firebase: { sign_in_provider: "password" as const } };

async function seedAdmin(uid: string, role: string) {
  const env = await getTestEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `admins/${uid}`), {
      email: `${uid}@example.com`,
      displayName: uid,
      role,
      active: true,
    });
  });
}

function openSessionDoc(cashierId: string, overrides: Record<string, unknown> = {}) {
  return {
    cashierId,
    cashierName: "Cashier",
    startingCash: 100,
    status: "open",
    salesCount: 0,
    cashTotal: 0,
    cardTotal: 0,
    discountTotal: 0,
    grossTotal: 0,
    ...overrides,
  };
}

describe("register sessions", () => {
  beforeEach(async () => {
    await clearFirestore();
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  // Multi-branch: a session is opened on a register of the cashier's branch,
  // taking that register's lock in the same write (see openRegister()).
  it("lets a cashier open their own session with zero starting totals", async () => {
    await seedBranchSetup({ uid: "cashier1", withSession: false });
    const env = await getTestEnv();
    const fs = env.authenticatedContext("cashier1", IDENTIFIED).firestore();
    const batch = writeBatch(fs);
    batch.set(doc(fs, "registerSessions/s1"), openSessionDoc("cashier1", { branchId: "b1", registerId: "b1-r1" }));
    batch.update(doc(fs, "registers/b1-r1"), { openSessionId: "s1" });
    await assertSucceeds(batch.commit());
  });

  it("rejects a session with no branch/register, or without taking the register's lock", async () => {
    await seedBranchSetup({ uid: "cashier1", withSession: false });
    const env = await getTestEnv();
    const fs = env.authenticatedContext("cashier1", IDENTIFIED).firestore();
    await assertFails(setDoc(doc(fs, "registerSessions/s1"), openSessionDoc("cashier1")));
    await assertFails(setDoc(doc(fs, "registerSessions/s2"), openSessionDoc("cashier1", { branchId: "b1", registerId: "b1-r1" })));
  });

  it("rejects opening a session with non-zero totals", async () => {
    await seedAdmin("cashier1", "cashier");
    const env = await getTestEnv();
    const cashier = env.authenticatedContext("cashier1", IDENTIFIED);
    await assertFails(setDoc(doc(cashier.firestore(), "registerSessions/s1"), openSessionDoc("cashier1", { salesCount: 3 })));
    await assertFails(setDoc(doc(cashier.firestore(), "registerSessions/s2"), openSessionDoc("cashier1", { cashTotal: 50 })));
  });

  it("rejects a cashier opening a session for someone else", async () => {
    await seedAdmin("cashier1", "cashier");
    const env = await getTestEnv();
    const cashier = env.authenticatedContext("cashier1", IDENTIFIED);
    await assertFails(setDoc(doc(cashier.firestore(), "registerSessions/s1"), openSessionDoc("cashier2")));
  });

  it("rejects a non-cashier admin role from opening a session", async () => {
    await seedAdmin("viewer1", "viewer");
    const env = await getTestEnv();
    const viewer = env.authenticatedContext("viewer1", IDENTIFIED);
    await assertFails(setDoc(doc(viewer.firestore(), "registerSessions/s1"), openSessionDoc("viewer1")));
  });

  it("lets a cashier update their own open session", async () => {
    await seedAdmin("cashier1", "cashier");
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "registerSessions/s1"), openSessionDoc("cashier1"));
    });
    const cashier = env.authenticatedContext("cashier1", IDENTIFIED);
    await assertSucceeds(updateDoc(doc(cashier.firestore(), "registerSessions/s1"), { salesCount: 1, cashTotal: 42 }));
  });

  it("rejects a cashier updating someone else's session", async () => {
    await seedAdmin("cashier1", "cashier");
    await seedAdmin("cashier2", "cashier");
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "registerSessions/s1"), openSessionDoc("cashier1"));
    });
    const cashier2 = env.authenticatedContext("cashier2", IDENTIFIED);
    await assertFails(updateDoc(doc(cashier2.firestore(), "registerSessions/s1"), { salesCount: 1 }));
  });

  it("lets an admin force-update or delete any session (stuck-session backstop)", async () => {
    await seedAdmin("cashier1", "cashier");
    await seedAdmin("owner1", "owner");
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "registerSessions/s1"), openSessionDoc("cashier1"));
    });
    const owner = env.authenticatedContext("owner1", IDENTIFIED);
    await assertSucceeds(updateDoc(doc(owner.firestore(), "registerSessions/s1"), { status: "closed" }));
    await assertSucceeds(deleteDoc(doc(owner.firestore(), "registerSessions/s1")));
  });

  it("rejects a cashier deleting a session (owner/admin only)", async () => {
    await seedAdmin("cashier1", "cashier");
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "registerSessions/s1"), openSessionDoc("cashier1"));
    });
    const cashier = env.authenticatedContext("cashier1", IDENTIFIED);
    await assertFails(deleteDoc(doc(cashier.firestore(), "registerSessions/s1")));
  });

  it("blocks a non-admin, non-cashier from reading sessions", async () => {
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "registerSessions/s1"), openSessionDoc("cashier1"));
    });
    const rando = env.authenticatedContext("rando1", IDENTIFIED);
    await assertFails(getDoc(doc(rando.firestore(), "registerSessions/s1")));
  });
});
