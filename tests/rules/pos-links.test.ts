import { assertFails, assertSucceeds } from "./testing";
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc, updateDoc, writeBatch } from "../../src/db/firestore";
import { afterAll, beforeEach, describe, it } from "vitest";
import { seedBranchSetup } from "./branchFixtures";
import { clearFirestore, getTestEnv, teardownTestEnv } from "./setup";

// POS device links (posLinks/{token}): a device holding a link's token signs
// in anonymously and registers ITSELF as a cashier pinned to that link's
// branch + register. Mirrors src/firebase/posLinks.ts.

const ANON = { firebase: { sign_in_provider: "anonymous" as const } };
const TOKEN = "t".repeat(40);

function deviceDoc(overrides: Record<string, unknown> = {}) {
  return {
    email: "",
    displayName: "POS b1 · Register 1",
    role: "cashier",
    active: true,
    branchIds: ["b1"],
    registerIds: ["b1-r1"],
    posLink: TOKEN,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// deviceUid: who the link is already bound to (null = not opened yet).
async function seed(opts: { linkActive?: boolean; withLink?: boolean; deviceUid?: string | null } = {}) {
  await seedBranchSetup({ uid: "owner1", role: "owner", withSession: false });
  const env = await getTestEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const fs = ctx.firestore();
    await setDoc(doc(fs, "admins/admin1"), { email: "a@example.com", displayName: "a", role: "admin", active: true });
    await setDoc(doc(fs, "admins/cash1"), { email: "c@example.com", displayName: "c", role: "cashier", active: true, branchIds: ["b1"] });
    if (opts.withLink ?? true) {
      const deviceUid = opts.deviceUid === undefined ? "dev1" : opts.deviceUid;
      await setDoc(doc(fs, `posLinks/${TOKEN}`), { branchId: "b1", registerId: "b1-r1", active: opts.linkActive ?? true, ...(deviceUid ? { deviceUid } : {}) });
    }
  });
}

describe("POS device links", () => {
  beforeEach(async () => {
    await clearFirestore();
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  it("anyone holding the token can read that link, but nobody but admins can list links", async () => {
    await seed();
    const env = await getTestEnv();
    await assertSucceeds(getDoc(doc(env.unauthenticatedContext().firestore(), `posLinks/${TOKEN}`)));
    await assertFails(getDocs(collection(env.unauthenticatedContext().firestore(), "posLinks")));
    await assertFails(getDocs(collection(env.authenticatedContext("cash1").firestore(), "posLinks")));
    await assertSucceeds(getDocs(collection(env.authenticatedContext("admin1").firestore(), "posLinks")));
  });

  it("only owner/admin create links, and only long random tokens", async () => {
    await seed({ withLink: false });
    const env = await getTestEnv();
    const data = { branchId: "b1", registerId: "b1-r1", active: true };
    await assertFails(setDoc(doc(env.authenticatedContext("cash1").firestore(), `posLinks/${TOKEN}`), data));
    await assertFails(setDoc(doc(env.authenticatedContext("admin1").firestore(), "posLinks/short"), data));
    await assertSucceeds(setDoc(doc(env.authenticatedContext("admin1").firestore(), `posLinks/${TOKEN}`), data));
  });

  it("a device with a valid link registers itself as a cashier pinned to that branch + register", async () => {
    await seed();
    const env = await getTestEnv();
    const fs = env.authenticatedContext("dev1", ANON).firestore();
    await assertSucceeds(setDoc(doc(fs, "admins/dev1"), deviceDoc()));
  });

  it("a device can't claim another branch/register, another role, or a revoked/missing link", async () => {
    await seed();
    const env = await getTestEnv();
    const fs = env.authenticatedContext("dev1", ANON).firestore();
    await assertFails(setDoc(doc(fs, "admins/dev1"), deviceDoc({ branchIds: ["b2"] })));
    await assertFails(setDoc(doc(fs, "admins/dev1"), deviceDoc({ branchIds: ["b1", "b2"] })));
    await assertFails(setDoc(doc(fs, "admins/dev1"), deviceDoc({ registerIds: ["b1-r2"] })));
    await assertFails(setDoc(doc(fs, "admins/dev1"), deviceDoc({ role: "admin" })));
    await assertFails(setDoc(doc(fs, "admins/dev1"), deviceDoc({ posLink: "u".repeat(40) })));
    await assertFails(setDoc(doc(fs, "admins/dev2"), deviceDoc())); // someone else's uid
  });

  it("opening a link reserves nothing: any device holding it registers, and devices never write the link", async () => {
    await seed({ deviceUid: null });
    const env = await getTestEnv();
    const fs1 = env.authenticatedContext("dev1", ANON).firestore();
    const fs2 = env.authenticatedContext("dev2", ANON).firestore();
    await assertSucceeds(setDoc(doc(fs1, "admins/dev1"), deviceDoc()));
    await assertSucceeds(setDoc(doc(fs2, "admins/dev2"), deviceDoc()));
    await assertFails(updateDoc(doc(fs1, `posLinks/${TOKEN}`), { deviceUid: "dev1" }));
    await assertFails(updateDoc(doc(fs2, `posLinks/${TOKEN}`), { active: true, branchId: "b2" }));
  });

  it("a revoked link can't be used to register", async () => {
    await seed({ linkActive: false });
    const env = await getTestEnv();
    await assertFails(setDoc(doc(env.authenticatedContext("dev1", ANON).firestore(), "admins/dev1"), deviceDoc()));
  });

  it("a real staff account can't turn itself into a device (or edit itself) via a link", async () => {
    await seed();
    const env = await getTestEnv();
    await assertFails(setDoc(doc(env.authenticatedContext("cash1").firestore(), "admins/cash1"), deviceDoc()));
  });

  it("a registered device can sell like any cashier: opens its register's session", async () => {
    await seed();
    const env = await getTestEnv();
    const fs = env.authenticatedContext("dev1", ANON).firestore();
    await setDoc(doc(fs, "admins/dev1"), deviceDoc());
    const b = writeBatch(fs);
    b.set(doc(fs, "registerSessions/s1"), {
      cashierId: "dev1", cashierName: "POS", branchId: "b1", registerId: "b1-r1", status: "open",
      startingCash: 0, salesCount: 0, cashTotal: 0, cardTotal: 0, discountTotal: 0, grossTotal: 0,
    });
    b.update(doc(fs, "registers/b1-r1"), { openSessionId: "s1" });
    await assertSucceeds(b.commit());
  });

  it("admins revoke: deactivate the link and its device docs, but can't promote a device", async () => {
    await seed();
    const env = await getTestEnv();
    await setDoc(doc(env.authenticatedContext("dev1", ANON).firestore(), "admins/dev1"), deviceDoc());
    const adminFs = env.authenticatedContext("admin1").firestore();
    await assertFails(updateDoc(doc(adminFs, "admins/dev1"), { role: "owner" }));
    await assertFails(updateDoc(doc(adminFs, "admins/cash1"), { active: false })); // real staff stay owner-only
    const b = writeBatch(adminFs);
    b.update(doc(adminFs, `posLinks/${TOKEN}`), { active: false, revokedAt: new Date() });
    b.update(doc(adminFs, "admins/dev1"), { active: false });
    await assertSucceeds(b.commit());
    // ...after which the device is cut off from cashier-only data.
    await assertFails(getDoc(doc(env.authenticatedContext("dev1", ANON).firestore(), "registers/b1-r1")));
    await assertSucceeds(deleteDoc(doc(adminFs, "admins/dev1")));
  });

  it("a device whose old link was revoked can re-register with a new active link", async () => {
    await seed();
    const env = await getTestEnv();
    const NEW = "n".repeat(40);
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), `posLinks/${NEW}`), { branchId: "b1", registerId: "b1-r1", active: true, deviceUid: "dev1" });
      await setDoc(doc(ctx.firestore(), "admins/dev1"), deviceDoc({ active: false }));
      await setDoc(doc(ctx.firestore(), `posLinks/${TOKEN}`), { branchId: "b1", registerId: "b1-r1", active: false });
    });
    const fs = env.authenticatedContext("dev1", ANON).firestore();
    await assertFails(setDoc(doc(fs, "admins/dev1"), deviceDoc())); // old link: revoked
    await assertSucceeds(setDoc(doc(fs, "admins/dev1"), deviceDoc({ posLink: NEW })));
  });
});
