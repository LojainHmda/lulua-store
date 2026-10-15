import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Static guard: the customer storefront and the POS must only ever receive
// products through the two sellability-filtered entry points. If someone adds
// a new place that loads products for customers/POS, this fails and points at
// the file, so the filter can't be forgotten "in just one component".

const SRC = fileURLToPath(new URL("../../src", import.meta.url));

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : /\.(ts|tsx)$/.test(e.name) ? [full] : [];
  });
}
const files = walk(SRC).map((f) => ({ rel: path.relative(SRC, f).replace(/\\/g, "/"), text: fs.readFileSync(f, "utf8") }));
const read = (rel: string) => files.find((f) => f.rel === rel)?.text ?? "";

// Customer-facing / POS code = everything except the admin app, the Firebase
// transaction helpers, and the admin-only order panel.
const customerAndPos = files.filter((f) => !f.rel.startsWith("admin/") && !f.rel.startsWith("firebase/") && !f.rel.startsWith("components/admin/"));

describe("sellability coverage of product-loading paths", () => {
  it("only CatalogContext (storefront) and Terminal (POS) query the products collection for customers/POS", () => {
    const loaders = customerAndPos.filter((f) => /collection\(\s*db\s*,\s*["']products["']\s*\)/.test(f.text)).map((f) => f.rel);
    expect(loaders.sort()).toEqual(["context/CatalogContext.tsx", "pos/Terminal.tsx"]);
  });

  it("the storefront catalog applies the sellability filter to the list every page reads", () => {
    const catalog = read("context/CatalogContext.tsx");
    expect(catalog).toMatch(/products:\s*filterSellable\(allProducts\)/);
    expect(catalog).toMatch(/import \{ filterSellable \} from "..\/data\/sellability"/);
  });

  it("the POS grid, search, category filter and scan all work from the sellable list", () => {
    const pos = read("pos/Terminal.tsx");
    expect(pos).toMatch(/const sellableProducts = useMemo\(\(\) => products\.filter\(isSellable\)/);
    expect(pos).toMatch(/return sellableProducts\.filter\(/);
    expect(pos).toMatch(/if \(!isSellable\(product\)\)/); // a scan of a hidden product never opens the picker
    expect(pos).not.toMatch(/isTileUnavailable/); // the old "grey out" special case is gone
  });

  it("only the cart drawer and checkout validation may read allProducts (id lookups for what the shopper already holds)", () => {
    // Matches the property access, not the words "all products" that also
    // appear in translation text and page copy.
    const users = customerAndPos.filter((f) => /catalog\.allProducts\b/.test(f.text)).map((f) => f.rel);
    expect(users.sort()).toEqual(["components/layout/CartDrawer.tsx", "pages/Checkout.tsx"]);
    expect(read("context/CatalogContext.tsx")).toMatch(/allProducts: Product\[\];/); // and the context is what exposes it
  });

  it("no customer/POS file loads products through the admin API, bypassing the catalog", () => {
    const bypass = customerAndPos.filter((f) => /\bproductsApi\b/.test(f.text)).map((f) => f.rel);
    expect(bypass).toEqual([]);
  });

  it("every storefront listing reads catalog.products (never a raw static PRODUCTS list)", () => {
    const rawStatic = customerAndPos.filter((f) => f.rel.startsWith("pages/") || f.rel.startsWith("components/")).filter((f) => /import \{[^}]*\bPRODUCTS\b[^}]*\} from/.test(f.text)).map((f) => f.rel);
    expect(rawStatic).toEqual([]);
  });
});
