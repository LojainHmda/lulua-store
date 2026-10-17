// Test harness for the security rules (services/api/src/rules/): the real
// API server, in-process, on an in-memory Postgres (PGlite), driven through
// the app's own database client (src/db/firestore.ts). Same surface the
// tests were written against with @firebase/rules-unit-testing, so the
// rules tests from the Firestore era run unchanged against the port.
import { signAccessToken } from "../../services/api/src/auth.ts";
import { type Db, openDb } from "../../services/api/src/db.ts";
import type { Rules } from "../../services/api/src/rules/types.ts";
import { storeRules } from "../../services/api/src/rules/index.ts";
import { createApp } from "../../services/api/src/server.ts";
import { Firestore } from "../../src/db/firestore";
import { createTransport } from "../../src/db/transport";

export interface RulesTestContext {
  firestore(): Firestore;
}

export interface TokenOptions {
  email?: string;
  firebase?: { sign_in_provider?: string };
}

export interface RulesTestEnvironment {
  authenticatedContext(uid: string, token?: TokenOptions): RulesTestContext;
  unauthenticatedContext(): RulesTestContext;
  withSecurityRulesDisabled(fn: (ctx: RulesTestContext) => Promise<void>): Promise<void>;
  clearFirestore(): Promise<void>;
  cleanup(): Promise<void>;
}

const allowAll: Rules = { read: async () => true, write: async () => true };
const noFiles = { put: async () => "", remove: async () => {} };

export async function initializeTestEnvironment(): Promise<RulesTestEnvironment> {
  const db: Db = await openDb("pglite://");
  const secured = createApp(db, storeRules, noFiles);
  const open = createApp(db, allowAll, noFiles);

  const context = (app: ReturnType<typeof createApp>, token: () => Promise<string | null>): RulesTestContext => {
    const fs = new Firestore(
      createTransport({ baseUrl: "http://test", getToken: token, fetch: async (r) => app.fetch(r) })
    );
    return { firestore: () => fs };
  };

  return {
    authenticatedContext(uid, opts) {
      const provider = opts?.firebase?.sign_in_provider ?? "password";
      return context(secured, () => signAccessToken({ uid, email: opts?.email ?? null, provider }));
    },
    unauthenticatedContext() {
      return context(secured, async () => null);
    },
    async withSecurityRulesDisabled(fn) {
      await fn(context(open, async () => null));
    },
    async clearFirestore() {
      await db.query("DELETE FROM app.docs");
    },
    async cleanup() {
      await db.close();
    },
  };
}

function isPermissionDenied(e: unknown) {
  const err = e as { code?: string; message?: string };
  return err?.code === "permission-denied" || /permission/i.test(err?.message ?? "");
}

export async function assertFails<T>(p: Promise<T>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    if (isPermissionDenied(e)) return e;
    throw new Error(`Expected PERMISSION_DENIED but got unexpected error: ${(e as Error)?.message ?? e}`);
  }
  throw new Error("Expected request to fail, but it succeeded.");
}

export async function assertSucceeds<T>(p: Promise<T>): Promise<T> {
  return p;
}
