import { assertFails, assertSucceeds } from "./testing";
import { doc, getDoc, serverTimestamp, setDoc, Timestamp } from "../../src/db/firestore";
import { afterAll, beforeEach, describe, it } from "vitest";
import { clearFirestore, getTestEnv, teardownTestEnv } from "./setup";
import { seedBranchSetup } from "./branchFixtures";

// End-of-day snapshots (branchDaySnapshots), Admin → Branches → End of day.

const IDENTIFIED = { firebase: { sign_in_provider: "password" as const } };

async function seedStaff(uid: string, role: string) {
  await (await getTestEnv()).withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `admins/${uid}`), { email: `${uid}@example.com`, displayName: uid, role, active: true, branchIds: [] });
  });
}

const snap = (uid: string, extra: Record<string, unknown> = {}) => ({
  branchId: "b1",
  branchName: "Branch b1",
  date: "2026-10-19",
  figures: { salesCount: 2, salesTotal: 240, netTotal: 200 },
  closedByUid: uid,
  closedByName: uid,
  closedAt: serverTimestamp(),
  version: 1,
  note: "",
  ...extra,
});

describe("end-of-day snapshots", () => {
  beforeEach(async () => {
    await clearFirestore();
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  it("owner/admin close the day once per branch-day; closing again bumps the version; cashiers can't", async () => {
    await seedBranchSetup({ uid: "c1" });
    await seedStaff("a1", "admin");
    await seedStaff("e1", "editor");
    await seedStaff("o1", "owner");
    const env = await getTestEnv();
    const admin = env.authenticatedContext("a1", IDENTIFIED).firestore();
    const cashier = env.authenticatedContext("c1", IDENTIFIED).firestore();
    const editor = env.authenticatedContext("e1", IDENTIFIED).firestore();
    const path = "branchDaySnapshots/b1__2026-10-19";

    await assertFails(setDoc(doc(cashier, path), snap("c1")));
    await assertFails(setDoc(doc(editor, path), snap("e1")));
    await assertFails(setDoc(doc(admin, "branchDaySnapshots/b1__2026-10-18"), snap("a1"))); // id must match branch + date
    await assertFails(setDoc(doc(admin, path), snap("o1"))); // not in someone else's name
    await assertFails(setDoc(doc(admin, path), snap("a1", { closedAt: Timestamp.fromMillis(Date.now() - 86400000) }))); // backdated
    await assertFails(setDoc(doc(admin, path), snap("a1", { version: 2 })));
    await assertSucceeds(setDoc(doc(admin, path), snap("a1")));

    await assertFails(getDoc(doc(cashier, path)));
    await assertSucceeds(getDoc(doc(admin, path)));

    const owner = env.authenticatedContext("o1", IDENTIFIED).firestore();
    await assertFails(setDoc(doc(owner, path), snap("o1", { version: 1 }))); // must be the next version
    await assertFails(setDoc(doc(owner, path), snap("o1", { version: 2, date: "2026-10-20" })));
    await assertSucceeds(setDoc(doc(owner, path), snap("o1", { version: 2, figures: { salesCount: 3, salesTotal: 300, netTotal: 260 } })));
  });
});
