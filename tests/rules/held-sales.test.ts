import { assertFails, assertSucceeds } from "./testing";
import { doc, getDoc, Timestamp, updateDoc, setDoc } from "../../src/db/firestore";
import type { Firestore } from "../../src/db/firestore";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { clearFirestore, getTestEnv, teardownTestEnv } from "./setup";
import { seedBranchSetup } from "./branchFixtures";
import { discardHeldSale, holdSale, resumeHeldSale } from "../../src/firebase/heldSales";
import type { RegisterSession } from "../../src/admin/types";

// Held sales (src/firebase/heldSales.ts), run for real against the rules.

const IDENTIFIED = { firebase: { sign_in_provider: "password" as const } };
const LINES = [{ productId: "dress", variantId: "white", size: "S", qty: 2, name: "Dress", color: "White", price: 100 }];

async function fsFor(uid: string): Promise<Firestore> {
  return (await getTestEnv()).authenticatedContext(uid, IDENTIFIED).firestore();
}
async function sessionOf(uid: string, sessionId: string): Promise<RegisterSession> {
  let s: RegisterSession | null = null;
  const env = await getTestEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const snap = await getDoc(doc(ctx.firestore(), `registerSessions/${sessionId}`));
    s = { id: snap.id, ...snap.data() } as RegisterSession;
  });
  expect(s).not.toBeNull();
  void uid;
  return s!;
}
async function read(path: string) {
  let out: Record<string, unknown> | undefined;
  await (await getTestEnv()).withSecurityRulesDisabled(async (ctx) => {
    const s = await getDoc(doc(ctx.firestore(), path));
    out = s.exists() ? s.data() : undefined;
  });
  return out;
}

describe("held sales", () => {
  beforeEach(async () => {
    await clearFirestore();
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  it("holds a cart from the cashier's own shift and another till of the branch resumes it, once", async () => {
    const a = await seedBranchSetup({ uid: "c1" });
    const b = await seedBranchSetup({ uid: "c2", registerId: "b1-r2", sessionId: "c2-session" });
    const fs1 = await fsFor("c1");
    const held = await holdSale(fs1, await sessionOf("c1", a.sessionId), { uid: "c1", name: "C1" }, { lines: LINES, customerName: "Rana", note: "back in 10 min" });
    expect(held.ref).toMatch(/^H-/);
    expect(await read(`heldSales/${held.id}`)).toMatchObject({ status: "held", itemCount: 2, subtotal: 200, customerName: "Rana" });
    // Nothing sold: no order, no stock touched (there is none to touch here).

    const fs2 = await fsFor("c2");
    const got = await resumeHeldSale(fs2, held.id, await sessionOf("c2", b.sessionId), { uid: "c2", name: "C2" });
    expect(got.lines).toEqual(LINES);
    expect(await read(`heldSales/${held.id}`)).toMatchObject({ status: "resumed", resumedByUid: "c2", resumedSessionId: b.sessionId });
    // Second till: refused, told who took it.
    await expect(resumeHeldSale(fs1, held.id, await sessionOf("c1", a.sessionId), { uid: "c1", name: "C1" })).rejects.toMatchObject({ code: "taken", by: "C2" });
  });

  it("two tills resuming at the same moment: only one gets it", async () => {
    const a = await seedBranchSetup({ uid: "c1" });
    const b = await seedBranchSetup({ uid: "c2", registerId: "b1-r2", sessionId: "c2-session" });
    const fs1 = await fsFor("c1");
    const fs2 = await fsFor("c2");
    const held = await holdSale(fs1, await sessionOf("c1", a.sessionId), { uid: "c1", name: "C1" }, { lines: LINES });
    const [s1, s2] = [await sessionOf("c1", a.sessionId), await sessionOf("c2", b.sessionId)];
    const results = await Promise.allSettled([resumeHeldSale(fs1, held.id, s1, { uid: "c1", name: "C1" }), resumeHeldSale(fs2, held.id, s2, { uid: "c2", name: "C2" })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("another branch can't see or take it; a cashier can't hold on someone else's shift", async () => {
    const a = await seedBranchSetup({ uid: "c1" });
    await seedBranchSetup({ uid: "c9", branchId: "b2" });
    const held = await holdSale(await fsFor("c1"), await sessionOf("c1", a.sessionId), { uid: "c1", name: "C1" }, { lines: LINES });
    const fs9 = await fsFor("c9");
    await assertFails(getDoc(doc(fs9, `heldSales/${held.id}`)));
    await assertFails(updateDoc(doc(fs9, `heldSales/${held.id}`), { status: "resumed", resumedByUid: "c9" }));
    // c9 holding on c1's session.
    await expect(holdSale(fs9, await sessionOf("c1", a.sessionId), { uid: "c9", name: "C9" }, { lines: LINES })).rejects.toMatchObject({ code: "permission-denied" });
  });

  it("discard is final; a held sale older than 24h can be discarded but not resumed; contents can't be edited", async () => {
    const a = await seedBranchSetup({ uid: "c1" });
    const fs = await fsFor("c1");
    const s = await sessionOf("c1", a.sessionId);
    const h1 = await holdSale(fs, s, { uid: "c1", name: "C1" }, { lines: LINES });
    await assertFails(updateDoc(doc(fs, `heldSales/${h1.id}`), { lines: [] }));
    await discardHeldSale(fs, h1.id, { uid: "c1", name: "C1" });
    await expect(resumeHeldSale(fs, h1.id, s, { uid: "c1", name: "C1" })).rejects.toMatchObject({ code: "taken" });

    const h2 = await holdSale(fs, s, { uid: "c1", name: "C1" }, { lines: LINES });
    await (await getTestEnv()).withSecurityRulesDisabled(async (ctx) =>
      setDoc(doc(ctx.firestore(), `heldSales/${h2.id}`), { ...(await read(`heldSales/${h2.id}`)), createdAt: Timestamp.fromMillis(Date.now() - 25 * 3600e3) })
    );
    await expect(resumeHeldSale(fs, h2.id, s, { uid: "c1", name: "C1" })).rejects.toMatchObject({ code: "expired" });
    // Even bypassing the app, the server refuses resuming an expired one.
    await assertFails(updateDoc(doc(fs, `heldSales/${h2.id}`), { status: "resumed", resumedByUid: "c1" }));
    await assertSucceeds(discardHeldSale(fs, h2.id, { uid: "c1", name: "C1" }));
  });
});
