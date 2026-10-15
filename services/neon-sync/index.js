// Copies the store's Firestore data into Neon (PostgreSQL) for reporting,
// BI tools and backups. The app itself keeps running on Firestore; this is a
// one-way, read-only copy refreshed on a schedule (Cloud Run Job + Cloud
// Scheduler, see README.md).
//
// Every Firestore collection becomes a table lulua.<collection_in_snake_case>
// (id, data jsonb, synced_at). Each run replaces a table's rows in one
// transaction, so readers always see a complete snapshot. Friendly SQL views
// (lulua.v_orders, v_order_lines, v_products, v_branch_stock,
// v_stock_movements) sit on top.
//
// Env:
//   DATABASE_URL         Neon connection string (from Secret Manager)
//   FIRESTORE_DATABASE   Firestore database id (default "lulua-store")
//   GOOGLE_CLOUD_PROJECT set automatically on Cloud Run
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore, Timestamp, GeoPoint, DocumentReference } from "firebase-admin/firestore";
import pg from "pg";

const SCHEMA = "lulua";
// POS link tokens are credentials (holding one opens a till): never copied.
const SKIP = new Set(["posLinks"]);

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

initializeApp({ credential: applicationDefault(), projectId: process.env.GOOGLE_CLOUD_PROJECT });
const fs = getFirestore(process.env.FIRESTORE_DATABASE || "lulua-store");

const snake = (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

// Firestore values -> plain JSON (timestamps as ISO strings).
function plain(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Timestamp) return v.toDate().toISOString();
  if (v instanceof GeoPoint) return { lat: v.latitude, lng: v.longitude };
  if (v instanceof DocumentReference) return v.path;
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.from(v).toString("base64");
  if (Array.isArray(v)) return v.map(plain);
  if (typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
}

async function copyCollection(client, col) {
  const table = `${SCHEMA}.${snake(col.id)}`;
  const snap = await col.get();
  await client.query("BEGIN");
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS ${table} (id text PRIMARY KEY, data jsonb NOT NULL, synced_at timestamptz NOT NULL DEFAULT now())`);
    await client.query(`DELETE FROM ${table}`);
    const docs = snap.docs;
    for (let i = 0; i < docs.length; i += 500) {
      const chunk = docs.slice(i, i + 500);
      const params = [];
      const rows = chunk.map((d, j) => {
        params.push(d.id, JSON.stringify(plain(d.data())));
        return `($${j * 2 + 1}, $${j * 2 + 2}::jsonb)`;
      });
      await client.query(`INSERT INTO ${table} (id, data) VALUES ${rows.join(",")}`, params);
    }
    await client.query("COMMIT");
    return docs.length;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

// Views over the raw tables; each only when its source table exists.
const VIEWS = {
  orders: `CREATE OR REPLACE VIEW ${SCHEMA}.v_orders AS SELECT
      id,
      data->>'orderNumber' AS order_number,
      (data->>'createdAt')::timestamptz AS created_at,
      data->>'source' AS source,
      data->>'status' AS status,
      data->>'branchId' AS branch_id,
      data->>'branchName' AS branch_name,
      data->>'registerName' AS register_name,
      data->>'cashierName' AS cashier_name,
      data->>'customerName' AS customer_name,
      data->>'customerPhone' AS customer_phone,
      data->>'paymentMethod' AS payment_method,
      (data->>'subtotal')::numeric AS subtotal,
      (data->>'shipping')::numeric AS shipping,
      COALESCE((data->>'discount')::numeric, 0) AS discount,
      (data->>'total')::numeric AS total,
      COALESCE((data->>'cashAmount')::numeric, 0) AS cash_amount,
      COALESCE((data->>'cardAmount')::numeric, 0) AS card_amount
    FROM ${SCHEMA}.orders`,
  orders_lines: `CREATE OR REPLACE VIEW ${SCHEMA}.v_order_lines AS SELECT
      o.id AS order_id,
      (o.data->>'createdAt')::timestamptz AS created_at,
      o.data->>'source' AS source,
      o.data->>'status' AS status,
      o.data->>'branchId' AS branch_id,
      l->>'productId' AS product_id,
      l->>'variantId' AS variant_id,
      l->>'name' AS product_name,
      l->>'color' AS color,
      l->>'size' AS size,
      (l->>'qty')::int AS qty,
      (l->>'price')::numeric AS price,
      (l->>'qty')::int * (l->>'price')::numeric AS line_total
    FROM ${SCHEMA}.orders o, jsonb_array_elements(COALESCE(o.data->'lines', '[]'::jsonb)) l`,
  products: `CREATE OR REPLACE VIEW ${SCHEMA}.v_products AS SELECT
      id,
      data->>'name' AS name,
      data->>'nameAr' AS name_ar,
      data->>'sku' AS sku,
      data->>'slug' AS slug,
      data->>'category' AS category,
      data->>'status' AS status,
      (data->>'price')::numeric AS price,
      (data->>'compareAtPrice')::numeric AS compare_at_price,
      (data->>'createdAt')::timestamptz AS created_at
    FROM ${SCHEMA}.products`,
  branch_stock: `CREATE OR REPLACE VIEW ${SCHEMA}.v_branch_stock AS SELECT
      s.data->>'branchId' AS branch_id,
      s.data->>'productId' AS product_id,
      split_part(c.key, '::', 1) AS variant_id,
      split_part(c.key, '::', 2) AS size,
      (c.value->>'qty')::int AS qty
    FROM ${SCHEMA}.branch_stock s, jsonb_each(COALESCE(s.data->'stockByCell', '{}'::jsonb)) c`,
  stock_movements: `CREATE OR REPLACE VIEW ${SCHEMA}.v_stock_movements AS SELECT
      id,
      (data->>'createdAt')::timestamptz AS created_at,
      data->>'reason' AS reason,
      data->>'source' AS source,
      data->>'branchId' AS branch_id,
      data->>'productId' AS product_id,
      data->>'productName' AS product_name,
      data->>'colorName' AS color,
      data->>'size' AS size,
      (data->>'qtyBefore')::int AS qty_before,
      (data->>'qtyChange')::int AS qty_change,
      (data->>'qtyAfter')::int AS qty_after,
      data->>'actorName' AS actor_name,
      data->>'orderNumber' AS order_number
    FROM ${SCHEMA}.stock_movements`,
};

async function main() {
  const started = Date.now();
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    const copied = [];
    for (const col of await fs.listCollections()) {
      if (SKIP.has(col.id)) continue;
      const n = await copyCollection(client, col);
      copied.push(snake(col.id));
      console.log(`  ${col.id}: ${n}`);
    }
    for (const [source, sql] of Object.entries(VIEWS)) {
      if (copied.includes(source.replace(/_lines$/, ""))) await client.query(sql);
    }
    console.log(`Synced ${copied.length} collections in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("Sync failed:", err);
  process.exit(1);
});
