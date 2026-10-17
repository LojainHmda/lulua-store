import { assertFails, assertSucceeds } from "./testing";
import { collection, doc, getDoc, getDocs, query, runTransaction, setDoc, where } from "../../src/db/firestore";
import type { Firestore } from "../../src/db/firestore";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { aggregateCancellationRestoreQty, computeCancellationStockUpdates, computeStockDeltas } from "../../src/admin/stockMovements";
import type { AdminOrder, AdminProduct } from "../../src/admin/types";
import { clearFirestore, getTestEnv, teardownTestEnv } from "./setup";

// Integration tests for the Order Cancellation -> Stock Restoration feature
// (see src/firebase/orderCancellation.ts). cancelOrderTransaction() below
// hand-rolls the same transaction shape as the real cancelOrderAndRestoreStock()
// rather than importing it directly -- that function is bound to the app's
// own `db` singleton (src/firebase/config.ts), a different Firestore client
// instance than @firebase/rules-unit-testing's isolated RulesTestEnvironment
// context, so it can't be invoked against this harness directly. This is the
// SAME approach every existing file in this suite already uses (see
// checkout.test.ts's checkoutTransaction(), stock-movements-transactions.test.ts's
// checkoutWithLedger()/orderEditWithLedger()). The pure business logic
// (aggregateCancellationRestoreQty, computeCancellationStockUpdates,
// computeStockDeltas) IS imported and called for real here -- it's pure,
// Firebase-independent code -- so these tests exercise the actual shared
// helpers the real transaction uses, not a hand-derived reimplementation of
// them.

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

function product(colorVariants: ColorVariant[], overrides: Record<string, unknown> = {}) {
  return { name: "Cancel Test Product", slug: "cancel-test-product", price: 100, status: "active", colorVariants, ...overrides };
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

async function seedOrder(orderId: string, status: string, lines: Record<string, unknown>[], overrides: Record<string, unknown> = {}) {
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
      ...overrides,
    });
  });
}

async function allMovements(productId?: string): Promise<Record<string, unknown>[]> {
  const env = await getTestEnv();
  let result: Record<string, unknown>[] = [];
  await env.withSecurityRulesDisabled(async (ctx) => {
    const fs = ctx.firestore();
    const q = productId ? query(collection(fs, "stockMovements"), where("productId", "==", productId)) : collection(fs, "stockMovements");
    const snap = await getDocs(q);
    result = snap.docs.map((d) => d.data());
  });
  return result;
}

async function productQty(productId: string, variantId: string, size: string): Promise<number | null> {
  const env = await getTestEnv();
  let result: number | null = null;
  await env.withSecurityRulesDisabled(async (ctx) => {
    const snap = await getDoc(doc(ctx.firestore(), "products", productId));
    const p = snap.data() as { colorVariants: ColorVariant[] };
    result = p.colorVariants.find((v) => v.id === variantId)!.sizeStock.find((s) => s.size === size)!.qty;
  });
  return result;
}

async function orderStatus(orderId: string): Promise<string> {
  const env = await getTestEnv();
  let result = "";
  await env.withSecurityRulesDisabled(async (ctx) => {
    const snap = await getDoc(doc(ctx.firestore(), "orders", orderId));
    result = (snap.data() as { status: string }).status;
  });
  return result;
}

// Mirrors src/firebase/orderCancellation.ts's cancelOrderAndRestoreStock()
// exactly: fresh status guard, aggregate-by-key, per-line validation via the
// real computeCancellationStockUpdates(), product update + stockMovements
// doc(s) via the real computeStockDeltas(), order status flip -- all one
// transaction.
function cancelOrderTransaction(fs: Firestore, orderId: string, actor: { email: string; displayName: string }) {
  const orderRef = doc(fs, "orders", orderId);
  return runTransaction(fs, async (tx) => {
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists()) throw new Error("Order not found.");
    const order = orderSnap.data() as AdminOrder;
    if (order.status !== "pending" && order.status !== "processing") {
      throw new Error("Only pending or processing orders can be cancelled this way.");
    }

    const restoreEntries = aggregateCancellationRestoreQty(order.lines);
    if (restoreEntries.length === 0) {
      tx.update(orderRef, { status: "cancelled", updatedAt: new Date() });
      return;
    }

    const distinctProductIds = [...new Set(restoreEntries.map((e) => e.productId))];
    const productRefs = distinctProductIds.map((id) => doc(fs, "products", id));
    const productSnaps = await Promise.all(productRefs.map((ref) => tx.get(ref)));

    const productById = new Map<string, AdminProduct>();
    productSnaps.forEach((snap, i) => {
      if (!snap.exists()) throw new Error("One of the products in this order no longer exists.");
      productById.set(distinctProductIds[i], { id: snap.id, ...snap.data() } as AdminProduct);
    });

    const updates = computeCancellationStockUpdates(restoreEntries, productById);

    for (const u of updates) {
      tx.update(doc(fs, "products", u.productId), { colorVariants: u.after, updatedAt: new Date() });
      for (const delta of computeStockDeltas(u.before, u.after)) {
        tx.set(doc(collection(fs, "stockMovements")), {
          productId: u.productId,
          productName: u.productName,
          variantId: delta.variantId,
          colorName: delta.colorName,
          size: delta.size,
          qtyBefore: delta.qtyBefore,
          qtyChange: delta.qtyChange,
          qtyAfter: delta.qtyAfter,
          reason: "order_cancelled",
          source: "admin",
          actorEmail: actor.email,
          actorName: actor.displayName,
          orderId,
          orderNumber: order.orderNumber,
          createdAt: new Date(),
        });
      }
    }

    tx.update(orderRef, { status: "cancelled", updatedAt: new Date() });
  });
}

const ACTOR = { email: "admin1@example.com", displayName: "admin1" };

describe("order cancellation: basic restoration", () => {
  beforeEach(async () => {
    await clearFirestore();
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  it("restores stock and cancels a pending order", async () => {
    await seedAdmin("admin1", "admin");
    await seedProduct("p1", product([{ id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 5 }] }]));
    await seedOrder("order1", "pending", [{ productId: "p1", variantId: "black", name: "Cancel Test Product", qty: 2, price: 100, size: "S", color: "Black" }]);
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await assertSucceeds(cancelOrderTransaction(admin.firestore(), "order1", ACTOR));

    expect(await orderStatus("order1")).toBe("cancelled");
    expect(await productQty("p1", "black", "S")).toBe(7);
    const movements = await allMovements("p1");
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      variantId: "black", colorName: "Black", size: "S",
      qtyBefore: 5, qtyChange: 2, qtyAfter: 7,
      reason: "order_cancelled", source: "admin",
      actorEmail: "admin1@example.com", actorName: "admin1",
      orderId: "order1", orderNumber: "SIS-ORDER1",
    });
  });

  it("restores stock and cancels a processing order", async () => {
    await seedAdmin("admin1", "admin");
    await seedProduct("p1", product([{ id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "M", qty: 3 }] }]));
    await seedOrder("order1", "processing", [{ productId: "p1", variantId: "black", name: "Cancel Test Product", qty: 1, price: 100, size: "M", color: "Black" }]);
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await assertSucceeds(cancelOrderTransaction(admin.firestore(), "order1", ACTOR));
    expect(await orderStatus("order1")).toBe("cancelled");
    expect(await productQty("p1", "black", "M")).toBe(4);
  });

  it("cancels an empty manual/off-site order (no lines) with no stock movement at all", async () => {
    await seedAdmin("admin1", "admin");
    await seedOrder("order1", "pending", []);
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await assertSucceeds(cancelOrderTransaction(admin.firestore(), "order1", ACTOR));
    expect(await orderStatus("order1")).toBe("cancelled");
    expect(await allMovements()).toHaveLength(0);
  });

  it("restores stock correctly across multiple products in one order", async () => {
    await seedAdmin("admin1", "admin");
    await seedProduct("p1", product([{ id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 5 }] }]));
    await seedProduct("p2", product([{ id: "red", colorName: "Red", colorHex: "#f00", sizeStock: [{ size: "L", qty: 1 }] }]));
    await seedOrder("order1", "pending", [
      { productId: "p1", variantId: "black", name: "Cancel Test Product", qty: 1, price: 100, size: "S", color: "Black" },
      { productId: "p2", variantId: "red", name: "Cancel Test Product 2", qty: 4, price: 100, size: "L", color: "Red" },
    ]);
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await assertSucceeds(cancelOrderTransaction(admin.firestore(), "order1", ACTOR));
    expect(await productQty("p1", "black", "S")).toBe(6);
    expect(await productQty("p2", "red", "L")).toBe(5);
    expect(await allMovements()).toHaveLength(2);
  });

  it("restores stock correctly across multiple variants (colors) of the same product", async () => {
    await seedAdmin("admin1", "admin");
    await seedProduct(
      "p1",
      product([
        { id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 5 }] },
        { id: "red", colorName: "Red", colorHex: "#f00", sizeStock: [{ size: "S", qty: 2 }] },
      ])
    );
    await seedOrder("order1", "pending", [
      { productId: "p1", variantId: "black", name: "Cancel Test Product", qty: 1, price: 100, size: "S", color: "Black" },
      { productId: "p1", variantId: "red", name: "Cancel Test Product", qty: 3, price: 100, size: "S", color: "Red" },
    ]);
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await assertSucceeds(cancelOrderTransaction(admin.firestore(), "order1", ACTOR));
    expect(await productQty("p1", "black", "S")).toBe(6);
    expect(await productQty("p1", "red", "S")).toBe(5);
    expect(await allMovements("p1")).toHaveLength(2);
  });

  it("restores stock correctly across multiple sizes of the same variant", async () => {
    await seedAdmin("admin1", "admin");
    await seedProduct("p1", product([{ id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 5 }, { size: "M", qty: 2 }] }]));
    await seedOrder("order1", "pending", [
      { productId: "p1", variantId: "black", name: "Cancel Test Product", qty: 1, price: 100, size: "S", color: "Black" },
      { productId: "p1", variantId: "black", name: "Cancel Test Product", qty: 2, price: 100, size: "M", color: "Black" },
    ]);
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await assertSucceeds(cancelOrderTransaction(admin.firestore(), "order1", ACTOR));
    expect(await productQty("p1", "black", "S")).toBe(6);
    expect(await productQty("p1", "black", "M")).toBe(4);
  });

  it("combines duplicate (productId, variantId, size) lines into one correctly-summed restoration", async () => {
    await seedAdmin("admin1", "admin");
    await seedProduct("p1", product([{ id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 5 }] }]));
    await seedOrder("order1", "pending", [
      { productId: "p1", variantId: "black", name: "Cancel Test Product", qty: 1, price: 100, size: "S", color: "Black" },
      { productId: "p1", variantId: "black", name: "Cancel Test Product", qty: 2, price: 100, size: "S", color: "Black" },
    ]);
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await assertSucceeds(cancelOrderTransaction(admin.firestore(), "order1", ACTOR));
    // 5 + (1 + 2) = 8, as one movement, not two.
    expect(await productQty("p1", "black", "S")).toBe(8);
    const movements = await allMovements("p1");
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ qtyBefore: 5, qtyChange: 3, qtyAfter: 8 });
  });

  it("restores exactly the order's CURRENT lines, reflecting a prior partial edit, not the original checkout amount", async () => {
    await seedAdmin("admin1", "admin");
    await seedProduct("p1", product([{ id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 5 }] }]));
    // Simulates an order originally placed for qty 3, later reduced to qty 1
    // via updateOrderLines() (already given back qty 2 at edit time) --
    // the order doc's `lines` now says 1, which is exactly what cancellation
    // must restore, not the original 3.
    await seedOrder("order1", "processing", [{ productId: "p1", variantId: "black", name: "Cancel Test Product", qty: 1, price: 100, size: "S", color: "Black" }]);
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await assertSucceeds(cancelOrderTransaction(admin.firestore(), "order1", ACTOR));
    expect(await productQty("p1", "black", "S")).toBe(6);
  });
});

describe("order cancellation: invalid states are rejected, stock untouched", () => {
  beforeEach(async () => {
    await clearFirestore();
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  const invalidStatuses = ["shipped", "delivered", "completed", "refunded", "cancelled"];

  for (const status of invalidStatuses) {
    it(`rejects cancelling a ${status} order and leaves its stock untouched`, async () => {
      await seedAdmin("admin1", "admin");
      await seedProduct("p1", product([{ id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 5 }] }]));
      await seedOrder("order1", status, [{ productId: "p1", variantId: "black", name: "Cancel Test Product", qty: 1, price: 100, size: "S", color: "Black" }]);
      const env = await getTestEnv();
      const admin = env.authenticatedContext("admin1", IDENTIFIED);
      await expect(cancelOrderTransaction(admin.firestore(), "order1", ACTOR)).rejects.toThrow();
      expect(await orderStatus("order1")).toBe(status);
      expect(await productQty("p1", "black", "S")).toBe(5);
      expect(await allMovements("p1")).toHaveLength(0);
    });
  }

  it("rejects cancelling an order that doesn't exist", async () => {
    await seedAdmin("admin1", "admin");
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await expect(cancelOrderTransaction(admin.firestore(), "ghost-order", ACTOR)).rejects.toThrow();
  });
});

describe("order cancellation: data integrity -- no silent partial restoration", () => {
  beforeEach(async () => {
    await clearFirestore();
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  it("fails safely (no writes at all) when a referenced product no longer exists", async () => {
    await seedAdmin("admin1", "admin");
    await seedProduct("p1", product([{ id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 5 }] }]));
    // p2 deliberately never seeded -- simulates a product deleted after the order was placed.
    await seedOrder("order1", "pending", [
      { productId: "p1", variantId: "black", name: "Cancel Test Product", qty: 1, price: 100, size: "S", color: "Black" },
      { productId: "p2", variantId: "x", name: "Deleted Product", qty: 1, price: 100, size: "S", color: "X" },
    ]);
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await expect(cancelOrderTransaction(admin.firestore(), "order1", ACTOR)).rejects.toThrow();
    // The order must stay pending and p1's stock must be completely
    // untouched -- proving the whole transaction rolled back rather than
    // restoring the one line it could safely resolve.
    expect(await orderStatus("order1")).toBe("pending");
    expect(await productQty("p1", "black", "S")).toBe(5);
    expect(await allMovements()).toHaveLength(0);
  });

  it("fails safely when the line's color variant no longer exists on the product", async () => {
    await seedAdmin("admin1", "admin");
    await seedProduct("p1", product([{ id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 5 }] }]));
    await seedOrder("order1", "pending", [{ productId: "p1", variantId: "gold", name: "Cancel Test Product", qty: 1, price: 100, size: "S", color: "Gold" }]);
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await expect(cancelOrderTransaction(admin.firestore(), "order1", ACTOR)).rejects.toThrow();
    expect(await orderStatus("order1")).toBe("pending");
    expect(await productQty("p1", "black", "S")).toBe(5);
  });

  it("fails safely when the line's size no longer exists on the variant", async () => {
    await seedAdmin("admin1", "admin");
    await seedProduct("p1", product([{ id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 5 }] }]));
    await seedOrder("order1", "pending", [{ productId: "p1", variantId: "black", name: "Cancel Test Product", qty: 1, price: 100, size: "XXL", color: "Black" }]);
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await expect(cancelOrderTransaction(admin.firestore(), "order1", ACTOR)).rejects.toThrow();
    expect(await orderStatus("order1")).toBe("pending");
  });

  it("fails safely when the size's stock was never confirmed (qty: null) instead of guessing", async () => {
    await seedAdmin("admin1", "admin");
    await seedProduct("p1", product([{ id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: null }] }]));
    await seedOrder("order1", "pending", [{ productId: "p1", variantId: "black", name: "Cancel Test Product", qty: 1, price: 100, size: "S", color: "Black" }]);
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await expect(cancelOrderTransaction(admin.firestore(), "order1", ACTOR)).rejects.toThrow();
    expect(await orderStatus("order1")).toBe("pending");
    expect(await productQty("p1", "black", "S")).toBe(null);
  });
});

describe("order cancellation: idempotency / concurrency", () => {
  beforeEach(async () => {
    await clearFirestore();
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  it("rejects a second cancellation attempt after the first already succeeded, without double-restoring stock", async () => {
    await seedAdmin("admin1", "admin");
    await seedProduct("p1", product([{ id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 5 }] }]));
    await seedOrder("order1", "pending", [{ productId: "p1", variantId: "black", name: "Cancel Test Product", qty: 2, price: 100, size: "S", color: "Black" }]);
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);

    await assertSucceeds(cancelOrderTransaction(admin.firestore(), "order1", ACTOR));
    expect(await productQty("p1", "black", "S")).toBe(7);

    // Second attempt: the order's fresh status is now "cancelled", so the
    // in-transaction guard must reject this outright.
    await expect(cancelOrderTransaction(admin.firestore(), "order1", ACTOR)).rejects.toThrow();
    expect(await productQty("p1", "black", "S")).toBe(7); // unchanged, not 9
    expect(await allMovements("p1")).toHaveLength(1); // still just the one movement
  });

  it("simulates a double-click / two browser tabs: two concurrent cancellation attempts on the same order restore stock exactly once", async () => {
    await seedAdmin("admin1", "admin");
    await seedProduct("p1", product([{ id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 5 }] }]));
    await seedOrder("order1", "pending", [{ productId: "p1", variantId: "black", name: "Cancel Test Product", qty: 2, price: 100, size: "S", color: "Black" }]);
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);

    const attempt = () =>
      cancelOrderTransaction(admin.firestore(), "order1", ACTOR).then(
        () => ({ ok: true as const }),
        (err) => ({ ok: false as const, err })
      );
    const [r1, r2] = await Promise.all([attempt(), attempt()]);
    const successes = [r1, r2].filter((r) => r.ok);
    expect(successes).toHaveLength(1);
    expect(await orderStatus("order1")).toBe("cancelled");
    expect(await productQty("p1", "black", "S")).toBe(7); // 5 + 2, restored exactly once
    expect(await allMovements("p1")).toHaveLength(1);
  });

  it("simulates two different admins racing to cancel the same order: exactly one succeeds", async () => {
    await seedAdmin("admin1", "admin");
    await seedAdmin("admin2", "admin");
    await seedProduct("p1", product([{ id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 10 }] }]));
    await seedOrder("order1", "processing", [{ productId: "p1", variantId: "black", name: "Cancel Test Product", qty: 3, price: 100, size: "S", color: "Black" }]);
    const env = await getTestEnv();
    const admin1 = env.authenticatedContext("admin1", IDENTIFIED);
    const admin2 = env.authenticatedContext("admin2", IDENTIFIED);

    const attempt = (fs: Firestore, actor: { email: string; displayName: string }) =>
      cancelOrderTransaction(fs, "order1", actor).then(
        () => ({ ok: true as const }),
        (err) => ({ ok: false as const, err })
      );
    const [r1, r2] = await Promise.all([
      attempt(admin1.firestore(), { email: "admin1@example.com", displayName: "admin1" }),
      attempt(admin2.firestore(), { email: "admin2@example.com", displayName: "admin2" }),
    ]);
    expect([r1, r2].filter((r) => r.ok)).toHaveLength(1);
    expect(await productQty("p1", "black", "S")).toBe(13); // restored exactly once
    expect(await allMovements("p1")).toHaveLength(1);
  });

  it("cancellation racing with an order-line edit on the same order: exactly one operation wins, no corrupted end state", async () => {
    await seedAdmin("admin1", "admin");
    await seedProduct("p1", product([{ id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 5 }] }]));
    await seedOrder("order1", "pending", [{ productId: "p1", variantId: "black", name: "Cancel Test Product", qty: 2, price: 100, size: "S", color: "Black" }]);
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    const fs = admin.firestore();

    // Mirrors adminOrderEdit.ts's updateOrderLines(): reduces the line's qty
    // from 2 to 1, giving back exactly 1 unit, rewrites order.lines, AND
    // records the same stockMovements entry the real function writes for
    // that give-back (reason: "order_edit") -- pre-existing gap found while
    // verifying Phase A: this helper previously omitted that write, so the
    // "edit wins the race" branch below could never actually pass its own
    // assertion. Unrelated to Phase A's own attribution fields; fixed here
    // since Phase A's slightly heavier orders/{id} update rule shifted this
    // race's timing enough to expose it far more often than before.
    const editAttempt = () =>
      runTransaction(fs, async (tx) => {
        const orderRef = doc(fs, "orders/order1");
        const orderSnap = await tx.get(orderRef);
        const order = orderSnap.data() as AdminOrder;
        if (order.status !== "pending" && order.status !== "processing") throw new Error("not editable");
        const productRef = doc(fs, "products/p1");
        const productSnap = await tx.get(productRef);
        const p = productSnap.data() as { name: string; colorVariants: ColorVariant[] };
        const before = p.colorVariants.find((v) => v.id === "black")!.sizeStock.find((s) => s.size === "S")!.qty ?? 0;
        const newColorVariants = p.colorVariants.map((v) => ({ ...v, sizeStock: v.sizeStock.map((s) => (s.size === "S" ? { ...s, qty: (s.qty ?? 0) + 1 } : s)) }));
        tx.update(productRef, { colorVariants: newColorVariants, updatedAt: new Date() });
        tx.set(doc(collection(fs, "stockMovements")), {
          productId: "p1", productName: "Cancel Test Product", variantId: "black", colorName: "Black", size: "S",
          qtyBefore: before, qtyChange: 1, qtyAfter: before + 1,
          reason: "order_edit", source: "admin", actorEmail: ACTOR.email, actorName: ACTOR.displayName,
          orderId: "order1", orderNumber: order.orderNumber, createdAt: new Date(),
        });
        tx.update(orderRef, {
          lines: [{ productId: "p1", variantId: "black", name: "Cancel Test Product", qty: 1, price: 100, size: "S", color: "Black" }],
          subtotal: 100, total: 100, updatedAt: new Date(),
        });
      }).then(
        () => ({ ok: true as const, kind: "edit" as const }),
        (err) => ({ ok: false as const, kind: "edit" as const, err })
      );

    const cancelAttempt = () =>
      cancelOrderTransaction(fs, "order1", ACTOR).then(
        () => ({ ok: true as const, kind: "cancel" as const }),
        (err) => ({ ok: false as const, kind: "cancel" as const, err })
      );

    const [editResult, cancelResult] = await Promise.all([editAttempt(), cancelAttempt()]);

    const finalStatus = await orderStatus("order1");
    const finalQty = await productQty("p1", "black", "S");
    const movements = await allMovements("p1");

    // Firestore's runTransaction() automatically retries on a write
    // conflict rather than immediately failing the loser -- edit and cancel
    // are not mutually exclusive by business rule (only cancel-vs-cancel or
    // edit-vs-emptying are, per the other tests in this suite), so BOTH can
    // legitimately succeed: whichever commits first, the other's retry
    // simply re-reads the new state and proceeds from there. The only way
    // edit can genuinely fail is if cancel's commit (which flips status
    // away from pending/processing) lands before edit's own status guard
    // re-checks fresh state on a retry.
    if (editResult.ok) {
      // Edit committed while status was still pending/processing (whether
      // before or interleaved with cancel's retries) -- cancel, reading
      // fresh, then restored exactly the post-edit remaining qty (1), on
      // top of edit's own give-back (1) for the reduction from 2 to 1.
      expect(cancelResult.ok).toBe(true);
      expect(finalStatus).toBe("cancelled");
      expect(movements.map((m) => m.reason).sort()).toEqual(["order_cancelled", "order_edit"]);
    } else {
      // Cancel committed first, using the original (pre-edit) lines --
      // edit's later retry saw status already "cancelled" and correctly
      // refused (the existing "Only pending or processing orders can be
      // edited" guard, unmodified by this feature).
      expect(cancelResult.ok).toBe(true);
      expect(finalStatus).toBe("cancelled");
      expect(movements.map((m) => m.reason)).toEqual(["order_cancelled"]);
    }

    // The single invariant that must hold no matter which interleaving
    // occurred: the full originally-reserved quantity (2) is given back
    // exactly once in total -- never doubled (9), never lost (6 stuck
    // mid-way with the order still open), never dropped entirely (5).
    expect(finalQty).toBe(7);
    expect(movements.reduce((sum, m) => sum + (m.qtyChange as number), 0)).toBe(2);
  });
});

describe("order cancellation: role/permission boundary", () => {
  beforeEach(async () => {
    await clearFirestore();
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  it("lets an owner cancel and restore stock, same as an admin", async () => {
    await seedAdmin("owner1", "owner");
    await seedProduct("p1", product([{ id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 5 }] }]));
    await seedOrder("order1", "pending", [{ productId: "p1", variantId: "black", name: "Cancel Test Product", qty: 1, price: 100, size: "S", color: "Black" }]);
    const env = await getTestEnv();
    const owner = env.authenticatedContext("owner1", IDENTIFIED);
    await assertSucceeds(cancelOrderTransaction(owner.firestore(), "order1", { email: "owner1@example.com", displayName: "owner1" }));
    expect(await orderStatus("order1")).toBe("cancelled");
  });

  it("rejects a cashier from cancelling an order (status changes stay owner/admin-only)", async () => {
    await seedAdmin("cashier1", "cashier");
    await seedProduct("p1", product([{ id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 5 }] }]));
    await seedOrder("order1", "pending", [{ productId: "p1", variantId: "black", name: "Cancel Test Product", qty: 1, price: 100, size: "S", color: "Black" }]);
    const env = await getTestEnv();
    const cashier = env.authenticatedContext("cashier1", IDENTIFIED);
    await assertFails(cancelOrderTransaction(cashier.firestore(), "order1", { email: "cashier1@example.com", displayName: "cashier1" }));
    expect(await orderStatus("order1")).toBe("pending");
    expect(await productQty("p1", "black", "S")).toBe(5);
  });

  it("rejects an editor from cancelling an order (catalog-scoped, never orders)", async () => {
    await seedAdmin("editor1", "editor");
    await seedProduct("p1", product([{ id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 5 }] }]));
    await seedOrder("order1", "pending", [{ productId: "p1", variantId: "black", name: "Cancel Test Product", qty: 1, price: 100, size: "S", color: "Black" }]);
    const env = await getTestEnv();
    const editor = env.authenticatedContext("editor1", IDENTIFIED);
    await assertFails(cancelOrderTransaction(editor.firestore(), "order1", { email: "editor1@example.com", displayName: "editor1" }));
    expect(await orderStatus("order1")).toBe("pending");
    expect(await productQty("p1", "black", "S")).toBe(5);
  });

  it("rejects a viewer from cancelling an order", async () => {
    await seedAdmin("viewer1", "viewer");
    await seedProduct("p1", product([{ id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 5 }] }]));
    await seedOrder("order1", "pending", [{ productId: "p1", variantId: "black", name: "Cancel Test Product", qty: 1, price: 100, size: "S", color: "Black" }]);
    const env = await getTestEnv();
    const viewer = env.authenticatedContext("viewer1", IDENTIFIED);
    await assertFails(cancelOrderTransaction(viewer.firestore(), "order1", { email: "viewer1@example.com", displayName: "viewer1" }));
  });
});
