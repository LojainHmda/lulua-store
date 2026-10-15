import { assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, getDoc, runTransaction, setDoc } from "firebase/firestore";
import type { Firestore } from "firebase/firestore";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { allLinesPrepared, deriveStatusAfterPreparationChange, setLinePrepared } from "../../src/admin/orderPreparation";
import type { AdminOrder, OrderLine } from "../../src/admin/types";
import { clearFirestore, getTestEnv, teardownTestEnv } from "./setup";

// Integration tests for Phase 3's preparation-state write path (see
// src/firebase/orderPreparation.ts's setOrderLinePrepared()). Hand-rolls the
// same transaction shape rather than importing the real function -- same
// reasoning every other file in this suite already documents (that function
// is bound to the app's own `db` singleton, a different Firestore client
// instance than this harness's per-identity clients). The three pure
// functions it's built from (setLinePrepared, allLinesPrepared,
// deriveStatusAfterPreparationChange) ARE imported and called for real --
// they're pure, Firebase-independent code -- so these tests exercise the
// actual shared preparation logic against real rules enforcement, not a
// hand-derived reimplementation of either half.
//
// firestore.rules itself needed NO changes for this feature: orders/{id}'s
// existing `allow update: if (isAdminOrAbove() && isValidNonDeliveryUpdate())
// ...` already grants owner/admin unrestricted field-level write access
// (isValidNonDeliveryUpdate() only constrains nonDeliveryFlagged/
// nonDeliveryNote when THOSE specific keys are present, and is a no-op
// otherwise) -- these tests exist to prove that claim empirically against
// the real rules, not to exercise a rule that was written for this feature.

const IDENTIFIED = { firebase: { sign_in_provider: "password" as const } };

async function seedAdmin(uid: string, role: string) {
  const env = await getTestEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `admins/${uid}`), { email: `${uid}@example.com`, displayName: uid, role, active: true });
  });
}

async function seedOrder(orderId: string, status: string, lines: OrderLine[], preparedLines?: Record<string, boolean>) {
  const env = await getTestEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const data: Record<string, unknown> = {
      orderNumber: `SIS-${orderId.toUpperCase()}`,
      customerName: "Test Customer",
      customerEmail: "test@example.com",
      lines,
      subtotal: lines.reduce((sum, l) => sum + l.price * l.qty, 0),
      shipping: 0,
      total: lines.reduce((sum, l) => sum + l.price * l.qty, 0),
      status,
    };
    if (preparedLines) data.preparedLines = preparedLines;
    await setDoc(doc(ctx.firestore(), `orders/${orderId}`), data);
  });
}

async function readOrder(orderId: string): Promise<AdminOrder | undefined> {
  const env = await getTestEnv();
  let order: AdminOrder | undefined;
  await env.withSecurityRulesDisabled(async (ctx) => {
    const snap = await getDoc(doc(ctx.firestore(), `orders/${orderId}`));
    order = snap.exists() ? ({ id: snap.id, ...snap.data() } as AdminOrder) : undefined;
  });
  return order;
}

function line(overrides: Partial<OrderLine> = {}): OrderLine {
  return { productId: "p1", variantId: "black", name: "Test Product", qty: 1, price: 100, size: "S", color: "Black", ...overrides };
}

// Mirrors setOrderLinePrepared() (src/firebase/orderPreparation.ts) exactly:
// one transaction, fresh in-transaction read, preparedLines/status derived
// from THAT read via the real pure functions, then one write touching only
// preparedLines/status/updatedAt.
function preparationTransaction(fs: Firestore, orderId: string, targetLine: Pick<OrderLine, "productId" | "variantId" | "size">, prepared: boolean) {
  const orderRef = doc(fs, "orders", orderId);
  return runTransaction(fs, async (tx) => {
    const snap = await tx.get(orderRef);
    if (!snap.exists()) throw new Error("Order not found.");
    const order = snap.data() as AdminOrder;
    const nextPreparedLines = setLinePrepared(order.preparedLines, targetLine, prepared);
    const nextStatus = deriveStatusAfterPreparationChange(order.status, allLinesPrepared(order.lines, nextPreparedLines));
    tx.update(orderRef, { preparedLines: nextPreparedLines, status: nextStatus, updatedAt: new Date() });
  });
}

describe("order preparation: transactional integration", () => {
  beforeEach(async () => {
    await clearFirestore();
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  it("confirming the only line on a pending order moves it straight to 'ready'", async () => {
    await seedAdmin("admin1", "admin");
    await seedOrder("order1", "pending", [line()]);
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await assertSucceeds(preparationTransaction(admin.firestore(), "order1", line(), true));
    const order = await readOrder("order1");
    expect(order?.status).toBe("ready");
    expect(order?.preparedLines).toEqual({ "p1::black::S": true });
  });

  it("confirming one of two lines keeps the order in 'processing'", async () => {
    await seedAdmin("admin1", "admin");
    await seedOrder("order1", "pending", [line({ productId: "p1" }), line({ productId: "p2" })]);
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await assertSucceeds(preparationTransaction(admin.firestore(), "order1", line({ productId: "p1" }), true));
    const order = await readOrder("order1");
    expect(order?.status).toBe("processing");
  });

  it("resetting a line on a 'ready' order drops it back to 'processing'", async () => {
    await seedAdmin("admin1", "admin");
    await seedOrder("order1", "ready", [line()], { "p1::black::S": true });
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await assertSucceeds(preparationTransaction(admin.firestore(), "order1", line(), false));
    const order = await readOrder("order1");
    expect(order?.status).toBe("processing");
    expect(order?.preparedLines).toEqual({});
  });

  it("never touches stock: a product document is untouched by a preparation write", async () => {
    await seedAdmin("admin1", "admin");
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "products/p1"), {
        name: "Test Product",
        slug: "test-product",
        price: 100,
        status: "active",
        colorVariants: [{ id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 5 }] }],
      });
    });
    await seedOrder("order1", "pending", [line()]);
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await assertSucceeds(preparationTransaction(admin.firestore(), "order1", line(), true));
    let qty: number | null = null;
    await env.withSecurityRulesDisabled(async (ctx) => {
      const snap = await getDoc(doc(ctx.firestore(), "products/p1"));
      qty = (snap.data() as { colorVariants: { sizeStock: { size: string; qty: number }[] }[] }).colorVariants[0].sizeStock[0].qty;
    });
    expect(qty).toBe(5);
  });

  it("does not touch status for a shipped order (preparation is not a preparation-managed status)", async () => {
    await seedAdmin("admin1", "admin");
    await seedOrder("order1", "shipped", [line()]);
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await assertSucceeds(preparationTransaction(admin.firestore(), "order1", line(), true));
    const order = await readOrder("order1");
    expect(order?.status).toBe("shipped");
    // The write still succeeds (rules don't forbid it), but the derived
    // status logic itself refuses to move a shipped order -- this is the
    // same UI-level guard (canPrepare/PREPARABLE_STATUSES) OrderDetail.tsx
    // already relies on to keep the checklist non-interactive past shipping.
  });
});

describe("order preparation: role/permission boundary", () => {
  beforeEach(async () => {
    await clearFirestore();
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  it("lets an owner write preparation state, same as an admin", async () => {
    await seedAdmin("owner1", "owner");
    await seedOrder("order1", "pending", [line()]);
    const env = await getTestEnv();
    const owner = env.authenticatedContext("owner1", IDENTIFIED);
    await assertSucceeds(preparationTransaction(owner.firestore(), "order1", line(), true));
    expect((await readOrder("order1"))?.status).toBe("ready");
  });

  it("rejects a cashier from writing preparation state (matches order-detail access: owner/admin only)", async () => {
    await seedAdmin("cashier1", "cashier");
    await seedOrder("order1", "pending", [line()]);
    const env = await getTestEnv();
    const cashier = env.authenticatedContext("cashier1", IDENTIFIED);
    await assertFails(preparationTransaction(cashier.firestore(), "order1", line(), true));
    expect((await readOrder("order1"))?.status).toBe("pending");
  });

  it("rejects an editor from writing preparation state (catalog-scoped, never orders)", async () => {
    await seedAdmin("editor1", "editor");
    await seedOrder("order1", "pending", [line()]);
    const env = await getTestEnv();
    const editor = env.authenticatedContext("editor1", IDENTIFIED);
    await assertFails(preparationTransaction(editor.firestore(), "order1", line(), true));
    expect((await readOrder("order1"))?.status).toBe("pending");
  });

  it("rejects a viewer from writing preparation state", async () => {
    await seedAdmin("viewer1", "viewer");
    await seedOrder("order1", "pending", [line()]);
    const env = await getTestEnv();
    const viewer = env.authenticatedContext("viewer1", IDENTIFIED);
    await assertFails(preparationTransaction(viewer.firestore(), "order1", line(), true));
    expect((await readOrder("order1"))?.status).toBe("pending");
  });

  it("rejects an anonymous/unauthenticated user from writing preparation state", async () => {
    await seedOrder("order1", "pending", [line()]);
    const env = await getTestEnv();
    const guest = env.unauthenticatedContext();
    await assertFails(preparationTransaction(guest.firestore(), "order1", line(), true));
    expect((await readOrder("order1"))?.status).toBe("pending");
  });

  it("rejects a signed-in customer (non-admin) who owns this order from writing preparation state", async () => {
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "orders/order1"), {
        orderNumber: "SIS-ORDER1",
        customerId: "customer1",
        customerName: "Test Customer",
        customerEmail: "test@example.com",
        lines: [line()],
        subtotal: 100,
        shipping: 0,
        total: 100,
        status: "pending",
      });
    });
    const customer = env.authenticatedContext("customer1", IDENTIFIED);
    await assertFails(preparationTransaction(customer.firestore(), "order1", line(), true));
    expect((await readOrder("order1"))?.status).toBe("pending");
  });
});
