import { assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, setDoc } from "firebase/firestore";
import { afterAll, beforeEach, describe, it } from "vitest";
import { clearFirestore, getTestEnv, teardownTestEnv } from "./setup";

const IDENTIFIED = { firebase: { sign_in_provider: "password" as const } };
const ANONYMOUS = { firebase: { sign_in_provider: "anonymous" as const } };

function reviewDoc(overrides: Record<string, unknown> = {}) {
  return {
    productId: "prod1",
    productName: "Test Dress",
    author: "Alice",
    rating: 5,
    title: "Love it",
    body: "Great fit and fabric.",
    status: "pending",
    ...overrides,
  };
}

describe("reviews: customer submission", () => {
  beforeEach(async () => {
    await clearFirestore();
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  it("lets an identified customer submit a pending review", async () => {
    const env = await getTestEnv();
    const alice = env.authenticatedContext("alice", IDENTIFIED);
    await assertSucceeds(setDoc(doc(alice.firestore(), "reviews/r1"), reviewDoc()));
  });

  it("rejects an anonymous guest submitting a review", async () => {
    const env = await getTestEnv();
    const guest = env.authenticatedContext("guest1", ANONYMOUS);
    await assertFails(setDoc(doc(guest.firestore(), "reviews/r1"), reviewDoc()));
  });

  it("rejects a customer self-approving their own review", async () => {
    const env = await getTestEnv();
    const alice = env.authenticatedContext("alice", IDENTIFIED);
    await assertFails(setDoc(doc(alice.firestore(), "reviews/r1"), reviewDoc({ status: "approved" })));
  });

  it("rejects a rating outside 1-5", async () => {
    const env = await getTestEnv();
    const alice = env.authenticatedContext("alice", IDENTIFIED);
    await assertFails(setDoc(doc(alice.firestore(), "reviews/r1"), reviewDoc({ rating: 6 })));
  });

  it("rejects an empty body", async () => {
    const env = await getTestEnv();
    const alice = env.authenticatedContext("alice", IDENTIFIED);
    await assertFails(setDoc(doc(alice.firestore(), "reviews/r1"), reviewDoc({ body: "" })));
  });

  it("rejects extra unexpected fields", async () => {
    const env = await getTestEnv();
    const alice = env.authenticatedContext("alice", IDENTIFIED);
    await assertFails(setDoc(doc(alice.firestore(), "reviews/r1"), reviewDoc({ authorId: "alice" })));
  });

  it("rejects a customer updating an existing review", async () => {
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "reviews/r1"), reviewDoc({ status: "approved" }));
    });
    const alice = env.authenticatedContext("alice", IDENTIFIED);
    await assertFails(setDoc(doc(alice.firestore(), "reviews/r1"), reviewDoc({ status: "approved", rating: 1 })));
  });

  it("still lets an editor create/update/delete reviews freely", async () => {
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "admins/editor1"), { email: "e@example.com", role: "editor", active: true });
    });
    const editor = env.authenticatedContext("editor1", IDENTIFIED);
    await assertSucceeds(setDoc(doc(editor.firestore(), "reviews/r1"), reviewDoc({ status: "approved" })));
  });
});
