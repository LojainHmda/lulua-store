import { assertFails, assertSucceeds } from "./testing";
import { collection, doc, getDoc, runTransaction, setDoc, updateDoc } from "../../src/db/firestore";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { clearFirestore, getTestEnv, teardownTestEnv } from "./setup";

// Regression + new-feature coverage for the approved
// colorvariants-map-migration-plan-2026-09-22 flattened stock schema
// (colorVariants: metadata-only map; stockByCell: flat, composite-keyed
// "<variantId>::<size>" map). This is the formal test-suite counterpart of
// the two feasibility spikes' emulator matrices
// (migration/colorvariants-map-migration-plan-2026-09-22/spike/ and
// .../spike2/) — every case proven there is re-proven here against the
// REAL, deployed firestore.rules (not a standalone prototype copy), so
// this suite is what actually gates the migration going forward.
//
// Covers exactly the 11 required cases from the approved implementation
// request, plus the full security/tampering suite, plus realistic catalog
// shapes (the real product-732 shape: 18 colors, 40 total slots) and a
// synthetic shape far beyond anything in the real catalog (300 slots).

interface FlatStockCell {
  qty: number;
  qtyUnknown?: boolean;
}
interface FlatVariantMeta {
  colorName: string;
  colorHex: string;
  order: number;
}
interface FlatProduct {
  name: string;
  price: number;
  status: string;
  colorVariants: Record<string, FlatVariantMeta>;
  stockByCell: Record<string, FlatStockCell>;
}
interface ClaimLine {
  productId: string;
  variantId: string;
  size: string;
  qty: number;
  price: number;
}

function flatProduct(colorSpecs: Record<string, { colorName: string; sizes: Record<string, number> }>, price = 50): FlatProduct {
  const colorVariants: Record<string, FlatVariantMeta> = {};
  const stockByCell: Record<string, FlatStockCell> = {};
  let order = 0;
  for (const [vid, spec] of Object.entries(colorSpecs)) {
    colorVariants[vid] = { colorName: spec.colorName, colorHex: "#112233", order: order++ };
    for (const [size, qty] of Object.entries(spec.sizes)) stockByCell[`${vid}::${size}`] = { qty };
  }
  return { name: "Flat Schema Test Product", price, status: "active", colorVariants, stockByCell };
}

function smallFlat(): FlatProduct {
  return flatProduct({ black: { colorName: "Black", sizes: { S: 10, M: 5 } } });
}
function shape4x3Flat(): FlatProduct {
  // Mirrors real product 636: 4 colors x 3 sizes = 12 total slots.
  return flatProduct({
    gray: { colorName: "Gray", sizes: { S: 5, M: 5, L: 5 } },
    olive: { colorName: "Olive", sizes: { S: 5, M: 5, L: 5 } },
    navy: { colorName: "Navy", sizes: { S: 5, M: 5, L: 5 } },
    brown: { colorName: "Brown", sizes: { S: 5, M: 5, L: 5 } },
  });
}
function largeShapeFlat(): FlatProduct {
  // Mirrors the real product-732/734 shape: 18 colors, 40 total slots.
  const spec: Record<string, { colorName: string; sizes: Record<string, number> }> = {};
  let remaining = 40;
  for (let v = 0; v < 18; v++) {
    const n = v === 17 ? Math.max(1, remaining) : 2;
    remaining -= n;
    const sizes: Record<string, number> = {};
    for (let s = 0; s < n; s++) sizes[`SZ${s}`] = 10;
    spec[`v${v}`] = { colorName: `Color${v}`, sizes };
  }
  return flatProduct(spec);
}
function eightVariantFlat(): FlatProduct {
  const spec: Record<string, { colorName: string; sizes: Record<string, number> }> = {};
  for (let v = 0; v < 18; v++) spec[`v${v}`] = { colorName: `Color${v}`, sizes: { SZ0: 10, SZ1: 10 } };
  return flatProduct(spec);
}
function syntheticExtremeFlat(): FlatProduct {
  // 30 colors x 10 sizes = 300 total slots -- 7.5x today's real worst case.
  const spec: Record<string, { colorName: string; sizes: Record<string, number> }> = {};
  for (let v = 0; v < 30; v++) {
    const sizes: Record<string, number> = {};
    for (let s = 0; s < 10; s++) sizes[`SZ${s}`] = 10;
    spec[`v${v}`] = { colorName: `Color${v}`, sizes };
  }
  return flatProduct(spec);
}
function oldArrayShapedProduct() {
  return {
    name: "Legacy Array-Shaped Product",
    price: 50,
    status: "active",
    colorVariants: [
      { id: "black", colorName: "Black", colorHex: "#000", sizeStock: [{ size: "S", qty: 10 }, { size: "M", qty: 5 }] },
      { id: "white", colorName: "White", colorHex: "#fff", sizeStock: [{ size: "S", qty: 8 }, { size: "M", qty: 8 }] },
    ],
  };
}

async function seedAdmin(uid: string, role: string) {
  const env = await getTestEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `admins/${uid}`), { email: `${uid}@example.com`, displayName: uid, role, active: true, branchIds: ["b1"] });
  });
}
async function seedProduct(id: string, data: FlatProduct | ReturnType<typeof oldArrayShapedProduct>) {
  const env = await getTestEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `products/${id}`), data);
  });
}
async function seedOpenSession(id: string, cashierId: string) {
  const env = await getTestEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `registerSessions/${id}`), {
      cashierId, status: "open", salesCount: 0, cashTotal: 0, cardTotal: 0, discountTotal: 0, grossTotal: 0, startingCash: 0,
      branchId: "b1", registerId: "b1-r1",
    });
  });
}

function applyDecrementFlat(stockByCell: Record<string, FlatStockCell>, linesForProduct: ClaimLine[]): Record<string, FlatStockCell> {
  const after = JSON.parse(JSON.stringify(stockByCell)) as Record<string, FlatStockCell>;
  for (const l of linesForProduct) {
    const key = `${l.variantId}::${l.size}`;
    if (!after[key]) continue; // nonexistent cell: leave untouched, let the rule itself reject via the claim
    after[key] = { qty: after[key].qty - l.qty };
  }
  return after;
}

const IDENTIFIED = { firebase: { sign_in_provider: "password" as const } };

async function attemptPosSale(opts: {
  uid: string;
  sessionId: string;
  lines: ClaimLine[];
  productWriteOverride?: (after: Record<string, FlatStockCell>, productId: string) => Record<string, FlatStockCell>;
}) {
  const env = await getTestEnv();
  const ctx = env.authenticatedContext(opts.uid, IDENTIFIED);
  const fs = ctx.firestore();
  const byProduct = new Map<string, ClaimLine[]>();
  for (const l of opts.lines) {
    if (!byProduct.has(l.productId)) byProduct.set(l.productId, []);
    byProduct.get(l.productId)!.push(l);
  }
  return runTransaction(fs, async (tx) => {
    const productSnaps = new Map<string, FlatProduct>();
    for (const pid of byProduct.keys()) {
      const snap = await tx.get(doc(fs, "products", pid));
      productSnaps.set(pid, snap.data() as FlatProduct);
    }
    const sessionRef = doc(fs, "registerSessions", opts.sessionId);
    const sessionSnap = await tx.get(sessionRef);
    tx.set(doc(fs, "checkoutClaims", opts.uid), { lines: opts.lines });
    let total = 0;
    for (const [pid, productLines] of byProduct) {
      const product = productSnaps.get(pid)!;
      let after = applyDecrementFlat(product.stockByCell, productLines);
      if (opts.productWriteOverride) after = opts.productWriteOverride(after, pid);
      tx.update(doc(fs, "products", pid), { stockByCell: after, updatedAt: new Date() });
      total += productLines.reduce((s, l) => s + l.price * l.qty, 0);
    }
    tx.set(doc(collection(fs, "orders")), {
      orderNumber: "SIS-FLAT-TEST",
      customerName: "Walk-in customer",
      customerEmail: "",
      lines: opts.lines.map((l) => ({ productId: l.productId, variantId: l.variantId, size: l.size, qty: l.qty, price: l.price, name: "x", color: "x" })),
      subtotal: total, discount: 0, shipping: 0, total,
      status: "completed", source: "pos", paymentMethod: "cash",
      cashAmount: total, cardAmount: 0, registerSessionId: opts.sessionId, branchId: "b1",
      createdAt: new Date(), updatedAt: new Date(),
    });
    const s = sessionSnap.data() as { salesCount?: number; cashTotal?: number; cardTotal?: number; discountTotal?: number; grossTotal?: number };
    tx.update(sessionRef, {
      salesCount: (s.salesCount ?? 0) + 1,
      cashTotal: (s.cashTotal ?? 0) + total,
      cardTotal: s.cardTotal ?? 0,
      discountTotal: s.discountTotal ?? 0,
      grossTotal: (s.grossTotal ?? 0) + total,
      updatedAt: new Date(),
    });
  });
}

describe("Flattened stock schema (colorvariants-map-migration-plan-2026-09-22): the 11 required cases", () => {
  beforeEach(async () => {
    await clearFirestore();
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  it("1. one product + one claimed color/variant -> valid", async () => {
    await seedAdmin("c1", "cashier");
    await seedProduct("p1", smallFlat());
    await seedOpenSession("s1", "c1");
    await assertSucceeds(attemptPosSale({ uid: "c1", sessionId: "s1", lines: [{ productId: "p1", variantId: "black", size: "S", qty: 2, price: 50 }] }));
  });

  it("2. one product + two distinct claimed color/variants -> valid", async () => {
    await seedAdmin("c2", "cashier");
    await seedProduct("p2", shape4x3Flat());
    await seedOpenSession("s2", "c2");
    await assertSucceeds(
      attemptPosSale({
        uid: "c2", sessionId: "s2",
        lines: [
          { productId: "p2", variantId: "gray", size: "S", qty: 1, price: 50 },
          { productId: "p2", variantId: "olive", size: "M", qty: 1, price: 50 },
        ],
      })
    );
  });

  it("3. one product + three distinct claimed color/variants -> valid", async () => {
    await seedAdmin("c3", "cashier");
    await seedProduct("p3", shape4x3Flat());
    await seedOpenSession("s3", "c3");
    await assertSucceeds(
      attemptPosSale({
        uid: "c3", sessionId: "s3",
        lines: [
          { productId: "p3", variantId: "gray", size: "S", qty: 1, price: 50 },
          { productId: "p3", variantId: "olive", size: "M", qty: 1, price: 50 },
          { productId: "p3", variantId: "navy", size: "L", qty: 1, price: 50 },
        ],
      })
    );
  });

  it("3b. all 8 checkout-line-cap lines against ONE product, 8 distinct variants -> valid (no artificial reduction)", async () => {
    await seedAdmin("c3b", "cashier");
    await seedProduct("p3b", eightVariantFlat());
    await seedOpenSession("s3b", "c3b");
    const lines: ClaimLine[] = Array.from({ length: 8 }, (_, i) => ({ productId: "p3b", variantId: `v${i}`, size: "SZ0", qty: 1, price: 50 }));
    await assertSucceeds(attemptPosSale({ uid: "c3b", sessionId: "s3b", lines }));
  });

  it("4. multiple sizes across two distinct variants of the same product -> valid", async () => {
    await seedAdmin("c4", "cashier");
    await seedProduct("p4", shape4x3Flat());
    await seedOpenSession("s4", "c4");
    await assertSucceeds(
      attemptPosSale({
        uid: "c4", sessionId: "s4",
        lines: [
          { productId: "p4", variantId: "gray", size: "S", qty: 1, price: 50 },
          { productId: "p4", variantId: "gray", size: "M", qty: 1, price: 50 },
          { productId: "p4", variantId: "olive", size: "L", qty: 1, price: 50 },
        ],
      })
    );
  });

  it("5. tampering with an unrelated variant -> rejected", async () => {
    await seedAdmin("c5", "cashier");
    await seedProduct("p5", shape4x3Flat());
    await seedOpenSession("s5", "c5");
    await assertFails(
      attemptPosSale({
        uid: "c5", sessionId: "s5",
        lines: [{ productId: "p5", variantId: "gray", size: "S", qty: 1, price: 50 }],
        productWriteOverride: (after) => { after["navy::S"] = { qty: 999 }; return after; },
      })
    );
  });

  it("6. tampering with an undeclared variant key -> rejected", async () => {
    await seedAdmin("c6", "cashier");
    await seedProduct("p6", eightVariantFlat());
    await seedOpenSession("s6", "c6");
    await assertFails(
      attemptPosSale({
        uid: "c6", sessionId: "s6",
        lines: [
          { productId: "p6", variantId: "v0", size: "SZ0", qty: 1, price: 50 },
          { productId: "p6", variantId: "v1", size: "SZ0", qty: 1, price: 50 },
        ],
        productWriteOverride: (after) => { after["v5::SZ0"] = { qty: 1 }; return after; },
      })
    );
  });

  it("7. tampering with an undeclared size inside a claimed variant -> rejected", async () => {
    await seedAdmin("c7", "cashier");
    await seedProduct("p7", shape4x3Flat());
    await seedOpenSession("s7", "c7");
    await assertFails(
      attemptPosSale({
        uid: "c7", sessionId: "s7",
        lines: [{ productId: "p7", variantId: "gray", size: "S", qty: 1, price: 50 }],
        productWriteOverride: (after) => { after["gray::L"] = { qty: 0 }; return after; },
      })
    );
  });

  it("8a. insufficient stock -> rejected", async () => {
    await seedAdmin("c8a", "cashier");
    await seedProduct("p8a", smallFlat());
    await seedOpenSession("s8a", "c8a");
    await assertFails(attemptPosSale({ uid: "c8a", sessionId: "s8a", lines: [{ productId: "p8a", variantId: "black", size: "S", qty: 999, price: 50 }] }));
  });

  it("8b. direct negative-qty write attempt -> rejected", async () => {
    await seedAdmin("c8b", "cashier");
    await seedProduct("p8b", smallFlat());
    await seedOpenSession("s8b", "c8b");
    await assertFails(
      attemptPosSale({
        uid: "c8b", sessionId: "s8b",
        lines: [{ productId: "p8b", variantId: "black", size: "S", qty: 5, price: 50 }],
        productWriteOverride: (after) => { after["black::S"] = { qty: -1 }; return after; },
      })
    );
  });

  it("9. restock-disguised-as-sale (claim says decrement, write increases) -> rejected", async () => {
    await seedAdmin("c9", "cashier");
    await seedProduct("p9", smallFlat());
    await seedOpenSession("s9", "c9");
    await assertFails(
      attemptPosSale({
        uid: "c9", sessionId: "s9",
        lines: [{ productId: "p9", variantId: "black", size: "S", qty: 1, price: 50 }],
        productWriteOverride: (after) => { after["black::S"] = { qty: 999 }; return after; },
      })
    );
  });

  it("10. nonexistent variant/size -> rejected (at the claim itself)", async () => {
    await seedAdmin("c10", "cashier");
    await seedProduct("p10", smallFlat());
    await seedOpenSession("s10", "c10");
    await assertFails(attemptPosSale({ uid: "c10", sessionId: "s10", lines: [{ productId: "p10", variantId: "purple-does-not-exist", size: "XL", qty: 1, price: 50 }] }));
  });

  it("11. claiming more distinct lines (9) than the existing 8-line checkout limit -> rejected", async () => {
    await seedAdmin("c11", "cashier");
    await seedProduct("p11", eightVariantFlat());
    await seedOpenSession("s11", "c11");
    const nineLines: ClaimLine[] = Array.from({ length: 9 }, (_, i) => ({ productId: "p11", variantId: `v${i}`, size: "SZ0", qty: 1, price: 50 }));
    await assertFails(attemptPosSale({ uid: "c11", sessionId: "s11", lines: nineLines }));
  });
});

describe("Flattened stock schema: additional security, regression, and realistic-scale coverage", () => {
  beforeEach(async () => {
    await clearFirestore();
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  it("colorVariants metadata is frozen during checkout by construction -- tampering it is rejected", async () => {
    await seedAdmin("cid", "cashier");
    await seedProduct("pid", shape4x3Flat());
    await seedOpenSession("sid", "cid");
    const env = await getTestEnv();
    const ctx = env.authenticatedContext("cid", IDENTIFIED);
    const fs = ctx.firestore();
    await assertFails(
      runTransaction(fs, async (tx) => {
        const ref = doc(fs, "products/pid");
        const snap = await tx.get(ref);
        const product = snap.data() as FlatProduct;
        const sessionRef = doc(fs, "registerSessions/sid");
        const sessionSnap = await tx.get(sessionRef);
        tx.set(doc(fs, "checkoutClaims/cid"), { lines: [{ productId: "pid", variantId: "gray", size: "S", qty: 1, price: 50 }] });
        const newColorVariants = JSON.parse(JSON.stringify(product.colorVariants));
        newColorVariants.gray.colorName = "Renamed";
        tx.update(ref, {
          colorVariants: newColorVariants,
          stockByCell: applyDecrementFlat(product.stockByCell, [{ productId: "pid", variantId: "gray", size: "S", qty: 1, price: 50 }]),
          updatedAt: new Date(),
        });
        tx.set(doc(collection(fs, "orders")), { orderNumber: "X", customerName: "x", customerEmail: "", lines: [], subtotal: 50, discount: 0, shipping: 0, total: 50, status: "completed", source: "pos", paymentMethod: "cash", cashAmount: 50, cardAmount: 0, registerSessionId: "sid", createdAt: new Date(), updatedAt: new Date() });
        const s = sessionSnap.data() as { salesCount?: number; cashTotal?: number; grossTotal?: number };
        tx.update(sessionRef, { salesCount: (s.salesCount ?? 0) + 1, cashTotal: (s.cashTotal ?? 0) + 50, cardTotal: 0, discountTotal: 0, grossTotal: (s.grossTotal ?? 0) + 50, updatedAt: new Date() });
      })
    );
  });

  it("a bare stockByCell write with NO checkoutClaims doc backing it -> rejected", async () => {
    await seedAdmin("cnc", "cashier");
    const product = smallFlat();
    await seedProduct("pnc", product);
    const env = await getTestEnv();
    const ctx = env.authenticatedContext("cnc", IDENTIFIED);
    const fs = ctx.firestore();
    await assertFails(updateDoc(doc(fs, "products/pnc"), { stockByCell: applyDecrementFlat(product.stockByCell, [{ productId: "pnc", variantId: "black", size: "S", qty: 1, price: 50 }]), updatedAt: new Date() }));
  });

  it("admin/editor unconditional manual stock edit on a flat-shaped product -> succeeds (no claim needed)", async () => {
    await seedAdmin("edit1", "editor");
    const product = smallFlat();
    await seedProduct("padmin", product);
    const env = await getTestEnv();
    const ctx = env.authenticatedContext("edit1", IDENTIFIED);
    const fs = ctx.firestore();
    const after = { ...product.stockByCell, "black::M": { qty: 999 } };
    await assertSucceeds(updateDoc(doc(fs, "products/padmin"), { stockByCell: after, updatedAt: new Date() }));
  });

  it("a plain cashier CANNOT make a bare unconditional stock edit on a flat-shaped product (role boundary unaffected)", async () => {
    await seedAdmin("cash1", "cashier");
    const product = smallFlat();
    await seedProduct("pcash", product);
    const env = await getTestEnv();
    const ctx = env.authenticatedContext("cash1", IDENTIFIED);
    const fs = ctx.firestore();
    const after = { ...product.stockByCell, "black::M": { qty: 999 } };
    await assertFails(updateDoc(doc(fs, "products/pcash"), { stockByCell: after, updatedAt: new Date() }));
  });

  it("regression: an OLD ARRAY-shaped product's checkout decrement still works completely unchanged", async () => {
    await seedAdmin("cold", "cashier");
    await seedProduct("pold", oldArrayShapedProduct());
    await seedOpenSession("sold", "cold");
    const env = await getTestEnv();
    const ctx = env.authenticatedContext("cold", IDENTIFIED);
    const fs = ctx.firestore();
    await assertSucceeds(
      runTransaction(fs, async (tx) => {
        const ref = doc(fs, "products/pold");
        const snap = await tx.get(ref);
        const product = snap.data() as ReturnType<typeof oldArrayShapedProduct>;
        const sessionRef = doc(fs, "registerSessions/sold");
        const sessionSnap = await tx.get(sessionRef);
        tx.set(doc(fs, "checkoutClaims/cold"), { lines: [{ productId: "pold", variantId: "black", size: "S", qty: 1, price: 50 }] });
        const newColorVariants = product.colorVariants.map((v) => (v.id !== "black" ? v : { ...v, sizeStock: v.sizeStock.map((s) => (s.size !== "S" ? s : { ...s, qty: s.qty - 1 })) }));
        tx.update(ref, { colorVariants: newColorVariants, updatedAt: new Date() });
        tx.set(doc(collection(fs, "orders")), { orderNumber: "OLD", customerName: "x", customerEmail: "", lines: [], subtotal: 50, discount: 0, shipping: 0, total: 50, status: "completed", source: "pos", paymentMethod: "cash", cashAmount: 50, cardAmount: 0, registerSessionId: "sold", branchId: "b1", createdAt: new Date(), updatedAt: new Date() });
        const s = sessionSnap.data() as { salesCount?: number; cashTotal?: number; grossTotal?: number };
        tx.update(sessionRef, { salesCount: (s.salesCount ?? 0) + 1, cashTotal: (s.cashTotal ?? 0) + 50, cardTotal: 0, discountTotal: 0, grossTotal: (s.grossTotal ?? 0) + 50, updatedAt: new Date() });
      })
    );
    const after = await getDoc(doc(fs, "products/pold"));
    const blackS = (after.data()?.colorVariants as { id: string; sizeStock: { size: string; qty: number }[] }[]).find((v) => v.id === "black")?.sizeStock.find((s) => s.size === "S");
    expect(blackS?.qty).toBe(9);
  });

  it("real product-732 shape (18 colors, 40 total slots), 1-line decrement -> valid (catalog-size cliff still gone)", async () => {
    await seedAdmin("clg1", "cashier");
    await seedProduct("plg1", largeShapeFlat());
    await seedOpenSession("slg1", "clg1");
    await assertSucceeds(attemptPosSale({ uid: "clg1", sessionId: "slg1", lines: [{ productId: "plg1", variantId: "v9", size: "SZ0", qty: 1, price: 50 }] }));
  });

  it("real product-732 shape (18 colors, 40 total slots), FULL 8-line claim across 8 distinct variants -> valid", async () => {
    await seedAdmin("clg2", "cashier");
    await seedProduct("plg2", largeShapeFlat());
    await seedOpenSession("slg2", "clg2");
    const lines: ClaimLine[] = Array.from({ length: 8 }, (_, i) => ({ productId: "plg2", variantId: `v${i}`, size: "SZ0", qty: 1, price: 50 }));
    await assertSucceeds(attemptPosSale({ uid: "clg2", sessionId: "slg2", lines }));
  });

  it("same large 8-line claim: tampering with a 9th, undeclared variant -> rejected", async () => {
    await seedAdmin("clg3", "cashier");
    await seedProduct("plg3", largeShapeFlat());
    await seedOpenSession("slg3", "clg3");
    const lines: ClaimLine[] = Array.from({ length: 8 }, (_, i) => ({ productId: "plg3", variantId: `v${i}`, size: "SZ0", qty: 1, price: 50 }));
    await assertFails(
      attemptPosSale({
        uid: "clg3", sessionId: "slg3", lines,
        productWriteOverride: (after) => { after["v17::SZ0"] = { qty: 0 }; return after; },
      })
    );
  });

  it("no-new-cliff stress test: SYNTHETIC 30 colors x 10 sizes = 300 total slots (7.5x today's real worst case) -> valid", async () => {
    await seedAdmin("cex1", "cashier");
    await seedProduct("pex1", syntheticExtremeFlat());
    await seedOpenSession("sex1", "cex1");
    await assertSucceeds(attemptPosSale({ uid: "cex1", sessionId: "sex1", lines: [{ productId: "pex1", variantId: "v29", size: "SZ9", qty: 1, price: 50 }] }));
  });

  it("ProductForm-style full save (BOTH colorVariants metadata AND stockByCell changed at once) -> succeeds for an editor", async () => {
    await seedAdmin("pf1", "editor");
    await seedProduct("ppf1", smallFlat());
    const env = await getTestEnv();
    const ctx = env.authenticatedContext("pf1", IDENTIFIED);
    const fs = ctx.firestore();
    await assertSucceeds(
      updateDoc(doc(fs, "products/ppf1"), {
        colorVariants: { black: { colorName: "Jet Black", colorHex: "#0a0a0a", order: 0 }, navy: { colorName: "Navy", colorHex: "#001", order: 1 } },
        stockByCell: { "black::S": { qty: 9 }, "black::M": { qty: 5 }, "navy::S": { qty: 2 } },
        updatedAt: new Date(),
      })
    );
  });

  it("same ProductForm-style full save is rejected for a plain cashier (no editor role)", async () => {
    await seedAdmin("pf2", "cashier");
    await seedProduct("ppf2", smallFlat());
    const env = await getTestEnv();
    const ctx = env.authenticatedContext("pf2", IDENTIFIED);
    const fs = ctx.firestore();
    await assertFails(
      updateDoc(doc(fs, "products/ppf2"), {
        colorVariants: { black: { colorName: "Jet Black", colorHex: "#0a0a0a", order: 0 } },
        stockByCell: { "black::S": { qty: 9 } },
        updatedAt: new Date(),
      })
    );
  });

  it("same 300-slot product: tampering with ONE untouched cell among 300 is still correctly caught", async () => {
    await seedAdmin("cex2", "cashier");
    await seedProduct("pex2", syntheticExtremeFlat());
    await seedOpenSession("sex2", "cex2");
    await assertFails(
      attemptPosSale({
        uid: "cex2", sessionId: "sex2",
        lines: [{ productId: "pex2", variantId: "v29", size: "SZ9", qty: 1, price: 50 }],
        productWriteOverride: (after) => { after["v0::SZ0"] = { qty: 999 }; return after; },
      })
    );
  });
});
