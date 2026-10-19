import { assertFails, assertSucceeds } from "./testing";
import { collection, doc, getDoc, getDocs, query, runTransaction, serverTimestamp, setDoc, Timestamp, updateDoc, where } from "../../src/db/firestore";
import type { Firestore } from "../../src/db/firestore";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { clearFirestore, getTestEnv, teardownTestEnv } from "./setup";
import { seedBranchSetup, seedBranchStock } from "./branchFixtures";
import {
  listReturnableSales,
  findSaleByNumber,
  listReturnsForSale,
  loadReturnPolicy,
  loadReturnedQty,
  PosReturnError,
  processPosReturn,
  type PosReturnRequest,
} from "../../src/firebase/posReturn";
import { newReturnNumber, returnSearchSince, saleLineRemaining } from "../../src/admin/posReturns";

// In-store returns (src/firebase/posReturn.ts): the REAL return transaction,
// run as a real cashier against the real rules, plus raw writes that try to
// get around it (add stock / move refund totals without a valid return).

const IDENTIFIED = { firebase: { sign_in_provider: "password" as const } };

const PRODUCT = {
  name: "Return Test Dress",
  slug: "return-test-dress",
  price: 100,
  status: "active",
  category: "dresses",
  colorVariants: [
    { id: "white", colorName: "White", colorHex: "#ffffff", sizeStock: [{ size: "S", qty: 5 }, { size: "M", qty: 5 }] },
  ],
};
const SCARF = {
  name: "Return Test Scarf",
  slug: "return-test-scarf",
  price: 50,
  status: "active",
  category: "accessories",
  colorVariants: [{ id: "red", colorName: "Red", colorHex: "#ff0000", sizeStock: [{ size: "One", qty: 5 }] }],
};

async function asAdmin(fn: (fs: Firestore) => Promise<void>) {
  const env = await getTestEnv();
  await env.withSecurityRulesDisabled(async (ctx) => fn(ctx.firestore()));
}

async function cashierFs(uid: string): Promise<Firestore> {
  return (await getTestEnv()).authenticatedContext(uid, IDENTIFIED).firestore();
}

interface SaleOpts {
  id?: string;
  branchId?: string;
  createdAt?: Date;
  discount?: number;
  paymentMethod?: "cash" | "card" | "split";
  cardAmount?: number;
  lines?: { productId: string; variantId: string; size: string; qty: number; price: number; name: string; color: string }[];
}

// A completed POS sale as placeOrder() writes it.
async function seedSale(opts: SaleOpts = {}) {
  const id = opts.id ?? "sale1";
  const lines = opts.lines ?? [
    { productId: "dress", variantId: "white", size: "S", qty: 2, price: 100, name: PRODUCT.name, color: "White" },
    { productId: "scarf", variantId: "red", size: "One", qty: 1, price: 50, name: SCARF.name, color: "Red" },
  ];
  const subtotal = lines.reduce((s, l) => s + l.price * l.qty, 0);
  const discount = opts.discount ?? 0;
  const total = subtotal - discount;
  const method = opts.paymentMethod ?? "cash";
  const cardAmount = method === "card" ? total : method === "split" ? (opts.cardAmount ?? 0) : 0;
  await asAdmin(async (fs) => {
    await setDoc(doc(fs, `orders/${id}`), {
      orderNumber: `SIS-${id.toUpperCase()}`,
      customerName: "Walk-in customer",
      customerEmail: "",
      lines,
      subtotal,
      discount,
      shipping: 0,
      total,
      status: "completed",
      source: "pos",
      paymentMethod: method,
      cashAmount: total - cardAmount,
      cardAmount,
      branchId: opts.branchId ?? "b1",
      branchName: "Branch b1",
      registerId: "b1-r1",
      registerName: "Register 1",
      createdAt: Timestamp.fromDate(opts.createdAt ?? new Date()),
    });
  });
  return { id, orderNumber: `SIS-${id.toUpperCase()}`, total };
}

async function seedCatalog() {
  await asAdmin(async (fs) => {
    await setDoc(doc(fs, "products/dress"), PRODUCT);
    await setDoc(doc(fs, "products/scarf"), SCARF);
  });
}

async function setPolicy(p: Record<string, unknown>) {
  await asAdmin(async (fs) => setDoc(doc(fs, "settings/posReturns"), p));
}

async function setDrawer(sessionId: string, startingCash: number) {
  await asAdmin(async (fs) => updateDoc(doc(fs, `registerSessions/${sessionId}`), { startingCash }));
}

let seq = 0;
function request(sessionId: string, over: Partial<PosReturnRequest>): PosReturnRequest {
  seq += 1;
  return {
    returnId: `ret-${seq}-${Math.random().toString(36).slice(2, 8)}`,
    returnNumber: newReturnNumber(Date.now() + seq),
    sessionId,
    lines: [],
    cardRefund: 0,
    expectedRefundTotal: 0,
    reason: "changed_mind",
    ...over,
  };
}

async function read(path: string) {
  let out: Record<string, any> | undefined;
  await asAdmin(async (fs) => {
    const s = await getDoc(doc(fs, path));
    out = s.exists() ? (s.data() as Record<string, any>) : undefined;
  });
  return out;
}

describe("POS returns", () => {
  beforeEach(async () => {
    await clearFirestore();
    await seedCatalog();
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  it("returns part of a sale: refund, counters, sale totals, branch stock, ledger and shift all move together", async () => {
    const { sessionId } = await seedBranchSetup({ uid: "c1" });
    await setDrawer(sessionId, 500);
    await seedBranchStock("b1", "dress", { "white::S": { qty: 3 } });
    const sale = await seedSale();
    const fs = await cashierFs("c1");
    const policy = await loadReturnPolicy(fs);

    const req = request(sessionId, {
      orderId: sale.id,
      lines: [{ productId: "dress", variantId: "white", size: "S", qty: 1, restock: true }],
      expectedRefundTotal: 100,
    });
    const res = await processPosReturn(fs, req, { uid: "c1" }, policy);
    expect(res.alreadyProcessed).toBe(false);
    expect(res.record.refundTotal).toBe(100);
    expect(res.record.refundMethod).toBe("cash");

    const ret = await read(`posReturns/${req.returnId}`);
    expect(ret?.orderNumber).toBe(sale.orderNumber);
    expect(ret?.branchId).toBe("b1");
    expect(ret?.saleBranchId).toBe("b1");
    expect((await read(`returnCounters/${sale.id}::dress::white::S`))?.returnedQty).toBe(1);
    const order = await read(`orders/${sale.id}`);
    expect(order?.refundedTotal).toBe(100);
    expect(order?.refundedCash).toBe(100);
    expect(order?.refundStatus).toBe("partial");
    expect(order?.total).toBe(250); // the sale itself is never rewritten
    expect((await read("branchStock/b1__dress"))?.stockByCell["white::S"].qty).toBe(4);
    const mv = await read(`stockMovements/${req.returnId}__0`);
    expect(mv).toMatchObject({ reason: "return_restock", source: "pos", qtyBefore: 3, qtyChange: 1, qtyAfter: 4, branchId: "b1", returnId: req.returnId });
    const session = await read(`registerSessions/${sessionId}`);
    expect(session).toMatchObject({ refundCount: 1, refundTotal: 100, cashRefundTotal: 100, cardRefundTotal: 0 });
  });

  it("returning a whole discounted sale in pieces refunds exactly what was paid", async () => {
    const { sessionId } = await seedBranchSetup({ uid: "c1" });
    await setDrawer(sessionId, 1000);
    // 250 - 25 discount = 225 paid. Dress line net 180, scarf 45.
    const sale = await seedSale({ discount: 25 });
    const fs = await cashierFs("c1");
    const policy = await loadReturnPolicy(fs);
    const one = { productId: "dress", variantId: "white", size: "S", qty: 1, restock: false };
    const r1 = await processPosReturn(fs, request(sessionId, { orderId: sale.id, lines: [one], expectedRefundTotal: 90 }), { uid: "c1" }, policy);
    const r2 = await processPosReturn(fs, request(sessionId, { orderId: sale.id, lines: [one], expectedRefundTotal: 90 }), { uid: "c1" }, policy);
    const r3 = await processPosReturn(
      fs,
      request(sessionId, { orderId: sale.id, lines: [{ productId: "scarf", variantId: "red", size: "One", qty: 1, restock: false }], expectedRefundTotal: 45 }),
      { uid: "c1" },
      policy
    );
    expect(r1.record.refundTotal + r2.record.refundTotal + r3.record.refundTotal).toBe(225);
    const order = await read(`orders/${sale.id}`);
    expect(order?.refundedTotal).toBe(225);
    expect(order?.refundStatus).toBe("full");
    expect(order?.returnCount).toBe(3);
    // Damaged units never go back into stock.
    expect(await read("branchStock/b1__dress")).toBeUndefined();
  });

  it("refuses to return more than was sold, and a confirmed total that no longer matches", async () => {
    const { sessionId } = await seedBranchSetup({ uid: "c1" });
    await setDrawer(sessionId, 1000);
    const sale = await seedSale();
    const fs = await cashierFs("c1");
    const policy = await loadReturnPolicy(fs);
    const line = { productId: "dress", variantId: "white", size: "S", qty: 3, restock: true };
    await expect(processPosReturn(fs, request(sessionId, { orderId: sale.id, lines: [line], expectedRefundTotal: 300 }), { uid: "c1" }, policy)).rejects.toMatchObject({
      code: "overReturn",
    });
    await expect(
      processPosReturn(fs, request(sessionId, { orderId: sale.id, lines: [{ ...line, qty: 1 }], expectedRefundTotal: 99 }), { uid: "c1" }, policy)
    ).rejects.toMatchObject({ code: "amountChanged" });
    expect(await read(`returnCounters/${sale.id}::dress::white::S`)).toBeUndefined();
  });

  it("a repeated submit of the same return is recorded once", async () => {
    const { sessionId } = await seedBranchSetup({ uid: "c1" });
    await setDrawer(sessionId, 500);
    const sale = await seedSale();
    const fs = await cashierFs("c1");
    const policy = await loadReturnPolicy(fs);
    const req = request(sessionId, { orderId: sale.id, lines: [{ productId: "dress", variantId: "white", size: "S", qty: 1, restock: true }], expectedRefundTotal: 100 });
    await processPosReturn(fs, req, { uid: "c1" }, policy);
    const again = await processPosReturn(fs, req, { uid: "c1" }, policy);
    expect(again.alreadyProcessed).toBe(true);
    expect((await read(`returnCounters/${sale.id}::dress::white::S`))?.returnedQty).toBe(1);
    expect((await read(`registerSessions/${sessionId}`))?.refundCount).toBe(1);
    expect((await read("branchStock/b1__dress"))?.stockByCell["white::S"].qty).toBe(1);
  });

  it("two tills returning the last unit at the same time: only one succeeds", async () => {
    const a = await seedBranchSetup({ uid: "c1" });
    const b = await seedBranchSetup({ uid: "c2", registerId: "b1-r2", sessionId: "c2-session" });
    await setDrawer(a.sessionId, 500);
    await setDrawer(b.sessionId, 500);
    const sale = await seedSale({ lines: [{ productId: "dress", variantId: "white", size: "S", qty: 1, price: 100, name: PRODUCT.name, color: "White" }] });
    const line = [{ productId: "dress", variantId: "white", size: "S", qty: 1, restock: true }];
    const fs1 = await cashierFs("c1");
    const fs2 = await cashierFs("c2");
    const policy = await loadReturnPolicy(fs1);
    const results = await Promise.allSettled([
      processPosReturn(fs1, request(a.sessionId, { orderId: sale.id, lines: line, expectedRefundTotal: 100 }), { uid: "c1" }, policy),
      processPosReturn(fs2, request(b.sessionId, { orderId: sale.id, lines: line, expectedRefundTotal: 100 }), { uid: "c2" }, policy),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await read(`orders/${sale.id}`))?.refundedTotal).toBe(100);
    expect((await read("branchStock/b1__dress"))?.stockByCell["white::S"].qty).toBe(1);
  });

  it("a sale from another branch is found by its receipt number and returned into the receiving branch's stock", async () => {
    await seedBranchSetup({ uid: "c1" });
    const { sessionId } = await seedBranchSetup({ uid: "c9", branchId: "b2" });
    await setDrawer(sessionId, 500);
    await seedBranchStock("b1", "dress", { "white::S": { qty: 3 } });
    const sale = await seedSale({ branchId: "b1" });
    const fs = await cashierFs("c9");
    const found = await findSaleByNumber(fs, sale.orderNumber.toLowerCase());
    expect(found?.id).toBe(sale.id);
    // ...but other branches' sales can't be listed wholesale.
    await assertFails(getDocs(query(collection(fs, "orders"), where("branchId", "==", "b1"))));

    const policy = await loadReturnPolicy(fs);
    const req = request(sessionId, { orderId: sale.id, lines: [{ productId: "dress", variantId: "white", size: "S", qty: 1, restock: true }], expectedRefundTotal: 100 });
    await processPosReturn(fs, req, { uid: "c9" }, policy);
    expect((await read("branchStock/b2__dress"))?.stockByCell["white::S"].qty).toBe(1);
    expect((await read("branchStock/b1__dress"))?.stockByCell["white::S"].qty).toBe(3);
    const ret = await read(`posReturns/${req.returnId}`);
    expect(ret).toMatchObject({ branchId: "b2", saleBranchId: "b1" });
    // The receiving cashier sees the sale's return history; the selling branch's cashier sees it too.
    expect(await listReturnsForSale(fs, sale.id)).toHaveLength(1);
    expect(await listReturnsForSale(await cashierFs("c1"), sale.id)).toHaveLength(1);
    const returned = await loadReturnedQty(fs, (await findSaleByNumber(fs, sale.orderNumber))!);
    expect(returned.get("dress::white::S")).toBe(1);
  });

  it("lists every branch's still-returnable sales, but nothing older than the return period", async () => {
    await seedBranchSetup({ uid: "c1" });
    await seedSale({ id: "s1" });
    await seedSale({ id: "s2", branchId: "b2" });
    await seedSale({ id: "old", createdAt: new Date(Date.now() - 20 * 86400000) });
    await seedSale({ id: "full" });
    await seedSale({ id: "void" });
    await asAdmin(async (fs) => {
      await updateDoc(doc(fs, "orders/full"), { refundStatus: "full" });
      await updateDoc(doc(fs, "orders/void"), { status: "cancelled" });
    });
    const fs = await cashierFs("c1");
    const list = await listReturnableSales(fs, returnSearchSince(14));
    expect(list.map((o) => o.id).sort()).toEqual(["s1", "s2"]);
    // Reaching further back than the return period (14 days by default) is refused.
    await assertFails(listReturnableSales(fs, new Date(Date.now() - 30 * 86400000)));
    // ...and so is an unbounded list of all branches' sales.
    await assertFails(getDocs(query(collection(fs, "orders"), where("source", "==", "pos"))));
  });

  it("an item returned in full stops being returnable even while the rest of its sale still is", async () => {
    const { sessionId } = await seedBranchSetup({ uid: "c1" });
    await setDrawer(sessionId, 500);
    const sale = await seedSale(); // 2 dresses + 1 scarf
    const fs = await cashierFs("c1");
    await processPosReturn(
      fs,
      request(sessionId, { orderId: sale.id, lines: [{ productId: "dress", variantId: "white", size: "S", qty: 2, restock: false }], expectedRefundTotal: 200 }),
      { uid: "c1" },
      await loadReturnPolicy(fs)
    );
    expect((await read(`orders/${sale.id}`))?.returnedByLine).toEqual({ "dress::white::S": 2, "scarf::red::One": 0 });
    const [s1] = await listReturnableSales(fs, returnSearchSince(14));
    expect(s1.id).toBe(sale.id);
    expect(s1.lines.filter((l) => saleLineRemaining(s1, l) > 0).map((l) => l.productId)).toEqual(["scarf"]);
  });

  it("a sale returned before per-line counts existed is read from its counters", async () => {
    await seedBranchSetup({ uid: "c1" });
    const sale = await seedSale();
    await asAdmin(async (afs) => {
      await updateDoc(doc(afs, `orders/${sale.id}`), { returnCount: 1, refundStatus: "partial" });
      await setDoc(doc(afs, `returnCounters/${sale.id}::scarf::red::One`), { orderId: sale.id, productId: "scarf", variantId: "red", size: "One", returnedQty: 1 });
    });
    const [s1] = await listReturnableSales(await cashierFs("c1"), returnSearchSince(14));
    expect(s1.lines.filter((l) => saleLineRemaining(s1, l) > 0).map((l) => l.productId)).toEqual(["dress"]);
  });

  it("enforces the return window", async () => {
    const { sessionId } = await seedBranchSetup({ uid: "c1" });
    await setDrawer(sessionId, 500);
    await setPolicy({ windowDays: 7, allowNoReceipt: false, nonReturnableCategoryIds: [] });
    const old = await seedSale({ createdAt: new Date(Date.now() - 8 * 86400000) });
    const fs = await cashierFs("c1");
    const policy = await loadReturnPolicy(fs);
    await expect(
      processPosReturn(fs, request(sessionId, { orderId: old.id, lines: [{ productId: "dress", variantId: "white", size: "S", qty: 1, restock: false }], expectedRefundTotal: 100 }), { uid: "c1" }, {
        ...policy,
        policy: { ...policy.policy, windowDays: 0 },
      })
    ).rejects.toMatchObject({ code: "permission-denied" }); // client told "no limit": the rules still refuse
    await expect(
      processPosReturn(fs, request(sessionId, { orderId: old.id, lines: [{ productId: "dress", variantId: "white", size: "S", qty: 1, restock: false }], expectedRefundTotal: 100 }), { uid: "c1" }, policy)
    ).rejects.toMatchObject({ code: "windowExpired" });
  });

  it("non-returnable categories are refused", async () => {
    const { sessionId } = await seedBranchSetup({ uid: "c1" });
    await setDrawer(sessionId, 500);
    await asAdmin(async (fs) => setDoc(doc(fs, "categories/acc"), { slug: "accessories", name: "Accessories", order: 1 }));
    await setPolicy({ windowDays: 14, allowNoReceipt: false, nonReturnableCategoryIds: ["acc"] });
    const sale = await seedSale();
    const fs = await cashierFs("c1");
    const policy = await loadReturnPolicy(fs);
    expect(policy.nonReturnableSlugs.has("accessories")).toBe(true);
    await expect(
      processPosReturn(fs, request(sessionId, { orderId: sale.id, lines: [{ productId: "scarf", variantId: "red", size: "One", qty: 1, restock: true }], expectedRefundTotal: 50 }), { uid: "c1" }, policy)
    ).rejects.toMatchObject({ code: "notReturnable" });
  });

  it("returns without a receipt only when the policy allows, at today's price", async () => {
    const { sessionId } = await seedBranchSetup({ uid: "c1" });
    await setDrawer(sessionId, 500);
    const fs = await cashierFs("c1");
    const line = [{ productId: "dress", variantId: "white", size: "M", qty: 1, restock: true }];
    await expect(processPosReturn(fs, request(sessionId, { lines: line, expectedRefundTotal: 100 }), { uid: "c1" }, await loadReturnPolicy(fs))).rejects.toMatchObject({
      code: "noReceiptDisabled",
    });
    // Client bypassing the policy: the rules refuse.
    const forced = await loadReturnPolicy(fs);
    await expect(
      processPosReturn(fs, request(sessionId, { lines: line, expectedRefundTotal: 100 }), { uid: "c1" }, { ...forced, policy: { ...forced.policy, allowNoReceipt: true } })
    ).rejects.toMatchObject({ code: "permission-denied" });

    await setPolicy({ windowDays: 14, allowNoReceipt: true, nonReturnableCategoryIds: [] });
    const req = request(sessionId, { lines: line, expectedRefundTotal: 100 });
    const res = await processPosReturn(fs, req, { uid: "c1" }, await loadReturnPolicy(fs));
    expect(res.record.kind).toBe("no_receipt");
    expect((await read("branchStock/b1__dress"))?.stockByCell["white::M"].qty).toBe(1);
  });

  it("card refunds are capped by what was paid by card; cash refunds by the drawer", async () => {
    const { sessionId } = await seedBranchSetup({ uid: "c1" });
    await setDrawer(sessionId, 20);
    const sale = await seedSale({ paymentMethod: "split", cardAmount: 150 }); // 100 cash + 150 card
    const fs = await cashierFs("c1");
    const policy = await loadReturnPolicy(fs);
    const all = [
      { productId: "dress", variantId: "white", size: "S", qty: 2, restock: true },
      { productId: "scarf", variantId: "red", size: "One", qty: 1, restock: true },
    ];
    await expect(processPosReturn(fs, request(sessionId, { orderId: sale.id, lines: all, cardRefund: 200, expectedRefundTotal: 250 }), { uid: "c1" }, policy)).rejects.toMatchObject({
      code: "cardTooHigh",
    });
    await expect(processPosReturn(fs, request(sessionId, { orderId: sale.id, lines: all, cardRefund: 150, expectedRefundTotal: 250 }), { uid: "c1" }, policy)).rejects.toMatchObject({
      code: "drawerShort",
    });
    await setDrawer(sessionId, 100);
    const res = await processPosReturn(fs, request(sessionId, { orderId: sale.id, lines: all, cardRefund: 150, expectedRefundTotal: 250 }), { uid: "c1" }, policy);
    expect(res.record).toMatchObject({ refundMethod: "split", cashRefund: 100, cardRefund: 150 });
    const s = await read(`registerSessions/${sessionId}`);
    expect(s).toMatchObject({ cashRefundTotal: 100, cardRefundTotal: 150 });
  });

  it("only the cashier's own open shift can pay a refund", async () => {
    const { sessionId } = await seedBranchSetup({ uid: "c1" });
    await seedBranchSetup({ uid: "c2", registerId: "b1-r2", sessionId: "c2-session" });
    await setDrawer(sessionId, 500);
    const sale = await seedSale();
    const fs2 = await cashierFs("c2");
    const req = request(sessionId, { orderId: sale.id, lines: [{ productId: "dress", variantId: "white", size: "S", qty: 1, restock: false }], expectedRefundTotal: 100 });
    await expect(processPosReturn(fs2, req, { uid: "c2" }, await loadReturnPolicy(fs2))).rejects.toMatchObject({ code: "notYourSession" });
    // Lying about who you are doesn't help: the rules check the session owner.
    await expect(processPosReturn(fs2, req, { uid: "c1" }, await loadReturnPolicy(fs2))).rejects.toMatchObject({ code: "permission-denied" });
  });

  describe("raw writes that skip the return", () => {
    it("a cashier can't add branch stock without a return", async () => {
      await seedBranchSetup({ uid: "c1" });
      await seedBranchStock("b1", "dress", { "white::S": { qty: 3 } });
      const fs = await cashierFs("c1");
      await assertFails(updateDoc(doc(fs, "branchStock/b1__dress"), { stockByCell: { "white::S": { qty: 9 } } }));
      await assertFails(updateDoc(doc(fs, "branchStock/b1__dress"), { stockByCell: { "white::S": { qty: 9 } }, lastReturnId: "nope" }));
      await assertFails(setDoc(doc(fs, "branchStock/b1__scarf"), { branchId: "b1", productId: "scarf", stockByCell: { "red::One": { qty: 5 } }, lastReturnId: "nope" }));
    });

    it("a cashier can't move a sale's refund totals or write a restock ledger row on their own", async () => {
      await seedBranchSetup({ uid: "c1" });
      const sale = await seedSale();
      const fs = await cashierFs("c1");
      await assertFails(updateDoc(doc(fs, `orders/${sale.id}`), { refundedTotal: 0, lastReturnId: "x" }));
      await assertFails(
        setDoc(doc(fs, "stockMovements/fake"), {
          productId: "dress",
          variantId: "white",
          size: "S",
          qtyBefore: 0,
          qtyChange: 5,
          qtyAfter: 5,
          reason: "return_restock",
          source: "pos",
          returnId: "x",
          branchId: "b1",
          actorUid: "c1",
        })
      );
    });

    it("a return record refunding more than the items' price, or restocking more than returned, is refused", async () => {
      const { sessionId, registerId } = await seedBranchSetup({ uid: "c1" });
      await setDrawer(sessionId, 1000);
      await seedBranchStock("b1", "dress", { "white::S": { qty: 3 } });
      const sale = await seedSale();
      const fs = await cashierFs("c1");
      const attempt = (refund: number, restockTo: number) =>
        runTransaction(fs, async (tx) => {
          const id = "forged";
          tx.set(doc(fs, `posReturns/${id}`), {
            returnNumber: "RET-X",
            kind: "receipt",
            orderId: sale.id,
            orderNumber: sale.orderNumber,
            branchId: "b1",
            registerId,
            sessionId,
            cashierUid: "c1",
            cashierName: "c1",
            lines: [{ productId: "dress", variantId: "white", size: "S", name: "x", color: "White", qty: 1, unitPrice: 100, refund, restock: true }],
            itemCount: 1,
            refundTotal: refund,
            refundMethod: "cash",
            cashRefund: refund,
            cardRefund: 0,
            reason: "other",
            createdAt: serverTimestamp(),
          });
          tx.set(doc(fs, `returnCounters/${sale.id}::dress::white::S`), { orderId: sale.id, productId: "dress", variantId: "white", size: "S", returnedQty: 1 });
          tx.update(doc(fs, `orders/${sale.id}`), { refundedTotal: refund, refundedCash: refund, refundedCard: 0, returnedQty: 1, returnedByLine: { "dress::white::S": 1 }, returnCount: 1, refundStatus: "partial", lastReturnId: id });
          tx.update(doc(fs, "branchStock/b1__dress"), { stockByCell: { "white::S": { qty: restockTo } }, lastReturnId: id });
          tx.update(doc(fs, `registerSessions/${sessionId}`), { refundCount: 1, refundTotal: refund, cashRefundTotal: refund, cardRefundTotal: 0 });
        });
      await assertFails(attempt(150, 4)); // refund above the unit price
      await assertFails(attempt(100, 8)); // 5 units into stock for 1 returned
      await assertSucceeds(attempt(100, 4)); // the honest version of the same writes
    });
  });

  it("PosReturnError carries a code the screen can translate", () => {
    const e = new PosReturnError("overReturn", { left: 1 });
    expect(e.code).toBe("overReturn");
    expect(e.params.left).toBe(1);
  });
});
