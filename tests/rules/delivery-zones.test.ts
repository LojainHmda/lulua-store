import { assertFails, assertSucceeds } from "./testing";
import { collection, doc, getDoc, getDocs, query, setDoc, updateDoc, where } from "../../src/db/firestore";
import { afterAll, beforeEach, describe, it } from "vitest";
import { clearFirestore, getTestEnv, teardownTestEnv } from "./setup";

// Rules coverage for the deliveryZones/{id} collection itself (see
// firestore.rules) -- who may read a zone, and who may create/update/delete
// one. The checkout-time "does the charged fee actually match this zone"
// trust boundary is isValidShippingForOrder(), already covered by
// tests/rules/checkout.test.ts's "A1 discount/delivery-zone shipping
// validation" block; this file is purely about the collection's own CRUD
// permissions, mirroring discounts/{id}'s existing role split
// (isAnyAdmin() read-all / isEditorOrAbove() write) one-for-one.

const IDENTIFIED = { firebase: { sign_in_provider: "password" as const } };
const ANONYMOUS = { firebase: { sign_in_provider: "anonymous" as const } };

const ACTIVE_ZONE = { name: "Nablus", nameAr: "نابلس", fee: 20, active: true, sortOrder: 0 };
const INACTIVE_ZONE = { name: "Retired Zone", nameAr: "منطقة ملغاة", fee: 20, active: false, sortOrder: 1 };

async function seedAdmin(uid: string, role: string) {
  const env = await getTestEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `admins/${uid}`), { email: `${uid}@example.com`, displayName: uid, role, active: true });
  });
}

async function seedZone(id: string, data: Record<string, unknown>) {
  const env = await getTestEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `deliveryZones/${id}`), data);
  });
}

describe("deliveryZones: read access", () => {
  beforeEach(async () => {
    await clearFirestore();
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  it("lets an unauthenticated visitor read an active zone (no isSignedIn() gate, same as discounts)", async () => {
    await seedZone("nablus", ACTIVE_ZONE);
    const env = await getTestEnv();
    const anon = env.unauthenticatedContext();
    await assertSucceeds(getDoc(doc(anon.firestore(), "deliveryZones/nablus")));
  });

  it("lets an anonymous guest session read an active zone", async () => {
    await seedZone("nablus", ACTIVE_ZONE);
    const env = await getTestEnv();
    const guest = env.authenticatedContext("guest1", ANONYMOUS);
    await assertSucceeds(getDoc(doc(guest.firestore(), "deliveryZones/nablus")));
  });

  it("lets a signed-in customer read an active zone", async () => {
    await seedZone("nablus", ACTIVE_ZONE);
    const env = await getTestEnv();
    const alice = env.authenticatedContext("alice", IDENTIFIED);
    await assertSucceeds(getDoc(doc(alice.firestore(), "deliveryZones/nablus")));
  });

  it("blocks an anonymous guest from reading an inactive zone directly by id", async () => {
    await seedZone("retired", INACTIVE_ZONE);
    const env = await getTestEnv();
    const guest = env.authenticatedContext("guest2", ANONYMOUS);
    await assertFails(getDoc(doc(guest.firestore(), "deliveryZones/retired")));
  });

  it("never returns an inactive zone in a customer's active-zones query (never expose inactive zones)", async () => {
    await seedZone("nablus", ACTIVE_ZONE);
    await seedZone("retired", INACTIVE_ZONE);
    const env = await getTestEnv();
    const guest = env.authenticatedContext("guest3", ANONYMOUS);
    const snap = await getDocs(query(collection(guest.firestore(), "deliveryZones"), where("active", "==", true)));
    if (snap.size !== 1 || snap.docs[0].id !== "nablus") {
      throw new Error(`expected exactly the active zone, got ${snap.docs.map((d) => d.id).join(", ")}`);
    }
  });

  it("lets an owner/admin/editor/viewer read an inactive zone (admin management view)", async () => {
    await seedZone("retired", INACTIVE_ZONE);
    await seedAdmin("owner1", "owner");
    await seedAdmin("admin1", "admin");
    await seedAdmin("editor1", "editor");
    await seedAdmin("viewer1", "viewer");
    const env = await getTestEnv();
    await assertSucceeds(getDoc(doc(env.authenticatedContext("owner1", IDENTIFIED).firestore(), "deliveryZones/retired")));
    await assertSucceeds(getDoc(doc(env.authenticatedContext("admin1", IDENTIFIED).firestore(), "deliveryZones/retired")));
    await assertSucceeds(getDoc(doc(env.authenticatedContext("editor1", IDENTIFIED).firestore(), "deliveryZones/retired")));
    await assertSucceeds(getDoc(doc(env.authenticatedContext("viewer1", IDENTIFIED).firestore(), "deliveryZones/retired")));
  });

  it("lets a cashier read an inactive zone too (isAnyAdmin() includes cashier)", async () => {
    await seedZone("retired", INACTIVE_ZONE);
    await seedAdmin("cashier1", "cashier");
    const env = await getTestEnv();
    await assertSucceeds(getDoc(doc(env.authenticatedContext("cashier1", IDENTIFIED).firestore(), "deliveryZones/retired")));
  });
});

describe("deliveryZones: write access", () => {
  beforeEach(async () => {
    await clearFirestore();
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  it("lets an editor create a new zone", async () => {
    await seedAdmin("editor1", "editor");
    const env = await getTestEnv();
    const editor = env.authenticatedContext("editor1", IDENTIFIED);
    await assertSucceeds(setDoc(doc(editor.firestore(), "deliveryZones/new-zone"), ACTIVE_ZONE));
  });

  it("lets an admin create a new zone", async () => {
    await seedAdmin("admin1", "admin");
    const env = await getTestEnv();
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await assertSucceeds(setDoc(doc(admin.firestore(), "deliveryZones/new-zone"), ACTIVE_ZONE));
  });

  it("lets an owner create a new zone", async () => {
    await seedAdmin("owner1", "owner");
    const env = await getTestEnv();
    const owner = env.authenticatedContext("owner1", IDENTIFIED);
    await assertSucceeds(setDoc(doc(owner.firestore(), "deliveryZones/new-zone"), ACTIVE_ZONE));
  });

  it("blocks a viewer from creating a zone", async () => {
    await seedAdmin("viewer1", "viewer");
    const env = await getTestEnv();
    const viewer = env.authenticatedContext("viewer1", IDENTIFIED);
    await assertFails(setDoc(doc(viewer.firestore(), "deliveryZones/new-zone"), ACTIVE_ZONE));
  });

  it("blocks a cashier from creating a zone", async () => {
    await seedAdmin("cashier1", "cashier");
    const env = await getTestEnv();
    const cashier = env.authenticatedContext("cashier1", IDENTIFIED);
    await assertFails(setDoc(doc(cashier.firestore(), "deliveryZones/new-zone"), ACTIVE_ZONE));
  });

  it("blocks a signed-in customer (non-admin) from creating a zone", async () => {
    const env = await getTestEnv();
    const alice = env.authenticatedContext("alice", IDENTIFIED);
    await assertFails(setDoc(doc(alice.firestore(), "deliveryZones/new-zone"), ACTIVE_ZONE));
  });

  it("blocks an anonymous guest from creating a zone", async () => {
    const env = await getTestEnv();
    const guest = env.authenticatedContext("guest1", ANONYMOUS);
    await assertFails(setDoc(doc(guest.firestore(), "deliveryZones/new-zone"), ACTIVE_ZONE));
  });

  it("blocks a customer from creating an already-inactive zone (not that it would help them -- write is role-gated regardless)", async () => {
    const env = await getTestEnv();
    const alice = env.authenticatedContext("alice", IDENTIFIED);
    await assertFails(setDoc(doc(alice.firestore(), "deliveryZones/sneaky"), INACTIVE_ZONE));
  });

  it("lets an editor update a zone's fee", async () => {
    await seedZone("nablus", ACTIVE_ZONE);
    await seedAdmin("editor1", "editor");
    const env = await getTestEnv();
    const editor = env.authenticatedContext("editor1", IDENTIFIED);
    await assertSucceeds(updateDoc(doc(editor.firestore(), "deliveryZones/nablus"), { fee: 25 }));
  });

  it("lets an editor deactivate a zone", async () => {
    await seedZone("nablus", ACTIVE_ZONE);
    await seedAdmin("editor1", "editor");
    const env = await getTestEnv();
    const editor = env.authenticatedContext("editor1", IDENTIFIED);
    await assertSucceeds(updateDoc(doc(editor.firestore(), "deliveryZones/nablus"), { active: false }));
  });

  it("blocks a viewer from modifying a zone's fee", async () => {
    await seedZone("nablus", ACTIVE_ZONE);
    await seedAdmin("viewer1", "viewer");
    const env = await getTestEnv();
    const viewer = env.authenticatedContext("viewer1", IDENTIFIED);
    await assertFails(updateDoc(doc(viewer.firestore(), "deliveryZones/nablus"), { fee: 999 }));
  });

  it("blocks a cashier from modifying a zone's fee", async () => {
    await seedZone("nablus", ACTIVE_ZONE);
    await seedAdmin("cashier1", "cashier");
    const env = await getTestEnv();
    const cashier = env.authenticatedContext("cashier1", IDENTIFIED);
    await assertFails(updateDoc(doc(cashier.firestore(), "deliveryZones/nablus"), { fee: 999 }));
  });

  it("blocks a signed-in customer from modifying a zone's fee (the core anti-tampering case)", async () => {
    await seedZone("nablus", ACTIVE_ZONE);
    const env = await getTestEnv();
    const mallory = env.authenticatedContext("mallory", IDENTIFIED);
    await assertFails(updateDoc(doc(mallory.firestore(), "deliveryZones/nablus"), { fee: 0 }));
  });

  it("blocks an anonymous guest from modifying a zone's fee", async () => {
    await seedZone("nablus", ACTIVE_ZONE);
    const env = await getTestEnv();
    const mallory = env.authenticatedContext("mallory", ANONYMOUS);
    await assertFails(updateDoc(doc(mallory.firestore(), "deliveryZones/nablus"), { fee: 0 }));
  });

  // Zones are managed through activate/deactivate only -- there is no
  // delete rule at all for deliveryZones/{id} any more (not even for
  // owner), so a historical order's denormalized deliveryZoneId/Name/NameAr
  // can never end up pointing at a removed document. DeliveryZones.tsx no
  // longer even offers a delete action; these tests prove the rule itself
  // closes the door too, not just the UI.
  it("blocks even an owner/admin/editor from deleting a zone", async () => {
    await seedZone("z1", ACTIVE_ZONE);
    await seedZone("z2", ACTIVE_ZONE);
    await seedZone("z3", ACTIVE_ZONE);
    await seedAdmin("owner1", "owner");
    await seedAdmin("admin1", "admin");
    await seedAdmin("editor1", "editor");
    const env = await getTestEnv();
    const { deleteDoc } = await import("../../src/db/firestore");
    await assertFails(deleteDoc(doc(env.authenticatedContext("owner1", IDENTIFIED).firestore(), "deliveryZones/z1")));
    await assertFails(deleteDoc(doc(env.authenticatedContext("admin1", IDENTIFIED).firestore(), "deliveryZones/z2")));
    await assertFails(deleteDoc(doc(env.authenticatedContext("editor1", IDENTIFIED).firestore(), "deliveryZones/z3")));
  });

  it("blocks a viewer/cashier/customer/guest from deleting a zone", async () => {
    await seedZone("z1", ACTIVE_ZONE);
    await seedAdmin("viewer1", "viewer");
    await seedAdmin("cashier1", "cashier");
    const env = await getTestEnv();
    const { deleteDoc } = await import("../../src/db/firestore");
    await assertFails(deleteDoc(doc(env.authenticatedContext("viewer1", IDENTIFIED).firestore(), "deliveryZones/z1")));
    await assertFails(deleteDoc(doc(env.authenticatedContext("cashier1", IDENTIFIED).firestore(), "deliveryZones/z1")));
    await assertFails(deleteDoc(doc(env.authenticatedContext("mallory", IDENTIFIED).firestore(), "deliveryZones/z1")));
    await assertFails(deleteDoc(doc(env.authenticatedContext("mallory2", ANONYMOUS).firestore(), "deliveryZones/z1")));
  });

  it("deactivating a zone (update) still works normally -- delete is what's blocked, not update", async () => {
    await seedZone("z1", ACTIVE_ZONE);
    await seedAdmin("editor1", "editor");
    const env = await getTestEnv();
    const editor = env.authenticatedContext("editor1", IDENTIFIED);
    await assertSucceeds(updateDoc(doc(editor.firestore(), "deliveryZones/z1"), { active: false }));
    const snap = await getDoc(doc(editor.firestore(), "deliveryZones/z1"));
    if (snap.data()?.active !== false) throw new Error("expected the zone to be deactivated, not deleted");
    if (!snap.exists()) throw new Error("expected the zone document to still exist after deactivation");
  });
});
