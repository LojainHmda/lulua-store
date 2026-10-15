import { assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, deleteDoc, updateDoc } from "firebase/firestore";
import { afterAll, beforeEach, describe, it } from "vitest";
import { clearFirestore, getTestEnv, teardownTestEnv } from "./setup";

describe("admin bootstrap & privilege escalation", () => {
  beforeEach(async () => {
    await clearFirestore();
  });

  afterAll(async () => {
    await teardownTestEnv();
  });

  it("lets the first signed-in user self-create an owner admin doc before bootstrap is claimed", async () => {
    const env = await getTestEnv();
    const alice = env.authenticatedContext("alice");
    await assertSucceeds(
      setDoc(doc(alice.firestore(), "admins/alice"), {
        email: "alice@example.com",
        displayName: "Alice",
        role: "owner",
        active: true,
      })
    );
  });

  it("blocks a second user from self-creating an owner doc once bootstrap is claimed", async () => {
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "system/bootstrap"), { ownerClaimed: true });
    });

    const bob = env.authenticatedContext("bob");
    await assertFails(
      setDoc(doc(bob.firestore(), "admins/bob"), {
        email: "bob@example.com",
        displayName: "Bob",
        role: "owner",
        active: true,
      })
    );
  });

  it("blocks a signed-in non-admin from creating an admin doc for someone else", async () => {
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "system/bootstrap"), { ownerClaimed: true });
    });

    const bob = env.authenticatedContext("bob");
    await assertFails(
      setDoc(doc(bob.firestore(), "admins/carol"), {
        email: "carol@example.com",
        displayName: "Carol",
        role: "owner",
        active: true,
      })
    );
  });

  it("blocks a non-admin from updating or deleting someone else's admin doc", async () => {
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "system/bootstrap"), { ownerClaimed: true });
      await setDoc(doc(ctx.firestore(), "admins/owner1"), {
        email: "owner@example.com",
        displayName: "Owner",
        role: "owner",
        active: true,
      });
    });

    const mallory = env.authenticatedContext("mallory");
    await assertFails(
      setDoc(doc(mallory.firestore(), "admins/owner1"), { role: "viewer" }, { merge: true })
    );
    await assertFails(deleteDoc(doc(mallory.firestore(), "admins/owner1")));
  });

  it("lets an existing owner create an admin doc for someone else (the invite flow)", async () => {
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "system/bootstrap"), { ownerClaimed: true });
      await setDoc(doc(ctx.firestore(), "admins/owner1"), {
        email: "owner@example.com",
        displayName: "Owner",
        role: "owner",
        active: true,
      });
    });

    const owner1 = env.authenticatedContext("owner1");
    await assertSucceeds(
      setDoc(doc(owner1.firestore(), "admins/newcashier"), {
        email: "cashier@example.com",
        displayName: "New Cashier",
        role: "cashier",
        active: true,
      })
    );
  });

  // Team.tsx's "edit name" feature: no new rule was needed for this — an
  // owner already has unconditional admins/{uid} update rights — but these
  // tests lock in the exact behavior the feature depends on: an owner can
  // rename an employee, the employee's role/email/uid are untouched by a
  // name-only write, and non-owners (including a legitimate but non-owner
  // admin, and a cashier) still can't update anyone's admin doc at all.
  it("lets an owner rename an employee's displayName, leaving role/email/active untouched", async () => {
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "system/bootstrap"), { ownerClaimed: true });
      await setDoc(doc(ctx.firestore(), "admins/owner1"), { email: "owner@example.com", displayName: "Owner", role: "owner", active: true });
      await setDoc(doc(ctx.firestore(), "admins/rafiq"), { email: "rafiq@example.com", displayName: "Rafiq", role: "cashier", active: true });
    });

    const owner1 = env.authenticatedContext("owner1");
    await assertSucceeds(updateDoc(doc(owner1.firestore(), "admins/rafiq"), { displayName: "Rafiq (left Sisley — renamed)" }));

    const after = await getDoc(doc(owner1.firestore(), "admins/rafiq"));
    const data = after.data();
    if (data?.displayName !== "Rafiq (left Sisley — renamed)") throw new Error(`expected renamed displayName, got ${JSON.stringify(data?.displayName)}`);
    if (data?.role !== "cashier") throw new Error(`expected role to stay cashier, got ${JSON.stringify(data?.role)}`);
    if (data?.email !== "rafiq@example.com") throw new Error(`expected email to stay unchanged, got ${JSON.stringify(data?.email)}`);
    if (data?.active !== true) throw new Error(`expected active to stay true, got ${JSON.stringify(data?.active)}`);
  });

  it("blocks a non-owner admin from renaming another employee (update stays owner-only)", async () => {
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "system/bootstrap"), { ownerClaimed: true });
      await setDoc(doc(ctx.firestore(), "admins/admin1"), { email: "admin1@example.com", displayName: "Admin One", role: "admin", active: true });
      await setDoc(doc(ctx.firestore(), "admins/rafiq2"), { email: "rafiq2@example.com", displayName: "Rafiq", role: "cashier", active: true });
    });

    const admin1 = env.authenticatedContext("admin1");
    await assertFails(updateDoc(doc(admin1.firestore(), "admins/rafiq2"), { displayName: "Someone Else" }));
  });

  it("blocks a cashier from renaming another employee or themselves", async () => {
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "system/bootstrap"), { ownerClaimed: true });
      await setDoc(doc(ctx.firestore(), "admins/cashier1"), { email: "cashier1@example.com", displayName: "Abd", role: "cashier", active: true });
      await setDoc(doc(ctx.firestore(), "admins/cashier2"), { email: "cashier2@example.com", displayName: "Jawaher", role: "cashier", active: true });
    });

    const cashier1 = env.authenticatedContext("cashier1");
    await assertFails(updateDoc(doc(cashier1.firestore(), "admins/cashier2"), { displayName: "Someone Else" }));
    await assertFails(updateDoc(doc(cashier1.firestore(), "admins/cashier1"), { displayName: "Abd (self-renamed)" }));
  });

  it("blocks a plain signed-in customer from reading any admin doc", async () => {
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "admins/owner1"), {
        email: "owner@example.com",
        displayName: "Owner",
        role: "owner",
        active: true,
      });
    });

    const customer = env.authenticatedContext("customer1");
    await assertFails(getDoc(doc(customer.firestore(), "admins/owner1")));
  });

  it("blocks an unauthenticated request from reading any admin doc", async () => {
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "admins/owner1"), {
        email: "owner@example.com",
        displayName: "Owner",
        role: "owner",
        active: true,
      });
    });

    const anon = env.unauthenticatedContext();
    await assertFails(getDoc(doc(anon.firestore(), "admins/owner1")));
  });
});
