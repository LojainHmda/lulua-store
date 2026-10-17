import { assertFails, assertSucceeds } from "./testing";
import { collection, doc, getDocs, query, serverTimestamp, setDoc, updateDoc } from "../../src/db/firestore";
import { afterAll, beforeEach, describe, it } from "vitest";
import { clearFirestore, getTestEnv, teardownTestEnv } from "./setup";
import { seedBranchSetup } from "./branchFixtures";

// Phase A: employee action attribution -- these tests exercise the
// firestore.rules changes directly (orderActorUidFieldsValid(),
// stockMovementActorUidValid(), registerSessions' frozen opener identity +
// closedByUid check, returns' processedByUid/resolvedByUid checks,
// activityLogs' mandatory actorUid), independent of the application
// transaction code. The point of every "rejects a spoofed ...Uid" test
// below is the exact requirement from the brief: an employee must never be
// able to attribute an action to a different employee by editing a request
// payload.

const IDENTIFIED = { firebase: { sign_in_provider: "password" as const } };

async function seedAdmin(uid: string, role: string) {
  const env = await getTestEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `admins/${uid}`), { email: `${uid}@example.com`, displayName: uid, role, active: true });
  });
}

async function seedOrder(orderId: string, overrides: Record<string, unknown> = {}) {
  const env = await getTestEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `orders/${orderId}`), {
      orderNumber: `SIS-${orderId.toUpperCase()}`,
      customerName: "Test Customer",
      customerEmail: "test@example.com",
      lines: [],
      subtotal: 0,
      shipping: 0,
      total: 0,
      status: "pending",
      ...overrides,
    });
  });
}

describe("orders: statusUpdatedBy* attribution", () => {
  beforeEach(async () => {
    await clearFirestore();
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  it("lets an admin stamp their own uid when changing status", async () => {
    await seedAdmin("admin1", "admin");
    await seedOrder("o1");
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await assertSucceeds(
      updateDoc(doc(admin.firestore(), "orders/o1"), {
        status: "processing",
        statusUpdatedByUid: "admin1",
        statusUpdatedByEmail: "admin1@example.com",
        statusUpdatedByName: "admin1",
        statusUpdatedAt: serverTimestamp(),
      })
    );
  });

  it("rejects an admin attributing a status change to a different employee's uid", async () => {
    await seedAdmin("admin1", "admin");
    await seedAdmin("admin2", "admin");
    await seedOrder("o1");
    const env = await getTestEnv();
    const admin1 = env.authenticatedContext("admin1", IDENTIFIED);
    await assertFails(
      updateDoc(doc(admin1.firestore(), "orders/o1"), {
        status: "processing",
        statusUpdatedByUid: "admin2",
        statusUpdatedByEmail: "admin2@example.com",
        statusUpdatedByName: "admin2",
      })
    );
  });

  it("rejects a plain status update with no statusUpdatedByUid at all when one is expected -- omission alone still succeeds (field is optional), but a WRONG value never does", async () => {
    // Documents the distinction: omitting the field entirely is fine
    // (checked elsewhere), only a mismatched value is rejected.
    await seedAdmin("admin1", "admin");
    await seedOrder("o1");
    const env = await getTestEnv();
    const admin1 = env.authenticatedContext("admin1", IDENTIFIED);
    await assertSucceeds(updateDoc(doc(admin1.firestore(), "orders/o1"), { status: "processing" }));
  });
});

describe("orders: cancelledBy* attribution", () => {
  beforeEach(async () => {
    await clearFirestore();
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  it("lets an admin cancel with their own uid", async () => {
    await seedAdmin("admin1", "admin");
    await seedOrder("o1");
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await assertSucceeds(
      updateDoc(doc(admin.firestore(), "orders/o1"), {
        status: "cancelled",
        cancelledByUid: "admin1",
        cancelledByEmail: "admin1@example.com",
        cancelledByName: "admin1",
        cancelledAt: serverTimestamp(),
      })
    );
  });

  it("rejects cancelling with a spoofed cancelledByUid naming a different employee", async () => {
    await seedAdmin("admin1", "admin");
    await seedAdmin("owner1", "owner");
    await seedOrder("o1");
    const env = await getTestEnv();
    const admin1 = env.authenticatedContext("admin1", IDENTIFIED);
    await assertFails(
      updateDoc(doc(admin1.firestore(), "orders/o1"), {
        status: "cancelled",
        cancelledByUid: "owner1",
        cancelledByEmail: "owner1@example.com",
        cancelledByName: "owner1",
      })
    );
  });
});

describe("orders: linesUpdatedBy* / internalNoteUpdatedBy* / customerShippingUpdatedBy* attribution", () => {
  beforeEach(async () => {
    await clearFirestore();
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  it("lets an admin stamp their own uid on a line-item edit", async () => {
    await seedAdmin("admin1", "admin");
    await seedOrder("o1");
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await assertSucceeds(
      updateDoc(doc(admin.firestore(), "orders/o1"), {
        lines: [],
        linesUpdatedByUid: "admin1",
        linesUpdatedByEmail: "admin1@example.com",
        linesUpdatedByName: "admin1",
      })
    );
  });

  it("rejects a line-item edit attributed to a spoofed uid", async () => {
    await seedAdmin("admin1", "admin");
    await seedOrder("o1");
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await assertFails(updateDoc(doc(admin.firestore(), "orders/o1"), { lines: [], linesUpdatedByUid: "someone-else" }));
  });

  it("lets an admin save an internal note with their own uid", async () => {
    await seedAdmin("admin1", "admin");
    await seedOrder("o1");
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await assertSucceeds(
      updateDoc(doc(admin.firestore(), "orders/o1"), {
        notes: "call before delivery",
        internalNoteUpdatedByUid: "admin1",
        internalNoteUpdatedByEmail: "admin1@example.com",
        internalNoteUpdatedByName: "admin1",
      })
    );
  });

  it("rejects an internal note update attributed to a spoofed uid", async () => {
    await seedAdmin("admin1", "admin");
    await seedOrder("o1");
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await assertFails(updateDoc(doc(admin.firestore(), "orders/o1"), { notes: "x", internalNoteUpdatedByUid: "not-me" }));
  });

  it("lets an admin save customer/shipping edits with their own uid", async () => {
    await seedAdmin("admin1", "admin");
    await seedOrder("o1");
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await assertSucceeds(
      updateDoc(doc(admin.firestore(), "orders/o1"), {
        customerName: "New Name",
        customerShippingUpdatedByUid: "admin1",
        customerShippingUpdatedByEmail: "admin1@example.com",
        customerShippingUpdatedByName: "admin1",
      })
    );
  });

  it("rejects a customer/shipping edit attributed to a spoofed uid", async () => {
    await seedAdmin("admin1", "admin");
    await seedOrder("o1");
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await assertFails(updateDoc(doc(admin.firestore(), "orders/o1"), { customerName: "X", customerShippingUpdatedByUid: "not-me" }));
  });
});

// Matches the keys the tests below write into lineBranchStockNotes --
// isValidCashierBranchNoteUpdate() only actually validates a map key that
// corresponds to one of the order's own real lines (see its own comment in
// firestore.rules for why), so every test that needs a specific key to be
// genuinely checked (not just vacuously skipped) must seed a matching line.
const TWO_TEST_LINES = [
  { productId: "p1", variantId: "v1", name: "Line 1", qty: 1, price: 10, size: "M", color: "Navy" },
  { productId: "p2", variantId: "v2", name: "Line 2", qty: 1, price: 10, size: "S", color: "Beige" },
];

describe("orders: nonDeliveryMarkedByUid / branchStockNoteUpdatedByUid attribution", () => {
  beforeEach(async () => {
    await clearFirestore();
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  it("lets an admin mark non-delivery with their own uid", async () => {
    await seedAdmin("admin1", "admin");
    await seedOrder("o1");
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await assertSucceeds(
      updateDoc(doc(admin.firestore(), "orders/o1"), {
        nonDeliveryFlagged: true,
        nonDeliveryMarkedBy: "admin1@example.com",
        nonDeliveryMarkedByName: "admin1",
        nonDeliveryMarkedByUid: "admin1",
      })
    );
  });

  it("rejects marking non-delivery attributed to a spoofed uid", async () => {
    await seedAdmin("admin1", "admin");
    await seedOrder("o1");
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await assertFails(
      updateDoc(doc(admin.firestore(), "orders/o1"), { nonDeliveryFlagged: true, nonDeliveryMarkedByUid: "someone-else" })
    );
  });

  it("lets a cashier save a branch stock note with their own uid (the narrow cashier exception)", async () => {
    await seedAdmin("cashier1", "cashier");
    await seedOrder("o1", { lines: TWO_TEST_LINES });
    const env = await getTestEnv();
    const cashier = env.authenticatedContext("cashier1", IDENTIFIED);
    await assertSucceeds(
      updateDoc(doc(cashier.firestore(), "orders/o1"), {
        lineBranchStockNotes: {
          "p1::v1::M": {
            note: "check branch 2",
            updatedByUid: "cashier1",
            updatedByEmail: "cashier1@example.com",
            updatedByName: "cashier1",
            updatedAt: serverTimestamp(),
          },
        },
      })
    );
  });

  it("lets a second cashier add a note for a different line without disturbing the first line's existing entry", async () => {
    await seedAdmin("cashier1", "cashier");
    await seedAdmin("cashier2", "cashier");
    await seedOrder("o1", {
      lines: TWO_TEST_LINES,
      lineBranchStockNotes: {
        "p1::v1::M": { note: "from cashier1", updatedByUid: "cashier1", updatedByEmail: "cashier1@example.com", updatedByName: "cashier1", updatedAt: serverTimestamp() },
      },
    });
    const env = await getTestEnv();
    const cashier2 = env.authenticatedContext("cashier2", IDENTIFIED);
    await assertSucceeds(
      updateDoc(doc(cashier2.firestore(), "orders/o1"), {
        lineBranchStockNotes: {
          "p1::v1::M": { note: "from cashier1", updatedByUid: "cashier1", updatedByEmail: "cashier1@example.com", updatedByName: "cashier1", updatedAt: serverTimestamp() },
          "p2::v2::S": { note: "from cashier2", updatedByUid: "cashier2", updatedByEmail: "cashier2@example.com", updatedByName: "cashier2", updatedAt: serverTimestamp() },
        },
      })
    );
  });

  // Per-entry attribution isn't enforced at the rules layer for this map --
  // see isValidCashierBranchNoteUpdate()'s own doc comment in
  // firestore.rules for why every per-entry validation design tried here
  // hit Firestore's 1000-expression ceiling on nothing more than two
  // already-noted lines. Documented as an accepted residual risk (this
  // field is pure display text, never read by any stock/price/status
  // logic), not a gap to silently ignore -- unlike every OTHER attribution
  // field this describe block covers, which remain fully enforced.
  it("does not enforce per-entry uid attribution on lineBranchStockNotes at the rules layer (documented residual risk)", async () => {
    await seedAdmin("cashier1", "cashier");
    await seedAdmin("cashier2", "cashier");
    await seedOrder("o1", { lines: TWO_TEST_LINES });
    const env = await getTestEnv();
    const cashier1 = env.authenticatedContext("cashier1", IDENTIFIED);
    await assertSucceeds(
      updateDoc(doc(cashier1.firestore(), "orders/o1"), {
        lineBranchStockNotes: {
          "p1::v1::M": { note: "x", updatedByUid: "cashier2", updatedByEmail: "cashier1@example.com", updatedByName: "cashier1", updatedAt: serverTimestamp() },
        },
      })
    );
  });

  it("still rejects a cashier's branch-note update if it also touches an out-of-scope field, even with a correct uid", async () => {
    await seedAdmin("cashier1", "cashier");
    await seedOrder("o1");
    const env = await getTestEnv();
    const cashier = env.authenticatedContext("cashier1", IDENTIFIED);
    await assertFails(
      updateDoc(doc(cashier.firestore(), "orders/o1"), {
        lineBranchStockNotes: {
          "p1::v1::M": { note: "x", updatedByUid: "cashier1", updatedByEmail: "cashier1@example.com", updatedByName: "cashier1", updatedAt: serverTimestamp() },
        },
        status: "cancelled",
      })
    );
  });
});

describe("orders: createdByUid (manual/staff order) and cashierUid (POS order) on create", () => {
  beforeEach(async () => {
    await clearFirestore();
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  it("lets an admin create a manual order attributed to their own uid", async () => {
    await seedAdmin("admin1", "admin");
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await assertSucceeds(
      setDoc(doc(admin.firestore(), "orders/manual1"), {
        orderNumber: "SIS-MANUAL1",
        customerName: "Walk-in",
        lines: [],
        subtotal: 0,
        shipping: 0,
        total: 0,
        status: "pending",
        createdByUid: "admin1",
        createdByEmail: "admin1@example.com",
        createdByName: "admin1",
      })
    );
  });

  it("rejects creating a manual order attributed to a different employee's uid", async () => {
    await seedAdmin("admin1", "admin");
    await seedAdmin("admin2", "admin");
    const env = await getTestEnv();
    const admin1 = env.authenticatedContext("admin1", IDENTIFIED);
    await assertFails(
      setDoc(doc(admin1.firestore(), "orders/manual1"), {
        orderNumber: "SIS-MANUAL1",
        customerName: "Walk-in",
        lines: [],
        subtotal: 0,
        shipping: 0,
        total: 0,
        status: "pending",
        createdByUid: "admin2",
      })
    );
  });

  it("lets a cashier create a POS order attributed to their own uid via cashierUid", async () => {
    const { branchId, sessionId } = await seedBranchSetup({ uid: "cashier1" });
    const env = await getTestEnv();
    const cashier = env.authenticatedContext("cashier1", IDENTIFIED);
    await assertSucceeds(
      setDoc(doc(cashier.firestore(), "orders/pos1"), {
        orderNumber: "SIS-POS1",
        customerName: "Walk-in customer",
        customerEmail: "",
        lines: [],
        subtotal: 0,
        shipping: 0,
        total: 0,
        status: "completed",
        source: "pos",
        branchId,
        registerSessionId: sessionId,
        cashierUid: "cashier1",
        cashierEmail: "cashier1@example.com",
        cashierName: "cashier1",
      })
    );
  });

  it("rejects a POS order creation claiming a different cashier's uid", async () => {
    await seedAdmin("cashier1", "cashier");
    await seedAdmin("cashier2", "cashier");
    const env = await getTestEnv();
    const cashier1 = env.authenticatedContext("cashier1", IDENTIFIED);
    await assertFails(
      setDoc(doc(cashier1.firestore(), "orders/pos1"), {
        orderNumber: "SIS-POS1",
        customerName: "Walk-in customer",
        lines: [],
        subtotal: 0,
        shipping: 0,
        total: 0,
        status: "completed",
        source: "pos",
        cashierUid: "cashier2",
      })
    );
  });

  it("rejects a web/customer checkout create that tries to sneak in a cashierUid (structurally excluded by isValidCheckoutOrder's own field allowlist, unrelated to Phase A's own check)", async () => {
    const env = await getTestEnv();
    const customer = env.authenticatedContext("customer1", IDENTIFIED);
    // checkoutClaims doc intentionally omitted -- this attempt is expected
    // to fail on the field-allowlist alone before it would ever reach the
    // (also-failing) claim cross-check.
    await assertFails(
      setDoc(doc(customer.firestore(), "orders/web1"), {
        orderNumber: "SIS-WEB1",
        customerId: "customer1",
        customerName: "A Customer",
        customerEmail: "c@example.com",
        lines: [{ productId: "p1", variantId: "v1", size: "M", qty: 1, price: 10, name: "x", color: "black" }],
        subtotal: 10,
        shipping: 0,
        total: 10,
        status: "pending",
        source: "web",
        deliveryZoneId: "zone1",
        cashierUid: "customer1",
      })
    );
  });
});

describe("stockMovements: actorUid attribution", () => {
  beforeEach(async () => {
    await clearFirestore();
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  function movement(overrides: Record<string, unknown> = {}) {
    return {
      productId: "p1",
      productName: "Test Product",
      variantId: "black",
      colorName: "Black",
      size: "M",
      qtyBefore: 5,
      qtyChange: -1,
      qtyAfter: 4,
      reason: "manual_adjustment",
      source: "admin",
      ...overrides,
    };
  }

  it("lets an admin (editor-or-above, fully-trusted branch) write a movement naming their own uid", async () => {
    await seedAdmin("admin1", "admin");
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await assertSucceeds(setDoc(doc(admin.firestore(), "stockMovements/m1"), movement({ actorUid: "admin1", actorEmail: "admin1@example.com", actorName: "admin1" })));
  });

  it("rejects an admin writing a movement naming a different employee's uid", async () => {
    await seedAdmin("admin1", "admin");
    await seedAdmin("admin2", "admin");
    const env = await getTestEnv();
    const admin1 = env.authenticatedContext("admin1", IDENTIFIED);
    await assertFails(setDoc(doc(admin1.firestore(), "stockMovements/m1"), movement({ actorUid: "admin2" })));
  });

  it("still lets a movement with no actorUid at all through the trusted editor/admin branch (e.g. a hypothetical anonymized entry)", async () => {
    await seedAdmin("admin1", "admin");
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await assertSucceeds(setDoc(doc(admin.firestore(), "stockMovements/m1"), movement()));
  });

  it("rejects a plausible-sale movement (POS) claiming a different cashier's uid", async () => {
    await seedAdmin("cashier1", "cashier");
    await seedAdmin("cashier2", "cashier");
    const env = await getTestEnv();
    const cashier1 = env.authenticatedContext("cashier1", IDENTIFIED);
    await assertFails(
      setDoc(
        doc(cashier1.firestore(), "stockMovements/m1"),
        movement({ reason: "sale", source: "pos", qtyChange: -1, actorUid: "cashier2" })
      )
    );
  });
});

describe("registerSessions: closedByUid attribution and frozen opener identity", () => {
  beforeEach(async () => {
    await clearFirestore();
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  function openSessionDoc(cashierId: string, overrides: Record<string, unknown> = {}) {
    return {
      cashierId,
      cashierName: "Cashier One",
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

  it("lets a cashier close their own session, naming their own uid", async () => {
    await seedAdmin("cashier1", "cashier");
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "registerSessions/s1"), openSessionDoc("cashier1"));
    });
    const cashier = env.authenticatedContext("cashier1", IDENTIFIED);
    await assertSucceeds(
      updateDoc(doc(cashier.firestore(), "registerSessions/s1"), {
        status: "closed",
        closedByUid: "cashier1",
        closedByEmail: "cashier1@example.com",
        closedByName: "Cashier One",
      })
    );
  });

  it("rejects closing a session with a spoofed closedByUid naming a different employee", async () => {
    await seedAdmin("cashier1", "cashier");
    await seedAdmin("cashier2", "cashier");
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "registerSessions/s1"), openSessionDoc("cashier1"));
    });
    const cashier1 = env.authenticatedContext("cashier1", IDENTIFIED);
    await assertFails(updateDoc(doc(cashier1.firestore(), "registerSessions/s1"), { status: "closed", closedByUid: "cashier2" }));
  });

  it("lets an admin close someone else's session, naming their own (the admin's) uid", async () => {
    await seedAdmin("cashier1", "cashier");
    await seedAdmin("admin1", "admin");
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "registerSessions/s1"), openSessionDoc("cashier1"));
    });
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await assertSucceeds(updateDoc(doc(admin.firestore(), "registerSessions/s1"), { status: "closed", closedByUid: "admin1" }));
  });

  it("rejects rewriting cashierId (the opener's identity) on update, even by an admin", async () => {
    await seedAdmin("cashier1", "cashier");
    await seedAdmin("admin1", "admin");
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "registerSessions/s1"), openSessionDoc("cashier1"));
    });
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await assertFails(updateDoc(doc(admin.firestore(), "registerSessions/s1"), { cashierId: "admin1" }));
  });

  it("rejects rewriting cashierName on update", async () => {
    await seedAdmin("cashier1", "cashier");
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "registerSessions/s1"), openSessionDoc("cashier1"));
    });
    const cashier = env.authenticatedContext("cashier1", IDENTIFIED);
    await assertFails(updateDoc(doc(cashier.firestore(), "registerSessions/s1"), { cashierName: "Someone Else" }));
  });
});

describe("returns: processedByUid / resolvedByUid attribution", () => {
  beforeEach(async () => {
    await clearFirestore();
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  const DEFAULT_LINE = { productId: "prod1", variantId: "black", name: "Test Dress", color: "Black", size: "M", qty: 5, price: 100 };

  async function seedOrderForReturn(orderId: string) {
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), `orders/${orderId}`), {
        orderNumber: "SIS-TEST1",
        customerName: "Test Customer",
        customerEmail: "test@example.com",
        lines: [DEFAULT_LINE],
        subtotal: 100,
        shipping: 0,
        total: 100,
        status: "shipped",
      });
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

  async function submitReturnWithCounter(fs: import("../../src/db/firestore").Firestore, returnId: string, data: Record<string, unknown>) {
    const { runTransaction } = await import("../../src/db/firestore");
    const cId = `${data.orderId}::${data.productId}::${data.variantId}::${data.size}`;
    return runTransaction(fs, async (tx) => {
      const counterRef = doc(fs, "returnCounters", cId);
      const counterSnap = await tx.get(counterRef);
      const before = counterSnap.exists() ? ((counterSnap.data()!.returnedQty as number) ?? 0) : 0;
      tx.set(counterRef, {
        orderId: data.orderId,
        productId: data.productId,
        variantId: data.variantId,
        size: data.size,
        returnedQty: before + (data.qty as number),
      });
      tx.set(doc(fs, "returns", returnId), data);
    });
  }

  it("lets a cashier log a return intake naming their own uid via processedByUid", async () => {
    await seedAdmin("cashier1", "cashier");
    await seedOrderForReturn("order1");
    const env = await getTestEnv();
    const cashier = env.authenticatedContext("cashier1", IDENTIFIED);
    await assertSucceeds(submitReturnWithCounter(cashier.firestore(), "r1", quarantineDoc({ processedByUid: "cashier1" })));
  });

  it("rejects a return intake with a spoofed processedByUid naming a different employee", async () => {
    await seedAdmin("cashier1", "cashier");
    await seedAdmin("cashier2", "cashier");
    await seedOrderForReturn("order1");
    const env = await getTestEnv();
    const cashier1 = env.authenticatedContext("cashier1", IDENTIFIED);
    await assertFails(submitReturnWithCounter(cashier1.firestore(), "r1", quarantineDoc({ processedByUid: "cashier2" })));
  });

  it("lets an admin resolve a return naming their own uid via resolvedByUid", async () => {
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
        resolvedByUid: "admin1",
      })
    );
  });

  it("rejects resolving a return with a spoofed resolvedByUid naming a different employee", async () => {
    await seedAdmin("admin1", "admin");
    await seedAdmin("owner1", "owner");
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "returns/r1"), quarantineDoc());
    });
    const admin1 = env.authenticatedContext("admin1", IDENTIFIED);
    await assertFails(
      updateDoc(doc(admin1.firestore(), "returns/r1"), {
        status: "resolved",
        disposition: "good",
        restocked: true,
        resolvedByUid: "owner1",
      })
    );
  });
});

describe("activityLogs: mandatory, non-spoofable actorUid", () => {
  beforeEach(async () => {
    await clearFirestore();
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  function logEntry(overrides: Record<string, unknown> = {}) {
    return { actorEmail: "admin1@example.com", actorName: "admin1", action: "product.created", target: "Test Product", ...overrides };
  }

  it("lets an admin write a log entry naming their own uid", async () => {
    await seedAdmin("admin1", "admin");
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await assertSucceeds(setDoc(doc(admin.firestore(), "activityLogs/log1"), logEntry({ actorUid: "admin1" })));
  });

  it("rejects a log entry with no actorUid at all -- it is now mandatory, not optional", async () => {
    await seedAdmin("admin1", "admin");
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await assertFails(setDoc(doc(admin.firestore(), "activityLogs/log1"), logEntry()));
  });

  it("rejects a log entry falsely attributing an action to a different employee's uid", async () => {
    await seedAdmin("admin1", "admin");
    await seedAdmin("owner1", "owner");
    const env = await getTestEnv();
    const admin1 = env.authenticatedContext("admin1", IDENTIFIED);
    await assertFails(
      setDoc(doc(admin1.firestore(), "activityLogs/log1"), logEntry({ actorUid: "owner1", actorName: "owner1", actorEmail: "owner1@example.com" }))
    );
  });

  it("rejects even the lowest-privileged admin-level role (viewer) from spoofing another employee's uid", async () => {
    await seedAdmin("viewer1", "viewer");
    await seedAdmin("owner1", "owner");
    const env = await getTestEnv();
    const viewer = env.authenticatedContext("viewer1", IDENTIFIED);
    await assertFails(setDoc(doc(viewer.firestore(), "activityLogs/log1"), logEntry({ actorUid: "owner1" })));
  });

  it("still lets a viewer write a log entry naming their own (correct) uid -- isAnyAdmin() itself is unchanged", async () => {
    await seedAdmin("viewer1", "viewer");
    const env = await getTestEnv();
    const viewer = env.authenticatedContext("viewer1", IDENTIFIED);
    await assertSucceeds(setDoc(doc(viewer.firestore(), "activityLogs/log1"), logEntry({ actorUid: "viewer1", actorName: "viewer1", actorEmail: "viewer1@example.com" })));
  });

  it("entries remain immutable and unreadable-by-non-admin exactly as before (unchanged behavior)", async () => {
    await seedAdmin("admin1", "admin");
    await seedAdmin("cashier1", "cashier");
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "activityLogs/log1"), logEntry({ actorUid: "admin1" }));
    });
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await assertFails(updateDoc(doc(admin.firestore(), "activityLogs/log1"), { target: "changed" }));
    // A cashier is admin-level (isAnyAdmin()) but read requires
    // isAdminOrAbove() -- this must be denied, not just return empty.
    const cashier = env.authenticatedContext("cashier1", IDENTIFIED);
    await assertFails(getDocs(query(collection(cashier.firestore(), "activityLogs"))));
  });
});
