import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
} from "../db/firestore";
import type { QueryConstraint } from "../db/firestore";
import { db, isBackendConfigured } from "./config";

export function createCollectionApi<T extends { id: string }>(collectionName: string) {
  const colRef = () => collection(db, collectionName);

  return {
    async list(constraints: QueryConstraint[] = []): Promise<T[]> {
      const q = constraints.length ? query(colRef(), ...constraints) : colRef();
      const snap = await getDocs(q);
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as T);
    },

    subscribe(onData: (items: T[]) => void, constraints: QueryConstraint[] = []) {
      const q = constraints.length ? query(colRef(), ...constraints) : colRef();
      return onSnapshot(
        q,
        (snap) => {
          onData(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as T));
        },
        // Without this, a permission-denied (or any other) listener error
        // is only ever surfaced as an "Uncaught Error in snapshot listener"
        // console warning from the Firestore SDK itself -- onData() never
        // fires, so a caller using this to drive a `loading` flag (every
        // admin list page does) is left spinning forever with zero
        // indication anything went wrong. Reporting an empty list instead
        // at least unblocks the UI; the console.error below is what an
        // admin/developer actually needs to diagnose a genuine rules issue.
        (error) => {
          console.error(`[${collectionName}] subscribe() error:`, error);
          onData([]);
        }
      );
    },

    async get(id: string): Promise<T | undefined> {
      const snap = await getDoc(doc(db, collectionName, id));
      return snap.exists() ? ({ id: snap.id, ...snap.data() } as T) : undefined;
    },

    async create(data: Omit<T, "id">): Promise<string> {
      const ref = await addDoc(colRef(), {
        ...data,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      return ref.id;
    },

    async createWithId(id: string, data: Omit<T, "id">): Promise<void> {
      await setDoc(doc(db, collectionName, id), {
        ...data,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    },

    async update(id: string, data: Partial<Omit<T, "id">>): Promise<void> {
      await updateDoc(doc(db, collectionName, id), {
        ...data,
        updatedAt: serverTimestamp(),
      });
    },

    async remove(id: string): Promise<void> {
      await deleteDoc(doc(db, collectionName, id));
    },
  };
}

// Newsletter signups come straight from anonymous storefront visitors — no
// backend, same "public write, admin-only read" shape as the analytics
// counters. The document is deliberately exactly { email, createdAt } to
// satisfy the newsletterSubscribers rule in firestore.rules; note this can't
// go through createCollectionApi().create(), which also stamps an updatedAt
// field the rule rejects.
export async function addNewsletterSubscriber(email: string): Promise<void> {
  if (!isBackendConfigured) return;
  await addDoc(collection(db, "newsletterSubscribers"), { email, createdAt: serverTimestamp() });
}

export async function getSingletonDoc<T>(path: string, id: string): Promise<T | undefined> {
  if (!isBackendConfigured) return undefined;
  const snap = await getDoc(doc(db, path, id));
  return snap.exists() ? (snap.data() as T) : undefined;
}

export async function setSingletonDoc<T extends object>(path: string, id: string, data: T): Promise<void> {
  if (!isBackendConfigured) return;
  await setDoc(doc(db, path, id), { ...data, updatedAt: serverTimestamp() }, { merge: true });
}

export function subscribeSingletonDoc<T>(path: string, id: string, onData: (data: T | undefined) => void) {
  if (!isBackendConfigured) return () => {};
  return onSnapshot(doc(db, path, id), (snap) => {
    onData(snap.exists() ? (snap.data() as T) : undefined);
  });
}
