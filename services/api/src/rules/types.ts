// What a security rule sees. Mirrors Firestore rules' request/resource:
//   auth    request.auth (null = signed out)
//   before  resource.data (null = document doesn't exist yet)
//   after   request.resource.data (null = being deleted)
//   get     get(path): the pre-commit state of any document
//   getAfter getAfter(path): the state as if this commit had applied
import type { QuerySpec } from "../query.ts";
import type { DocData } from "../values.ts";

export interface Auth {
  uid: string;
  email: string | null;
  // "password" | "google.com" | "anonymous" — Firebase's sign_in_provider.
  provider: string;
}

type Lookup = (path: string) => Promise<DocData | null>;

export interface WriteCtx {
  op: "create" | "update" | "delete";
  auth: Auth | null;
  path: string;
  collection: string;
  id: string;
  before: DocData | null;
  after: DocData | null;
  get: Lookup;
  getAfter: Lookup;
  now: Date;
}

export interface ReadCtx {
  // "get" = one document by path, "list" = a query.
  kind: "get" | "list";
  auth: Auth | null;
  collection: string;
  id: string;
  data: DocData;
  query?: QuerySpec;
  get: Lookup;
  now: Date;
}

export interface Rules {
  read(ctx: ReadCtx): Promise<boolean>;
  write(ctx: WriteCtx): Promise<boolean>;
}
