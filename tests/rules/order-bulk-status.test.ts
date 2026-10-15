import { assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, getDoc, runTransaction, setDoc } from "firebase/firestore";
import type { Firestore } from "firebase/firestore";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { checkBulkStatusEligibility } from "../../src/admin/orderBulkStatus";
import { aggregateCancellationRestoreQty, computeCancellationStockUpdates, computeStockDeltas } from "../../src/admin/stockMovements";
import type { AdminOrder, OrderStatus } from "../../src/admin/types";
import { clearFirestore, getTestEnv, teardownTestEnv } from "./setup";

// Integration tests for Bulk Order Status Update's transactional write path
// (see src/firebase/orderBulkStatusUpdate.ts's updateOrderStatusIfEligible()).
// Hand-rolls the same transaction shape rather than importing the real
// function -- same reasoning every other file in this suite already
// documents (that function is bound to the app's own `db` singleton, a
// different Firestore client instance than this harness's per-identity
// clients). checkBulkStatusEligibility() IS imported and called for real --
// it's pure, Firebase-independent code -- so these tests exercise the
// actual shared eligibility logic, not a hand-derived reimplementation.

const IDENTIFIED = { firebase: { sign_in_provider: "password" as const } };

interface SizeStock {
  size: string;
  qty: number | null;
}
interface ColorVariant {
  id: string;
  colorName: string;
  colorHex: string;
  sizeStock: SizeStock[];
}

async function seedAdmin(uid: string, role: string) {
  const env = await getTestEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `admins/${uid}`), { email: `${uid}@example.com`, displayName: uid, role, active: true });
  });
}

async function seedProduct(id: string, data: Record<string, unknown>) {
  const env = await getTestEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `products/${id}`), data);
  });
}

function product(colorVariants: ColorVariant[], overrides: Record<string, unknown> = {}) {
  return { name: "Bulk Status Test Product", slug: "bulk-status-test-product", price: 100, status: "active", colorVariants, ...overrides };
}

async function seedOrder(orderId: string, status: string, lines: Record<string, unknown>[] = []) {
  const env = await getTestEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `orders/${orderId}`), {
      orderNumber: `SIS-${orderId.toUpperCase()}`,
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

async function orderStatus(orderId: string): Promise<string | undefined> {
  const env = await getTestEnv();
  let status: string | undefined;
  await env.withSecurityRulesDisabled(async (ctx) => {
    const snap = await getDoc(doc(ctx.firestore(), `orders/${orderId}`));
    status = snap.data()?.status;
  });
  return status;
}

async function productQty(productId: string, variantId: string, size: string): Promise<number | null> {
  const env = await getTestEnv();
  let qty: number | null = null;
  await env.withSecurityRulesDisabled(async (ctx) => {
    const snap = await getDoc(doc(ctx.firestore(), `products/${productId}`));
    const p = snap.data() as { colorVariants: ColorVariant[] };
    qty = p.colorVariants.find((v) => v.id === variantId)!.sizeStock.find((s) => s.size === size)!.qty;
  });
  return qty;
}

// Mirrors updateOrderStatusIfEligible() exactly: one transaction, fresh
// in-transaction read, eligibility re-checked against THAT read (never
// whatever the caller already had cached), then the write.
function bulkStatusTransaction(fs: Firestore, orderId: string, targetStatus: OrderStatus) {
  const orderRef = doc(fs, "orders", orderId);
  return runTransaction(fs, async (tx) => {
    const snap = await tx.get(orderRef);
    if (!snap.exists()) throw new Error("Order not found.");
    const order = snap.data() as AdminOrder;
    const check = checkBulkStatusEligibility(order, targetStatus);
    if (!check.eligible) throw new Error(`ineligible: ${check.reasonKey}`);
    tx.update(orderRef, { status: targetStatus, updatedAt: new Date() });
  });
}

// Mirrors cancelOrderAndRestoreStock() exactly, simplified to a single
// product/line -- only used here to race against bulkStatusTransaction()
// on the same order, proving the two can never both "win" in a way that
// leaves stock restored AND the order in some other active status.
function cancelOrderTransaction(fs: Firestore, orderId: string, productId: string) {
  const orderRef = doc(fs, "orders", orderId);
  const productRef = doc(fs, "products", productId);
  return runTransaction(fs, async (tx) => {
    const orderSnap = await tx.get(orderRef);
    const order = orderSnap.data() as AdminOrder;
    if (order.status !== "pending" && order.status !== "processing") throw new Error("Only pending or processing orders can be cancelled this way.");
    const restoreEntries = aggregateCancellationRestoreQty(order.lines);
    if (restoreEntries.length === 0) {
      tx.update(orderRef, { status: "cancelled", updatedAt: new Date() });
      return;
    }
    const productSnap = await tx.get(productRef);
    if (!productSnap.exists()) throw new Error("Product no longer exists.");
    const productById = new Map([[productId, { id: productSnap.id, ...productSnap.data() } as { id: string; name: string; colorVariants: ColorVariant[] }]]);
    const updates = computeCancellationStockUpdates(restoreEntries, productById);
    for (const u of updates) {
      tx.update(doc(fs, "products", u.productId), { colorVariants: u.after, updatedAt: new Date() });
      computeStockDeltas(u.before, u.after); // exercised for parity with the real transaction; movements omitted, not needed for this race's assertions
    }
    tx.update(orderRef, { status: "cancelled", updatedAt: new Date() });
  });
}

describe("bulk order status update: transactional integration", () => {
  beforeEach(async () => {
    await clearFirestore();
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  it("successfully updates a pending order's status", async () => {
    await seedAdmin("admin1", "admin");
    await seedOrder("order1", "pending");
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await assertSucceeds(bulkStatusTransaction(admin.firestore(), "order1", "shipped"));
    expect(await orderStatus("order1")).toBe("shipped");
  });

  it("allows moving between any two non-cancelled statuses (matches OrderDetail.tsx's own single-order freedom)", async () => {
    await seedAdmin("admin1", "admin");
    await seedOrder("order1", "delivered");
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await assertSucceeds(bulkStatusTransaction(admin.firestore(), "order1", "refunded"));
    expect(await orderStatus("order1")).toBe("refunded");
  });

  it("rejects moving an order to 'cancelled' through this path -- must always go through cancelOrderAndRestoreStock()", async () => {
    await seedAdmin("admin1", "admin");
    await seedOrder("order1", "pending");
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await expect(bulkStatusTransaction(admin.firestore(), "order1", "cancelled")).rejects.toThrow();
    expect(await orderStatus("order1")).toBe("pending");
  });

  it("rejects updating an order that is currently cancelled, and leaves it untouched", async () => {
    await seedAdmin("admin1", "admin");
    await seedOrder("order1", "cancelled");
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await expect(bulkStatusTransaction(admin.firestore(), "order1", "shipped")).rejects.toThrow();
    expect(await orderStatus("order1")).toBe("cancelled");
  });

  it("rejects updating an order that no longer exists", async () => {
    await seedAdmin("admin1", "admin");
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await expect(bulkStatusTransaction(admin.firestore(), "ghost-order", "shipped")).rejects.toThrow();
  });

  // Directly validates the fix for the race the safety review surfaced:
  // checking eligibility against a component's own onSnapshot-cached order
  // state and then issuing a bare (non-transactional) update would let a
  // just-cancelled order still look "pending" and get silently moved to
  // another status, with its already-restored stock never re-decremented.
  // A transactional re-read closes that window -- this test proves it by
  // actually racing the two operations against the real emulator, not just
  // asserting the code "looks" safe.
  it("racing a cancellation against a bulk status update on the same order: they can never both succeed, and stock is never left inconsistent", async () => {
    await seedAdmin("admin1", "admin");
    await seedProduct("p1", product([{ id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 5 }] }]));
    await seedOrder("order1", "pending", [{ productId: "p1", variantId: "black", name: "Bulk Status Test Product", qty: 2, price: 100, size: "S", color: "Black" }]);
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    const fs = admin.firestore();

    const bulkAttempt = () =>
      bulkStatusTransaction(fs, "order1", "shipped").then(
        () => ({ ok: true as const, kind: "bulk" as const }),
        (err) => ({ ok: false as const, kind: "bulk" as const, err })
      );
    const cancelAttempt = () =>
      cancelOrderTransaction(fs, "order1", "p1").then(
        () => ({ ok: true as const, kind: "cancel" as const }),
        (err) => ({ ok: false as const, kind: "cancel" as const, err })
      );

    const [bulkResult, cancelResult] = await Promise.all([bulkAttempt(), cancelAttempt()]);

    // The one invariant that must hold no matter which operation's
    // transaction happens to commit first: they can never BOTH succeed.
    // Either the bulk update won (order is "shipped", stock was never
    // touched by a lost cancellation) or the cancellation won (order is
    // "cancelled", stock was restored, and the bulk update's fresh
    // in-transaction re-read correctly saw "cancelled" and refused).
    expect(bulkResult.ok && cancelResult.ok).toBe(false);

    const finalStatus = await orderStatus("order1");
    const finalQty = await productQty("p1", "black", "S");

    if (bulkResult.ok) {
      expect(cancelResult.ok).toBe(false);
      expect(finalStatus).toBe("shipped");
      // Bulk status update never touches stock, win or lose -- still 5.
      expect(finalQty).toBe(5);
    } else {
      expect(cancelResult.ok).toBe(true);
      expect(finalStatus).toBe("cancelled");
      // Cancellation won and restored the 2 reserved units back to stock;
      // the bulk update's loss means "shipped" was never written, so this
      // is 5 + 2 = 7, never left partway (6) and never double-restored (9).
      expect(finalQty).toBe(7);
    }
  });
});

describe("bulk order status update: role/permission boundary", () => {
  beforeEach(async () => {
    await clearFirestore();
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  it("lets an owner update status, same as an admin", async () => {
    await seedAdmin("owner1", "owner");
    await seedOrder("order1", "pending");
    const env = await getTestEnv();
    const owner = env.authenticatedContext("owner1", IDENTIFIED);
    await assertSucceeds(bulkStatusTransaction(owner.firestore(), "order1", "processing"));
    expect(await orderStatus("order1")).toBe("processing");
  });

  it("rejects a cashier from bulk-updating order status (status changes stay owner/admin-only)", async () => {
    await seedAdmin("cashier1", "cashier");
    await seedOrder("order1", "pending");
    const env = await getTestEnv();
    const cashier = env.authenticatedContext("cashier1", IDENTIFIED);
    await assertFails(bulkStatusTransaction(cashier.firestore(), "order1", "processing"));
    expect(await orderStatus("order1")).toBe("pending");
  });

  it("rejects an editor from bulk-updating order status (catalog-scoped, never orders)", async () => {
    await seedAdmin("editor1", "editor");
    await seedOrder("order1", "pending");
    const env = await getTestEnv();
    const editor = env.authenticatedContext("editor1", IDENTIFIED);
    await assertFails(bulkStatusTransaction(editor.firestore(), "order1", "processing"));
    expect(await orderStatus("order1")).toBe("pending");
  });

  it("rejects a viewer from bulk-updating order status", async () => {
    await seedAdmin("viewer1", "viewer");
    await seedOrder("order1", "pending");
    const env = await getTestEnv();
    const viewer = env.authenticatedContext("viewer1", IDENTIFIED);
    await assertFails(bulkStatusTransaction(viewer.firestore(), "order1", "processing"));
    expect(await orderStatus("order1")).toBe("pending");
  });

  it("rejects an anonymous/unauthenticated user from bulk-updating order status", async () => {
    await seedOrder("order1", "pending");
    const env = await getTestEnv();
    const guest = env.unauthenticatedContext();
    await assertFails(bulkStatusTransaction(guest.firestore(), "order1", "processing"));
    expect(await orderStatus("order1")).toBe("pending");
  });
});
