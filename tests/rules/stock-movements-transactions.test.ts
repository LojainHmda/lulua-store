import { assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, query, runTransaction, setDoc, updateDoc, where } from "firebase/firestore";
import type { Firestore } from "firebase/firestore";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { computeStockDeltas } from "../../src/admin/stockMovements";
import { clearFirestore, getTestEnv, teardownTestEnv } from "./setup";
import { seedBranchSetup } from "./branchFixtures";

// Phase 2 focused tests: verify the ACTUAL SHAPE of transaction that
// orderTransaction.ts / adminOrderEdit.ts / returnsTransaction.ts now write
// (stock update + stockMovements doc(s), same transaction) behaves
// correctly against the real firestore.rules, for every scenario called out
// in the Phase 2 request. These hand-roll the transaction shape rather than
// importing placeOrder()/updateOrderLines()/resolveReturn() directly —
// those functions are bound to the app's own `db`/`auth` singletons
// (src/firebase/config.ts, src/firebase/auth.ts), a different Firestore/Auth
// client instance than @firebase/rules-unit-testing's isolated
// RulesTestEnvironment context, so they can't be invoked against this
// harness directly. This is the SAME approach every existing file in this
// suite already uses (see checkout.test.ts's own checkoutTransaction()) —
// not a shortcut specific to this file. computeStockDeltas() itself,
// however, IS imported and called for real (it's a pure function with no
// Firebase dependency), so these tests exercise the actual shared helper,
// not a hand-derived reimplementation of it.

const IDENTIFIED = { firebase: { sign_in_provider: "password" as const } };

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

// This test harness's SDK (unlike the app's own initializeFirestore with
// ignoreUndefinedProperties) rejects an explicit `undefined` field value
// outright rather than omitting the key — matching stock-movements.test.ts's
// (Phase 1) own precedent.
function stripUndefined<T extends Record<string, unknown>>(obj: T): T {
  const copy = { ...obj };
  for (const key of Object.keys(copy)) {
    if (copy[key] === undefined) delete copy[key];
  }
  return copy;
}

function product(colorVariants: ColorVariant[], overrides: Record<string, unknown> = {}) {
  return { name: "Ledger Test Product", slug: "ledger-test-product", price: 50, status: "active", colorVariants, ...overrides };
}

async function seedAdmin(uid: string, role: string) {
  const env = await getTestEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `admins/${uid}`), { email: `${uid}@example.com`, displayName: uid, role, active: true });
  });
}

// Every web order created below charges shipping: 0 -- backed by a real,
// active, zero-fee zone so isValidShippingForOrder() (firestore.rules)
// accepts it, same TEST_ZONE_ID pattern checkout.test.ts uses. POS orders
// never reference a zone at all (POS stays zero-shipping via a separate,
// isCashierOrAbove()-gated rule branch that doesn't require one).
const TEST_ZONE_ID = "test-zone";

async function seedTestZone() {
  const env = await getTestEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `deliveryZones/${TEST_ZONE_ID}`), { name: "Test Zone", nameAr: "منطقة تجريبية", fee: 0, active: true, sortOrder: 0 });
  });
}

async function seedProduct(id: string, data: Record<string, unknown>) {
  const env = await getTestEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `products/${id}`), data);
  });
}

async function seedReturn(id: string, overrides: Record<string, unknown> = {}) {
  const env = await getTestEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `returns/${id}`), {
      orderId: "order1",
      orderNumber: "SIS-RET1",
      customerName: "Test Customer",
      customerEmail: "test@example.com",
      productId: "prodR",
      productName: "Ledger Test Product",
      variantId: "v1",
      colorName: "Black",
      size: "S",
      qty: 1,
      reason: "defective",
      status: "quarantine",
      disposition: null,
      restocked: false,
      processedBy: "cashier1@example.com",
      processedByName: "cashier1",
      ...overrides,
    });
  });
}

// Verification reads only — deliberately bypasses rules (via
// withSecurityRulesDisabled, same as every seed*() helper above) since the
// point here is "did the data end up correct," not re-testing the read
// permission boundary (already covered in full by stock-movements.test.ts,
// Phase 1). Using a restricted (e.g. plain customer) context for these
// would just fail on the READ rule itself and tell us nothing new.
async function allMovements(productId?: string): Promise<Record<string, unknown>[]> {
  const env = await getTestEnv();
  // withSecurityRulesDisabled()'s real type signature is
  // `(ctx) => Promise<void>) => Promise<void>` — TypeScript's void-return
  // compatibility rule lets a callback return a value without a type
  // error, but the value is NOT propagated through the outer promise at
  // runtime. Captured via an outer variable instead of `return`ed.
  let result: Record<string, unknown>[] = [];
  await env.withSecurityRulesDisabled(async (ctx) => {
    const fs = ctx.firestore();
    const q = productId ? query(collection(fs, "stockMovements"), where("productId", "==", productId)) : collection(fs, "stockMovements");
    const snap = await getDocs(q);
    result = snap.docs.map((d) => d.data());
  });
  return result;
}

async function productQty(productId: string, variantId: string, size: string): Promise<number> {
  const env = await getTestEnv();
  let result = Number.NaN;
  await env.withSecurityRulesDisabled(async (ctx) => {
    const snap = await getDoc(doc(ctx.firestore(), "products", productId));
    const p = snap.data() as { colorVariants: ColorVariant[] };
    result = p.colorVariants.find((v) => v.id === variantId)!.sizeStock.find((s) => s.size === size)!.qty;
  });
  return result;
}

// Mirrors orderTransaction.ts's real shape exactly: claim + N product
// decrements (each producing its stockMovements docs via the real
// computeStockDeltas()) + order create, all one transaction.
function checkoutWithLedger(
  fs: Firestore,
  uid: string,
  opts: {
    lines: { productId: string; variantId: string; size: string; qty: number; price: number }[];
    isPos: boolean;
    cashierUid?: string;
    cashierEmail?: string;
    cashierName?: string;
    registerSessionId?: string;
    branchId?: string;
    failIfInsufficientStock?: boolean;
  }
) {
  const distinctIds = [...new Set(opts.lines.map((l) => l.productId))];
  return runTransaction(fs, async (tx) => {
    const refs = distinctIds.map((id) => doc(fs, "products", id));
    const snaps = await Promise.all(refs.map((r) => tx.get(r)));
    const sessionSnap = opts.registerSessionId ? await tx.get(doc(fs, "registerSessions", opts.registerSessionId)) : null;

    const orderRef = doc(collection(fs, "orders"));
    const orderNumber = `SIS-LEDGERTEST-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

    tx.set(doc(fs, "checkoutClaims", uid), { lines: opts.lines });

    snaps.forEach((snap, i) => {
      const productId = distinctIds[i];
      const p = snap.data() as { name: string; colorVariants: ColorVariant[] };
      const linesForProduct = opts.lines.filter((l) => l.productId === productId);
      const newColorVariants = p.colorVariants.map((v) => ({
        ...v,
        sizeStock: v.sizeStock.map((s) => {
          const claimed = linesForProduct.filter((l) => l.variantId === v.id && l.size === s.size).reduce((sum, l) => sum + l.qty, 0);
          if (claimed === 0) return s;
          if (opts.failIfInsufficientStock && s.qty < claimed) {
            throw new Error(`insufficient stock for ${productId}/${v.id}/${s.size}`);
          }
          return { ...s, qty: s.qty - claimed };
        }),
      }));
      tx.update(doc(fs, "products", productId), { colorVariants: newColorVariants, updatedAt: new Date() });
      for (const d of computeStockDeltas(p.colorVariants, newColorVariants)) {
        tx.set(
          doc(collection(fs, "stockMovements")),
          stripUndefined({
            productId,
            productName: p.name,
            variantId: d.variantId,
            colorName: d.colorName,
            size: d.size,
            qtyBefore: d.qtyBefore,
            qtyChange: d.qtyChange,
            qtyAfter: d.qtyAfter,
            reason: "sale",
            source: opts.isPos ? "pos" : "web",
            actorUid: opts.isPos ? opts.cashierUid : undefined,
            actorEmail: opts.isPos ? opts.cashierEmail : undefined,
            actorName: opts.isPos ? opts.cashierName : undefined,
            orderId: orderRef.id,
            orderNumber,
            createdAt: new Date(),
          })
        );
      }
    });

    const subtotal = opts.lines.reduce((sum, l) => sum + l.price * l.qty, 0);
    tx.set(
      orderRef,
      stripUndefined({
        orderNumber,
        customerId: uid,
        customerName: "Ledger Test Customer",
        customerEmail: "ledger@example.com",
        lines: opts.lines.map((l) => ({ productId: l.productId, variantId: l.variantId, name: "Ledger Test Product", qty: l.qty, price: l.price, size: l.size, color: "Black" })),
        subtotal,
        discount: 0,
        shipping: 0,
        total: subtotal,
        status: "pending",
        source: opts.isPos ? "pos" : "web",
        // Multi-branch: a cashier's POS order names their branch + session.
        branchId: opts.isPos ? opts.branchId : undefined,
        registerSessionId: opts.isPos ? opts.registerSessionId : undefined,
        policyConsent: opts.isPos ? undefined : { policyVersion: 1, lang: "en" },
        deliveryZoneId: opts.isPos ? undefined : TEST_ZONE_ID,
        deliveryZoneName: opts.isPos ? undefined : "Test Zone",
        deliveryZoneNameAr: opts.isPos ? undefined : "منطقة تجريبية",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
    );

    if (sessionSnap?.exists() && opts.registerSessionId) {
      tx.update(doc(fs, "registerSessions", opts.registerSessionId), {
        salesCount: 1, cashTotal: subtotal, cardTotal: 0, discountTotal: 0, grossTotal: subtotal, updatedAt: new Date(),
      });
    }

    return orderRef.id;
  });
}

// Mirrors adminOrderEdit.ts's real shape: stock update + stockMovements
// doc(s) for every real delta, same transaction.
function orderEditWithLedger(
  fs: Firestore,
  opts: { productId: string; before: ColorVariant[]; after: ColorVariant[]; orderId: string; orderNumber: string; actorEmail: string; actorName: string }
) {
  return runTransaction(fs, async (tx) => {
    tx.update(doc(fs, "products", opts.productId), { colorVariants: opts.after, updatedAt: new Date() });
    for (const d of computeStockDeltas(opts.before, opts.after)) {
      tx.set(doc(collection(fs, "stockMovements")), {
        productId: opts.productId,
        productName: "Ledger Test Product",
        variantId: d.variantId,
        colorName: d.colorName,
        size: d.size,
        qtyBefore: d.qtyBefore,
        qtyChange: d.qtyChange,
        qtyAfter: d.qtyAfter,
        reason: "order_edit",
        source: "admin",
        actorEmail: opts.actorEmail,
        actorName: opts.actorName,
        orderId: opts.orderId,
        orderNumber: opts.orderNumber,
        createdAt: new Date(),
      });
    }
  });
}

// Mirrors returnsTransaction.ts's resolveReturn(..., "good") shape: stock
// restore + return status update + stockMovements doc(s), same transaction.
function resolveGoodReturnWithLedger(
  fs: Firestore,
  opts: { returnId: string; productId: string; before: ColorVariant[]; after: ColorVariant[]; orderId: string; orderNumber: string; actorEmail: string; actorName: string }
) {
  return runTransaction(fs, async (tx) => {
    tx.update(doc(fs, "products", opts.productId), { colorVariants: opts.after, updatedAt: new Date() });
    tx.update(doc(fs, "returns", opts.returnId), {
      status: "resolved", disposition: "good", restocked: true,
      resolvedBy: opts.actorEmail, resolvedByName: opts.actorName, resolvedAt: new Date(), updatedAt: new Date(),
    });
    for (const d of computeStockDeltas(opts.before, opts.after)) {
      tx.set(doc(collection(fs, "stockMovements")), {
        productId: opts.productId,
        productName: "Ledger Test Product",
        variantId: d.variantId,
        colorName: d.colorName,
        size: d.size,
        qtyBefore: d.qtyBefore,
        qtyChange: d.qtyChange,
        qtyAfter: d.qtyAfter,
        reason: "return_restock",
        source: "admin",
        actorEmail: opts.actorEmail,
        actorName: opts.actorName,
        orderId: opts.orderId,
        orderNumber: opts.orderNumber,
        returnId: opts.returnId,
        createdAt: new Date(),
      });
    }
  });
}

describe("stock movement ledger: transactional integration", () => {
  beforeEach(async () => {
    await clearFirestore();
    await seedTestZone();
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  it("website sale creates the correct negative movement, no invented actor", async () => {
    await seedProduct("p1", product([{ id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 5 }] }]));
    const env = await getTestEnv();
    const customer = env.authenticatedContext("cust1", IDENTIFIED);
    await assertSucceeds(
      checkoutWithLedger(customer.firestore(), "cust1", { lines: [{ productId: "p1", variantId: "black", size: "S", qty: 2, price: 50 }], isPos: false })
    );
    const movements = await allMovements("p1");
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ variantId: "black", size: "S", qtyBefore: 5, qtyChange: -2, qtyAfter: 3, reason: "sale", source: "web" });
    expect(movements[0].actorUid).toBeUndefined();
    expect(movements[0].actorEmail).toBeUndefined();
    expect(movements[0].actorName).toBeUndefined();
  });

  it("POS sale creates the correct negative movement and identifies source/cashier correctly", async () => {
    await seedProduct("p1", product([{ id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 5 }] }]));
    await seedBranchSetup({ uid: "cashier1", sessionId: "sess1" });
    const env = await getTestEnv();
    const cashier = env.authenticatedContext("cashier1", IDENTIFIED);
    await assertSucceeds(
      checkoutWithLedger(cashier.firestore(), "cashier1", {
        lines: [{ productId: "p1", variantId: "black", size: "S", qty: 1, price: 50 }],
        isPos: true,
        cashierUid: "cashier1",
        cashierEmail: "cashier1@example.com",
        cashierName: "Cashier One",
        registerSessionId: "sess1",
        branchId: "b1",
      })
    );
    const movements = await allMovements("p1");
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      qtyBefore: 5, qtyChange: -1, qtyAfter: 4, reason: "sale", source: "pos",
      actorUid: "cashier1", actorEmail: "cashier1@example.com", actorName: "Cashier One",
    });
  });

  it("a multi-variant/multi-size sale across two products creates exactly the required movement rows", async () => {
    await seedProduct(
      "p1",
      product([
        { id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 5 }, { size: "M", qty: 5 }] },
        { id: "red", colorName: "Red", colorHex: "#f00", sizeStock: [{ size: "S", qty: 5 }] },
      ])
    );
    await seedProduct("p2", product([{ id: "default", colorName: "Only", colorHex: "#111", sizeStock: [{ size: "One Size", qty: 5 }] }]));
    const env = await getTestEnv();
    const customer = env.authenticatedContext("cust1", IDENTIFIED);
    await assertSucceeds(
      checkoutWithLedger(customer.firestore(), "cust1", {
        isPos: false,
        lines: [
          { productId: "p1", variantId: "black", size: "S", qty: 1, price: 50 },
          { productId: "p1", variantId: "black", size: "M", qty: 2, price: 50 },
          { productId: "p1", variantId: "red", size: "S", qty: 1, price: 50 },
          { productId: "p2", variantId: "default", size: "One Size", qty: 3, price: 50 },
        ],
      })
    );
    const movements = await allMovements();
    expect(movements).toHaveLength(4);
    const bySize = new Map(movements.map((m) => [`${m.productId}::${m.variantId}::${m.size}`, m]));
    expect(bySize.get("p1::black::S")).toMatchObject({ qtyBefore: 5, qtyChange: -1, qtyAfter: 4 });
    expect(bySize.get("p1::black::M")).toMatchObject({ qtyBefore: 5, qtyChange: -2, qtyAfter: 3 });
    expect(bySize.get("p1::red::S")).toMatchObject({ qtyBefore: 5, qtyChange: -1, qtyAfter: 4 });
    expect(bySize.get("p2::default::One Size")).toMatchObject({ qtyBefore: 5, qtyChange: -3, qtyAfter: 2 });
  });

  it("admin order-line increase AND decrease in the same edit creates correctly signed movements", async () => {
    await seedAdmin("admin1", "admin");
    await seedProduct(
      "p1",
      product([{ id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 10 }, { size: "M", qty: 2 }] }])
    );
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    // S: order line qty went UP by 3 -> stock DOWN by 3 (10 -> 7).
    // M: order line qty went DOWN by 3 -> stock UP by 3 (2 -> 5).
    await assertSucceeds(
      orderEditWithLedger(admin.firestore(), {
        productId: "p1",
        before: [{ id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 10 }, { size: "M", qty: 2 }] }],
        after: [{ id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 7 }, { size: "M", qty: 5 }] }],
        orderId: "order1",
        orderNumber: "SIS-EDIT1",
        actorEmail: "admin1@example.com",
        actorName: "admin1",
      })
    );
    const movements = await allMovements("p1");
    expect(movements).toHaveLength(2);
    const bySize = new Map(movements.map((m) => [m.size, m]));
    expect(bySize.get("S")).toMatchObject({ qtyBefore: 10, qtyChange: -3, qtyAfter: 7, reason: "order_edit", source: "admin", actorEmail: "admin1@example.com" });
    expect(bySize.get("M")).toMatchObject({ qtyBefore: 2, qtyChange: 3, qtyAfter: 5, reason: "order_edit", source: "admin" });
  });

  it("zero-delta order edit (no real quantity change) creates no movement", async () => {
    await seedAdmin("admin1", "admin");
    const same: ColorVariant[] = [{ id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 10 }] }];
    await seedProduct("p1", product(same));
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await assertSucceeds(
      orderEditWithLedger(admin.firestore(), {
        productId: "p1", before: same, after: same, orderId: "order1", orderNumber: "SIS-EDIT2", actorEmail: "admin1@example.com", actorName: "admin1",
      })
    );
    expect(await allMovements("p1")).toHaveLength(0);
  });

  it("a return resolved as Good creates the correct positive movement", async () => {
    await seedAdmin("admin1", "admin");
    await seedProduct("prodR", product([{ id: "v1", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 3 }] }]));
    await seedReturn("ret1");
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await assertSucceeds(
      resolveGoodReturnWithLedger(admin.firestore(), {
        returnId: "ret1",
        productId: "prodR",
        before: [{ id: "v1", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 3 }] }],
        after: [{ id: "v1", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 4 }] }],
        orderId: "order1",
        orderNumber: "SIS-RET1",
        actorEmail: "admin1@example.com",
        actorName: "admin1",
      })
    );
    const movements = await allMovements("prodR");
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      qtyBefore: 3, qtyChange: 1, qtyAfter: 4, reason: "return_restock", source: "admin", returnId: "ret1", orderId: "order1", orderNumber: "SIS-RET1",
    });
  });

  it("a return resolved as Damaged (non-restocking) creates no movement", async () => {
    await seedAdmin("admin1", "admin");
    await seedProduct("prodR", product([{ id: "v1", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 3 }] }]));
    await seedReturn("ret2");
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    // Damaged never touches product stock at all -- a plain returns/{id}
    // update, exactly like returnsTransaction.ts's real markDamaged path.
    await assertSucceeds(
      updateDoc(doc(admin.firestore(), "returns/ret2"), {
        status: "resolved", disposition: "damaged", restocked: false, resolvedBy: "admin1@example.com", resolvedByName: "admin1", resolvedAt: new Date(),
      })
    );
    expect(await allMovements("prodR")).toHaveLength(0);
  });

  it("a failed transaction (rules-rejected) commits neither the stock change nor any movement", async () => {
    await seedProduct("p1", product([{ id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 5 }] }]));
    const env = await getTestEnv();
    const customer = env.authenticatedContext("cust1", IDENTIFIED);
    // Deliberately skip setting checkoutClaims -- isValidStockDecrement()
    // requires a matching claim, so this whole transaction (product update
    // AND the stockMovements tx.set() riding along with it) must be
    // rejected by the rules engine and nothing may commit.
    await assertFails(
      runTransaction(customer.firestore(), async (tx) => {
        const ref = doc(customer.firestore(), "products/p1");
        const snap = await tx.get(ref);
        const p = snap.data() as { name: string; colorVariants: ColorVariant[] };
        const newColorVariants = p.colorVariants.map((v) => ({ ...v, sizeStock: v.sizeStock.map((s) => ({ ...s, qty: s.qty - 1 })) }));
        tx.update(ref, { colorVariants: newColorVariants, updatedAt: new Date() });
        for (const d of computeStockDeltas(p.colorVariants, newColorVariants)) {
          tx.set(doc(collection(customer.firestore(), "stockMovements")), {
            productId: "p1", productName: p.name, variantId: d.variantId, colorName: d.colorName, size: d.size,
            qtyBefore: d.qtyBefore, qtyChange: d.qtyChange, qtyAfter: d.qtyAfter,
            reason: "sale", source: "web", orderId: "order-orphan", orderNumber: "SIS-ORPHAN", createdAt: new Date(),
          });
        }
      })
    );
    expect(await productQty("p1", "black", "S")).toBe(5);
    expect(await allMovements("p1")).toHaveLength(0);
  });

  it("a failed transaction (application-level throw, e.g. insufficient stock) commits neither the stock change nor any movement", async () => {
    await seedProduct("p1", product([{ id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 1 }] }]));
    const env = await getTestEnv();
    const customer = env.authenticatedContext("cust1", IDENTIFIED);
    await expect(
      checkoutWithLedger(customer.firestore(), "cust1", {
        lines: [{ productId: "p1", variantId: "black", size: "S", qty: 5, price: 50 }],
        isPos: false,
        failIfInsufficientStock: true,
      })
    ).rejects.toThrow();
    expect(await productQty("p1", "black", "S")).toBe(1);
    expect(await allMovements("p1")).toHaveLength(0);
  });

  it("concurrent transactions racing for the last unit commit exactly one movement, never a duplicate", async () => {
    await seedProduct("p1", product([{ id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 1 }] }]));
    const env = await getTestEnv();
    const custA = env.authenticatedContext("custA", IDENTIFIED);
    const custB = env.authenticatedContext("custB", IDENTIFIED);
    const attempt = (fs: Firestore, uid: string) =>
      checkoutWithLedger(fs, uid, {
        lines: [{ productId: "p1", variantId: "black", size: "S", qty: 1, price: 50 }],
        isPos: false,
        failIfInsufficientStock: true,
      }).then(
        () => ({ ok: true as const }),
        (err) => ({ ok: false as const, err })
      );
    const [resultA, resultB] = await Promise.all([attempt(custA.firestore(), "custA"), attempt(custB.firestore(), "custB")]);
    const successes = [resultA, resultB].filter((r) => r.ok);
    expect(successes).toHaveLength(1);
    const movements = await allMovements("p1");
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ qtyBefore: 1, qtyChange: -1, qtyAfter: 0 });
    expect(await productQty("p1", "black", "S")).toBe(0);
  });
});
