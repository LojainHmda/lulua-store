import { describe, expect, it } from "vitest";
import { memoryStore, pendingQtyByCell, type PendingSale } from "../../src/pos/offline/offlineStore";
import { syncPending, type SendOutcome } from "../../src/pos/offline/sync";

const sale = (id: string, createdAt: number, over: Partial<PendingSale> = {}): PendingSale => ({
  id,
  orderNumber: `SIS-${id}`,
  sessionId: "s1",
  branchId: "b1",
  registerId: "r1",
  cashierUid: "c1",
  cashierName: "C1",
  createdAt,
  input: { lines: [{ productId: "p", variantId: "v", size: "S", qty: 2 }], discount: 0, expectedPromoDiscount: 0, paymentMethod: "cash", cashAmount: 200, cardAmount: 0, linePrices: { "p::v::S": 100 } },
  total: 200,
  itemCount: 2,
  receipt: { orderNumber: `SIS-${id}`, createdAt, customerName: "Walk-in customer", lines: [], subtotal: 200, shipping: 0, total: 200 },
  status: "pending",
  attempts: 0,
  ...over,
});

describe("syncPending", () => {
  it("sends oldest first and removes what the server has", async () => {
    const store = memoryStore([sale("b", 2), sale("a", 1)]);
    const order: string[] = [];
    const r = await syncPending(store, "c1", async (p) => (order.push(p.id), { kind: "sent" }), async () => true);
    expect(order).toEqual(["a", "b"]);
    expect(r.sent).toHaveLength(2);
    expect(await store.list()).toEqual([]);
  });

  it("stops at the first 'still offline' and keeps the rest for later", async () => {
    const store = memoryStore([sale("a", 1), sale("b", 2)]);
    const r = await syncPending(store, "c1", async (p): Promise<SendOutcome> => (p.id === "a" ? { kind: "offline" } : { kind: "sent" }), async () => true);
    expect(r.stoppedOffline).toBe(true);
    expect((await store.list()).map((p) => p.id).sort()).toEqual(["a", "b"]);
    expect((await store.list()).find((p) => p.id === "a")!.attempts).toBe(1);
  });

  it("a refused sale is kept as an issue and reported, never dropped; the next ones still go", async () => {
    const store = memoryStore([sale("a", 1), sale("b", 2)]);
    const reported: string[] = [];
    const r = await syncPending(
      store,
      "c1",
      async (p): Promise<SendOutcome> => (p.id === "a" ? { kind: "issue", code: "sessionClosed", message: "closed" } : { kind: "sent" }),
      async (p) => (reported.push(p.id), true)
    );
    expect(r.issues.map((p) => p.id)).toEqual(["a"]);
    expect(reported).toEqual(["a"]);
    const left = await store.list();
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ id: "a", status: "issue", issue: { code: "sessionClosed", reported: true } });
  });

  it("an issue whose report didn't get through is reported on the next run, not resent", async () => {
    const store = memoryStore([sale("a", 1, { status: "issue", issue: { code: "x", message: "m", reported: false } })]);
    let sends = 0;
    await syncPending(store, "c1", async () => (sends++, { kind: "sent" }), async () => true);
    expect(sends).toBe(0);
    expect((await store.list())[0].issue!.reported).toBe(true);
  });

  it("only this cashier's sales; a thrown error becomes an issue", async () => {
    const store = memoryStore([sale("a", 1, { cashierUid: "other" }), sale("b", 2)]);
    const r = await syncPending(store, "c1", async () => {
      throw new Error("boom");
    }, async () => true);
    expect(r.issues.map((p) => p.id)).toEqual(["b"]);
    expect((await store.list()).find((p) => p.id === "a")!.status).toBe("pending");
  });
});

it("units waiting to be sent, per branch cell", () => {
  const m = pendingQtyByCell([sale("a", 1), sale("b", 2), sale("c", 3, { branchId: "b2" }), sale("d", 4, { status: "issue" })], "b1");
  expect(m.get("p::v::S")).toBe(4);
});
