// Demo products for trying the store: 2 per active category (including
// subcategories), with colors, sizes, stock in every branch. All ids start
// with "demo-" — remove them all with:  node scripts/seed-demo-products.ts --remove
import { openDb } from "../src/db.ts";

const db = await openDb();
const now = { $ts: new Date().toISOString() };

if (process.argv.includes("--remove")) {
  const { rows } = await db.query<{ n: number }>(
    "WITH d AS (DELETE FROM app.docs WHERE (collection = 'products' AND id LIKE 'demo-%') OR (collection = 'branchStock' AND id LIKE '%\_\_demo-%') RETURNING 1) SELECT count(*)::int n FROM d"
  );
  console.log(`Removed ${rows[0].n} demo documents.`);
  await db.close();
  process.exit(0);
}

const CLOTHES = ["S", "M", "L", "XL"];
const ONE = ["One Size"];
// Per category slug: [nameAr, name, price, sizes]
const NAMES: Record<string, [string, string, number, string[]][]> = {
  "women-pajamas": [["بيجاما ستاتي ساتان", "Satin pajama set", 95, CLOTHES], ["بيجاما ستاتي شتوية", "Winter pajama set", 110, CLOTHES]],
  "women-underwear": [["طقم داخلي ستاتي قطن", "Cotton lingerie set", 45, CLOTHES], ["كلوت دانتيل", "Lace briefs", 20, CLOTHES]],
  "men-underwear": [["بوكسر رجالي قطن", "Cotton boxers", 25, CLOTHES], ["فانيلة رجالي", "Men's undershirt", 30, CLOTHES]],
  "men-pajamas": [["بيجاما رجالي كاروهات", "Checked pajama set", 90, CLOTHES], ["بيجاما رجالي صيفية", "Summer pajama set", 75, CLOTHES]],
  "men-pajamas-soba": [["بيجاما سوبا كلاسيك", "Soba classic pajama", 120, CLOTHES], ["بيجاما سوبا قطن", "Soba cotton pajama", 105, CLOTHES]],
  "bridal-nightgowns": [["قميص نوم عرايسي حرير", "Silk bridal nightgown", 150, CLOTHES], ["قميص نوم عرايسي دانتيل", "Lace bridal nightgown", 135, CLOTHES]],
  "home-furnishings": [["طقم شراشف مزدوج", "Double sheet set", 160, ONE], ["بطانية ناعمة", "Soft blanket", 120, ONE]],
  "kitchen-supplies": [["طقم أواني طبخ", "Cookware set", 220, ONE], ["مريول مطبخ", "Kitchen apron", 25, ONE]],
  baby: [["طقم مواليد قطن", "Newborn cotton set", 60, ["0-3M", "3-6M", "6-12M"]], ["بطانية أطفال", "Baby blanket", 55, ONE]],
};
const GENERIC: [string, string, number, string[]][] = [["منتج تجريبي ١", "Demo product 1", 50, CLOTHES], ["منتج تجريبي ٢", "Demo product 2", 70, CLOTHES]];
const COLORS = [
  { id: "black", colorName: "Black", colorNameAr: "أسود", colorHex: "#1c1a17" },
  { id: "rose", colorName: "Rose", colorNameAr: "وردي", colorHex: "#d9a3b0" },
];

const { rows: cats } = await db.query<{ data: { slug: string; nameAr: string } }>(
  "SELECT data FROM app.docs WHERE collection = 'categories' AND (data->>'isActive') IS DISTINCT FROM 'false'"
);
const { rows: branches } = await db.query<{ id: string }>("SELECT id FROM app.docs WHERE collection = 'branches'");

let n = 0;
for (const { data: cat } of cats) {
  const list = NAMES[cat.slug] ?? GENERIC.map(([ar, en, p, s]) => [`${cat.nameAr} - ${ar}`, en, p, s] as [string, string, number, string[]]);
  for (const [i, [nameAr, name, price, sizes]] of list.entries()) {
    const id = `demo-${cat.slug}-${i + 1}`.slice(0, 60);
    const colorVariants: Record<string, unknown> = {};
    const stockByCell: Record<string, { qty: number }> = {};
    COLORS.forEach((c, order) => {
      const vid = `${c.id}-${id}`;
      colorVariants[vid] = { order, imageId: "", colorHex: c.colorHex, colorName: c.colorName, colorNameAr: c.colorNameAr };
      for (const s of sizes) stockByCell[`${vid}::${s}`] = { qty: 10 };
    });
    const product = {
      sku: `729${String(100000000 + n).padStart(10, "0")}`,
      name,
      nameAr,
      slug: id,
      category: cat.slug,
      price,
      sizes,
      tags: ["demo"],
      status: "active",
      description: `${name} — demo product.`,
      descriptionAr: `${nameAr} — منتج تجريبي.`,
      details: [],
      detailsAr: [],
      rating: 4.5,
      reviewCount: 0,
      colorVariants,
      stockByCell,
      createdAt: now,
      updatedAt: now,
    };
    await db.query(
      `INSERT INTO app.docs (collection, id, data) VALUES ('products', $1, $2)
       ON CONFLICT (collection, id) DO UPDATE SET data = EXCLUDED.data, version = app.docs.version + 1, updated_at = now()`,
      [id, JSON.stringify(product)]
    );
    for (const b of branches) {
      await db.query(
        `INSERT INTO app.docs (collection, id, data) VALUES ('branchStock', $1, $2)
         ON CONFLICT (collection, id) DO UPDATE SET data = EXCLUDED.data, version = app.docs.version + 1, updated_at = now()`,
        [`${b.id}__${id}`, JSON.stringify({ branchId: b.id, productId: id, stockByCell, createdAt: now, updatedAt: now })]
      );
    }
    console.log(`${cat.nameAr}: ${nameAr} (${price})`);
    n++;
  }
}
await db.query("SELECT pg_notify('docs', $1)", [JSON.stringify({ c: "products" })]);
await db.query("SELECT pg_notify('docs', $1)", [JSON.stringify({ c: "branchStock" })]);
console.log(`${n} demo products added.`);
await db.close();
