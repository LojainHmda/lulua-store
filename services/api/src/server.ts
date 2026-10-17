// Lulua API: the app's only backend, on top of Neon (Postgres).
//
//   POST /v1/get          one document            { path }
//   POST /v1/query        a query (or its count)  { query, count? }
//   POST /v1/commit       writes / transactions   { reads?, writes }
//   GET  /v1/listen       live change feed (Server-Sent Events)
//   POST /v1/auth/*       accounts and sessions
//   POST /v1/storage/*    file uploads
//
// Every read and write is checked against the security rules
// (src/rules/), the server-side port of what firestore.rules used to do.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import * as A from "./auth.ts";
import { commit, type CommitRequest } from "./commit.ts";
import { type Db, openDb } from "./db.ts";
import { type QuerySpec, runQuery, splitPath } from "./query.ts";
import { storeRules } from "./rules/index.ts";
import type { Auth, Rules } from "./rules/types.ts";
import { checkPath, type FileStore, openFileStore } from "./storage.ts";
import { type DocData, WriteError } from "./values.ts";

const STATUS: Record<string, number> = {
  "permission-denied": 403,
  "not-found": 404,
  aborted: 409,
  "invalid-argument": 400,
  unauthenticated: 401,
};

export function createApp(db: Db, rules: Rules = storeRules, files: FileStore = openFileStore()) {
  const app = new Hono<{ Variables: { auth: Auth | null } }>();
  const origins = (process.env.CORS_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  app.use("*", cors({ origin: origins.length ? origins : "*", allowHeaders: ["Authorization", "Content-Type"], maxAge: 86400 }));

  app.use("*", async (c, next) => {
    const h = c.req.header("Authorization");
    c.set("auth", h?.startsWith("Bearer ") ? await A.verifyAccessToken(h.slice(7)) : null);
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof WriteError) return c.json({ error: { code: err.code, message: err.message } }, (STATUS[err.code] ?? 400) as 400);
    if (err instanceof A.AuthError) return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
    console.error(err);
    const bad = err instanceof Error && /^Bad /.test(err.message);
    return c.json(
      { error: { code: bad ? "invalid-argument" : "internal", message: bad ? err.message : "Internal error" } },
      bad ? 400 : 500
    );
  });

  const getter = (cache = new Map<string, DocData | null>()) => async (path: string) => {
    if (!cache.has(path)) {
      const { collection, id } = splitPath(path);
      const { rows } = await db.query<{ data: DocData }>("SELECT data FROM app.docs WHERE collection = $1 AND id = $2", [collection, id]);
      cache.set(path, rows[0]?.data ?? null);
    }
    return cache.get(path)!;
  };

  app.get("/healthz", (c) => c.text("ok"));

  // --- Data -------------------------------------------------------------

  app.post("/v1/get", async (c) => {
    const { path } = await c.req.json<{ path: string }>();
    const { collection, id } = splitPath(path);
    const { rows } = await db.query<{ data: DocData; version: string }>(
      "SELECT data, version FROM app.docs WHERE collection = $1 AND id = $2",
      [collection, id]
    );
    const row = rows[0];
    // A missing document is readable iff the rules would allow reading it
    // with empty data — checked so existence itself doesn't leak.
    const ok = await rules.read({ kind: "get", auth: c.get("auth"), collection, id, data: row?.data ?? {}, get: getter(), now: new Date() });
    if (!ok) throw new WriteError("permission-denied", `Missing or insufficient permissions (get ${path})`);
    return c.json(row ? { exists: true, data: row.data, version: Number(row.version) } : { exists: false, version: 0 });
  });

  app.post("/v1/query", async (c) => {
    const { query, count } = await c.req.json<{ query: QuerySpec; count?: boolean }>();
    const auth = c.get("auth");
    const get = getter();
    const now = new Date();
    const rows = await runQuery(db, query);
    const allowed = [];
    for (const r of rows) {
      if (await rules.read({ kind: "list", auth, collection: query.collection, id: r.id, data: r.data, query, get, now })) allowed.push(r);
      // Firestore rejects a query that could return a document the caller
      // can't read; the app relies on that (e.g. to detect "not an admin").
      else throw new WriteError("permission-denied", `Missing or insufficient permissions (list ${query.collection})`);
    }
    if (count) return c.json({ count: allowed.length });
    return c.json({ docs: allowed });
  });

  app.post("/v1/commit", async (c) => {
    const body = await c.req.json<CommitRequest>();
    return c.json(await commit(db, rules, c.get("auth"), body));
  });

  // One stream per browser tab. Each event is { c: collection, ids? } —
  // which documents changed, never their data; the client re-reads what
  // it's subscribed to, through the normal (rule-checked) endpoints.
  const streams = new Set<(payload: string) => void>();
  const ready = db.listen("docs", (payload) => streams.forEach((s) => s(payload)));

  app.get("/v1/listen", async (c) => {
    await ready;
    return streamSSE(c, async (stream) => {
      const queue: string[] = [];
      let wake: (() => void) | undefined;
      const push = (p: string) => {
        queue.push(p);
        wake?.();
      };
      streams.add(push);
      stream.onAbort(() => {
        streams.delete(push);
        wake?.();
      });
      await stream.writeSSE({ event: "ready", data: "{}" });
      while (!stream.aborted) {
        if (!queue.length) {
          // Heartbeat keeps proxies from closing an idle stream.
          await new Promise<void>((r) => {
            wake = r;
            setTimeout(r, 25_000);
          });
          wake = undefined;
          if (!queue.length && !stream.aborted) await stream.writeSSE({ event: "ping", data: "" });
          continue;
        }
        await stream.writeSSE({ event: "change", data: queue.shift()! });
      }
      streams.delete(push);
    });
  });

  // --- Auth ---------------------------------------------------------------

  const needAuth = (c: Context) => {
    const a = c.get("auth") as Auth | null;
    if (!a) throw new A.AuthError("auth/requires-recent-login", "Not signed in", 401);
    return a;
  };
  const body = (c: Context) => c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);

  app.post("/v1/auth/signup", async (c) => {
    const b = await body(c);
    const upgrade = b.link ? needAuth(c) : null;
    return db.tx(async (sql) => {
      const u = (await A.signUp(sql, b.email, b.password, upgrade))!;
      return c.json(await A.issueSession(sql, u));
    });
  });
  app.post("/v1/auth/login", async (c) => {
    const b = await body(c);
    return db.tx(async (sql) => c.json(await A.issueSession(sql, await A.signIn(sql, b.email, b.password))));
  });
  app.post("/v1/auth/anonymous", (c) => db.tx(async (sql) => c.json(await A.issueSession(sql, await A.signInAnonymous(sql)))));
  app.post("/v1/auth/google", async (c) => {
    const b = await body(c);
    const upgrade = b.link ? needAuth(c) : null;
    return db.tx(async (sql) => c.json(await A.issueSession(sql, await A.signInGoogle(sql, b.idToken, b.nonce, upgrade))));
  });
  app.post("/v1/auth/refresh", async (c) => {
    const b = await body(c);
    return db.tx(async (sql) => c.json(await A.refreshSession(sql, b.refreshToken)));
  });
  app.post("/v1/auth/logout", async (c) => {
    await A.revokeRefresh(db, (await body(c)).refreshToken);
    return c.json({});
  });
  app.post("/v1/auth/profile", async (c) => {
    const a = needAuth(c);
    return c.json({ user: A.publicUser(await A.updateProfile(db, a, await body(c))) });
  });
  app.post("/v1/auth/password", async (c) => {
    const a = needAuth(c);
    const b = await body(c);
    return db.tx(async (sql) => c.json(await A.updatePassword(sql, a, b.password)));
  });

  // --- Files ----------------------------------------------------------------

  const isActiveAdmin = async (a: Auth | null) => Boolean(a && (await getter()(`admins/${a.uid}`))?.active === true);

  app.post("/v1/storage/upload", async (c) => {
    const path = checkPath(c.req.query("path") ?? "");
    if (!path.startsWith("media/") || !(await isActiveAdmin(c.get("auth")))) {
      throw new WriteError("permission-denied", "Only admins can upload files");
    }
    const bytes = Buffer.from(await c.req.arrayBuffer());
    if (bytes.length > 50 * 1024 * 1024) throw new WriteError("invalid-argument", "File too large (50 MB max)");
    const url = await files.put(path, bytes, c.req.header("Content-Type") || "application/octet-stream");
    return c.json({ path, url });
  });
  app.post("/v1/storage/delete", async (c) => {
    const { path } = await c.req.json<{ path: string }>();
    checkPath(path);
    if (!path.startsWith("media/") || !(await isActiveAdmin(c.get("auth")))) {
      throw new WriteError("permission-denied", "Only admins can delete files");
    }
    await files.remove(path);
    return c.json({});
  });
  app.get("/v1/storage/file/*", async (c) => {
    const path = checkPath(c.req.path.replace(/^\/v1\/storage\/file\//, ""));
    const f = path.startsWith("media/") && files.read ? await files.read(path) : null;
    if (!f) return c.notFound();
    return c.body(new Uint8Array(f.body), 200, { "Content-Type": f.contentType, "Cache-Control": "public, max-age=3600" });
  });

  return app;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const db = await openDb();
  // Passwords imported from Firebase verify with the project's hash
  // parameters, saved by scripts/import-from-firebase.ts.
  const { rows } = await db.query<{ value: Record<string, unknown> }>("SELECT value FROM app.meta WHERE key = 'firebase_hash_config'");
  const hc = rows[0]?.value;
  if (hc && !process.env.FIREBASE_HASH_SIGNER_KEY) {
    process.env.FIREBASE_HASH_SIGNER_KEY = String(hc.signerKey);
    process.env.FIREBASE_HASH_SALT_SEPARATOR = String(hc.saltSeparator);
    process.env.FIREBASE_HASH_ROUNDS = String(hc.rounds);
    process.env.FIREBASE_HASH_MEM_COST = String(hc.memoryCost);
  }
  const port = Number(process.env.PORT) || 8787;
  serve({ fetch: createApp(db).fetch, port }, () => console.log(`lulua-api listening on :${port}`));
}
