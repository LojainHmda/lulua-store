// Firestore-style queries -> SQL over app.docs, with Firestore's semantics:
//   - a document missing a filtered/ordered field never matches,
//   - range filters (<, <=, >, >=) only match values of the same JSON type,
//   - results are ordered by the orderBy fields, then by document id,
//   - "__name__" is the document id (documentId()).
import type { Sql } from "./db.ts";
import type { DocData, Json } from "./values.ts";

export type Op = "==" | "!=" | "<" | "<=" | ">" | ">=" | "in" | "not-in" | "array-contains" | "array-contains-any";

export interface Filter {
  field: string;
  op: Op;
  value: Json;
}

export interface QuerySpec {
  collection: string;
  filters?: Filter[];
  orderBy?: { field: string; dir: "asc" | "desc" }[];
  limit?: number;
  limitToLast?: number;
  // Cursor values line up with the orderBy fields, then the document id.
  startAt?: Json[];
  startAfter?: Json[];
  endAt?: Json[];
  endBefore?: Json[];
}

export interface DocRow {
  id: string;
  data: DocData;
  version: number;
}

const OPS = new Set(["==", "!=", "<", "<=", ">", ">=", "in", "not-in", "array-contains", "array-contains-any"]);
const FIELD_RE = /^[A-Za-z0-9_$]+(\.[A-Za-z0-9_$]+)*$/;

class Builder {
  params: unknown[] = [];
  p(v: unknown) {
    this.params.push(v);
    return `$${this.params.length}`;
  }
  pj(v: Json) {
    return `${this.p(JSON.stringify(v))}::jsonb`;
  }
  field(f: string) {
    if (f === "__name__") return "to_jsonb(id)";
    if (!FIELD_RE.test(f)) throw new Error(`Bad field path: ${f}`);
    return `(data #> ${this.p(f.split("."))}::text[])`;
  }
}

function filterSql(b: Builder, f: Filter): string {
  if (!OPS.has(f.op)) throw new Error(`Bad operator: ${f.op}`);
  const e = b.field(f.field);
  switch (f.op) {
    case "==":
      return `${e} = ${b.pj(f.value)}`;
    case "!=":
      return `(${e} IS NOT NULL AND ${e} <> ${b.pj(f.value)})`;
    case "in":
      return `${e} IN (SELECT jsonb_array_elements(${b.pj(f.value)}))`;
    case "not-in":
      return `(${e} IS NOT NULL AND ${e} NOT IN (SELECT jsonb_array_elements(${b.pj(f.value)})))`;
    case "array-contains":
      return `(jsonb_typeof(${e}) = 'array' AND ${e} @> jsonb_build_array(${b.pj(f.value)}))`;
    case "array-contains-any":
      return `(jsonb_typeof(${e}) = 'array' AND EXISTS (SELECT 1 FROM jsonb_array_elements(${b.pj(f.value)}) v WHERE ${e} @> jsonb_build_array(v)))`;
    default: {
      const v = b.pj(f.value);
      return `(jsonb_typeof(${e}) = jsonb_typeof(${v}) AND ${e} ${f.op} ${v})`;
    }
  }
}

// (a, b, id) > (x, y, z) with per-column direction, written out longhand.
function cursorSql(b: Builder, order: { field: string; dir: "asc" | "desc" }[], values: Json[], after: boolean, lower: boolean) {
  const n = Math.min(values.length, order.length);
  const ors: string[] = [];
  for (let i = 0; i < n; i++) {
    const ands: string[] = [];
    for (let j = 0; j < i; j++) ands.push(`${b.field(order[j].field)} = ${b.pj(values[j])}`);
    const asc = order[i].dir === "asc";
    const op = lower === asc ? ">" : "<";
    ands.push(`${b.field(order[i].field)} ${op} ${b.pj(values[i])}`);
    ors.push(`(${ands.join(" AND ")})`);
  }
  // Inclusive cursors (startAt/endAt) also match the exact tuple.
  if (!after) ors.push(`(${values.slice(0, n).map((v, j) => `${b.field(order[j].field)} = ${b.pj(v)}`).join(" AND ")})`);
  return `(${ors.join(" OR ")})`;
}

export function buildQuery(spec: QuerySpec, count = false) {
  const b = new Builder();
  const where = [`collection = ${b.p(spec.collection)}`];
  for (const f of spec.filters ?? []) where.push(filterSql(b, f));

  const order = [...(spec.orderBy ?? [])];
  for (const o of order) if (o.field !== "__name__") where.push(`${b.field(o.field)} IS NOT NULL`);
  if (!order.some((o) => o.field === "__name__")) {
    order.push({ field: "__name__", dir: order.length ? order[order.length - 1].dir : "asc" });
  }

  if (spec.startAt) where.push(cursorSql(b, order, spec.startAt, false, true));
  if (spec.startAfter) where.push(cursorSql(b, order, spec.startAfter, true, true));
  if (spec.endAt) where.push(cursorSql(b, order, spec.endAt, false, false));
  if (spec.endBefore) where.push(cursorSql(b, order, spec.endBefore, true, false));

  if (count) return { text: `SELECT count(*)::int AS n FROM app.docs WHERE ${where.join(" AND ")}`, params: b.params };

  // limitToLast: take the last N in reverse order, then flip back.
  const last = spec.limitToLast != null;
  const orderSql = order
    .map((o) => `${b.field(o.field)} ${(o.dir === "asc") !== last ? "ASC" : "DESC"}`)
    .join(", ");
  const lim = last ? spec.limitToLast : spec.limit;
  const text = `SELECT id, data, version FROM app.docs WHERE ${where.join(" AND ")} ORDER BY ${orderSql}${
    lim != null ? ` LIMIT ${b.p(Math.max(0, Math.floor(lim)))}` : ""
  }`;
  return { text, params: b.params, reversed: last };
}

export async function runQuery(sql: Sql, spec: QuerySpec): Promise<DocRow[]> {
  const q = buildQuery(spec);
  const { rows } = await sql.query<{ id: string; data: DocData; version: string | number }>(q.text, q.params);
  const out = rows.map((r) => ({ id: r.id, data: r.data, version: Number(r.version) }));
  return q.reversed ? out.reverse() : out;
}

// "orders/abc" -> { collection: "orders", id: "abc" }.
export function splitPath(path: string): { collection: string; id: string } {
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2 || parts.length % 2 !== 0) throw new Error(`Bad document path: ${path}`);
  return { collection: parts.slice(0, -1).join("/"), id: parts[parts.length - 1] };
}
