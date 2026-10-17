// Makes the store's own category list (src/data/storeCategories.ts) the
// main categories in Neon: adds any that are missing (doc id = slug, same
// fields the admin's "Add store categories" button writes), puts them first,
// and hides (isActive: false) every other category — never deletes, so
// products filed under an old category keep working.
import { STORE_CATEGORY_PRESET, type PresetNode } from "../../../src/data/storeCategories.ts";
import { openDb } from "../src/db.ts";

const db = await openDb();
const now = { $ts: new Date().toISOString() };
const wanted: { id: string; data: Record<string, unknown> }[] = [];
const walk = (nodes: PresetNode[], parentId: string | null) => {
  for (const n of nodes) {
    wanted.push({
      id: n.slug,
      data: { slug: n.slug, name: n.name, nameAr: n.nameAr, tagline: "", taglineAr: "", imageId: "", imageUrl: "", icon: n.icon, parentId, isActive: true },
    });
    if (n.children) walk(n.children, n.slug);
  }
};
walk(STORE_CATEGORY_PRESET, null);

await db.tx(async (sql) => {
  const { rows } = await sql.query<{ id: string; data: Record<string, unknown> }>(
    "SELECT id, data FROM app.docs WHERE collection = 'categories' ORDER BY (data->>'order')::int NULLS LAST FOR UPDATE"
  );
  const existing = new Map(rows.map((r) => [r.id, r.data]));
  let order = 0;
  for (const w of wanted) {
    const cur = existing.get(w.id);
    const data = cur ? { ...cur, isActive: true, parentId: w.data.parentId, order: order++, updatedAt: now } : { ...w.data, order: order++, createdAt: now, updatedAt: now };
    await sql.query(
      `INSERT INTO app.docs (collection, id, data) VALUES ('categories', $1, $2)
       ON CONFLICT (collection, id) DO UPDATE SET data = EXCLUDED.data, version = app.docs.version + 1, updated_at = now()`,
      [w.id, JSON.stringify(data)]
    );
    console.log(`${cur ? "kept " : "added"} ${w.data.nameAr}`);
  }
  const keep = new Set(wanted.map((w) => w.id));
  for (const r of rows) {
    if (keep.has(r.id)) continue;
    await sql.query(
      "UPDATE app.docs SET data = $2, version = version + 1, updated_at = now() WHERE collection = 'categories' AND id = $1",
      [r.id, JSON.stringify({ ...r.data, isActive: false, order: order++, updatedAt: now })]
    );
    console.log(`hidden ${r.data.nameAr}`);
  }
  await sql.query("SELECT pg_notify('docs', $1)", [JSON.stringify({ c: "categories" })]);
});
await db.close();
