import type { PaymentMethod } from "../../admin/types";
import type { ReceiptData } from "../../receipts/renderReceipt";

// Sales made while the till was offline, kept ON THIS DEVICE (IndexedDB) until
// the server has them -- they survive a page refresh or a closed tab. Each
// carries the id/number the till gave it, so sending it twice can never
// record it twice (placeOrder returns the existing order).

export interface PendingSaleInput {
  lines: { productId: string; variantId: string; size: string; qty: number }[];
  discount: number;
  discountPercent?: number;
  expectedPromoDiscount: number;
  paymentMethod: PaymentMethod;
  cashAmount: number;
  cardAmount: number;
  // "<productId>::<variantId>::<size>" -> price charged.
  linePrices: Record<string, number>;
}

export interface PendingSale {
  id: string;
  orderNumber: string;
  sessionId: string;
  branchId: string;
  registerId: string;
  registerName?: string;
  cashierUid: string;
  cashierName: string;
  // When the sale happened at the till (epoch ms).
  createdAt: number;
  input: PendingSaleInput;
  total: number;
  itemCount: number;
  // The receipt as printed (createdAt as epoch ms).
  receipt: Omit<ReceiptData, "createdAt"> & { createdAt: number };
  // pending = not on the server yet; issue = the server couldn't record it
  // as it was (kept here and reported for review).
  status: "pending" | "issue";
  issue?: { code: string; message: string; reported: boolean };
  attempts: number;
}

export interface OfflineStore {
  list(): Promise<PendingSale[]>;
  put(p: PendingSale): Promise<void>;
  remove(id: string): Promise<void>;
}

const DB_NAME = "lulua-pos-offline";
const STORE = "sales";

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openIdb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => {
          resolve(req.result);
          db.close();
        };
        tx.onerror = () => {
          reject(tx.error);
          db.close();
        };
      })
  );
}

export function idbStore(): OfflineStore {
  return {
    list: () => run<PendingSale[]>("readonly", (s) => s.getAll() as IDBRequest<PendingSale[]>),
    put: async (p) => {
      await run("readwrite", (s) => s.put(p));
    },
    remove: async (id) => {
      await run("readwrite", (s) => s.delete(id));
    },
  };
}

// For tests.
export function memoryStore(initial: PendingSale[] = []): OfflineStore {
  const m = new Map(initial.map((p) => [p.id, p]));
  return {
    list: async () => [...m.values()].map((p) => structuredClone(p)),
    put: async (p) => {
      m.set(p.id, structuredClone(p));
    },
    remove: async (id) => {
      m.delete(id);
    },
  };
}

// Units of each "<productId>::<variantId>::<size>" still waiting to be sent
// for a branch -- the till takes them off the stock it shows meanwhile.
export function pendingQtyByCell(sales: PendingSale[], branchId: string | undefined): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of sales) {
    if (p.status !== "pending" || p.branchId !== branchId) continue;
    for (const l of p.input.lines) {
      const k = `${l.productId}::${l.variantId}::${l.size}`;
      m.set(k, (m.get(k) ?? 0) + l.qty);
    }
  }
  return m;
}
