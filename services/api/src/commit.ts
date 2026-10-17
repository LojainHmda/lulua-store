// Every write goes through commit(): a single setDoc() is a one-write
// commit, writeBatch() a multi-write one, and runTransaction() a commit
// that also carries the versions of the documents the transaction read.
//
// Same guarantees Firestore gave the app:
//   - all writes apply or none do,
//   - a transaction whose reads went stale (another commit changed one of
//     those docs since) fails with "aborted" and the client re-runs it,
//   - every written document is checked by the security rules against its
//     state before (resource) and after (request.resource) the commit, with
//     get() = pre-commit state and getAfter() = post-commit state.
import type { Db, Sql } from "./db.ts";
import { splitPath } from "./query.ts";
import type { Auth, Rules } from "./rules/types.ts";
import { applySet, applyUpdate, type DocData, type Json, timestamp, WriteError } from "./values.ts";

export type Write =
  | { op: "set"; path: string; data: DocData; merge?: boolean }
  | { op: "update"; path: string; data: DocData }
  | { op: "delete"; path: string };

export interface CommitRequest {
  // version 0 = the transaction saw the document as missing.
  reads?: { path: string; version: number }[];
  writes: Write[];
}

const MAX_WRITES = 500;

async function lockRows(sql: Sql, paths: string[]) {
  const keys = paths.map(splitPath);
  const { rows } = await sql.query<{ collection: string; id: string; data: DocData; version: string | number }>(
    `SELECT collection, id, data, version FROM app.docs
      WHERE (collection, id) IN (SELECT * FROM unnest($1::text[], $2::text[]))
      ORDER BY collection, id FOR UPDATE`,
    [keys.map((k) => k.collection), keys.map((k) => k.id)]
  );
  return new Map(rows.map((r) => [`${r.collection}/${r.id}`, { data: r.data, version: Number(r.version) }]));
}

export async function commit(db: Db, rules: Rules, auth: Auth | null, req: CommitRequest): Promise<{ commitTime: string }> {
  const writes = req.writes ?? [];
  if (writes.length > MAX_WRITES) throw new WriteError("invalid-argument", `At most ${MAX_WRITES} writes per commit`);
  const now = new Date();
  const nowTs: Json = timestamp(now);

  await db.tx(async (sql) => {
    const paths = [...new Set([...(req.reads ?? []).map((r) => r.path), ...writes.map((w) => w.path)])];
    for (const p of paths) splitPath(p);
    const locked = await lockRows(sql, paths);

    for (const r of req.reads ?? []) {
      if ((locked.get(r.path)?.version ?? 0) !== r.version) {
        throw new WriteError("aborted", "Transaction conflict: a document it read has changed");
      }
    }

    // Pre-commit state of every path the rules ask about, loaded lazily.
    const pre = new Map<string, DocData | null>([...locked].map(([k, v]) => [k, v.data]));
    for (const p of paths) if (!pre.has(p)) pre.set(p, null);
    const get = async (path: string): Promise<DocData | null> => {
      if (!pre.has(path)) {
        const { collection, id } = splitPath(path);
        const { rows } = await sql.query<{ data: DocData }>(
          "SELECT data FROM app.docs WHERE collection = $1 AND id = $2",
          [collection, id]
        );
        pre.set(path, rows[0]?.data ?? null);
      }
      return pre.get(path)!;
    };

    const post = new Map<string, DocData | null>();
    // update() of a document that doesn't exist: still rule-checked as an
    // update first (permission-denied wins, as in Firestore), then not-found.
    const missingUpdate = new Set<string>();
    for (const w of writes) {
      const cur = post.has(w.path) ? post.get(w.path)! : await get(w.path);
      if (w.op === "delete") post.set(w.path, null);
      else if (w.op === "set") post.set(w.path, applySet(cur, w.data, Boolean(w.merge), nowTs));
      else {
        if (!cur) missingUpdate.add(w.path);
        post.set(w.path, applyUpdate(cur ?? {}, w.data, nowTs));
      }
    }
    const getAfter = async (path: string) => (post.has(path) ? post.get(path)! : get(path));

    for (const [path, after] of post) {
      const before = await get(path);
      const { collection, id } = splitPath(path);
      const op = !after ? "delete" : before || missingUpdate.has(path) ? "update" : "create";
      const ok = await rules.write({ op, auth, path, collection, id, before, after, get, getAfter, now });
      if (!ok) throw new WriteError("permission-denied", `Missing or insufficient permissions (${op} ${path})`);
    }
    if (missingUpdate.size) throw new WriteError("not-found", `No document to update: ${[...missingUpdate][0]}`);

    for (const [path, after] of post) {
      const { collection, id } = splitPath(path);
      const existed = locked.has(path);
      if (!after) {
        if (existed) await sql.query("DELETE FROM app.docs WHERE collection = $1 AND id = $2", [collection, id]);
      } else if (existed) {
        await sql.query(
          "UPDATE app.docs SET data = $3, version = version + 1, updated_at = now() WHERE collection = $1 AND id = $2",
          [collection, id, JSON.stringify(after)]
        );
      } else {
        // Created concurrently by another commit since we looked: retry.
        const { rows } = await sql.query(
          "INSERT INTO app.docs (collection, id, data) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING id",
          [collection, id, JSON.stringify(after)]
        );
        if (!rows.length) throw new WriteError("aborted", "Transaction conflict: document was just created");
      }
    }

    const byCollection = new Map<string, string[]>();
    for (const path of post.keys()) {
      const { collection, id } = splitPath(path);
      byCollection.set(collection, [...(byCollection.get(collection) ?? []), id]);
    }
    for (const [c, ids] of byCollection) {
      // NOTIFY payloads cap at 8000 bytes; a bare collection name means
      // "something in here changed".
      const payload = JSON.stringify({ c, ids });
      await sql.query("SELECT pg_notify('docs', $1)", [payload.length < 7000 ? payload : JSON.stringify({ c })]);
    }
  });

  return { commitTime: now.toISOString() };
}
