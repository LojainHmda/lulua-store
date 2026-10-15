import { assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { deleteDoc, doc, getDoc, setDoc, updateDoc } from "firebase/firestore";
import { afterAll, beforeEach, describe, it } from "vitest";
import { clearFirestore, getTestEnv, teardownTestEnv } from "./setup";

const IDENTIFIED = { firebase: { sign_in_provider: "password" as const } };
const ANONYMOUS = { firebase: { sign_in_provider: "anonymous" as const } };

const baseProfile = {
  uid: "alice",
  authProvider: "password",
  name: "Alice",
  email: "alice@example.com",
  ordersCount: 0,
  totalSpent: 0,
};

describe("customer self-serve profile rules", () => {
  beforeEach(async () => {
    await clearFirestore();
  });

  afterAll(async () => {
    await teardownTestEnv();
  });

  it("lets an identified user create their own profile doc with only allowed fields", async () => {
    const env = await getTestEnv();
    const alice = env.authenticatedContext("alice", IDENTIFIED);
    await assertSucceeds(setDoc(doc(alice.firestore(), "customers/alice"), baseProfile));
  });

  it("blocks an anonymous guest from creating a profile doc for themselves", async () => {
    const env = await getTestEnv();
    const guest = env.authenticatedContext("guest1", ANONYMOUS);
    await assertFails(
      setDoc(doc(guest.firestore(), "customers/guest1"), { ...baseProfile, uid: "guest1" })
    );
  });

  it("blocks creating a profile doc for a different uid than the requester's own", async () => {
    const env = await getTestEnv();
    const alice = env.authenticatedContext("alice", IDENTIFIED);
    await assertFails(
      setDoc(doc(alice.firestore(), "customers/bob"), { ...baseProfile, uid: "bob" })
    );
  });

  it("blocks self-serve create with a non-zero ordersCount or totalSpent", async () => {
    const env = await getTestEnv();
    const alice = env.authenticatedContext("alice", IDENTIFIED);
    await assertFails(
      setDoc(doc(alice.firestore(), "customers/alice"), { ...baseProfile, ordersCount: 3 })
    );
    await assertFails(
      setDoc(doc(alice.firestore(), "customers/alice"), { ...baseProfile, totalSpent: 250 })
    );
  });

  it("blocks self-serve create carrying an admin/CRM-only field like tags or notes", async () => {
    const env = await getTestEnv();
    const alice = env.authenticatedContext("alice", IDENTIFIED);
    await assertFails(
      setDoc(doc(alice.firestore(), "customers/alice"), { ...baseProfile, tags: ["vip"] })
    );
    await assertFails(
      setDoc(doc(alice.firestore(), "customers/alice"), { ...baseProfile, notes: "hand-written note" })
    );
  });

  it("lets an identified user read and update only their own name/phone/photoURL", async () => {
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "customers/alice"), baseProfile);
    });

    const alice = env.authenticatedContext("alice", IDENTIFIED);
    await assertSucceeds(getDoc(doc(alice.firestore(), "customers/alice")));
    await assertSucceeds(
      updateDoc(doc(alice.firestore(), "customers/alice"), { name: "Alice Updated", phone: "+1 555 0100" })
    );
  });

  it("blocks a self-serve update that touches ordersCount, totalSpent, tags, or notes", async () => {
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "customers/alice"), baseProfile);
    });

    const alice = env.authenticatedContext("alice", IDENTIFIED);
    await assertFails(updateDoc(doc(alice.firestore(), "customers/alice"), { ordersCount: 5 }));
    await assertFails(updateDoc(doc(alice.firestore(), "customers/alice"), { totalSpent: 999 }));
    await assertFails(updateDoc(doc(alice.firestore(), "customers/alice"), { tags: ["vip"] }));
    await assertFails(updateDoc(doc(alice.firestore(), "customers/alice"), { notes: "sneaky" }));
  });

  it("lets an identified user add their own saved address", async () => {
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "customers/alice"), baseProfile);
    });

    const alice = env.authenticatedContext("alice", IDENTIFIED);
    await assertSucceeds(
      updateDoc(doc(alice.firestore(), "customers/alice"), {
        addresses: [{ id: "addr1", address: "123 Main St", isDefault: true }],
      })
    );
  });

  it("blocks an anonymous guest from writing addresses onto any profile doc", async () => {
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "customers/guest1"), { ...baseProfile, uid: "guest1" });
    });

    const guest = env.authenticatedContext("guest1", ANONYMOUS);
    await assertFails(
      updateDoc(doc(guest.firestore(), "customers/guest1"), {
        addresses: [{ id: "addr1", address: "123 Main St", isDefault: true }],
      })
    );
  });

  it("blocks a signed-in user from writing addresses onto someone else's profile doc", async () => {
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "customers/alice"), baseProfile);
    });

    const bob = env.authenticatedContext("bob", IDENTIFIED);
    await assertFails(
      updateDoc(doc(bob.firestore(), "customers/alice"), {
        addresses: [{ id: "addr1", address: "Hijacked address", isDefault: true }],
      })
    );
  });

  it("blocks a self-serve addresses write that also sneaks in an admin-only field", async () => {
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "customers/alice"), baseProfile);
    });

    const alice = env.authenticatedContext("alice", IDENTIFIED);
    await assertFails(
      updateDoc(doc(alice.firestore(), "customers/alice"), {
        addresses: [{ id: "addr1", address: "123 Main St", isDefault: true }],
        ordersCount: 99,
      })
    );
  });

  it("blocks writing addresses as a non-list value", async () => {
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "customers/alice"), baseProfile);
    });

    const alice = env.authenticatedContext("alice", IDENTIFIED);
    await assertFails(updateDoc(doc(alice.firestore(), "customers/alice"), { addresses: "not-a-list" }));
  });

  it("blocks exceeding the 10-address cap", async () => {
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "customers/alice"), baseProfile);
    });

    const alice = env.authenticatedContext("alice", IDENTIFIED);
    const tooMany = Array.from({ length: 11 }, (_, i) => ({ id: `addr${i}`, address: `Address ${i}`, isDefault: i === 0 }));
    await assertFails(updateDoc(doc(alice.firestore(), "customers/alice"), { addresses: tooMany }));

    const exactlyTen = tooMany.slice(0, 10);
    await assertSucceeds(updateDoc(doc(alice.firestore(), "customers/alice"), { addresses: exactlyTen }));
  });

  it("lets an admin update a customer's addresses too", async () => {
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "admins/owner1"), {
        email: "owner@example.com",
        displayName: "Owner",
        role: "owner",
        active: true,
      });
      await setDoc(doc(ctx.firestore(), "customers/alice"), baseProfile);
    });

    const owner = env.authenticatedContext("owner1", IDENTIFIED);
    await assertSucceeds(
      updateDoc(doc(owner.firestore(), "customers/alice"), {
        addresses: [{ id: "addr1", address: "Admin-added address", isDefault: true }],
      })
    );
  });

  it("blocks a signed-in user from reading or writing someone else's profile doc", async () => {
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "customers/alice"), baseProfile);
    });

    const bob = env.authenticatedContext("bob", IDENTIFIED);
    await assertFails(getDoc(doc(bob.firestore(), "customers/alice")));
    await assertFails(updateDoc(doc(bob.firestore(), "customers/alice"), { name: "Hijacked" }));
  });

  it("blocks a non-admin from deleting any profile doc", async () => {
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "customers/alice"), baseProfile);
    });

    const alice = env.authenticatedContext("alice", IDENTIFIED);
    await assertFails(deleteDoc(doc(alice.firestore(), "customers/alice")));
  });

  it("lets an admin create a manual CRM lead doc with a random id and no uid field", async () => {
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "admins/owner1"), {
        email: "owner@example.com",
        displayName: "Owner",
        role: "owner",
        active: true,
      });
    });

    const owner = env.authenticatedContext("owner1", IDENTIFIED);
    await assertSucceeds(
      setDoc(doc(owner.firestore(), "customers/lead-abc123"), {
        name: "Walk-in Lead",
        email: "lead@example.com",
        ordersCount: 0,
        totalSpent: 0,
        tags: ["walk-in"],
        notes: "Met at the pop-up shop",
      })
    );
  });

  // Audit finding B1: the isAnyAdmin() branch on customers/{id} create had
  // NO field restriction at all — a "read-only" viewer, or a catalog-scoped
  // editor/cashier, could create an arbitrary-schema CRM lead. Narrowed to
  // isAdminOrAbove(); the only real caller (CustomerList.tsx's manual "add
  // lead" form) is already owner/admin-only in the UI, so no legitimate
  // functionality depends on the wider grant.
  it("blocks an editor, viewer, and cashier from creating an arbitrary CRM lead doc", async () => {
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "admins/editor1"), { email: "editor1@example.com", displayName: "Editor", role: "editor", active: true });
      await setDoc(doc(ctx.firestore(), "admins/viewer1"), { email: "viewer1@example.com", displayName: "Viewer", role: "viewer", active: true });
      await setDoc(doc(ctx.firestore(), "admins/cashier1"), { email: "cashier1@example.com", displayName: "Cashier", role: "cashier", active: true });
    });

    const leadDoc = { name: "Walk-in Lead", email: "lead2@example.com", ordersCount: 0, totalSpent: 0 };
    for (const [uid, path] of [
      ["editor1", "customers/lead-by-editor"],
      ["viewer1", "customers/lead-by-viewer"],
      ["cashier1", "customers/lead-by-cashier"],
    ]) {
      const ctx = env.authenticatedContext(uid, IDENTIFIED);
      await assertFails(setDoc(doc(ctx.firestore(), path), leadDoc));
    }
  });

  it("still lets owner/admin create a manual CRM lead doc (intended access retained)", async () => {
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "admins/admin1"), { email: "admin1@example.com", displayName: "Admin", role: "admin", active: true });
    });
    const admin = env.authenticatedContext("admin1", IDENTIFIED);
    await assertSucceeds(
      setDoc(doc(admin.firestore(), "customers/lead-by-admin"), {
        name: "Walk-in Lead 2", email: "lead3@example.com", ordersCount: 0, totalSpent: 0,
      })
    );
  });

  it("lets an admin update and delete any customer doc, including admin-only fields", async () => {
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "admins/owner1"), {
        email: "owner@example.com",
        displayName: "Owner",
        role: "owner",
        active: true,
      });
      await setDoc(doc(ctx.firestore(), "customers/alice"), baseProfile);
    });

    const owner = env.authenticatedContext("owner1", IDENTIFIED);
    await assertSucceeds(
      updateDoc(doc(owner.firestore(), "customers/alice"), { ordersCount: 2, totalSpent: 150, tags: ["vip"] })
    );
    await assertSucceeds(deleteDoc(doc(owner.firestore(), "customers/alice")));
  });
});
