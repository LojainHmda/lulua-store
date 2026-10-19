// The app's database API, backed by the Lulua API on Neon (Postgres).
//
// Deliberately the same functions and shapes as the Firestore web SDK the
// app was written against (doc, collection, query, where, getDocs,
// onSnapshot, runTransaction, writeBatch, serverTimestamp, Timestamp, ...),
// so the app's data code reads the same. Semantics match too: queries,
// transactions that retry when a document they read changed, all-or-nothing
// batches, server-checked security rules, and live listeners.
import { ApiError, type Change, type Transport } from "./transport";

export type DocumentData = { [field: string]: any };
export type Unsubscribe = () => void;
export type FirestoreErrorCode = string;
export { ApiError as FirestoreError };

// --- Instance -------------------------------------------------------------

export class Firestore {
  readonly type = "firestore";
  _transport: Transport;
  // Listeners re-fetch when a commit from THIS tab lands, without waiting
  // for the server's change feed to echo it back.
  _local = new Set<(c: Change) => void>();
  constructor(transport: Transport) {
    this._transport = transport;
  }
  _notifyLocal(paths: string[]) {
    const by = new Map<string, string[]>();
    for (const p of paths) {
      const { parent, id } = splitDocPath(p);
      by.set(parent, [...(by.get(parent) ?? []), id]);
    }
    for (const [c, ids] of by) this._local.forEach((l) => l({ c, ids }));
  }
}

// --- Values -----------------------------------------------------------------

export class Timestamp {
  readonly seconds: number;
  readonly nanoseconds: number;
  constructor(seconds: number, nanoseconds: number) {
    this.seconds = seconds;
    this.nanoseconds = nanoseconds;
  }
  static now() {
    return Timestamp.fromMillis(Date.now());
  }
  static fromDate(d: Date) {
    return Timestamp.fromMillis(d.getTime());
  }
  static fromMillis(ms: number) {
    const seconds = Math.floor(ms / 1000);
    return new Timestamp(seconds, Math.round((ms - seconds * 1000) * 1e6));
  }
  toMillis() {
    return this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6);
  }
  toDate() {
    return new Date(this.toMillis());
  }
  isEqual(other: Timestamp) {
    return other instanceof Timestamp && other.seconds === this.seconds && other.nanoseconds === this.nanoseconds;
  }
  valueOf() {
    // Sortable string, like Firestore's, so `<`/`>` between Timestamps work.
    return `${String(this.seconds + 1e11).padStart(12, "0")}.${String(this.nanoseconds).padStart(9, "0")}`;
  }
  toJSON() {
    return { seconds: this.seconds, nanoseconds: this.nanoseconds };
  }
  toString() {
    return `Timestamp(seconds=${this.seconds}, nanoseconds=${this.nanoseconds})`;
  }
}

export class FieldValue {
  _wire: { $sv: string; n?: number; v?: unknown[] };
  constructor(wire: { $sv: string; n?: number; v?: unknown[] }) {
    this._wire = wire;
  }
  isEqual(other: FieldValue) {
    return other instanceof FieldValue && JSON.stringify(other._wire) === JSON.stringify(this._wire);
  }
}

export const serverTimestamp = () => new FieldValue({ $sv: "serverTimestamp" });
export const deleteField = () => new FieldValue({ $sv: "delete" });
export const increment = (n: number) => new FieldValue({ $sv: "increment", n });
export const arrayUnion = (...v: unknown[]) => new FieldValue({ $sv: "arrayUnion", v: v.map(encode) as unknown[] });
export const arrayRemove = (...v: unknown[]) => new FieldValue({ $sv: "arrayRemove", v: v.map(encode) as unknown[] });

export class FieldPath {
  _path: string;
  constructor(...segments: string[]) {
    this._path = segments.join(".");
  }
}
export const documentId = () => new FieldPath("__name__");
const fieldName = (f: string | FieldPath) => (f instanceof FieldPath ? f._path : f);

// JS value -> wire JSON. Like `ignoreUndefinedProperties: true`: undefined
// map fields are dropped.
function encode(v: unknown): unknown {
  if (v === undefined) return undefined;
  if (v === null || typeof v !== "object") {
    if (typeof v === "number" && !Number.isFinite(v)) throw new ApiError("invalid-argument", `Unsupported number ${v}`, 400);
    return v;
  }
  if (v instanceof Timestamp) return { $ts: v.toDate().toISOString() };
  if (v instanceof Date) return { $ts: v.toISOString() };
  if (v instanceof FieldValue) return v._wire;
  if (v instanceof DocumentReference) return v.path;
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : encode(x)));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    const e = encode(x);
    if (e !== undefined) out[k] = e;
  }
  return out;
}

// Wire JSON -> JS value (timestamps back to Timestamp).
function decode(v: unknown): any {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(decode);
  const o = v as Record<string, unknown>;
  if (typeof o.$ts === "string" && Object.keys(o).length === 1) return Timestamp.fromDate(new Date(o.$ts));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(o)) out[k] = decode(x);
  return out;
}

// Deep copy that keeps Timestamps as Timestamps (structuredClone doesn't).
function clone(v: unknown): unknown {
  if (v === null || typeof v !== "object" || v instanceof Timestamp) return v;
  if (Array.isArray(v)) return v.map(clone);
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = clone(x);
  return out;
}

// --- References -------------------------------------------------------------

const AUTO_ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
function autoId() {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => AUTO_ID_CHARS[b % AUTO_ID_CHARS.length]).join("");
}

const segs = (p: string) => p.split("/").filter(Boolean);

function splitDocPath(path: string) {
  const s = segs(path);
  return { parent: s.slice(0, -1).join("/"), id: s[s.length - 1] };
}

interface QuerySpec {
  collection: string;
  filters: { field: string; op: string; value: unknown }[];
  orderBy: { field: string; dir: "asc" | "desc" }[];
  limit?: number;
  limitToLast?: number;
  startAt?: unknown[];
  startAfter?: unknown[];
  endAt?: unknown[];
  endBefore?: unknown[];
}

export class DocumentReference<T = DocumentData> {
  readonly type = "document";
  firestore: Firestore;
  path: string;
  constructor(firestore: Firestore, path: string) {
    if (segs(path).length % 2 !== 0) throw new ApiError("invalid-argument", `Invalid document path: ${path}`, 400);
    this.firestore = firestore;
    this.path = segs(path).join("/");
  }
  get id() {
    return splitDocPath(this.path).id;
  }
  get parent(): CollectionReference<T> {
    return new CollectionReference<T>(this.firestore, splitDocPath(this.path).parent);
  }
  withConverter() {
    return this;
  }
}

export class Query<T = DocumentData> {
  type: "query" | "collection" = "query";
  firestore: Firestore;
  _spec: QuerySpec;
  constructor(firestore: Firestore, spec: QuerySpec) {
    this.firestore = firestore;
    this._spec = spec;
  }
  withConverter() {
    return this;
  }
  /** @internal phantom for typing */
  declare _t?: T;
}

export class CollectionReference<T = DocumentData> extends Query<T> {
  override type = "collection" as const;
  path: string;
  constructor(firestore: Firestore, path: string) {
    if (segs(path).length % 2 !== 1) throw new ApiError("invalid-argument", `Invalid collection path: ${path}`, 400);
    super(firestore, { collection: segs(path).join("/"), filters: [], orderBy: [] });
    this.path = segs(path).join("/");
  }
  get id() {
    return segs(this.path).pop()!;
  }
}

type Parent = Firestore | DocumentReference<any> | CollectionReference<any>;
const fsOf = (p: Parent) => (p instanceof Firestore ? p : p.firestore);
const basePath = (p: Parent) => (p instanceof Firestore ? "" : p.path);
const join = (...parts: string[]) => parts.filter(Boolean).join("/");

export function collection(parent: Parent, path: string, ...more: string[]): CollectionReference<DocumentData> {
  return new CollectionReference(fsOf(parent), join(basePath(parent), path, ...more));
}

export function doc(parent: Parent, path?: string, ...more: string[]): DocumentReference<DocumentData> {
  if (path === undefined) {
    if (!(parent instanceof CollectionReference)) throw new ApiError("invalid-argument", "doc() needs a path", 400);
    return new DocumentReference(parent.firestore, join(parent.path, autoId()));
  }
  return new DocumentReference(fsOf(parent), join(basePath(parent), path, ...more));
}

// --- Query constraints --------------------------------------------------------

export type WhereFilterOp = "<" | "<=" | "==" | "!=" | ">=" | ">" | "array-contains" | "in" | "array-contains-any" | "not-in";
export type OrderByDirection = "asc" | "desc";

export class QueryConstraint {
  readonly type: string;
  _apply: (s: QuerySpec) => QuerySpec;
  constructor(type: string, apply: (s: QuerySpec) => QuerySpec) {
    this.type = type;
    this._apply = apply;
  }
}

function encodeFilterValue(field: string, v: unknown) {
  // documentId() filters take ids (or references) — the server compares ids.
  if (field === "__name__") {
    const id = (x: unknown) => (x instanceof DocumentReference ? x.id : String(x));
    return Array.isArray(v) ? v.map(id) : id(v);
  }
  return encode(v);
}

export const where = (field: string | FieldPath, op: WhereFilterOp, value: unknown) => {
  const f = fieldName(field);
  return new QueryConstraint("where", (s) => ({ ...s, filters: [...s.filters, { field: f, op, value: encodeFilterValue(f, value) }] }));
};
export const orderBy = (field: string | FieldPath, dir: OrderByDirection = "asc") =>
  new QueryConstraint("orderBy", (s) => ({ ...s, orderBy: [...s.orderBy, { field: fieldName(field), dir }] }));
export const limit = (n: number) => new QueryConstraint("limit", (s) => ({ ...s, limit: n, limitToLast: undefined }));
export const limitToLast = (n: number) => new QueryConstraint("limitToLast", (s) => ({ ...s, limitToLast: n, limit: undefined }));

// Cursor from field values, or from a snapshot (its values for the query's
// orderBy fields, then its id).
function cursor(kind: "startAt" | "startAfter" | "endAt" | "endBefore", args: unknown[]) {
  return new QueryConstraint(kind, (s) => {
    let values: unknown[];
    if (args.length === 1 && args[0] instanceof DocumentSnapshot) {
      const snap = args[0];
      values = [...s.orderBy.filter((o) => o.field !== "__name__").map((o) => encode(snap.get(o.field))), snap.id];
    } else {
      values = args.map((v, i) => (s.orderBy[i]?.field === "__name__" ? encodeFilterValue("__name__", v) : encode(v)));
    }
    return { ...s, [kind]: values };
  });
}
export const startAt = (...a: unknown[]) => cursor("startAt", a);
export const startAfter = (...a: unknown[]) => cursor("startAfter", a);
export const endAt = (...a: unknown[]) => cursor("endAt", a);
export const endBefore = (...a: unknown[]) => cursor("endBefore", a);

export function query<T>(q: Query<T>, ...constraints: (QueryConstraint | undefined | null | false)[]): Query<T> {
  let spec = q._spec;
  for (const c of constraints) if (c) spec = c._apply(spec);
  return new Query<T>(q.firestore, spec);
}

// --- Snapshots --------------------------------------------------------------------

const metadata = { hasPendingWrites: false, fromCache: false, isEqual: () => true };

function getField(data: DocumentData | undefined, field: string | FieldPath) {
  let cur: any = data;
  for (const p of fieldName(field).split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[p];
  }
  return cur;
}

export class DocumentSnapshot<T = DocumentData> {
  ref: DocumentReference<T>;
  _data: T | undefined;
  metadata = metadata;
  constructor(ref: DocumentReference<T>, data: T | undefined) {
    this.ref = ref;
    this._data = data;
  }
  get id() {
    return this.ref.id;
  }
  exists(): this is QueryDocumentSnapshot<T> {
    return this._data !== undefined;
  }
  // Options (serverTimestamps: "estimate") are accepted for compatibility:
  // server timestamps are always resolved by the time data arrives here.
  data(_options?: { serverTimestamps?: string }): T | undefined {
    return this._data === undefined ? undefined : (clone(this._data) as T);
  }
  get(field: string | FieldPath): any {
    return getField(this._data as DocumentData, field);
  }
}

export class QueryDocumentSnapshot<T = DocumentData> extends DocumentSnapshot<T> {
  override data(options?: { serverTimestamps?: string }): T {
    return super.data(options) as T;
  }
}

export interface DocumentChange<T = DocumentData> {
  type: "added" | "modified" | "removed";
  doc: QueryDocumentSnapshot<T>;
  oldIndex: number;
  newIndex: number;
}

export class QuerySnapshot<T = DocumentData> {
  docs: QueryDocumentSnapshot<T>[];
  query: Query<T>;
  metadata = metadata;
  _changes: DocumentChange<T>[];
  constructor(query: Query<T>, docs: QueryDocumentSnapshot<T>[], changes: DocumentChange<T>[]) {
    this.query = query;
    this.docs = docs;
    this._changes = changes;
  }
  get size() {
    return this.docs.length;
  }
  get empty() {
    return this.docs.length === 0;
  }
  forEach(cb: (d: QueryDocumentSnapshot<T>) => void) {
    this.docs.forEach(cb);
  }
  docChanges() {
    return this._changes;
  }
}

interface WireDoc {
  id: string;
  data: unknown;
  version: number;
}

function toQuerySnapshot<T>(q: Query<T>, rows: WireDoc[], prev?: QuerySnapshot<T>) {
  const parent = q._spec.collection;
  const docs = rows.map(
    (r) => new QueryDocumentSnapshot<T>(new DocumentReference<T>(q.firestore, join(parent, r.id)), decode(r.data) as T)
  );
  const before = prev?.docs ?? [];
  const beforeIdx = new Map(before.map((d, i) => [d.id, i]));
  const afterIdx = new Map(docs.map((d, i) => [d.id, i]));
  const changes: DocumentChange<T>[] = [];
  before.forEach((d, i) => {
    if (!afterIdx.has(d.id)) changes.push({ type: "removed", doc: d, oldIndex: i, newIndex: -1 });
  });
  docs.forEach((d, i) => {
    const old = beforeIdx.get(d.id);
    if (old === undefined) changes.push({ type: "added", doc: d, oldIndex: -1, newIndex: i });
    else if (JSON.stringify(encode(before[old]._data)) !== JSON.stringify(encode(d._data))) {
      changes.push({ type: "modified", doc: d, oldIndex: old, newIndex: i });
    }
  });
  return new QuerySnapshot<T>(q, docs, changes);
}

// --- Reads ------------------------------------------------------------------------------

async function fetchDoc<T>(ref: DocumentReference<T>) {
  const r = await ref.firestore._transport.post<{ exists: boolean; data?: unknown; version: number }>("/v1/get", { path: ref.path });
  return { snap: new DocumentSnapshot<T>(ref, r.exists ? (decode(r.data) as T) : undefined), version: r.version };
}

export async function getDoc<T>(ref: DocumentReference<T>): Promise<DocumentSnapshot<T>> {
  return (await fetchDoc(ref)).snap;
}
export const getDocFromServer = getDoc;

async function fetchQuery<T>(q: Query<T>) {
  return (await q.firestore._transport.post<{ docs: WireDoc[] }>("/v1/query", { query: q._spec })).docs;
}

export async function getDocs<T>(q: Query<T>): Promise<QuerySnapshot<T>> {
  return toQuerySnapshot(q, await fetchQuery(q));
}
export const getDocsFromServer = getDocs;

export async function getCountFromServer(q: Query<any>) {
  const { count } = await q.firestore._transport.post<{ count: number }>("/v1/query", { query: q._spec, count: true });
  return { data: () => ({ count }) };
}

// --- Writes ---------------------------------------------------------------------------------

export interface SetOptions {
  merge?: boolean;
  mergeFields?: (string | FieldPath)[];
}

type Write =
  | { op: "set"; path: string; data: unknown; merge?: boolean }
  | { op: "update"; path: string; data: unknown }
  | { op: "delete"; path: string };

function setWrite(ref: DocumentReference<any>, data: unknown, opts?: SetOptions): Write {
  if (opts?.mergeFields) {
    const picked: Record<string, unknown> = {};
    for (const f of opts.mergeFields) picked[fieldName(f)] = getField(data as DocumentData, f);
    return { op: "update", path: ref.path, data: encode(picked) };
  }
  return { op: "set", path: ref.path, data: encode(data), merge: Boolean(opts?.merge) };
}

// updateDoc(ref, {a: 1, "b.c": 2}) or updateDoc(ref, "a", 1, "b.c", 2)
function updateWrite(ref: DocumentReference<any>, args: unknown[]): Write {
  let data: Record<string, unknown>;
  if (typeof args[0] === "string" || args[0] instanceof FieldPath) {
    data = {};
    for (let i = 0; i < args.length; i += 2) data[fieldName(args[i] as string)] = args[i + 1];
  } else {
    data = args[0] as Record<string, unknown>;
  }
  return { op: "update", path: ref.path, data: encode(data) };
}

async function commit(fs: Firestore, writes: Write[], reads?: { path: string; version: number }[]) {
  if (!writes.length && !reads?.length) return;
  await fs._transport.post("/v1/commit", { reads, writes });
  fs._notifyLocal(writes.map((w) => w.path));
}

export async function setDoc(ref: DocumentReference<any>, data: unknown, opts?: SetOptions): Promise<void> {
  await commit(ref.firestore, [setWrite(ref, data, opts)]);
}
export async function updateDoc(ref: DocumentReference<any>, ...args: unknown[]): Promise<void> {
  await commit(ref.firestore, [updateWrite(ref, args)]);
}
export async function deleteDoc(ref: DocumentReference<any>): Promise<void> {
  await commit(ref.firestore, [{ op: "delete", path: ref.path }]);
}
export async function addDoc<T>(col: CollectionReference<T>, data: unknown): Promise<DocumentReference<T>> {
  const ref = doc(col) as DocumentReference<T>;
  await setDoc(ref, data);
  return ref;
}

export class WriteBatch {
  _fs: Firestore;
  _writes: Write[] = [];
  _done = false;
  constructor(fs: Firestore) {
    this._fs = fs;
  }
  set(ref: DocumentReference<any>, data: unknown, opts?: SetOptions) {
    this._writes.push(setWrite(ref, data, opts));
    return this;
  }
  update(ref: DocumentReference<any>, ...args: unknown[]) {
    this._writes.push(updateWrite(ref, args));
    return this;
  }
  delete(ref: DocumentReference<any>) {
    this._writes.push({ op: "delete", path: ref.path });
    return this;
  }
  async commit() {
    if (this._done) throw new ApiError("failed-precondition", "A write batch can only be committed once", 400);
    this._done = true;
    await commit(this._fs, this._writes);
  }
}

export const writeBatch = (fs: Firestore) => new WriteBatch(fs);

export class Transaction {
  _fs: Firestore;
  _reads = new Map<string, number>();
  _writes: Write[] = [];
  constructor(fs: Firestore) {
    this._fs = fs;
  }
  async get<T>(ref: DocumentReference<T>): Promise<DocumentSnapshot<T>> {
    if (this._writes.length) {
      throw new ApiError("invalid-argument", "Firestore transactions require all reads to be executed before all writes.", 400);
    }
    const { snap, version } = await fetchDoc(ref);
    const seen = this._reads.get(ref.path);
    // Reading the same document twice and getting two different versions
    // means it changed mid-transaction: the commit would fail anyway.
    if (seen !== undefined && seen !== version) throw new ApiError("aborted", "Document changed during transaction", 409);
    this._reads.set(ref.path, version);
    return snap;
  }
  set(ref: DocumentReference<any>, data: unknown, opts?: SetOptions) {
    this._writes.push(setWrite(ref, data, opts));
    return this;
  }
  update(ref: DocumentReference<any>, ...args: unknown[]) {
    this._writes.push(updateWrite(ref, args));
    return this;
  }
  delete(ref: DocumentReference<any>) {
    this._writes.push({ op: "delete", path: ref.path });
    return this;
  }
}

export async function runTransaction<T>(fs: Firestore, fn: (tx: Transaction) => Promise<T>, opts?: { maxAttempts?: number }): Promise<T> {
  const max = opts?.maxAttempts ?? 5;
  for (let attempt = 1; ; attempt++) {
    const tx = new Transaction(fs);
    try {
      const out = await fn(tx);
      await commit(fs, tx._writes, [...tx._reads].map(([path, version]) => ({ path, version })));
      return out;
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "aborted") || attempt >= max) throw e;
      await new Promise((r) => setTimeout(r, Math.random() * 50 * attempt));
    }
  }
}

// --- Live listeners ---------------------------------------------------------------------------

type Observer<S> = { next?: (s: S) => void; error?: (e: ApiError) => void; complete?: () => void };

function listen<S>(
  fs: Firestore,
  affects: (c: Change) => boolean,
  load: () => Promise<S>,
  same: (a: S, b: S) => boolean,
  next: (s: S) => void,
  error: (e: ApiError) => void
): Unsubscribe {
  let stopped = false;
  let last: S | undefined;
  let inflight = false;
  let again = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const refresh = async () => {
    if (inflight) {
      again = true;
      return;
    }
    inflight = true;
    try {
      do {
        again = false;
        const s = await load();
        if (stopped) return;
        if (last === undefined || !same(last, s)) {
          last = s;
          next(s);
        }
      } while (again && !stopped);
    } catch (e) {
      if (!stopped) {
        // No connection (server unreachable): keep the last data and try
        // again shortly -- a dropped network must never end a listener or
        // blank what the screen shows (a till keeps selling offline). The
        // change feed also triggers a re-fetch when it reconnects.
        if (e instanceof ApiError && e.code === "unavailable") {
          clearTimeout(timer);
          timer = setTimeout(refresh, 5000);
        } else {
          stopped = true;
          cleanup();
          error(e instanceof ApiError ? e : new ApiError("unknown", String(e), 0));
        }
      }
    } finally {
      inflight = false;
    }
  };
  // Coalesce bursts (a transaction touching 10 docs = one re-fetch).
  const schedule = () => {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(refresh, 30);
  };
  const onChange = (c: Change) => {
    if (affects(c)) schedule();
  };
  const offFeed = fs._transport.onChange(onChange, schedule);
  fs._local.add(onChange);
  const offAuth = authListeners.add(schedule);
  function cleanup() {
    clearTimeout(timer);
    offFeed();
    fs._local.delete(onChange);
    offAuth();
  }
  void refresh();
  return () => {
    if (stopped) return;
    stopped = true;
    cleanup();
  };
}

// Signing in or out changes what the rules let a listener see: every
// listener re-fetches. Called by the auth module.
const authListeners = {
  set: new Set<() => void>(),
  add(fn: () => void) {
    this.set.add(fn);
    return () => {
      this.set.delete(fn);
    };
  },
};
export function _notifyAuthChanged() {
  authListeners.set.forEach((f) => f());
}

export function onSnapshot<T>(
  ref: DocumentReference<T>,
  next: (s: DocumentSnapshot<T>) => void,
  error?: (e: ApiError) => void
): Unsubscribe;
export function onSnapshot<T>(ref: DocumentReference<T>, observer: Observer<DocumentSnapshot<T>>): Unsubscribe;
export function onSnapshot<T>(q: Query<T>, next: (s: QuerySnapshot<T>) => void, error?: (e: ApiError) => void): Unsubscribe;
export function onSnapshot<T>(q: Query<T>, observer: Observer<QuerySnapshot<T>>): Unsubscribe;
export function onSnapshot<T>(
  target: DocumentReference<T> | Query<T>,
  ...args: any[]
): Unsubscribe {
  // (target, observer) | (target, next, error?) | (target, options, ...)
  if (args[0] && typeof args[0] === "object" && !("next" in args[0]) && !("error" in args[0])) args = args.slice(1);
  const obs: Observer<any> =
    typeof args[0] === "function" ? { next: args[0], error: args[1], complete: args[2] } : (args[0] ?? {});
  const next = (s: any) => obs.next?.(s);
  const error = (e: ApiError) => {
    if (obs.error) obs.error(e);
    else console.error("Uncaught Error in snapshot listener:", e);
  };

  if (target instanceof DocumentReference) {
    const { parent, id } = splitDocPath(target.path);
    return listen<DocumentSnapshot<T>>(
      target.firestore,
      (c) => c.c === parent && (!c.ids || c.ids.includes(id)),
      () => getDoc(target),
      (a, b) => JSON.stringify(encode(a._data)) === JSON.stringify(encode(b._data)) && a.exists() === b.exists(),
      next,
      error
    );
  }
  const q = target;
  let prev: QuerySnapshot<T> | undefined;
  return listen<QuerySnapshot<T>>(
    q.firestore,
    (c) => c.c === q._spec.collection,
    async () => {
      const s = toQuerySnapshot(q, await fetchQuery(q), prev);
      return s;
    },
    (_a, b) => b._changes.length === 0,
    (s) => {
      prev = s;
      next(s);
    },
    error
  );
}

// --- Setup ---------------------------------------------------------------------------------------

export function initializeFirestore(transport: Transport) {
  return new Firestore(transport);
}
