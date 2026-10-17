// Document values on the wire and in Postgres (jsonb).
//
// Plain JSON, plus two tagged shapes the client (src/db/firestore.ts) and
// this server agree on:
//   { "$ts": "<ISO-8601>" }   a Timestamp. Stored as-is: two of them compare
//                             correctly with jsonb's own ordering, since the
//                             ISO strings are fixed-width.
//   { "$sv": "<op>", ... }    a write-time sentinel (serverTimestamp(),
//                             increment(), arrayUnion(), arrayRemove(),
//                             deleteField()), only ever inside a write; it is
//                             resolved here, against the document's current
//                             value, and never stored.

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type DocData = { [k: string]: Json };

export const isPlainObject = (v: unknown): v is { [k: string]: Json } =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isTimestamp = (v: unknown) => isPlainObject(v) && typeof v.$ts === "string" && Object.keys(v).length === 1;
const isSentinel = (v: unknown): v is { $sv: string; n?: number; v?: Json[] } =>
  isPlainObject(v) && typeof v.$sv === "string";

// A map field (merged by `set(..., {merge})`, walked into by updates) as
// opposed to a leaf value: timestamps are leaves even though they're objects.
const isMap = (v: unknown): v is { [k: string]: Json } => isPlainObject(v) && !isTimestamp(v) && !isSentinel(v);

export function deepEqual(a: Json | undefined, b: Json | undefined): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as Json[];
    return a.length === bb.length && a.every((x, i) => deepEqual(x, bb[i]));
  }
  const ao = a as { [k: string]: Json };
  const bo = b as { [k: string]: Json };
  const ak = Object.keys(ao);
  return ak.length === Object.keys(bo).length && ak.every((k) => k in bo && deepEqual(ao[k], bo[k]));
}

export class WriteError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const DELETE = Symbol("delete");

// One sentinel (or plain value) -> the value to store, given what's there now.
function resolve(value: Json, current: Json | undefined, now: Json): Json | typeof DELETE {
  if (isSentinel(value)) {
    switch (value.$sv) {
      case "serverTimestamp":
        return now;
      case "delete":
        return DELETE;
      case "increment": {
        const n = Number(value.n ?? 0);
        return typeof current === "number" ? current + n : n;
      }
      case "arrayUnion": {
        const out = Array.isArray(current) ? [...current] : [];
        for (const el of value.v ?? []) if (!out.some((x) => deepEqual(x, el))) out.push(el);
        return out;
      }
      case "arrayRemove": {
        const rm = value.v ?? [];
        return Array.isArray(current) ? current.filter((x) => !rm.some((r) => deepEqual(x, r))) : [];
      }
      default:
        throw new WriteError("invalid-argument", `Unknown sentinel ${value.$sv}`);
    }
  }
  if (Array.isArray(value)) return value.map((v) => resolveNested(v, undefined, now));
  if (isMap(value)) return resolveMap(value, isMap(current) ? current : undefined, now, false);
  return value;
}

function resolveNested(value: Json, current: Json | undefined, now: Json): Json {
  const r = resolve(value, current, now);
  return r === DELETE ? null : r;
}

// `merge` = keep fields of `current` the new map doesn't mention (set merge).
function resolveMap(value: { [k: string]: Json }, current: { [k: string]: Json } | undefined, now: Json, merge: boolean) {
  const out: { [k: string]: Json } = merge && current ? { ...current } : {};
  for (const [k, v] of Object.entries(value)) {
    const cur = current?.[k];
    const r = merge && isMap(v) ? resolveMap(v, isMap(cur) ? cur : undefined, now, true) : resolve(v, cur, now);
    if (r === DELETE) delete out[k];
    else out[k] = r;
  }
  return out;
}

export function applySet(before: DocData | null, data: DocData, merge: boolean, now: Json): DocData {
  return resolveMap(data, before ?? undefined, now, merge);
}

// updateDoc(): keys are field paths ("a.b.c"); everything not named stays.
export function applyUpdate(before: DocData, data: DocData, now: Json): DocData {
  const out = structuredClone(before);
  for (const [path, v] of Object.entries(data)) {
    const parts = path.split(".");
    let node: { [k: string]: Json } = out;
    for (const p of parts.slice(0, -1)) {
      if (!isMap(node[p])) node[p] = {};
      node = node[p] as { [k: string]: Json };
    }
    const last = parts[parts.length - 1];
    const r = resolve(v, node[last], now);
    if (r === DELETE) delete node[last];
    else node[last] = r;
  }
  return out;
}

export const timestamp = (d: Date): Json => ({ $ts: d.toISOString() });
export const tsToDate = (v: Json | undefined): Date | null =>
  isTimestamp(v) ? new Date((v as { $ts: string }).$ts) : null;
