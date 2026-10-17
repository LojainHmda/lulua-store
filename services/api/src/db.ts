// The one Postgres the app uses. Production: Neon via DATABASE_URL (the
// pooled connection string is fine for queries; LISTEN needs a direct,
// non-pooler connection, so DATABASE_URL_DIRECT is used for that when set).
// Local dev and tests: PGlite (Postgres compiled to WASM, in-process), so no
// Docker or installed Postgres is needed — DATABASE_URL unset or "pglite://<dir>"
// (empty dir = in-memory).
import pg from "pg";

export interface Sql {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

export interface Db extends Sql {
  // Several statements, no parameters (schema setup).
  exec(sql: string): Promise<void>;
  tx<T>(fn: (sql: Sql) => Promise<T>): Promise<T>;
  // Fires `cb(payload)` on every NOTIFY to `channel`, from any instance.
  listen(channel: string, cb: (payload: string) => void): Promise<void>;
  close(): Promise<void>;
}

export const SCHEMA_SQL = `
CREATE SCHEMA IF NOT EXISTS app;

-- Every document of every collection. "collection" is the full parent path
-- ("orders", or "a/x/b" for a subcollection), id the last path segment.
CREATE TABLE IF NOT EXISTS app.docs (
  collection text NOT NULL,
  id text NOT NULL,
  data jsonb NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection, id)
);
CREATE INDEX IF NOT EXISTS docs_data_gin ON app.docs USING gin (data jsonb_path_ops);

CREATE TABLE IF NOT EXISTS app.users (
  uid text PRIMARY KEY,
  email text UNIQUE,
  password_hash text,
  google_sub text UNIQUE,
  anonymous boolean NOT NULL DEFAULT false,
  display_name text,
  photo_url text,
  disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

CREATE TABLE IF NOT EXISTS app.refresh_tokens (
  token_hash text PRIMARY KEY,
  uid text NOT NULL REFERENCES app.users(uid) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS refresh_tokens_uid ON app.refresh_tokens (uid);

-- Small server-side settings (e.g. firebase_hash_config: the parameters
-- that verify passwords imported from Firebase Auth).
CREATE TABLE IF NOT EXISTS app.meta (key text PRIMARY KEY, value jsonb NOT NULL);
`;

function pgDb(url: string, directUrl: string): Db {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  let listener: pg.Client | undefined;
  const handlers = new Map<string, ((p: string) => void)[]>();
  return {
    query: (text, params) => pool.query(text, params as unknown[]) as never,
    async exec(sql) {
      await pool.query(sql);
    },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await fn({ query: (t, p) => client.query(t, p as unknown[]) as never });
        await client.query("COMMIT");
        return out;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    async listen(channel, cb) {
      if (!listener) {
        listener = new pg.Client({ connectionString: directUrl });
        await listener.connect();
        listener.on("notification", (n) => handlers.get(n.channel)?.forEach((h) => h(n.payload ?? "")));
        // A dropped LISTEN connection would silently stop all live updates:
        // crash so Cloud Run restarts the instance instead.
        listener.on("error", (e) => {
          console.error("LISTEN connection lost", e);
          process.exit(1);
        });
      }
      if (!handlers.has(channel)) {
        handlers.set(channel, []);
        await listener.query(`LISTEN "${channel}"`);
      }
      handlers.get(channel)!.push(cb);
    },
    async close() {
      await listener?.end();
      await pool.end();
    },
  };
}

async function pgliteDb(dir: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const lite = dir ? await PGlite.create(dir) : await PGlite.create();
  // PGlite is a single connection: serialize transactions so one never
  // interleaves with another (Postgres would block on row locks instead).
  let chain: Promise<unknown> = Promise.resolve();
  const q: Sql["query"] = (text, params) => lite.query(text, params) as never;
  return {
    query: q,
    async exec(sql) {
      await lite.exec(sql);
    },
    tx(fn) {
      const run = chain.then(() => lite.transaction((t) => fn({ query: (x, p) => t.query(x, p) as never })));
      chain = run.catch(() => {});
      return run;
    },
    async listen(channel, cb) {
      await lite.listen(channel, cb);
    },
    close: () => lite.close(),
  };
}

export async function openDb(url = process.env.DATABASE_URL ?? ""): Promise<Db> {
  const db =
    !url || url.startsWith("pglite:")
      ? await pgliteDb(url.replace(/^pglite:\/*/, ""))
      : pgDb(url, process.env.DATABASE_URL_DIRECT || url);
  await db.exec(SCHEMA_SQL);
  return db;
}
