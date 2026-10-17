import { assertFails, assertSucceeds } from "./testing";
import type { RulesTestContext } from "./testing";
import { deleteDoc, doc, getDoc, runTransaction, setDoc, updateDoc } from "../../src/db/firestore";
import { afterAll, beforeEach, describe, it } from "vitest";
import { clearFirestore, getTestEnv, teardownTestEnv } from "./setup";

// Dedicated coverage for the authoritative, server-enforced return-quantity
// cap: returnCounters/{orderId::productId::variantId::size} is the running
// total of "how much of this exact order line has ever been returned",
// checked against the order's actually-sold qty via orderLineQtyForReturn()
// in firestore.rules, and tied to every returns/{id} create via
// returnCounterMatchesIntake(). See the long comments on both rule blocks
// in firestore.rules for the full design rationale — this file verifies
// that design actually holds under the Firestore emulator, not just reads
// well as a comment.

const IDENTIFIED = { firebase: { sign_in_provider: "password" as const } };

async function seedAdmin(uid: string, role: string) {
  const env = await getTestEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `admins/${uid}`), { email: `${uid}@example.com`, displayName: uid, role, active: true });
  });
}

async function seedOrder(orderId: string, lines: Record<string, unknown>[], status = "shipped") {
  const env = await getTestEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `orders/${orderId}`), {
      orderNumber: "SIS-TEST1",
      customerName: "Test Customer",
      customerEmail: "test@example.com",
      lines,
      subtotal: 100,
      shipping: 0,
      total: 100,
      status,
    });
  });
}

const LINE = { productId: "prod1", variantId: "black", name: "Test Dress", color: "Black", size: "M", qty: 3, price: 100 };

function counterId(orderId: string, productId: string, variantId: string, size: string): string {
  return `${orderId}::${productId}::${variantId}::${size}`;
}

function returnDoc(overrides: Record<string, unknown> = {}) {
  return {
    orderId: "order1",
    orderNumber: "SIS-TEST1",
    customerName: "Test Customer",
    customerEmail: "test@example.com",
    productId: "prod1",
    productName: "Test Dress",
    variantId: "black",
    colorName: "Black",
    size: "M",
    qty: 1,
    reason: "defective",
    status: "quarantine",
    disposition: null,
    restocked: false,
    processedBy: "cashier1@example.com",
    processedByName: "cashier1",
    ...overrides,
  };
}

// Mirrors createReturn()'s real transaction shape exactly.
async function submitReturn(ctx: RulesTestContext, returnId: string, data: Record<string, unknown>) {
  const db = ctx.firestore();
  const cId = counterId(data.orderId as string, data.productId as string, data.variantId as string, data.size as string);
  return runTransaction(db, async (tx) => {
    const counterRef = doc(db, "returnCounters", cId);
    const counterSnap = await tx.get(counterRef);
    const before = counterSnap.exists() ? ((counterSnap.data()!.returnedQty as number) ?? 0) : 0;
    tx.set(counterRef, {
      orderId: data.orderId,
      productId: data.productId,
      variantId: data.variantId,
      size: data.size,
      returnedQty: before + (data.qty as number),
    });
    tx.set(doc(db, "returns", returnId), data);
  });
}

describe("return quantity authoritative cap (returnCounters)", () => {
  beforeEach(async () => {
    await clearFirestore();
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  it("lets a cashier return up to exactly the sold qty, across multiple partial returns", async () => {
    await seedAdmin("cashier1", "cashier");
    await seedOrder("order1", [LINE]); // qty sold = 3
    const env = await getTestEnv();
    const cashier = env.authenticatedContext("cashier1", IDENTIFIED);
    await assertSucceeds(submitReturn(cashier, "r1", returnDoc({ qty: 1 })));
    await assertSucceeds(submitReturn(cashier, "r2", returnDoc({ qty: 2 }))); // cumulative 3 == sold qty
  });

  it("rejects a return that would push the cumulative total past the sold qty", async () => {
    await seedAdmin("cashier1", "cashier");
    await seedOrder("order1", [LINE]); // qty sold = 3
    const env = await getTestEnv();
    const cashier = env.authenticatedContext("cashier1", IDENTIFIED);
    await assertSucceeds(submitReturn(cashier, "r1", returnDoc({ qty: 2 })));
    await assertFails(submitReturn(cashier, "r2", returnDoc({ qty: 2 }))); // 2 + 2 = 4 > 3
  });

  it("rejects a single return that alone exceeds the sold qty", async () => {
    await seedAdmin("cashier1", "cashier");
    await seedOrder("order1", [LINE]); // qty sold = 3
    const env = await getTestEnv();
    const cashier = env.authenticatedContext("cashier1", IDENTIFIED);
    await assertFails(submitReturn(cashier, "r1", returnDoc({ qty: 4 })));
  });

  it("rejects a return against a line that doesn't exist on the order at all", async () => {
    await seedAdmin("cashier1", "cashier");
    await seedOrder("order1", [LINE]);
    const env = await getTestEnv();
    const cashier = env.authenticatedContext("cashier1", IDENTIFIED);
    await assertFails(submitReturn(cashier, "r1", returnDoc({ productId: "prod-nonexistent" })));
  });

  it("tracks separate lines (different product/variant/size) independently", async () => {
    await seedAdmin("cashier1", "cashier");
    const lineA = { ...LINE, productId: "prodA", qty: 2 };
    const lineB = { ...LINE, productId: "prodB", variantId: "red", size: "L", qty: 2 };
    await seedOrder("order1", [lineA, lineB]);
    const env = await getTestEnv();
    const cashier = env.authenticatedContext("cashier1", IDENTIFIED);
    // Fully return line A...
    await assertSucceeds(submitReturn(cashier, "r1", returnDoc({ productId: "prodA", variantId: "black", size: "M", qty: 2 })));
    // ...line B is untouched and still independently returnable up to its own qty=2.
    await assertSucceeds(submitReturn(cashier, "r2", returnDoc({ productId: "prodB", variantId: "red", size: "L", qty: 2 })));
    // Line A is now exhausted — any further return on it fails regardless of line B's state.
    await assertFails(submitReturn(cashier, "r3", returnDoc({ productId: "prodA", variantId: "black", size: "M", qty: 1 })));
  });

  it("rejects creating a returns/{id} doc with no matching returnCounters write in the same transaction (direct-bypass attempt)", async () => {
    await seedAdmin("cashier1", "cashier");
    await seedOrder("order1", [LINE]);
    const env = await getTestEnv();
    const cashier = env.authenticatedContext("cashier1", IDENTIFIED);
    await assertFails(setDoc(doc(cashier.firestore(), "returns/r1"), returnDoc()));
  });

  it("rejects writing a returnCounters doc directly above the sold qty, even with no returns/{id} write at all (defense in depth)", async () => {
    await seedAdmin("cashier1", "cashier");
    await seedOrder("order1", [LINE]); // qty sold = 3
    const env = await getTestEnv();
    const cashier = env.authenticatedContext("cashier1", IDENTIFIED);
    await assertFails(
      setDoc(doc(cashier.firestore(), `returnCounters/${counterId("order1", "prod1", "black", "M")}`), {
        orderId: "order1",
        productId: "prod1",
        variantId: "black",
        size: "M",
        returnedQty: 4,
      })
    );
  });

  it("rejects a returnCounters write whose document id doesn't match its own fields", async () => {
    await seedAdmin("cashier1", "cashier");
    await seedOrder("order1", [LINE]);
    const env = await getTestEnv();
    const cashier = env.authenticatedContext("cashier1", IDENTIFIED);
    await assertFails(
      setDoc(doc(cashier.firestore(), "returnCounters/mismatched-id"), {
        orderId: "order1",
        productId: "prod1",
        variantId: "black",
        size: "M",
        returnedQty: 1,
      })
    );
  });

  it("rejects a returnCounters update that doesn't strictly increase returnedQty", async () => {
    await seedAdmin("cashier1", "cashier");
    await seedOrder("order1", [LINE]);
    const env = await getTestEnv();
    const cashier = env.authenticatedContext("cashier1", IDENTIFIED);
    const cId = counterId("order1", "prod1", "black", "M");
    await assertSucceeds(submitReturn(cashier, "r1", returnDoc({ qty: 1 })));
    await assertFails(setDoc(doc(cashier.firestore(), `returnCounters/${cId}`), { orderId: "order1", productId: "prod1", variantId: "black", size: "M", returnedQty: 1 }));
    await assertFails(setDoc(doc(cashier.firestore(), `returnCounters/${cId}`), { orderId: "order1", productId: "prod1", variantId: "black", size: "M", returnedQty: 0 }));
  });

  it("rejects changing a returnCounters doc's identity fields on update", async () => {
    await seedAdmin("cashier1", "cashier");
    await seedOrder("order1", [LINE]);
    const env = await getTestEnv();
    const cashier = env.authenticatedContext("cashier1", IDENTIFIED);
    const cId = counterId("order1", "prod1", "black", "M");
    await assertSucceeds(submitReturn(cashier, "r1", returnDoc({ qty: 1 })));
    await assertFails(
      updateDoc(doc(cashier.firestore(), `returnCounters/${cId}`), { productId: "prod-other", returnedQty: 2 })
    );
  });

  it("rejects a viewer or below from writing counters, allows cashier-or-above", async () => {
    await seedAdmin("viewer1", "viewer");
    await seedAdmin("editor1", "editor");
    await seedOrder("order1", [LINE]);
    const env = await getTestEnv();
    const viewer = env.authenticatedContext("viewer1", IDENTIFIED);
    const editor = env.authenticatedContext("editor1", IDENTIFIED);
    const cId = counterId("order1", "prod1", "black", "M");
    await assertFails(
      setDoc(doc(viewer.firestore(), `returnCounters/${cId}`), { orderId: "order1", productId: "prod1", variantId: "black", size: "M", returnedQty: 1 })
    );
    await assertFails(
      setDoc(doc(editor.firestore(), `returnCounters/${cId}`), { orderId: "order1", productId: "prod1", variantId: "black", size: "M", returnedQty: 1 })
    );
  });

  it("rejects a customer or anonymous visitor from reading or writing counters", async () => {
    await seedAdmin("cashier1", "cashier");
    await seedOrder("order1", [LINE]);
    const env = await getTestEnv();
    const cashier = env.authenticatedContext("cashier1", IDENTIFIED);
    await assertSucceeds(submitReturn(cashier, "r1", returnDoc({ qty: 1 })));
    const cId = counterId("order1", "prod1", "black", "M");
    const customer = env.authenticatedContext("customer1", IDENTIFIED);
    await assertFails(getDoc(doc(customer.firestore(), `returnCounters/${cId}`)));
    await assertFails(
      setDoc(doc(customer.firestore(), `returnCounters/${cId}`), { orderId: "order1", productId: "prod1", variantId: "black", size: "M", returnedQty: 2 })
    );
    const anon = env.unauthenticatedContext();
    await assertFails(getDoc(doc(anon.firestore(), `returnCounters/${cId}`)));
  });

  it("lets any active admin role (including viewer) read counters", async () => {
    await seedAdmin("cashier1", "cashier");
    await seedAdmin("viewer1", "viewer");
    await seedOrder("order1", [LINE]);
    const env = await getTestEnv();
    const cashier = env.authenticatedContext("cashier1", IDENTIFIED);
    await assertSucceeds(submitReturn(cashier, "r1", returnDoc({ qty: 1 })));
    const cId = counterId("order1", "prod1", "black", "M");
    const viewer = env.authenticatedContext("viewer1", IDENTIFIED);
    await assertSucceeds(getDoc(doc(viewer.firestore(), `returnCounters/${cId}`)));
  });

  it("rejects deleting a counter document, even for an owner", async () => {
    await seedAdmin("cashier1", "cashier");
    await seedAdmin("owner1", "owner");
    await seedOrder("order1", [LINE]);
    const env = await getTestEnv();
    const cashier = env.authenticatedContext("cashier1", IDENTIFIED);
    await assertSucceeds(submitReturn(cashier, "r1", returnDoc({ qty: 1 })));
    const cId = counterId("order1", "prod1", "black", "M");
    const owner = env.authenticatedContext("owner1", IDENTIFIED);
    await assertFails(deleteDoc(doc(owner.firestore(), `returnCounters/${cId}`)));
  });
});
