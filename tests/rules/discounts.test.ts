import { assertFails, assertSucceeds } from "./testing";
import { doc, getDoc, setDoc, updateDoc } from "../../src/db/firestore";
import { afterAll, beforeEach, describe, it } from "vitest";
import { clearFirestore, getTestEnv, teardownTestEnv } from "./setup";

const ANONYMOUS = { firebase: { sign_in_provider: "anonymous" as const } };
const IDENTIFIED = { firebase: { sign_in_provider: "password" as const } };

async function seedDiscount(id: string, data: Record<string, unknown>) {
  const env = await getTestEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `discounts/${id}`), {
      code: "SUMMER20", type: "percent", value: 20, active: true, usageCount: 0, ...data,
    });
  });
}

describe("discounts: customer read + usage increment", () => {
  beforeEach(async () => {
    await clearFirestore();
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  it("lets a guest read an active discount code", async () => {
    await seedDiscount("d1", { active: true });
    const env = await getTestEnv();
    const guest = env.authenticatedContext("guest1", ANONYMOUS);
    await assertSucceeds(getDoc(doc(guest.firestore(), "discounts/d1")));
  });

  it("rejects a guest reading an inactive discount code", async () => {
    await seedDiscount("d1", { active: false });
    const env = await getTestEnv();
    const guest = env.authenticatedContext("guest1", ANONYMOUS);
    await assertFails(getDoc(doc(guest.firestore(), "discounts/d1")));
  });

  it("lets a signed-in customer increment usageCount by exactly 1 on an active code", async () => {
    await seedDiscount("d1", { active: true, usageCount: 3 });
    const env = await getTestEnv();
    const alice = env.authenticatedContext("alice", IDENTIFIED);
    await assertSucceeds(updateDoc(doc(alice.firestore(), "discounts/d1"), { usageCount: 4 }));
  });

  it("rejects incrementing usageCount by more than 1", async () => {
    await seedDiscount("d1", { active: true, usageCount: 3 });
    const env = await getTestEnv();
    const alice = env.authenticatedContext("alice", IDENTIFIED);
    await assertFails(updateDoc(doc(alice.firestore(), "discounts/d1"), { usageCount: 10 }));
  });

  it("rejects a customer decrementing usageCount", async () => {
    await seedDiscount("d1", { active: true, usageCount: 3 });
    const env = await getTestEnv();
    const alice = env.authenticatedContext("alice", IDENTIFIED);
    await assertFails(updateDoc(doc(alice.firestore(), "discounts/d1"), { usageCount: 2 }));
  });

  it("rejects a customer touching any other field via the increment path", async () => {
    await seedDiscount("d1", { active: true, usageCount: 3, value: 20 });
    const env = await getTestEnv();
    const alice = env.authenticatedContext("alice", IDENTIFIED);
    await assertFails(updateDoc(doc(alice.firestore(), "discounts/d1"), { usageCount: 4, value: 100 }));
  });

  it("rejects a customer reactivating an inactive code via the increment path", async () => {
    await seedDiscount("d1", { active: false, usageCount: 3 });
    const env = await getTestEnv();
    const alice = env.authenticatedContext("alice", IDENTIFIED);
    await assertFails(updateDoc(doc(alice.firestore(), "discounts/d1"), { usageCount: 4 }));
  });

  it("still lets an editor freely edit a discount (value, active, etc.)", async () => {
    await seedDiscount("d1", { active: true, usageCount: 3, value: 20 });
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "admins/editor1"), { email: "e@example.com", role: "editor", active: true });
    });
    const editor = env.authenticatedContext("editor1", IDENTIFIED);
    await assertSucceeds(updateDoc(doc(editor.firestore(), "discounts/d1"), { value: 30, active: false }));
  });
});
