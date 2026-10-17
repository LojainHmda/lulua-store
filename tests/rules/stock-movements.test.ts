import { assertFails, assertSucceeds } from "./testing";
import { deleteDoc, doc, getDoc, setDoc, updateDoc } from "../../src/db/firestore";
import { afterAll, beforeEach, describe, it } from "vitest";
import { clearFirestore, getTestEnv, teardownTestEnv } from "./setup";

const IDENTIFIED = { firebase: { sign_in_provider: "password" as const } };
const ANONYMOUS = { firebase: { sign_in_provider: "anonymous" as const } };

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

// This test harness's SDK (unlike the app's own initializeFirestore with
// ignoreUndefinedProperties) rejects an explicit `undefined` field value
// outright rather than omitting the key — matching checkout.test.ts's own
// baseOrder() precedent, so a builder override of `undefined` genuinely
// OMITS the key (a real missing-field test) instead of throwing a client-
// side type error before the write ever reaches the rules evaluator.
function stripUndefined<T extends Record<string, unknown>>(obj: T): T {
  const copy = { ...obj };
  for (const key of Object.keys(copy)) {
    if (copy[key] === undefined) delete copy[key];
  }
  return copy;
}

// An admin/editor-initiated movement (Inventory, Product Form, admin order
// edit, return resolution) — trusted unconditionally via isEditorOrAbove(),
// same as products/{id} itself, so shape is deliberately unchecked by the
// rule for this branch.
function adminMovementDoc(overrides: Record<string, unknown> = {}) {
  return stripUndefined({
    productId: "prod1",
    productName: "Test Dress",
    variantId: "black",
    colorName: "Black",
    size: "M",
    qtyBefore: 10,
    qtyChange: -2,
    qtyAfter: 8,
    reason: "manual_adjustment",
    source: "admin",
    actorEmail: "admin1@example.com",
    actorName: "admin1",
    ...overrides,
  });
}

// A checkout-shaped sale movement — written by the purchasing customer's
// (or cashier's) own client, validated structurally via
// isPlausibleSaleMovement() since no admin role applies.
function saleMovementDoc(overrides: Record<string, unknown> = {}) {
  return stripUndefined({
    productId: "prod1",
    productName: "Test Dress",
    variantId: "black",
    colorName: "Black",
    size: "M",
    qtyBefore: 10,
    qtyChange: -1,
    qtyAfter: 9,
    reason: "sale",
    source: "web",
    orderId: "order1",
    orderNumber: "SIS-TEST1",
    ...overrides,
  });
}

describe("stockMovements", () => {
  beforeEach(async () => {
    await clearFirestore();
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  it("lets an editor/admin/owner create an admin-shaped movement", async () => {
    await seedAdmin("editor1", "editor");
    await seedAdmin("admin1", "admin");
    await seedAdmin("owner1", "owner");
    const env = await getTestEnv();
    const editor = env.authenticatedContext("editor1", IDENTIFIED);
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    const owner = env.authenticatedContext("owner1", IDENTIFIED);
    await assertSucceeds(setDoc(doc(editor.firestore(), "stockMovements/m1"), adminMovementDoc()));
    await assertSucceeds(setDoc(doc(admin.firestore(), "stockMovements/m2"), adminMovementDoc()));
    await assertSucceeds(setDoc(doc(owner.firestore(), "stockMovements/m3"), adminMovementDoc()));
  });

  it("lets a signed-in non-admin (a real checkout customer) create a valid sale-shaped movement", async () => {
    const env = await getTestEnv();
    const customer = env.authenticatedContext("customer1", IDENTIFIED);
    await assertSucceeds(setDoc(doc(customer.firestore(), "stockMovements/m1"), saleMovementDoc()));
  });

  it("lets an anonymous guest checkout create a valid sale-shaped movement (source: web)", async () => {
    const env = await getTestEnv();
    const guest = env.authenticatedContext("guest1", ANONYMOUS);
    await assertSucceeds(setDoc(doc(guest.firestore(), "stockMovements/m1"), saleMovementDoc()));
  });

  it("lets a cashier create a valid sale-shaped movement (source: pos)", async () => {
    await seedAdmin("cashier1", "cashier");
    const env = await getTestEnv();
    const cashier = env.authenticatedContext("cashier1", IDENTIFIED);
    await assertSucceeds(setDoc(doc(cashier.firestore(), "stockMovements/m1"), saleMovementDoc({ source: "pos" })));
  });

  it("rejects a signed-out (fully unauthenticated) client from creating any movement", async () => {
    const env = await getTestEnv();
    const anon = env.unauthenticatedContext();
    await assertFails(setDoc(doc(anon.firestore(), "stockMovements/m1"), saleMovementDoc()));
    await assertFails(setDoc(doc(anon.firestore(), "stockMovements/m2"), adminMovementDoc()));
  });

  it("rejects a viewer (below editor, not a valid sale shape) from creating an admin-shaped movement", async () => {
    await seedAdmin("viewer1", "viewer");
    const env = await getTestEnv();
    const viewer = env.authenticatedContext("viewer1", IDENTIFIED);
    await assertFails(setDoc(doc(viewer.firestore(), "stockMovements/m1"), adminMovementDoc()));
  });

  it("rejects malformed sale-shaped movements from a non-admin (missing/wrong-typed required fields)", async () => {
    const env = await getTestEnv();
    const customer = env.authenticatedContext("customer1", IDENTIFIED);
    const fs = customer.firestore();
    await assertFails(setDoc(doc(fs, "stockMovements/missingProductId"), saleMovementDoc({ productId: undefined })));
    await assertFails(setDoc(doc(fs, "stockMovements/emptyProductId"), saleMovementDoc({ productId: "" })));
    await assertFails(setDoc(doc(fs, "stockMovements/missingVariantId"), saleMovementDoc({ variantId: undefined })));
    await assertFails(setDoc(doc(fs, "stockMovements/missingSize"), saleMovementDoc({ size: undefined })));
    await assertFails(setDoc(doc(fs, "stockMovements/stringQtyBefore"), saleMovementDoc({ qtyBefore: "10" })));
    await assertFails(setDoc(doc(fs, "stockMovements/stringQtyAfter"), saleMovementDoc({ qtyAfter: "9" })));
    await assertFails(setDoc(doc(fs, "stockMovements/badSource"), saleMovementDoc({ source: "admin" })));
    await assertFails(setDoc(doc(fs, "stockMovements/badReason"), saleMovementDoc({ reason: "manual_adjustment" })));
  });

  it("rejects an invalid sale direction/sign from a non-admin (a decrement must be a negative int)", async () => {
    const env = await getTestEnv();
    const customer = env.authenticatedContext("customer1", IDENTIFIED);
    const fs = customer.firestore();
    await assertFails(setDoc(doc(fs, "stockMovements/zero"), saleMovementDoc({ qtyChange: 0 })));
    await assertFails(setDoc(doc(fs, "stockMovements/positive"), saleMovementDoc({ qtyChange: 1 })));
    await assertFails(setDoc(doc(fs, "stockMovements/float"), saleMovementDoc({ qtyChange: -1.5 })));
  });

  it("rejects update for every role, including owner", async () => {
    await seedAdmin("owner1", "owner");
    await seedAdmin("admin1", "admin");
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "stockMovements/m1"), adminMovementDoc());
      await setDoc(doc(ctx.firestore(), "stockMovements/m2"), adminMovementDoc());
    });
    const owner = env.authenticatedContext("owner1", IDENTIFIED);
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await assertFails(updateDoc(doc(owner.firestore(), "stockMovements/m1"), { qtyAfter: 999 }));
    await assertFails(updateDoc(doc(admin.firestore(), "stockMovements/m2"), { reason: "sale" }));
  });

  it("rejects delete for every role, including owner", async () => {
    await seedAdmin("owner1", "owner");
    await seedAdmin("admin1", "admin");
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "stockMovements/m1"), adminMovementDoc());
      await setDoc(doc(ctx.firestore(), "stockMovements/m2"), adminMovementDoc());
    });
    const owner = env.authenticatedContext("owner1", IDENTIFIED);
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await assertFails(deleteDoc(doc(owner.firestore(), "stockMovements/m1")));
    await assertFails(deleteDoc(doc(admin.firestore(), "stockMovements/m2")));
  });

  it("lets every admin role (owner/admin/editor/viewer/cashier) read movements", async () => {
    await seedAdmin("owner1", "owner");
    await seedAdmin("admin1", "admin");
    await seedAdmin("editor1", "editor");
    await seedAdmin("viewer1", "viewer");
    await seedAdmin("cashier1", "cashier");
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "stockMovements/m1"), adminMovementDoc());
    });
    for (const uid of ["owner1", "admin1", "editor1", "viewer1", "cashier1"]) {
      const ctx = env.authenticatedContext(uid, IDENTIFIED);
      await assertSucceeds(getDoc(doc(ctx.firestore(), "stockMovements/m1")));
    }
  });

  it("rejects a signed-in customer and an anonymous visitor from reading movements", async () => {
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "stockMovements/m1"), adminMovementDoc());
    });
    const customer = env.authenticatedContext("customer1", IDENTIFIED);
    await assertFails(getDoc(doc(customer.firestore(), "stockMovements/m1")));
    const anon = env.unauthenticatedContext();
    await assertFails(getDoc(doc(anon.firestore(), "stockMovements/m1")));
  });
});
