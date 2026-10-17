// The handful of Firestore-rules (CEL) primitives the ported rules use,
// with CEL's semantics where they differ from plain JS:
//   - reading a field a document doesn't have is an ERROR, not undefined,
//     and an error anywhere denies the request: strict() wraps documents
//     so a missing field throws RuleError (fail closed, like Firestore),
//   - `==` on lists/maps compares structurally (eq),
//   - `x in list` / `key in map` (inList / has).
import { deepEqual, type Json } from "../values.ts";

export class RuleError extends Error {}

const wrapCache = new WeakMap<object, object>();

// A read-only view of a value where missing map keys / out-of-range list
// indexes throw instead of yielding undefined.
export function strict<T>(v: T): T {
  if (typeof v !== "object" || v === null) return v;
  const hit = wrapCache.get(v);
  if (hit) return hit as T;
  const p = new Proxy(v, {
    get(target, key, recv) {
      if (typeof key === "symbol") return Reflect.get(target, key, recv);
      if (Array.isArray(target)) {
        if (key === "length") return target.length;
        if (/^\d+$/.test(key)) {
          if (Number(key) >= target.length) throw new RuleError(`Index ${key} out of range`);
          return strict(target[Number(key)]);
        }
        return Reflect.get(target, key, recv);
      }
      // `await` probes every resolved value for .then: not a field read.
      if (key === "then" && !Object.hasOwn(target, key)) return undefined;
      if (!Object.hasOwn(target, key)) throw new RuleError(`Property ${key} is undefined`);
      return strict((target as Record<string, unknown>)[key]);
    },
    set() {
      throw new RuleError("Rules are read-only");
    },
  });
  wrapCache.set(v, p);
  return p as T;
}

type M = Record<string, unknown>;

export const isMap = (v: unknown): v is M =>
  typeof v === "object" && v !== null && !Array.isArray(v) && !("$ts" in (v as M) && Object.keys(v as M).length === 1);
export const isList = (v: unknown): v is unknown[] => Array.isArray(v);
export const isString = (v: unknown): v is string => typeof v === "string";
export const isBool = (v: unknown): v is boolean => typeof v === "boolean";
export const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
export const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
export const isTimestamp = (v: unknown) =>
  typeof v === "object" && v !== null && typeof (v as M).$ts === "string" && Object.keys(v as M).length === 1;

// map.get(key, default)
export function getOr<T>(m: unknown, key: string, dflt: T): unknown {
  if (!isMap(m)) throw new RuleError("get() on a non-map");
  return Object.hasOwn(m, key) ? (m as M)[key] : dflt;
}

// `key in map`
export function has(m: unknown, key: string): boolean {
  if (!isMap(m)) throw new RuleError("`in` on a non-map");
  return Object.hasOwn(m, key);
}

export const eq = (a: unknown, b: unknown) => deepEqual(a as Json, b as Json);

// `x in list`
export function inList(v: unknown, list: unknown): boolean {
  if (!isList(list)) throw new RuleError("`in` on a non-list");
  return list.some((x) => eq(x, v));
}

export function size(v: unknown): number {
  if (isString(v) || isList(v)) return v.length;
  if (isMap(v)) return Object.keys(v).length;
  throw new RuleError("size() of a non-collection");
}

export const keys = (m: unknown): string[] => {
  if (!isMap(m)) throw new RuleError("keys() of a non-map");
  return Object.keys(m);
};

// after.diff(before).affectedKeys(): added, removed or changed keys.
export function affectedKeys(after: unknown, before: unknown): string[] {
  const a = isMap(after) ? after : {};
  const b = isMap(before) ? before : {};
  const all = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...all].filter((k) => !(Object.hasOwn(a, k) && Object.hasOwn(b, k) && eq(a[k], b[k])));
}

export const hasOnly = (ks: string[], allowed: string[]) => ks.every((k) => allowed.includes(k));

// CEL `a || b || ...`: true if any branch is true; a branch that errors
// counts as not-true (the request is denied only if no branch allows it).
export async function any(...branches: (() => boolean | Promise<boolean>)[]): Promise<boolean> {
  for (const b of branches) {
    try {
      if ((await b()) === true) return true;
    } catch (e) {
      if (!(e instanceof RuleError) && !(e instanceof TypeError)) throw e;
    }
  }
  return false;
}
