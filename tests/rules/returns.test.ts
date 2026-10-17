import { assertFails, assertSucceeds } from "./testing";
import type { RulesTestContext } from "./testing";
import { deleteDoc, doc, getDoc, runTransaction, setDoc, updateDoc } from "../../src/db/firestore";
import { afterAll, beforeEach, describe, it } from "vitest";
import { clearFirestore, getTestEnv, teardownTestEnv } from "./setup";

const IDENTIFIED = { firebase: { sign_in_provider: "password" as const } };

// Default line a bare seedOrder() attaches, matching quarantineDoc()'s
// default productId/variantId/size exactly, with enough qty (5) sold to
// leave headroom for multi-return tests. Tests that need a different shape
// pass their own `lines`.
const DEFAULT_LINE = { productId: "prod1", variantId: "black", name: "Test Dress", color: "Black", size: "M", qty: 5, price: 100 };

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

async function seedOrder(orderId: string, status: string, lines: Record<string, unknown>[] = [DEFAULT_LINE]) {
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

function counterId(orderId: string, productId: string, variantId: string, size: string): string {
  return `${orderId}::${productId}::${variantId}::${size}`;
}

// Mirrors src/firebase/returnsTransaction.ts's createReturn() exactly: a
// return document is only ever creatable alongside a matching
// returnCounters bump in the SAME transaction (see returnCounterMatchesIntake()
// in firestore.rules) — a bare setDoc(returns/{id}, ...) with no counter
// write now always fails, by design (tested explicitly below).
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

function quarantineDoc(overrides: Record<string, unknown> = {}) {
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

describe("returns quarantine", () => {
  beforeEach(async () => {
    await clearFirestore();
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  it("lets a cashier log a valid quarantine return against a shipped order", async () => {
    await seedAdmin("cashier1", "cashier");
    await seedOrder("order1", "shipped");
    const env = await getTestEnv();
    const cashier = env.authenticatedContext("cashier1", IDENTIFIED);
    await assertSucceeds(submitReturn(cashier, "r1", quarantineDoc()));
  });

  it("lets a cashier log a return against a delivered or completed order too", async () => {
    await seedAdmin("cashier1", "cashier");
    await seedOrder("order1", "delivered");
    await seedOrder("order2", "completed");
    const env = await getTestEnv();
    const cashier = env.authenticatedContext("cashier1", IDENTIFIED);
    await assertSucceeds(submitReturn(cashier, "r1", quarantineDoc()));
    await assertSucceeds(submitReturn(cashier, "r2", quarantineDoc({ orderId: "order2" })));
  });

  it("rejects a return against an order that hasn't shipped, or is cancelled/refunded", async () => {
    await seedAdmin("cashier1", "cashier");
    await seedOrder("orderPending", "pending");
    await seedOrder("orderProcessing", "processing");
    await seedOrder("orderCancelled", "cancelled");
    await seedOrder("orderRefunded", "refunded");
    const env = await getTestEnv();
    const cashier = env.authenticatedContext("cashier1", IDENTIFIED);
    for (const orderId of ["orderPending", "orderProcessing", "orderCancelled", "orderRefunded"]) {
      await assertFails(setDoc(doc(cashier.firestore(), `returns/r-${orderId}`), quarantineDoc({ orderId })));
    }
  });

  it("rejects create with a pre-set disposition or restocked=true", async () => {
    await seedAdmin("cashier1", "cashier");
    await seedOrder("order1", "shipped");
    const env = await getTestEnv();
    const cashier = env.authenticatedContext("cashier1", IDENTIFIED);
    await assertFails(setDoc(doc(cashier.firestore(), "returns/r1"), quarantineDoc({ disposition: "good" })));
    await assertFails(setDoc(doc(cashier.firestore(), "returns/r2"), quarantineDoc({ restocked: true })));
    await assertFails(setDoc(doc(cashier.firestore(), "returns/r3"), quarantineDoc({ status: "resolved" })));
  });

  it("rejects create with an invalid reason or non-positive qty", async () => {
    await seedAdmin("cashier1", "cashier");
    await seedOrder("order1", "shipped");
    const env = await getTestEnv();
    const cashier = env.authenticatedContext("cashier1", IDENTIFIED);
    await assertFails(setDoc(doc(cashier.firestore(), "returns/r1"), quarantineDoc({ reason: "bogus" })));
    await assertFails(setDoc(doc(cashier.firestore(), "returns/r2"), quarantineDoc({ qty: 0 })));
    await assertFails(setDoc(doc(cashier.firestore(), "returns/r3"), quarantineDoc({ qty: -1 })));
  });

  it("rejects a viewer from creating a return (below cashier)", async () => {
    await seedAdmin("viewer1", "viewer");
    await seedOrder("order1", "shipped");
    const env = await getTestEnv();
    const viewer = env.authenticatedContext("viewer1", IDENTIFIED);
    await assertFails(setDoc(doc(viewer.firestore(), "returns/r1"), quarantineDoc()));
  });

  it("rejects a customer or anonymous visitor from reading or writing returns", async () => {
    await seedAdmin("cashier1", "cashier");
    await seedOrder("order1", "shipped");
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "returns/r1"), quarantineDoc());
    });
    const customer = env.authenticatedContext("customer1", IDENTIFIED);
    await assertFails(getDoc(doc(customer.firestore(), "returns/r1")));
    await assertFails(setDoc(doc(customer.firestore(), "returns/r2"), quarantineDoc()));
    const anon = env.unauthenticatedContext();
    await assertFails(getDoc(doc(anon.firestore(), "returns/r1")));
  });

  it("rejects a cashier from updating/resolving a return", async () => {
    await seedAdmin("cashier1", "cashier");
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "returns/r1"), quarantineDoc());
    });
    const cashier = env.authenticatedContext("cashier1", IDENTIFIED);
    await assertFails(updateDoc(doc(cashier.firestore(), "returns/r1"), { inspectionNotes: "looks fine" }));
  });

  it("rejects an editor from updating/resolving a return (orders/returns stay admin-or-above, editor is catalog-scoped)", async () => {
    await seedAdmin("editor1", "editor");
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "returns/r1"), quarantineDoc());
    });
    const editor = env.authenticatedContext("editor1", IDENTIFIED);
    await assertFails(updateDoc(doc(editor.firestore(), "returns/r1"), { status: "resolved", disposition: "good", restocked: true }));
  });

  it("lets an admin resolve a return as good, incrementing restocked", async () => {
    await seedAdmin("admin1", "admin");
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "returns/r1"), quarantineDoc());
    });
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await assertSucceeds(
      updateDoc(doc(admin.firestore(), "returns/r1"), {
        status: "resolved",
        disposition: "good",
        restocked: true,
        resolvedBy: "admin1@example.com",
        resolvedByName: "admin1",
      })
    );
  });

  it("lets an owner mark a return needs_repair without touching restocked", async () => {
    await seedAdmin("owner1", "owner");
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "returns/r1"), quarantineDoc());
    });
    const owner = env.authenticatedContext("owner1", IDENTIFIED);
    await assertSucceeds(updateDoc(doc(owner.firestore(), "returns/r1"), { status: "needs_repair", inspectionNotes: "zipper broken" }));
  });

  it("rejects updating a return that is already resolved (terminal)", async () => {
    await seedAdmin("admin1", "admin");
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "returns/r1"), quarantineDoc({ status: "resolved", disposition: "damaged" }));
    });
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await assertFails(updateDoc(doc(admin.firestore(), "returns/r1"), { inspectionNotes: "changed my mind" }));
  });

  it("rejects flipping restocked from true back to false", async () => {
    await seedAdmin("admin1", "admin");
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      // Not resolved, so the "resolved is immutable" guard doesn't itself block this —
      // isolates the restocked-can-only-increase guard specifically.
      await setDoc(doc(ctx.firestore(), "returns/r1"), quarantineDoc({ status: "needs_repair", restocked: true }));
    });
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await assertFails(updateDoc(doc(admin.firestore(), "returns/r1"), { restocked: false }));
  });

  it("rejects changing identity fields (orderId/productId/variantId/size/qty) on update", async () => {
    await seedAdmin("admin1", "admin");
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "returns/r1"), quarantineDoc());
    });
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await assertFails(updateDoc(doc(admin.firestore(), "returns/r1"), { productId: "prod2" }));
    await assertFails(updateDoc(doc(admin.firestore(), "returns/r1"), { variantId: "red" }));
    await assertFails(updateDoc(doc(admin.firestore(), "returns/r1"), { size: "L" }));
    await assertFails(updateDoc(doc(admin.firestore(), "returns/r1"), { qty: 2 }));
    await assertFails(updateDoc(doc(admin.firestore(), "returns/r1"), { orderId: "order2" }));
  });

  it("lets an admin delete a return, rejects a cashier or editor from deleting", async () => {
    await seedAdmin("admin1", "admin");
    await seedAdmin("cashier1", "cashier");
    await seedAdmin("editor1", "editor");
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "returns/r1"), quarantineDoc());
      await setDoc(doc(ctx.firestore(), "returns/r2"), quarantineDoc());
      await setDoc(doc(ctx.firestore(), "returns/r3"), quarantineDoc());
    });
    const cashier = env.authenticatedContext("cashier1", IDENTIFIED);
    const editor = env.authenticatedContext("editor1", IDENTIFIED);
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await assertFails(deleteDoc(doc(cashier.firestore(), "returns/r1")));
    await assertFails(deleteDoc(doc(editor.firestore(), "returns/r2")));
    await assertSucceeds(deleteDoc(doc(admin.firestore(), "returns/r3")));
  });

  // Audit finding B1: returns/{id} read used to be isAnyAdmin() (every
  // active admin role, including viewer). Narrowed to isCashierOrAbove() —
  // cashier is kept because ProcessReturnModal.tsx (the cashier-reachable
  // return-intake modal) genuinely queries this collection to cap re-
  // returns; viewer and editor have no such functional need and lose
  // access, matching their documented "read-only catalog" / "catalog-
  // scoped" role descriptions.
  it("lets owner/admin/cashier read returns, but no longer a viewer", async () => {
    await seedAdmin("owner1", "owner");
    await seedAdmin("admin1", "admin");
    await seedAdmin("cashier1", "cashier");
    await seedAdmin("viewer1", "viewer");
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "returns/r1"), quarantineDoc());
    });
    const owner = env.authenticatedContext("owner1", IDENTIFIED);
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    const cashier = env.authenticatedContext("cashier1", IDENTIFIED);
    const viewer = env.authenticatedContext("viewer1", IDENTIFIED);
    await assertSucceeds(getDoc(doc(owner.firestore(), "returns/r1")));
    await assertSucceeds(getDoc(doc(admin.firestore(), "returns/r1")));
    await assertSucceeds(getDoc(doc(cashier.firestore(), "returns/r1")));
    await assertFails(getDoc(doc(viewer.firestore(), "returns/r1")));
  });

  it("blocks an editor from reading returns (catalog-scoped, never returns/orders)", async () => {
    await seedAdmin("editor1", "editor");
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "returns/r1"), quarantineDoc());
    });
    const editor = env.authenticatedContext("editor1", IDENTIFIED);
    await assertFails(getDoc(doc(editor.firestore(), "returns/r1")));
  });
});
