import { assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, setDoc, updateDoc, deleteDoc } from "firebase/firestore";
import { afterAll, beforeEach, describe, it } from "vitest";
import { clearFirestore, getTestEnv, teardownTestEnv } from "./setup";

const IDENTIFIED = { firebase: { sign_in_provider: "password" as const } };
const ANONYMOUS = { firebase: { sign_in_provider: "anonymous" as const } };

async function seedAdmin(uid: string, role: string) {
  const env = await getTestEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `admins/${uid}`), { email: `${uid}@example.com`, displayName: uid, role, active: true });
  });
}

function validLowStock(overrides: Record<string, unknown> = {}) {
  return {
    kind: "low_stock",
    title: "Low stock",
    body: "Test Dress (Black, S) has 2 left.",
    link: "/admin/inventory",
    read: false,
    ...overrides,
  };
}

describe("notifications: low-stock create exception", () => {
  beforeEach(async () => {
    await clearFirestore();
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  it("lets an anonymous guest create a well-formed low_stock notification", async () => {
    const env = await getTestEnv();
    const guest = env.authenticatedContext("guest1", ANONYMOUS);
    await assertSucceeds(setDoc(doc(guest.firestore(), "notifications/n1"), validLowStock()));
  });

  it("lets an identified customer create a well-formed low_stock notification", async () => {
    const env = await getTestEnv();
    const alice = env.authenticatedContext("alice", IDENTIFIED);
    await assertSucceeds(setDoc(doc(alice.firestore(), "notifications/n2"), validLowStock()));
  });

  it("lets a cashier create a well-formed low_stock notification (POS path)", async () => {
    await seedAdmin("cashier1", "cashier");
    const env = await getTestEnv();
    const cashier = env.authenticatedContext("cashier1", IDENTIFIED);
    await assertSucceeds(setDoc(doc(cashier.firestore(), "notifications/n3"), validLowStock()));
  });

  it("lets an editor create a well-formed low_stock notification (admin stock-edit path)", async () => {
    await seedAdmin("editor1", "editor");
    const env = await getTestEnv();
    const editor = env.authenticatedContext("editor1", IDENTIFIED);
    await assertSucceeds(setDoc(doc(editor.firestore(), "notifications/n4"), validLowStock()));
  });

  it("rejects a non-low_stock kind from a non-admin", async () => {
    const env = await getTestEnv();
    const guest = env.authenticatedContext("mallory", ANONYMOUS);
    await assertFails(setDoc(doc(guest.firestore(), "notifications/bad1"), validLowStock({ kind: "system" })));
  });

  it("rejects a pre-marked-read low_stock notification from a non-admin", async () => {
    const env = await getTestEnv();
    const guest = env.authenticatedContext("mallory", ANONYMOUS);
    await assertFails(setDoc(doc(guest.firestore(), "notifications/bad2"), validLowStock({ read: true })));
  });

  it("rejects a low_stock notification with an unexpected extra field", async () => {
    const env = await getTestEnv();
    const guest = env.authenticatedContext("mallory", ANONYMOUS);
    await assertFails(setDoc(doc(guest.firestore(), "notifications/bad3"), validLowStock({ recipientId: "someone" })));
  });

  it("rejects a low_stock notification with a non-string title", async () => {
    const env = await getTestEnv();
    const guest = env.authenticatedContext("mallory", ANONYMOUS);
    await assertFails(setDoc(doc(guest.firestore(), "notifications/bad4"), validLowStock({ title: 123 })));
  });

  it("still rejects any write attempt from a fully signed-out context", async () => {
    const env = await getTestEnv();
    const anon = env.unauthenticatedContext();
    await assertFails(setDoc(doc(anon.firestore(), "notifications/bad5"), validLowStock()));
  });

  it("does not let a non-admin update an existing notification, even their own low_stock one", async () => {
    await seedAdmin("owner1", "owner");
    const env = await getTestEnv();
    const owner = env.authenticatedContext("owner1", IDENTIFIED);
    await assertSucceeds(setDoc(doc(owner.firestore(), "notifications/existing1"), validLowStock()));

    const guest = env.authenticatedContext("mallory", ANONYMOUS);
    await assertFails(updateDoc(doc(guest.firestore(), "notifications/existing1"), { read: true }));
  });

  it("does not let a non-admin delete an existing notification", async () => {
    await seedAdmin("owner1", "owner");
    const env = await getTestEnv();
    const owner = env.authenticatedContext("owner1", IDENTIFIED);
    await assertSucceeds(setDoc(doc(owner.firestore(), "notifications/existing2"), validLowStock()));

    const guest = env.authenticatedContext("mallory", ANONYMOUS);
    await assertFails(deleteDoc(doc(guest.firestore(), "notifications/existing2")));
  });

  it("still lets admin/owner mark a notification read (existing behavior unchanged)", async () => {
    await seedAdmin("owner1", "owner");
    const env = await getTestEnv();
    const owner = env.authenticatedContext("owner1", IDENTIFIED);
    await assertSucceeds(setDoc(doc(owner.firestore(), "notifications/existing3"), validLowStock()));
    await assertSucceeds(updateDoc(doc(owner.firestore(), "notifications/existing3"), { read: true }));
  });

  it("still lets admin/owner create an arbitrary (non-low_stock) notification (existing unconditional create unchanged)", async () => {
    await seedAdmin("owner1", "owner");
    const env = await getTestEnv();
    const owner = env.authenticatedContext("owner1", IDENTIFIED);
    await assertSucceeds(
      setDoc(doc(owner.firestore(), "notifications/manual1"), {
        kind: "system",
        title: "Manual note",
        body: "Anything an admin wants",
        read: false,
      })
    );
  });

  it("still rejects a non-admin reading the notifications feed (existing read rule unchanged)", async () => {
    await seedAdmin("owner1", "owner");
    const env = await getTestEnv();
    const owner = env.authenticatedContext("owner1", IDENTIFIED);
    await assertSucceeds(setDoc(doc(owner.firestore(), "notifications/existing4"), validLowStock()));

    const { getDoc } = await import("firebase/firestore");
    const guest = env.authenticatedContext("mallory", ANONYMOUS);
    await assertFails(getDoc(doc(guest.firestore(), "notifications/existing4")));
  });
});
