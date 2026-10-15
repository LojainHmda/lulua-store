import { assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, getDoc, runTransaction, setDoc, updateDoc } from "firebase/firestore";
import type { Firestore } from "firebase/firestore";
import { afterAll, beforeEach, describe, it } from "vitest";
import { clearFirestore, getTestEnv, teardownTestEnv } from "./setup";
import { seedBranchSetup } from "./branchFixtures";

const IDENTIFIED = { firebase: { sign_in_provider: "password" as const } };
const ANONYMOUS = { firebase: { sign_in_provider: "anonymous" as const } };

interface SizeStock {
  size: string;
  qty: number;
}
interface ColorVariant {
  id: string;
  colorName: string;
  colorHex: string;
  sizeStock: SizeStock[];
}

const PRODUCT = {
  name: "Test Dress",
  slug: "test-dress",
  price: 100,
  status: "active",
  colorVariants: [
    { id: "black", colorName: "Black", colorHex: "#000000", sizeStock: [{ size: "S", qty: 5 }, { size: "M", qty: 3 }] },
    { id: "red", colorName: "Red", colorHex: "#ff0000", sizeStock: [{ size: "S", qty: 2 }] },
  ] as ColorVariant[],
};

const LEGACY_PRODUCT = {
  name: "Legacy Dress",
  slug: "legacy-dress",
  price: 80,
  status: "active",
  colorName: "Black",
  colorHex: "#000000",
  imageId: "abc123",
  stock: [{ size: "S", qty: 4 }, { size: "M", qty: 0 }],
};

function decrement(variants: ColorVariant[], variantId: string, size: string, qty: number): ColorVariant[] {
  return variants.map((v) =>
    v.id === variantId
      ? { ...v, sizeStock: v.sizeStock.map((s) => (s.size === size ? { ...s, qty: s.qty - qty } : s)) }
      : v
  );
}

async function seedProduct(id = "prod1", data: Record<string, unknown> = PRODUCT) {
  const env = await getTestEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `products/${id}`), data);
  });
}

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

// The zero-fee zone every baseOrder() below references by default so a
// plain `shipping: 0` order (the overwhelming majority of existing tests,
// none of which care about delivery-zone behavior specifically) keeps
// passing isValidShippingForOrder() unmodified. The A1 discount/shipping
// describe block below seeds its own additional, non-zero-fee zones to
// actually exercise the zone-fee-matching logic.
const TEST_ZONE_ID = "test-zone";

async function seedDeliveryZone(id: string, data: Record<string, unknown>) {
  const env = await getTestEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `deliveryZones/${id}`), { name: id, nameAr: id, sortOrder: 0, ...data });
  });
}

async function seedTestZone() {
  await seedDeliveryZone(TEST_ZONE_ID, { fee: 0, active: true });
}

function checkoutTransaction(
  fs: Firestore,
  opts: {
    uid: string;
    claimLines: { productId: string; variantId: string; size: string; qty: number; price: number }[];
    productWrites: { id: string; colorVariants: ColorVariant[] }[];
    order?: Record<string, unknown> | null;
    customerStatsUpdate?: boolean;
    skipClaim?: boolean;
  }
) {
  return runTransaction(fs, async (tx) => {
    // Firestore transactions require all reads before any writes.
    const customerSnap = opts.customerStatsUpdate ? await tx.get(doc(fs, `customers/${opts.uid}`)) : null;

    if (!opts.skipClaim) {
      tx.set(doc(fs, `checkoutClaims/${opts.uid}`), { lines: opts.claimLines });
    }
    for (const p of opts.productWrites) {
      tx.update(doc(fs, `products/${p.id}`), { colorVariants: p.colorVariants, updatedAt: new Date() });
    }
    if (opts.order !== null) {
      tx.set(doc(fs, `orders/order-${Math.random().toString(36).slice(2)}`), opts.order ?? {});
    }
    if (customerSnap) {
      const data = customerSnap.data() as { ordersCount?: number; totalSpent?: number } | undefined;
      tx.update(doc(fs, `customers/${opts.uid}`), {
        ordersCount: (data?.ordersCount ?? 0) + 1,
        totalSpent: (data?.totalSpent ?? 0) + opts.claimLines.reduce((s, l) => s + l.price * l.qty, 0),
        updatedAt: new Date(),
      });
    }
  });
}

function baseOrder(uid: string, overrides: Record<string, unknown> = {}) {
  const order: Record<string, unknown> = {
    orderNumber: "SIS-TEST",
    customerId: uid,
    customerName: "Test Customer",
    customerEmail: "test@example.com",
    lines: [{ productId: "prod1", variantId: "black", name: "Test Dress", qty: 2, price: 100, size: "S", color: "Black" }],
    subtotal: 200,
    shipping: 0,
    deliveryZoneId: TEST_ZONE_ID,
    deliveryZoneName: TEST_ZONE_ID,
    deliveryZoneNameAr: TEST_ZONE_ID,
    total: 200,
    status: "pending",
    // A real web order always carries this (see ExchangePolicyModal /
    // orderTransaction.ts) — included by default so every existing test
    // below still represents a realistic order. Pass `policyConsent:
    // undefined` in overrides to test its absence specifically: unlike the
    // app's own client (initializeFirestore with ignoreUndefinedProperties),
    // this test harness's SDK rejects an explicit `undefined` field value
    // outright, so it's stripped here to actually omit the key instead.
    policyConsent: { policyVersion: 1, lang: "en" },
    ...overrides,
  };
  for (const key of Object.keys(order)) {
    if (order[key] === undefined) delete order[key];
  }
  return order;
}

describe("checkout: happy paths", () => {
  beforeEach(async () => {
    await clearFirestore();
    await seedTestZone();
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  it("lets an anonymous guest complete a full checkout in one transaction", async () => {
    await seedProduct();
    const env = await getTestEnv();
    const guest = env.authenticatedContext("guest1", ANONYMOUS);
    const fs = guest.firestore();
    await assertSucceeds(
      checkoutTransaction(fs, {
        uid: "guest1",
        claimLines: [{ productId: "prod1", variantId: "black", size: "S", qty: 2, price: 100 }],
        productWrites: [{ id: "prod1", colorVariants: decrement(PRODUCT.colorVariants, "black", "S", 2) }],
        order: baseOrder("guest1"),
      })
    );
  });

  it("lets an identified customer check out and increments their ordersCount/totalSpent", async () => {
    await seedProduct();
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "customers/alice"), {
        uid: "alice", name: "Alice", email: "alice@example.com", ordersCount: 1, totalSpent: 50,
      });
    });
    const alice = env.authenticatedContext("alice", IDENTIFIED);
    const fs = alice.firestore();
    await assertSucceeds(
      checkoutTransaction(fs, {
        uid: "alice",
        claimLines: [{ productId: "prod1", variantId: "black", size: "S", qty: 2, price: 100 }],
        productWrites: [{ id: "prod1", colorVariants: decrement(PRODUCT.colorVariants, "black", "S", 2) }],
        order: baseOrder("alice"),
        customerStatsUpdate: true,
      })
    );
    const snap = await getDoc(doc(alice.firestore(), "customers/alice"));
    if (snap.data()?.ordersCount !== 2 || snap.data()?.totalSpent !== 250) {
      throw new Error(`expected ordersCount 2 / totalSpent 250, got ${JSON.stringify(snap.data())}`);
    }
  });

  it("normalizes a legacy (pre-colorVariants) product on its first purchase", async () => {
    await seedProduct("prod-legacy", LEGACY_PRODUCT);
    const env = await getTestEnv();
    const guest = env.authenticatedContext("guest2", ANONYMOUS);
    const fs = guest.firestore();
    const newVariants: ColorVariant[] = [
      {
        id: "default",
        colorName: "Black",
        colorHex: "#000000",
        sizeStock: [{ size: "S", qty: 3 }, { size: "M", qty: 0 }],
      },
    ];
    await assertSucceeds(
      checkoutTransaction(fs, {
        uid: "guest2",
        claimLines: [{ productId: "prod-legacy", variantId: "default", size: "S", qty: 1, price: 80 }],
        productWrites: [{ id: "prod-legacy", colorVariants: newVariants }],
        order: baseOrder("guest2", {
          lines: [{ productId: "prod-legacy", variantId: "default", name: "Legacy Dress", qty: 1, price: 80, size: "S", color: "Black" }],
          subtotal: 80,
          total: 80,
        }),
      })
    );
  });

  // Multi-branch: a cashier's POS order must name one of their own branches
  // and their own open session on that branch.
  it("lets a cashier create an order directly (POS path) without a checkout claim", async () => {
    const { branchId, sessionId } = await seedBranchSetup({ uid: "cashier1" });
    const env = await getTestEnv();
    const cashier = env.authenticatedContext("cashier1", IDENTIFIED);
    await assertSucceeds(
      setDoc(doc(cashier.firestore(), "orders/pos-order-1"), baseOrder("walkin-customer", { source: "pos", branchId, registerSessionId: sessionId }))
    );
  });

  it("denies a cashier a POS order with no branch, another branch, or someone else's session", async () => {
    const { branchId, sessionId } = await seedBranchSetup({ uid: "cashier1" });
    await seedBranchSetup({ uid: "cashier9", branchId: "b2" });
    const env = await getTestEnv();
    const cashier = env.authenticatedContext("cashier1", IDENTIFIED);
    const fs = cashier.firestore();
    await assertFails(setDoc(doc(fs, "orders/p1"), baseOrder("walkin-customer", { source: "pos", registerSessionId: sessionId })));
    await assertFails(setDoc(doc(fs, "orders/p2"), baseOrder("walkin-customer", { source: "pos", branchId: "b2", registerSessionId: sessionId })));
    await assertFails(setDoc(doc(fs, "orders/p3"), baseOrder("walkin-customer", { source: "pos", branchId, registerSessionId: "cashier9-session" })));
    // A cashier can't type in a non-POS (manual) order either.
    await assertFails(setDoc(doc(fs, "orders/p4"), baseOrder("walkin-customer", { source: "manual" })));
  });

  // Sisley's manual/off-site order workflow (OrderList.tsx's "New Order"
  // form) is built around customer name + phone, not email — many
  // in-person/phone customers don't have one. This path was never
  // rules-validated on customerEmail to begin with (owner/admin/cashier
  // create unconditionally via isCashierOrAbove(), never touching
  // isValidCheckoutOrder() at all), so this test documents/locks in
  // existing rules behavior rather than reflecting a rules change.
  it("lets an owner/admin create a manual order with no customerEmail at all (name + phone only)", async () => {
    await seedAdmin("admin-manual1", "admin");
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin-manual1", IDENTIFIED);
    await assertSucceeds(
      setDoc(
        doc(admin.firestore(), "orders/manual-order-1"),
        baseOrder("walkin-customer", {
          customerId: undefined,
          customerEmail: undefined,
          customerPhone: "0501234567",
          lines: [],
          subtotal: 0,
          total: 0,
        })
      )
    );
    const snap = await getDoc(doc(admin.firestore(), "orders/manual-order-1"));
    if ("customerEmail" in (snap.data() ?? {})) throw new Error("expected customerEmail to be genuinely absent, not just empty");
  });
});

describe("checkout: attack scenarios", () => {
  beforeEach(async () => {
    await clearFirestore();
    await seedTestZone();
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  it("rejects a claim with a tampered (too-low) price", async () => {
    await seedProduct();
    const env = await getTestEnv();
    const mallory = env.authenticatedContext("mallory", ANONYMOUS);
    await assertFails(
      setDoc(doc(mallory.firestore(), "checkoutClaims/mallory"), {
        lines: [{ productId: "prod1", variantId: "black", size: "S", qty: 2, price: 1 }],
      })
    );
  });

  it("rejects a claim referencing a color/size that doesn't exist on the product", async () => {
    await seedProduct();
    const env = await getTestEnv();
    const mallory = env.authenticatedContext("mallory", ANONYMOUS);
    await assertFails(
      setDoc(doc(mallory.firestore(), "checkoutClaims/mallory"), {
        lines: [{ productId: "prod1", variantId: "gold", size: "S", qty: 1, price: 100 }],
      })
    );
  });

  it("rejects a claim with more than 8 lines", async () => {
    await seedProduct();
    const env = await getTestEnv();
    const mallory = env.authenticatedContext("mallory", ANONYMOUS);
    const lines = Array.from({ length: 9 }, () => ({ productId: "prod1", variantId: "black", size: "S", qty: 1, price: 100 }));
    await assertFails(setDoc(doc(mallory.firestore(), "checkoutClaims/mallory"), { lines }));
  });

  it("rejects a product write that decrements more than the claimed quantity", async () => {
    await seedProduct();
    const env = await getTestEnv();
    const mallory = env.authenticatedContext("mallory", ANONYMOUS);
    const fs = mallory.firestore();
    await assertFails(
      checkoutTransaction(fs, {
        uid: "mallory",
        claimLines: [{ productId: "prod1", variantId: "black", size: "S", qty: 1, price: 100 }],
        productWrites: [{ id: "prod1", colorVariants: decrement(PRODUCT.colorVariants, "black", "S", 5) }],
        order: baseOrder("mallory", {
          lines: [{ productId: "prod1", variantId: "black", name: "Test Dress", qty: 1, price: 100, size: "S", color: "Black" }],
          subtotal: 100,
          total: 100,
        }),
      })
    );
  });

  it("rejects a bare stock decrement with no accompanying claim (vandalism)", async () => {
    await seedProduct();
    const env = await getTestEnv();
    const mallory = env.authenticatedContext("mallory", ANONYMOUS);
    await assertFails(
      updateDoc(doc(mallory.firestore(), "products/prod1"), {
        colorVariants: decrement(PRODUCT.colorVariants, "black", "S", 1),
        updatedAt: new Date(),
      })
    );
  });

  it("rejects a product write that increases stock instead of decreasing it", async () => {
    await seedProduct();
    const env = await getTestEnv();
    const mallory = env.authenticatedContext("mallory", ANONYMOUS);
    const fs = mallory.firestore();
    await assertFails(
      checkoutTransaction(fs, {
        uid: "mallory",
        claimLines: [{ productId: "prod1", variantId: "black", size: "S", qty: 1, price: 100 }],
        productWrites: [{ id: "prod1", colorVariants: decrement(PRODUCT.colorVariants, "black", "S", -5) }],
        order: null,
      })
    );
  });

  it("rejects a product write that drives stock negative", async () => {
    await seedProduct();
    const env = await getTestEnv();
    const mallory = env.authenticatedContext("mallory", ANONYMOUS);
    const fs = mallory.firestore();
    await assertFails(
      checkoutTransaction(fs, {
        uid: "mallory",
        claimLines: [{ productId: "prod1", variantId: "red", size: "S", qty: 20, price: 100 }],
        productWrites: [{ id: "prod1", colorVariants: decrement(PRODUCT.colorVariants, "red", "S", 20) }],
        order: null,
      })
    );
  });

  it("rejects a product write that also tampers with unrelated fields (price, name)", async () => {
    await seedProduct();
    const env = await getTestEnv();
    const mallory = env.authenticatedContext("mallory", ANONYMOUS);
    const fs = mallory.firestore();
    await assertFails(
      runTransaction(fs, async (tx) => {
        tx.set(doc(fs, "checkoutClaims/mallory"), {
          lines: [{ productId: "prod1", variantId: "black", size: "S", qty: 1, price: 100 }],
        });
        tx.update(doc(fs, "products/prod1"), {
          colorVariants: decrement(PRODUCT.colorVariants, "black", "S", 1),
          price: 1,
          updatedAt: new Date(),
        });
      })
    );
  });

  it("rejects a stock decrement authorized by someone else's claim (cross-account)", async () => {
    await seedProduct();
    const env = await getTestEnv();
    // Alice writes a legitimate claim for herself.
    const alice = env.authenticatedContext("alice", ANONYMOUS);
    await assertSucceeds(
      setDoc(doc(alice.firestore(), "checkoutClaims/alice"), {
        lines: [{ productId: "prod1", variantId: "black", size: "S", qty: 2, price: 100 }],
      })
    );
    // Mallory, signed in as herself, tries to decrement stock riding on Alice's claim.
    const mallory = env.authenticatedContext("mallory", ANONYMOUS);
    await assertFails(
      updateDoc(doc(mallory.firestore(), "products/prod1"), {
        colorVariants: decrement(PRODUCT.colorVariants, "black", "S", 2),
        updatedAt: new Date(),
      })
    );
  });

  it("rejects an order whose lines don't match the checkout claim", async () => {
    await seedProduct();
    const env = await getTestEnv();
    const mallory = env.authenticatedContext("mallory", ANONYMOUS);
    const fs = mallory.firestore();
    await assertFails(
      runTransaction(fs, async (tx) => {
        tx.set(doc(fs, "checkoutClaims/mallory"), {
          lines: [{ productId: "prod1", variantId: "black", size: "S", qty: 1, price: 100 }],
        });
        tx.set(doc(fs, "orders/order-mismatch"), baseOrder("mallory", {
          lines: [{ productId: "prod1", variantId: "black", name: "Test Dress", qty: 5, price: 100, size: "S", color: "Black" }],
          subtotal: 500,
          total: 500,
        }));
      })
    );
  });

  it("rejects an order create with negative shipping", async () => {
    await seedProduct();
    const env = await getTestEnv();
    const mallory = env.authenticatedContext("mallory", ANONYMOUS);
    const fs = mallory.firestore();
    await assertFails(
      runTransaction(fs, async (tx) => {
        tx.set(doc(fs, "checkoutClaims/mallory"), {
          lines: [{ productId: "prod1", variantId: "black", size: "S", qty: 2, price: 100 }],
        });
        tx.update(doc(fs, "products/prod1"), {
          colorVariants: decrement(PRODUCT.colorVariants, "black", "S", 2),
          updatedAt: new Date(),
        });
        tx.set(doc(fs, "orders/order-negship"), baseOrder("mallory", { shipping: -50, total: 150 }));
      })
    );
  });

  it("rejects an order create for a different customerId than the requester", async () => {
    await seedProduct();
    const env = await getTestEnv();
    const mallory = env.authenticatedContext("mallory", ANONYMOUS);
    await assertFails(setDoc(doc(mallory.firestore(), "orders/order-spoof"), baseOrder("someone-else")));
  });

  it("rejects a web order create with no policyConsent field at all", async () => {
    await seedProduct();
    const env = await getTestEnv();
    const mallory = env.authenticatedContext("mallory", ANONYMOUS);
    const fs = mallory.firestore();
    await assertFails(
      runTransaction(fs, async (tx) => {
        tx.set(doc(fs, "checkoutClaims/mallory"), {
          lines: [{ productId: "prod1", variantId: "black", size: "S", qty: 2, price: 100 }],
        });
        tx.update(doc(fs, "products/prod1"), {
          colorVariants: decrement(PRODUCT.colorVariants, "black", "S", 2),
          updatedAt: new Date(),
        });
        tx.set(doc(fs, "orders/order-noconsent"), baseOrder("mallory", { policyConsent: undefined }));
      })
    );
  });

  it("rejects a web order create with a malformed policyConsent (non-int version)", async () => {
    await seedProduct();
    const env = await getTestEnv();
    const mallory = env.authenticatedContext("mallory", ANONYMOUS);
    const fs = mallory.firestore();
    await assertFails(
      runTransaction(fs, async (tx) => {
        tx.set(doc(fs, "checkoutClaims/mallory"), {
          lines: [{ productId: "prod1", variantId: "black", size: "S", qty: 2, price: 100 }],
        });
        tx.update(doc(fs, "products/prod1"), {
          colorVariants: decrement(PRODUCT.colorVariants, "black", "S", 2),
          updatedAt: new Date(),
        });
        tx.set(
          doc(fs, "orders/order-badversion"),
          baseOrder("mallory", { policyConsent: { policyVersion: "1", lang: "en" } })
        );
      })
    );
  });

  it("rejects a web order create with an invalid policyConsent.lang", async () => {
    await seedProduct();
    const env = await getTestEnv();
    const mallory = env.authenticatedContext("mallory", ANONYMOUS);
    const fs = mallory.firestore();
    await assertFails(
      runTransaction(fs, async (tx) => {
        tx.set(doc(fs, "checkoutClaims/mallory"), {
          lines: [{ productId: "prod1", variantId: "black", size: "S", qty: 2, price: 100 }],
        });
        tx.update(doc(fs, "products/prod1"), {
          colorVariants: decrement(PRODUCT.colorVariants, "black", "S", 2),
          updatedAt: new Date(),
        });
        tx.set(
          doc(fs, "orders/order-badlang"),
          baseOrder("mallory", { policyConsent: { policyVersion: 1, lang: "fr" } })
        );
      })
    );
  });

  it("accepts a web order create with a well-formed policyConsent", async () => {
    await seedProduct();
    const env = await getTestEnv();
    const alice = env.authenticatedContext("alice", ANONYMOUS);
    const fs = alice.firestore();
    await assertSucceeds(
      checkoutTransaction(fs, {
        uid: "alice",
        claimLines: [{ productId: "prod1", variantId: "black", size: "S", qty: 2, price: 100 }],
        productWrites: [{ id: "prod1", colorVariants: decrement(PRODUCT.colorVariants, "black", "S", 2) }],
        order: baseOrder("alice", { policyConsent: { policyVersion: 3, lang: "ar" } }),
      })
    );
  });

  it("rejects a customer stats increment with no matching claim", async () => {
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "customers/alice"), { uid: "alice", name: "Alice", email: "a@example.com", ordersCount: 0, totalSpent: 0 });
    });
    const alice = env.authenticatedContext("alice", IDENTIFIED);
    await assertFails(updateDoc(doc(alice.firestore(), "customers/alice"), { ordersCount: 1, totalSpent: 500 }));
  });

  it("rejects a non-admin, non-checkout stock edit even with isSignedIn", async () => {
    await seedProduct();
    const env = await getTestEnv();
    const mallory = env.authenticatedContext("mallory", IDENTIFIED);
    await assertFails(
      updateDoc(doc(mallory.firestore(), "products/prod1"), {
        colorVariants: PRODUCT.colorVariants.map((v) => ({ ...v, colorName: "Hijacked" })),
        updatedAt: new Date(),
      })
    );
  });

  it("still lets an editor freely restock/edit products with no claim at all", async () => {
    await seedProduct();
    await seedAdmin("editor1", "editor");
    const env = await getTestEnv();
    const editor = env.authenticatedContext("editor1", IDENTIFIED);
    await assertSucceeds(
      updateDoc(doc(editor.firestore(), "products/prod1"), {
        colorVariants: decrement(PRODUCT.colorVariants, "black", "S", -10),
        updatedAt: new Date(),
      })
    );
  });
});

describe("checkout: order read access", () => {
  beforeEach(async () => {
    await clearFirestore();
    await seedTestZone();
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  it("lets a customer read their own order but not someone else's", async () => {
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "orders/order1"), baseOrder("alice"));
    });
    const alice = env.authenticatedContext("alice", IDENTIFIED);
    await assertSucceeds(getDoc(doc(alice.firestore(), "orders/order1")));

    const bob = env.authenticatedContext("bob", IDENTIFIED);
    await assertFails(getDoc(doc(bob.firestore(), "orders/order1")));
  });

  it("lets an admin read any order", async () => {
    await seedAdmin("owner1", "owner");
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "orders/order1"), baseOrder("alice"));
    });
    const owner = env.authenticatedContext("owner1", IDENTIFIED);
    await assertSucceeds(getDoc(doc(owner.firestore(), "orders/order1")));
  });

  // Audit finding B1: order read used to be isAnyAdmin() (every active
  // admin role). Narrowed to isCashierOrAbove() — editor and viewer have no
  // legitimate reason to see order PII (neither role's page is even
  // reachable in the UI: /admin/orders is owner/admin-only) and lose
  // access; cashier keeps it because GlobalOrdersSidebarPanel.tsx (order
  // search/lookup, reachable from POS) genuinely depends on it.
  it("lets owner/admin read order PII", async () => {
    await seedAdmin("owner2", "owner");
    await seedAdmin("admin2", "admin");
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "orders/order2"), baseOrder("alice"));
    });
    await assertSucceeds(getDoc(doc(env.authenticatedContext("owner2", IDENTIFIED).firestore(), "orders/order2")));
    await assertSucceeds(getDoc(doc(env.authenticatedContext("admin2", IDENTIFIED).firestore(), "orders/order2")));
  });

  // Multi-branch: a cashier reads online (web/manual) orders and their own
  // branches' POS sales -- never another branch's POS sales.
  it("lets a cashier read online orders' PII (GlobalOrdersSidebarPanel dependency)", async () => {
    await seedBranchSetup({ uid: "cashier3" });
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "orders/order3"), baseOrder("alice", { source: "web" }));
      await setDoc(doc(ctx.firestore(), "orders/order3m"), baseOrder("bob", { source: "manual" }));
    });
    const cashier = env.authenticatedContext("cashier3", IDENTIFIED);
    await assertSucceeds(getDoc(doc(cashier.firestore(), "orders/order3")));
    await assertSucceeds(getDoc(doc(cashier.firestore(), "orders/order3m")));
  });

  it("lets a cashier read their own branch's POS sales but not another branch's", async () => {
    await seedBranchSetup({ uid: "cashier4" });
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "orders/pos-b1"), baseOrder("walkin-customer", { source: "pos", branchId: "b1" }));
      await setDoc(doc(ctx.firestore(), "orders/pos-b2"), baseOrder("walkin-customer", { source: "pos", branchId: "b2" }));
      await setDoc(doc(ctx.firestore(), "orders/pos-legacy"), baseOrder("walkin-customer", { source: "pos" }));
    });
    const fs = env.authenticatedContext("cashier4", IDENTIFIED).firestore();
    await assertSucceeds(getDoc(doc(fs, "orders/pos-b1")));
    await assertFails(getDoc(doc(fs, "orders/pos-b2")));
    await assertFails(getDoc(doc(fs, "orders/pos-legacy")));
  });

  // Was blocked ("catalog-scoped, never orders") until editor was added to
  // isBranchNoteEditorOrAbove() so editor can use OrderDetail.tsx's Branch
  // Stock Note interaction, which needs to read the order to render its
  // line items -- see that function's own comment in firestore.rules.
  // Firestore has no field-level read security, so this necessarily grants
  // full order/PII read, not just the note.
  it("lets an editor read order PII (Branch Stock Note dependency)", async () => {
    await seedAdmin("editor2", "editor");
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "orders/order4"), baseOrder("alice"));
    });
    const editor = env.authenticatedContext("editor2", IDENTIFIED);
    await assertSucceeds(getDoc(doc(editor.firestore(), "orders/order4")));
  });

  it("blocks a viewer from reading order PII (read-only catalog browsing, never orders)", async () => {
    await seedAdmin("viewer2", "viewer");
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "orders/order5"), baseOrder("alice"));
    });
    const viewer = env.authenticatedContext("viewer2", IDENTIFIED);
    await assertFails(getDoc(doc(viewer.firestore(), "orders/order5")));
  });
});

// Audit finding A1: discount/shipping used to be range-checked only, never
// tied to a real discounts/{id} doc or settings/shipping — a signed-in
// principal (including an anonymous guest) could submit discount==subtotal
// with no real code, or an arbitrary shipping figure. isValidDiscountForOrder
// / isValidShippingForOrder (firestore.rules) close that; these tests prove
// it, mirroring the exact product/checkoutClaims helpers already above.
//
// The shipping half was later migrated from a flat Standard/Express
// settings/shipping rate to a per-city/region deliveryZones/{id} lookup (see
// isValidShippingForOrder's current implementation) -- the discount tests
// below are untouched by that migration, only the shipping ones changed
// shape, from seedShipping()'s standard/expressRate fields to seedDeliveryZone().
describe("checkout: A1 discount/delivery-zone shipping validation", () => {
  beforeEach(async () => {
    await clearFirestore();
    await seedTestZone();
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  async function seedDiscount(id: string, data: Record<string, unknown>) {
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), `discounts/${id}`), { code: id.toUpperCase(), usageCount: 0, ...data });
    });
  }

  // 2 lines x 100 = 200 subtotal throughout this block (see PRODUCT/baseOrder above).

  it("accepts a checkout with a valid, correctly re-derived discount code", async () => {
    await seedProduct();
    await seedDiscount("d10off", { type: "percent", value: 10, active: true });
    const env = await getTestEnv();
    const mallory = env.authenticatedContext("shopper1", ANONYMOUS);
    const fs = mallory.firestore();
    await assertSucceeds(
      checkoutTransaction(fs, {
        uid: "shopper1",
        claimLines: [{ productId: "prod1", variantId: "black", size: "S", qty: 2, price: 100 }],
        productWrites: [{ id: "prod1", colorVariants: decrement(PRODUCT.colorVariants, "black", "S", 2) }],
        order: baseOrder("shopper1", { discount: 20, discountId: "d10off", total: 180 }),
      })
    );
  });

  it("rejects a checkout claiming a discountId that doesn't exist", async () => {
    await seedProduct();
    const env = await getTestEnv();
    const mallory = env.authenticatedContext("shopper2", ANONYMOUS);
    const fs = mallory.firestore();
    await assertFails(
      checkoutTransaction(fs, {
        uid: "shopper2",
        claimLines: [{ productId: "prod1", variantId: "black", size: "S", qty: 2, price: 100 }],
        productWrites: [{ id: "prod1", colorVariants: decrement(PRODUCT.colorVariants, "black", "S", 2) }],
        order: baseOrder("shopper2", { discount: 20, discountId: "ghost-code", total: 180 }),
      })
    );
  });

  it("rejects a checkout claiming an inactive discount", async () => {
    await seedProduct();
    await seedDiscount("dead", { type: "fixed", value: 20, active: false });
    const env = await getTestEnv();
    const mallory = env.authenticatedContext("shopper3", ANONYMOUS);
    const fs = mallory.firestore();
    await assertFails(
      checkoutTransaction(fs, {
        uid: "shopper3",
        claimLines: [{ productId: "prod1", variantId: "black", size: "S", qty: 2, price: 100 }],
        productWrites: [{ id: "prod1", colorVariants: decrement(PRODUCT.colorVariants, "black", "S", 2) }],
        order: baseOrder("shopper3", { discount: 20, discountId: "dead", total: 180 }),
      })
    );
  });

  it("rejects a manipulated discount amount higher than a real code actually grants", async () => {
    await seedProduct();
    await seedDiscount("small5", { type: "fixed", value: 5, active: true });
    const env = await getTestEnv();
    const mallory = env.authenticatedContext("shopper4", ANONYMOUS);
    const fs = mallory.firestore();
    // Real code only grants 5, but the order claims 200 (the full subtotal) —
    // the exact fraudulent-free-order shape the audit flagged.
    await assertFails(
      checkoutTransaction(fs, {
        uid: "shopper4",
        claimLines: [{ productId: "prod1", variantId: "black", size: "S", qty: 2, price: 100 }],
        productWrites: [{ id: "prod1", colorVariants: decrement(PRODUCT.colorVariants, "black", "S", 2) }],
        order: baseOrder("shopper4", { discount: 200, discountId: "small5", total: 0 }),
      })
    );
  });

  it("rejects a discount amount exceeding the authoritative subtotal even for a real 100%+-value code", async () => {
    await seedProduct();
    await seedDiscount("over", { type: "fixed", value: 500, active: true });
    const env = await getTestEnv();
    const mallory = env.authenticatedContext("shopper5", ANONYMOUS);
    const fs = mallory.firestore();
    // A real code worth more than the cart (an admin could genuinely create
    // one) still can't be claimed above subtotal (200) — must be capped, the
    // same Math.min(amount, subtotal) the client already applies.
    await assertFails(
      checkoutTransaction(fs, {
        uid: "shopper5",
        claimLines: [{ productId: "prod1", variantId: "black", size: "S", qty: 2, price: 100 }],
        productWrites: [{ id: "prod1", colorVariants: decrement(PRODUCT.colorVariants, "black", "S", 2) }],
        order: baseOrder("shopper5", { discount: 500, discountId: "over", total: -300 }),
      })
    );
  });

  it("rejects a discount below its minSubtotal requirement", async () => {
    await seedProduct();
    await seedDiscount("bigorder", { type: "fixed", value: 10, active: true, minSubtotal: 1000 });
    const env = await getTestEnv();
    const mallory = env.authenticatedContext("shopper6", ANONYMOUS);
    const fs = mallory.firestore();
    await assertFails(
      checkoutTransaction(fs, {
        uid: "shopper6",
        claimLines: [{ productId: "prod1", variantId: "black", size: "S", qty: 2, price: 100 }],
        productWrites: [{ id: "prod1", colorVariants: decrement(PRODUCT.colorVariants, "black", "S", 2) }],
        order: baseOrder("shopper6", { discount: 10, discountId: "bigorder", total: 190 }),
      })
    );
  });

  it("rejects a discount already at its usage limit", async () => {
    await seedProduct();
    await seedDiscount("maxedout", { type: "fixed", value: 10, active: true, usageLimit: 5, usageCount: 5 });
    const env = await getTestEnv();
    const mallory = env.authenticatedContext("shopper7", ANONYMOUS);
    const fs = mallory.firestore();
    await assertFails(
      checkoutTransaction(fs, {
        uid: "shopper7",
        claimLines: [{ productId: "prod1", variantId: "black", size: "S", qty: 2, price: 100 }],
        productWrites: [{ id: "prod1", colorVariants: decrement(PRODUCT.colorVariants, "black", "S", 2) }],
        order: baseOrder("shopper7", { discount: 10, discountId: "maxedout", total: 190 }),
      })
    );
  });

  it("rejects a manipulated shipping amount that doesn't match the selected zone's real fee", async () => {
    await seedProduct();
    await seedDeliveryZone("nablus", { fee: 20, active: true });
    const env = await getTestEnv();
    const mallory = env.authenticatedContext("shopper8", ANONYMOUS);
    const fs = mallory.firestore();
    await assertFails(
      checkoutTransaction(fs, {
        uid: "shopper8",
        claimLines: [{ productId: "prod1", variantId: "black", size: "S", qty: 2, price: 100 }],
        productWrites: [{ id: "prod1", colorVariants: decrement(PRODUCT.colorVariants, "black", "S", 2) }],
        order: baseOrder("shopper8", { deliveryZoneId: "nablus", shipping: 1, total: 201 }),
      })
    );
  });

  it("rejects shipping charged at an inactive zone's fee, even at that zone's own real rate", async () => {
    await seedProduct();
    await seedDeliveryZone("retired-zone", { fee: 65, active: false });
    const env = await getTestEnv();
    const mallory = env.authenticatedContext("shopper9", ANONYMOUS);
    const fs = mallory.firestore();
    // The zone genuinely has fee 65 -- it's just inactive, which alone must
    // still fail closed (never expose/charge for a deactivated zone).
    await assertFails(
      checkoutTransaction(fs, {
        uid: "shopper9",
        claimLines: [{ productId: "prod1", variantId: "black", size: "S", qty: 2, price: 100 }],
        productWrites: [{ id: "prod1", colorVariants: decrement(PRODUCT.colorVariants, "black", "S", 2) }],
        order: baseOrder("shopper9", { deliveryZoneId: "retired-zone", shipping: 65, total: 265 }),
      })
    );
  });

  it("rejects a checkout referencing a delivery zone id that doesn't exist at all", async () => {
    await seedProduct();
    const env = await getTestEnv();
    const mallory = env.authenticatedContext("shopper9b", ANONYMOUS);
    const fs = mallory.firestore();
    await assertFails(
      checkoutTransaction(fs, {
        uid: "shopper9b",
        claimLines: [{ productId: "prod1", variantId: "black", size: "S", qty: 2, price: 100 }],
        productWrites: [{ id: "prod1", colorVariants: decrement(PRODUCT.colorVariants, "black", "S", 2) }],
        order: baseOrder("shopper9b", { deliveryZoneId: "ghost-zone", shipping: 0, total: 200 }),
      })
    );
  });

  it("rejects a web checkout order create with no deliveryZoneId field at all", async () => {
    await seedProduct();
    const env = await getTestEnv();
    const mallory = env.authenticatedContext("shopper9c", ANONYMOUS);
    const fs = mallory.firestore();
    await assertFails(
      checkoutTransaction(fs, {
        uid: "shopper9c",
        claimLines: [{ productId: "prod1", variantId: "black", size: "S", qty: 2, price: 100 }],
        productWrites: [{ id: "prod1", colorVariants: decrement(PRODUCT.colorVariants, "black", "S", 2) }],
        order: baseOrder("shopper9c", { deliveryZoneId: undefined, deliveryZoneName: undefined, deliveryZoneNameAr: undefined }),
      })
    );
  });

  it("accepts valid shipping matching the selected zone's real fee", async () => {
    await seedProduct();
    await seedDeliveryZone("nablus", { fee: 20, active: true });
    const env = await getTestEnv();
    const shopper = env.authenticatedContext("shopper10", ANONYMOUS);
    const fs = shopper.firestore();
    await assertSucceeds(
      checkoutTransaction(fs, {
        uid: "shopper10",
        claimLines: [{ productId: "prod1", variantId: "black", size: "S", qty: 2, price: 100 }],
        productWrites: [{ id: "prod1", colorVariants: decrement(PRODUCT.colorVariants, "black", "S", 2) }],
        order: baseOrder("shopper10", { deliveryZoneId: "nablus", shipping: 20, total: 220 }),
      })
    );
  });

  it("accepts shipping=0 for a real active zone whose configured fee genuinely is 0", async () => {
    // baseOrder()'s default TEST_ZONE_ID zone (seeded fresh in this
    // describe block's beforeEach) is exactly this case.
    await seedProduct();
    const env = await getTestEnv();
    const shopper = env.authenticatedContext("shopper11", ANONYMOUS);
    const fs = shopper.firestore();
    await assertSucceeds(
      checkoutTransaction(fs, {
        uid: "shopper11",
        claimLines: [{ productId: "prod1", variantId: "black", size: "S", qty: 2, price: 100 }],
        productWrites: [{ id: "prod1", colorVariants: decrement(PRODUCT.colorVariants, "black", "S", 2) }],
        order: baseOrder("shopper11", { shipping: 0, total: 200 }),
      })
    );
  });

  it("rejects charging shipping=0 for a real active zone whose fee is actually nonzero", async () => {
    await seedProduct();
    await seedDeliveryZone("nablus", { fee: 20, active: true });
    const env = await getTestEnv();
    const mallory = env.authenticatedContext("shopper12", ANONYMOUS);
    const fs = mallory.firestore();
    await assertFails(
      checkoutTransaction(fs, {
        uid: "shopper12",
        claimLines: [{ productId: "prod1", variantId: "black", size: "S", qty: 2, price: 100 }],
        productWrites: [{ id: "prod1", colorVariants: decrement(PRODUCT.colorVariants, "black", "S", 2) }],
        order: baseOrder("shopper12", { deliveryZoneId: "nablus", shipping: 0, total: 200 }),
      })
    );
  });

  it("accepts free (0) shipping when subtotal meets the free-shipping threshold, regardless of the zone's real fee", async () => {
    await seedProduct("prod1", { ...PRODUCT, price: 300 });
    await seedDeliveryZone("nablus", { fee: 20, active: true });
    const env = await getTestEnv();
    const shopper = env.authenticatedContext("shopper13", ANONYMOUS);
    const fs = shopper.firestore();
    await assertSucceeds(
      checkoutTransaction(fs, {
        uid: "shopper13",
        claimLines: [{ productId: "prod1", variantId: "black", size: "S", qty: 2, price: 300 }],
        productWrites: [{ id: "prod1", colorVariants: decrement(PRODUCT.colorVariants, "black", "S", 2) }],
        order: baseOrder("shopper13", {
          lines: [{ productId: "prod1", variantId: "black", name: "Test Dress", qty: 2, price: 300, size: "S", color: "Black" }],
          subtotal: 600,
          deliveryZoneId: "nablus",
          shipping: 0,
          total: 600,
        }),
      })
    );
  });

  it("rejects a checkout with no settings/shipping doc yet still charging a mismatched fee for a real zone", async () => {
    // A fresh project with no settings/shipping doc at all must still fall
    // back to the same default free-shipping threshold (500) the client
    // uses (SHIPPING_DEFAULTS) and still enforce the zone's real fee.
    await seedProduct();
    await seedDeliveryZone("nablus", { fee: 20, active: true });
    const env = await getTestEnv();
    const mallory = env.authenticatedContext("shopper14", ANONYMOUS);
    const fs = mallory.firestore();
    await assertFails(
      checkoutTransaction(fs, {
        uid: "shopper14",
        claimLines: [{ productId: "prod1", variantId: "black", size: "S", qty: 2, price: 100 }],
        productWrites: [{ id: "prod1", colorVariants: decrement(PRODUCT.colorVariants, "black", "S", 2) }],
        order: baseOrder("shopper14", { deliveryZoneId: "nablus", shipping: 5, total: 205 }),
      })
    );
  });

  it("accepts a checkout with no settings/shipping doc yet and a zero-fee zone", async () => {
    await seedProduct();
    const env = await getTestEnv();
    const shopper = env.authenticatedContext("shopper15", ANONYMOUS);
    const fs = shopper.firestore();
    await assertSucceeds(
      checkoutTransaction(fs, {
        uid: "shopper15",
        claimLines: [{ productId: "prod1", variantId: "black", size: "S", qty: 2, price: 100 }],
        productWrites: [{ id: "prod1", colorVariants: decrement(PRODUCT.colorVariants, "black", "S", 2) }],
        order: baseOrder("shopper15", { shipping: 0, total: 200 }),
      })
    );
  });

  it("blocks an anonymous guest's combined attack: fake discount AND a tampered zone fee in one order", async () => {
    await seedProduct();
    await seedDiscount("real10", { type: "percent", value: 10, active: true });
    await seedDeliveryZone("nablus", { fee: 20, active: true });
    const env = await getTestEnv();
    const mallory = env.authenticatedContext("attacker1", ANONYMOUS);
    const fs = mallory.firestore();
    // Real code exists (10% = 20), but claims the full subtotal as discount
    // AND zero shipping despite the selected zone's real fee being 20 — a
    // $0 order.
    await assertFails(
      checkoutTransaction(fs, {
        uid: "attacker1",
        claimLines: [{ productId: "prod1", variantId: "black", size: "S", qty: 2, price: 100 }],
        productWrites: [{ id: "prod1", colorVariants: decrement(PRODUCT.colorVariants, "black", "S", 2) }],
        order: baseOrder("attacker1", { discount: 200, discountId: "real10", deliveryZoneId: "nablus", shipping: 0, total: 0 }),
      })
    );
  });

  it("blocks a signed-in (non-anonymous) customer attempting the same fraudulent discount", async () => {
    await seedProduct();
    await seedDiscount("real10b", { type: "percent", value: 10, active: true });
    const env = await getTestEnv();
    const mallory = env.authenticatedContext("attacker2", IDENTIFIED);
    const fs = mallory.firestore();
    await assertFails(
      checkoutTransaction(fs, {
        uid: "attacker2",
        claimLines: [{ productId: "prod1", variantId: "black", size: "S", qty: 2, price: 100 }],
        productWrites: [{ id: "prod1", colorVariants: decrement(PRODUCT.colorVariants, "black", "S", 2) }],
        order: baseOrder("attacker2", { discount: 200, discountId: "real10b", total: 0 }),
      })
    );
  });

  // POS manual discounts are owner/admin-only (multi-branch POS): a cashier's
  // sale with any discount is rejected; owner/admin may still apply one with
  // no discountId, unaffected by the A1 discount-code validation.
  it("denies a cashier any manual POS discount", async () => {
    const { branchId, sessionId } = await seedBranchSetup({ uid: "cashier2" });
    const env = await getTestEnv();
    const cashier = env.authenticatedContext("cashier2", IDENTIFIED);
    await assertFails(
      setDoc(
        doc(cashier.firestore(), "orders/pos-discount-1"),
        baseOrder("walkin-customer", { source: "pos", branchId, registerSessionId: sessionId, discount: 10, total: 190 })
      )
    );
  });

  it("still lets an admin apply a manual POS discount, unaffected by the discountId validation", async () => {
    const { branchId, sessionId } = await seedBranchSetup({ uid: "admin-pos", role: "admin" });
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin-pos", IDENTIFIED);
    await assertSucceeds(
      setDoc(
        doc(admin.firestore(), "orders/pos-discount-2"),
        baseOrder("walkin-customer", { source: "pos", branchId, registerSessionId: sessionId, discount: 999999, total: -999799 })
      )
    );
  });
});

// Non-delivery warning feature: records that the delivery company could
// not deliver an order and returned it, independent of OrderStatus and of
// the separate returns/{id} collection (see isValidNonDeliveryUpdate() in
// firestore.rules). Owner/admin only, one-way once flagged.
describe("checkout: order non-delivery flag", () => {
  beforeEach(async () => {
    await clearFirestore();
    await seedTestZone();
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  it("lets owner/admin mark an order as non-delivery with a note", async () => {
    await seedAdmin("admin3", "admin");
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "orders/ndOrder1"), baseOrder("alice"));
    });
    const admin = env.authenticatedContext("admin3", IDENTIFIED);
    await assertSucceeds(
      updateDoc(doc(admin.firestore(), "orders/ndOrder1"), {
        nonDeliveryFlagged: true,
        nonDeliveryNote: "Wrong address, courier could not reach customer.",
        nonDeliveryMarkedBy: "admin3@example.com",
        nonDeliveryMarkedByName: "admin3",
      })
    );
    const snap = await getDoc(doc(admin.firestore(), "orders/ndOrder1"));
    if (snap.data()?.nonDeliveryFlagged !== true) throw new Error("expected nonDeliveryFlagged true");
  });

  it("lets owner/admin mark an order as non-delivery with no note", async () => {
    await seedAdmin("admin4", "admin");
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "orders/ndOrder2"), baseOrder("alice"));
    });
    const admin = env.authenticatedContext("admin4", IDENTIFIED);
    await assertSucceeds(
      updateDoc(doc(admin.firestore(), "orders/ndOrder2"), { nonDeliveryFlagged: true })
    );
  });

  it("rejects a non-boolean nonDeliveryFlagged value", async () => {
    await seedAdmin("admin5", "admin");
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "orders/ndOrder3"), baseOrder("alice"));
    });
    const admin = env.authenticatedContext("admin5", IDENTIFIED);
    await assertFails(updateDoc(doc(admin.firestore(), "orders/ndOrder3"), { nonDeliveryFlagged: "yes" }));
  });

  it("rejects a note longer than 500 characters", async () => {
    await seedAdmin("admin6", "admin");
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "orders/ndOrder4"), baseOrder("alice"));
    });
    const admin = env.authenticatedContext("admin6", IDENTIFIED);
    await assertFails(
      updateDoc(doc(admin.firestore(), "orders/ndOrder4"), {
        nonDeliveryFlagged: true,
        nonDeliveryNote: "x".repeat(501),
      })
    );
  });

  it("rejects flipping nonDeliveryFlagged back to false once set", async () => {
    await seedAdmin("admin7", "admin");
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "orders/ndOrder5"), baseOrder("alice", { nonDeliveryFlagged: true }));
    });
    const admin = env.authenticatedContext("admin7", IDENTIFIED);
    await assertFails(updateDoc(doc(admin.firestore(), "orders/ndOrder5"), { nonDeliveryFlagged: false }));
  });

  it("blocks a cashier from marking an order as non-delivery (order update stays admin-or-above)", async () => {
    await seedAdmin("cashier4", "cashier");
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "orders/ndOrder6"), baseOrder("alice"));
    });
    const cashier = env.authenticatedContext("cashier4", IDENTIFIED);
    await assertFails(updateDoc(doc(cashier.firestore(), "orders/ndOrder6"), { nonDeliveryFlagged: true }));
  });

  it("blocks an editor from marking an order as non-delivery", async () => {
    await seedAdmin("editor3", "editor");
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "orders/ndOrder7"), baseOrder("alice"));
    });
    const editor = env.authenticatedContext("editor3", IDENTIFIED);
    await assertFails(updateDoc(doc(editor.firestore(), "orders/ndOrder7"), { nonDeliveryFlagged: true }));
  });

  it("still lets owner/admin update unrelated fields (status) on an order that already has the flag set", async () => {
    await seedAdmin("admin8", "admin");
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "orders/ndOrder8"), baseOrder("alice", { nonDeliveryFlagged: true }));
    });
    const admin = env.authenticatedContext("admin8", IDENTIFIED);
    await assertSucceeds(updateDoc(doc(admin.firestore(), "orders/ndOrder8"), { status: "cancelled" }));
  });

  it("still lets owner/admin save unrelated notes on an order untouched by this feature (regression)", async () => {
    await seedAdmin("admin9", "admin");
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "orders/ndOrder9"), baseOrder("alice"));
    });
    const admin = env.authenticatedContext("admin9", IDENTIFIED);
    await assertSucceeds(updateDoc(doc(admin.firestore(), "orders/ndOrder9"), { notes: "Called customer to confirm address." }));
  });

  it("owner/admin can query orders by nonDeliveryFlagged == true (the New Order lookup's exact query)", async () => {
    const { query, where, getDocs, collection } = await import("firebase/firestore");
    await seedAdmin("admin10", "admin");
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "orders/ndOrder10"), baseOrder("alice", { nonDeliveryFlagged: true, customerPhone: "+972-50-123-4567" }));
      await setDoc(doc(ctx.firestore(), "orders/ndOrder11"), baseOrder("bob", { customerId: "bob" }));
    });
    const admin = env.authenticatedContext("admin10", IDENTIFIED);
    const snap = await getDocs(query(collection(admin.firestore(), "orders"), where("nonDeliveryFlagged", "==", true)));
    if (snap.size !== 1) throw new Error(`expected exactly 1 flagged order, got ${snap.size}`);
  });
});

// Inter-Branch Stock Note: a narrow exception letting a cashier write ONLY
// the lineBranchStockNotes map on an order — nothing else — so staff at
// another branch can be told a specific product needs to be sent over.
// Deliberately separate from `notes` (a web order's customer delivery
// instructions). Per-LINE-ITEM (keyed by returnLineKey), not per-order --
// see AdminOrder.lineBranchStockNotes' own doc comment in types.ts for why
// the old single order-level field was replaced.
function noteEntry(uid: string, note: string) {
  return { note, updatedByUid: uid, updatedByEmail: `${uid}@example.com`, updatedByName: uid };
}

// baseOrder()'s own single default line -- isValidCashierBranchNoteUpdate()
// only actually validates a map key that corresponds to one of the order's
// own real lines (see its own comment in firestore.rules for why), so tests
// that need a key to be genuinely checked (not vacuously skipped) must use
// this exact key rather than an arbitrary made-up one.
const BASE_LINE_KEY = "prod1::black::S";

describe("checkout: branch stock note", () => {
  beforeEach(async () => {
    await clearFirestore();
    await seedTestZone();
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  it("lets owner/admin write a line's branch stock note", async () => {
    await seedAdmin("bsnAdmin1", "admin");
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "orders/bsn1"), baseOrder("alice"));
    });
    const admin = env.authenticatedContext("bsnAdmin1", IDENTIFIED);
    await assertSucceeds(
      updateDoc(doc(admin.firestore(), "orders/bsn1"), {
        lineBranchStockNotes: { [BASE_LINE_KEY]: noteEntry("bsnAdmin1", "Product X is available at the other branch — please send it over.") },
      })
    );
    const snap = await getDoc(doc(admin.firestore(), "orders/bsn1"));
    if (snap.data()?.lineBranchStockNotes?.[BASE_LINE_KEY]?.note == null) throw new Error("expected the line note to be set");
  });

  it("lets a cashier write a line's branch stock note", async () => {
    await seedAdmin("bsnCashier1", "cashier");
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "orders/bsn2"), baseOrder("alice"));
    });
    const cashier = env.authenticatedContext("bsnCashier1", IDENTIFIED);
    await assertSucceeds(
      updateDoc(doc(cashier.firestore(), "orders/bsn2"), {
        lineBranchStockNotes: { [BASE_LINE_KEY]: noteEntry("bsnCashier1", "Available at the second branch.") },
      })
    );
  });

  it("lets a cashier clear/edit an existing line's note without disturbing an unrelated saved entry", async () => {
    await seedAdmin("bsnCashier2", "cashier");
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), "orders/bsn3"),
        baseOrder("alice", { lineBranchStockNotes: { [BASE_LINE_KEY]: noteEntry("bsnCashier2", "old note"), "unrelated::key::X": noteEntry("someoneElse", "untouched") } })
      );
    });
    const cashier = env.authenticatedContext("bsnCashier2", IDENTIFIED);
    await assertSucceeds(
      updateDoc(doc(cashier.firestore(), "orders/bsn3"), {
        lineBranchStockNotes: { [BASE_LINE_KEY]: noteEntry("bsnCashier2", ""), "unrelated::key::X": noteEntry("someoneElse", "untouched") },
      })
    );
  });

  // Per-note length isn't enforced at the rules layer -- see
  // isValidCashierBranchNoteUpdate()'s own doc comment in firestore.rules
  // for why every per-entry validation design tried here hit Firestore's
  // 1000-expression ceiling on nothing more than two already-noted lines.
  // Documented as an accepted residual risk, not a gap to silently ignore.
  it("does not block an oversized line note at the rules layer (documented residual risk, not enforced client-side either)", async () => {
    await seedAdmin("bsnCashier3", "cashier");
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "orders/bsn4"), baseOrder("alice"));
    });
    const cashier = env.authenticatedContext("bsnCashier3", IDENTIFIED);
    await assertSucceeds(
      updateDoc(doc(cashier.firestore(), "orders/bsn4"), {
        lineBranchStockNotes: { [BASE_LINE_KEY]: noteEntry("bsnCashier3", "x".repeat(501)) },
      })
    );
  });

  it("still blocks a cashier from writing more than 20 line notes at once (coarse map-size cap)", async () => {
    await seedAdmin("bsnCashier7", "cashier");
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "orders/bsn12"), baseOrder("alice"));
    });
    const cashier = env.authenticatedContext("bsnCashier7", IDENTIFIED);
    const tooMany: Record<string, unknown> = {};
    for (let i = 0; i < 21; i++) tooMany[`p${i}::v${i}::M`] = noteEntry("bsnCashier7", "x");
    await assertFails(updateDoc(doc(cashier.firestore(), "orders/bsn12"), { lineBranchStockNotes: tooMany }));
  });

  it("blocks a cashier from changing order status through this permission", async () => {
    await seedAdmin("bsnCashier4", "cashier");
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "orders/bsn5"), baseOrder("alice"));
    });
    const cashier = env.authenticatedContext("bsnCashier4", IDENTIFIED);
    await assertFails(updateDoc(doc(cashier.firestore(), "orders/bsn5"), { status: "cancelled" }));
  });

  it("blocks a cashier from smuggling a total/lines change in alongside a valid line note", async () => {
    await seedAdmin("bsnCashier5", "cashier");
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "orders/bsn6"), baseOrder("alice"));
    });
    const cashier = env.authenticatedContext("bsnCashier5", IDENTIFIED);
    await assertFails(
      updateDoc(doc(cashier.firestore(), "orders/bsn6"), {
        lineBranchStockNotes: { "p1::v1::M": noteEntry("bsnCashier5", "Available at the second branch.") },
        total: 0,
      })
    );
  });

  it("blocks a cashier from editing the general customer notes field through this permission", async () => {
    await seedAdmin("bsnCashier6", "cashier");
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "orders/bsn7"), baseOrder("alice", { notes: "Leave with the doorman." }));
    });
    const cashier = env.authenticatedContext("bsnCashier6", IDENTIFIED);
    await assertFails(updateDoc(doc(cashier.firestore(), "orders/bsn7"), { notes: "overwritten" }));
  });

  // editor is one of the 4 roles isBranchNoteEditorOrAbove() covers -- see
  // its own doc comment in firestore.rules.
  it("lets an editor write a line's branch stock note", async () => {
    await seedAdmin("bsnEditor1", "editor");
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "orders/bsn8"), baseOrder("alice"));
    });
    const editor = env.authenticatedContext("bsnEditor1", IDENTIFIED);
    await assertSucceeds(
      updateDoc(doc(editor.firestore(), "orders/bsn8"), { lineBranchStockNotes: { [BASE_LINE_KEY]: noteEntry("bsnEditor1", "Available at the second branch.") } })
    );
  });

  it("still blocks an editor from changing order status through this permission", async () => {
    await seedAdmin("bsnEditor2", "editor");
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "orders/bsn13"), baseOrder("alice"));
    });
    const editor = env.authenticatedContext("bsnEditor2", IDENTIFIED);
    await assertFails(updateDoc(doc(editor.firestore(), "orders/bsn13"), { status: "cancelled" }));
  });

  it("blocks a viewer from writing a line's branch stock note", async () => {
    await seedAdmin("bsnViewer1", "viewer");
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "orders/bsn9"), baseOrder("alice"));
    });
    const viewer = env.authenticatedContext("bsnViewer1", IDENTIFIED);
    await assertFails(
      updateDoc(doc(viewer.firestore(), "orders/bsn9"), { lineBranchStockNotes: { "p1::v1::M": noteEntry("bsnViewer1", "Available at the second branch.") } })
    );
  });

  it("blocks an anonymous/guest user from writing a line's branch stock note", async () => {
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "orders/bsn10"), baseOrder("guestX"));
    });
    const guest = env.authenticatedContext("guestX", ANONYMOUS);
    await assertFails(
      updateDoc(doc(guest.firestore(), "orders/bsn10"), { lineBranchStockNotes: { "p1::v1::M": noteEntry("guestX", "Available at the second branch.") } })
    );
  });

  it("does not change the existing customer notes / delivery instructions field at all (regression)", async () => {
    await seedAdmin("bsnAdmin2", "admin");
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "orders/bsn11"), baseOrder("alice", { notes: "Leave with the doorman if not home." }));
    });
    const admin = env.authenticatedContext("bsnAdmin2", IDENTIFIED);
    await assertSucceeds(
      updateDoc(doc(admin.firestore(), "orders/bsn11"), {
        lineBranchStockNotes: { "p1::v1::M": noteEntry("bsnAdmin2", "Available at the second branch.") },
      })
    );
    const snap = await getDoc(doc(admin.firestore(), "orders/bsn11"));
    if (snap.data()?.notes !== "Leave with the doorman if not home.") {
      throw new Error(`expected original customer notes untouched, got ${JSON.stringify(snap.data()?.notes)}`);
    }
  });
});

// Per-product cart note: an optional, per-order-line customer note (see
// CartLine.note / placeOrder()'s PlaceOrderLineInput). isValidCheckoutOrder()
// / lineMatchesClaim() only ever check 5 named fields on a line
// (productId/variantId/size/qty/price) and never do exhaustive key-set
// equality, so an extra `note` key on a line was never expected to require a
// rules change -- these tests prove that empirically against the real
// emulator rather than just by inspection.
describe("checkout: per-line customer note", () => {
  beforeEach(async () => {
    await clearFirestore();
    await seedTestZone();
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  it("accepts a checkout order whose line carries a customer note", async () => {
    await seedProduct();
    const env = await getTestEnv();
    const shopper = env.authenticatedContext("noteShopper1", ANONYMOUS);
    const fs = shopper.firestore();
    await assertSucceeds(
      checkoutTransaction(fs, {
        uid: "noteShopper1",
        claimLines: [{ productId: "prod1", variantId: "black", size: "S", qty: 2, price: 100 }],
        productWrites: [{ id: "prod1", colorVariants: decrement(PRODUCT.colorVariants, "black", "S", 2) }],
        order: baseOrder("noteShopper1", {
          lines: [{ productId: "prod1", variantId: "black", name: "Test Dress", qty: 2, price: 100, size: "S", color: "Black", note: "Please gift-wrap this." }],
        }),
      })
    );
  });

  it("accepts a multi-line order where only one line has a note (per-line isolation)", async () => {
    await seedProduct();
    const env = await getTestEnv();
    const shopper = env.authenticatedContext("noteShopper2", ANONYMOUS);
    const fs = shopper.firestore();
    await assertSucceeds(
      checkoutTransaction(fs, {
        uid: "noteShopper2",
        claimLines: [
          { productId: "prod1", variantId: "black", size: "S", qty: 1, price: 100 },
          { productId: "prod1", variantId: "black", size: "M", qty: 1, price: 100 },
        ],
        productWrites: [
          {
            id: "prod1",
            colorVariants: decrement(decrement(PRODUCT.colorVariants, "black", "S", 1), "black", "M", 1),
          },
        ],
        order: baseOrder("noteShopper2", {
          lines: [
            { productId: "prod1", variantId: "black", name: "Test Dress", qty: 1, price: 100, size: "S", color: "Black", note: "Rush delivery please" },
            { productId: "prod1", variantId: "black", name: "Test Dress", qty: 1, price: 100, size: "M", color: "Black" },
          ],
          subtotal: 200,
          total: 200,
        }),
      })
    );
  });

  it("still accepts an order whose lines have no note field at all (regression)", async () => {
    await seedProduct();
    const env = await getTestEnv();
    const shopper = env.authenticatedContext("noteShopper3", ANONYMOUS);
    const fs = shopper.firestore();
    await assertSucceeds(
      checkoutTransaction(fs, {
        uid: "noteShopper3",
        claimLines: [{ productId: "prod1", variantId: "black", size: "S", qty: 1, price: 100 }],
        productWrites: [{ id: "prod1", colorVariants: decrement(PRODUCT.colorVariants, "black", "S", 1) }],
        order: baseOrder("noteShopper3", {
          lines: [{ productId: "prod1", variantId: "black", name: "Test Dress", qty: 1, price: 100, size: "S", color: "Black" }],
          subtotal: 100,
          total: 100,
        }),
      })
    );
  });

  it("an admin editing order line items via updateOrderLines-style write preserves an existing note field", async () => {
    // Mirrors adminOrderEdit.ts's updateOrderLines() write shape (a plain
    // tx.update on orders/{id} to `lines`/subtotal/shipping/total) rather
    // than re-implementing the transaction -- this test's only job is to
    // prove the rules layer doesn't reject a `note` key riding along on an
    // admin's order-line update, same as it doesn't at order-create time.
    await seedAdmin("noteAdmin1", "admin");
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), "orders/noteOrder1"),
        baseOrder("alice", {
          lines: [{ productId: "prod1", variantId: "black", name: "Test Dress", qty: 1, price: 100, size: "S", color: "Black", note: "Handle with care" }],
          status: "pending",
        })
      );
    });
    const admin = env.authenticatedContext("noteAdmin1", IDENTIFIED);
    await assertSucceeds(
      updateDoc(doc(admin.firestore(), "orders/noteOrder1"), {
        lines: [{ productId: "prod1", variantId: "black", name: "Test Dress", qty: 2, price: 100, size: "S", color: "Black", note: "Handle with care" }],
        subtotal: 200,
        total: 200,
      })
    );
    const snap = await getDoc(doc(admin.firestore(), "orders/noteOrder1"));
    if (snap.data()?.lines?.[0]?.note !== "Handle with care") {
      throw new Error(`expected note to survive the line-item edit, got ${JSON.stringify(snap.data()?.lines)}`);
    }
  });
});
