import { collection, doc, onSnapshot, query, runTransaction, serverTimestamp, setDoc, Timestamp, where } from "../db/firestore";
import type { Firestore } from "../db/firestore";
import type { HeldSale, HeldSaleLine, RegisterSession } from "../admin/types";

// Held (parked) sales: a till's unfinished cart put aside so the cashier can
// serve the next customer, then resumed later -- from any till of the same
// branch. Holding never records a sale or touches stock. Every function takes
// the Firestore instance (the app passes firebase/config's `db`), so the
// rules tests run them for real.

// A held sale can be resumed for this long; after that it can only be
// discarded. Must match HELD_SALE_TTL_MS in services/api/src/rules.
export const HELD_SALE_TTL_MS = 24 * 60 * 60 * 1000;

export class HeldSaleError extends Error {
  readonly code: "taken" | "expired" | "missing" | "otherBranch";
  readonly by?: string;
  constructor(code: HeldSaleError["code"], by?: string) {
    super(code);
    this.code = code;
    this.by = by;
  }
}

export function heldSaleRef(now = Date.now()): string {
  return `H-${now.toString(36).toUpperCase().slice(-5)}`;
}

export function heldSaleExpired(h: Pick<HeldSale, "createdAt">, now = Date.now()): boolean {
  const ms = (h.createdAt as { toMillis?: () => number } | undefined)?.toMillis?.();
  return ms !== undefined && now - ms > HELD_SALE_TTL_MS;
}

export interface HoldInput {
  lines: HeldSaleLine[];
  customerName?: string;
  note?: string;
  discountMode?: "percent" | "amount";
  discountValue?: number | null;
}

export async function holdSale(fs: Firestore, session: RegisterSession, actor: { uid: string; name: string }, input: HoldInput): Promise<HeldSale> {
  const ref = doc(collection(fs, "heldSales"));
  const lines = input.lines.filter((l) => l.qty > 0);
  const data: Omit<HeldSale, "id"> = {
    ref: heldSaleRef(),
    status: "held",
    branchId: session.branchId ?? "",
    ...(session.branchCode ? { branchCode: session.branchCode } : {}),
    registerId: session.registerId ?? "",
    ...(session.registerName ? { registerName: session.registerName } : {}),
    sessionId: session.id,
    cashierUid: actor.uid,
    cashierName: actor.name,
    lines,
    itemCount: lines.reduce((s, l) => s + l.qty, 0),
    subtotal: Math.round(lines.reduce((s, l) => s + l.price * l.qty, 0) * 100) / 100,
    ...(input.customerName?.trim() ? { customerName: input.customerName.trim().slice(0, 80) } : {}),
    ...(input.note?.trim() ? { note: input.note.trim().slice(0, 200) } : {}),
    ...(input.discountValue ? { discountMode: input.discountMode ?? "percent", discountValue: input.discountValue } : {}),
  };
  await setDoc(ref, { ...data, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
  return { id: ref.id, ...data, createdAt: Timestamp.now() };
}

// This branch's sales on hold, newest first.
export function subscribeHeldSales(fs: Firestore, branchId: string, onData: (list: HeldSale[]) => void): () => void {
  return onSnapshot(
    query(collection(fs, "heldSales"), where("branchId", "==", branchId), where("status", "==", "held")),
    (snap) =>
      onData(
        snap.docs
          .map((d) => ({ id: d.id, ...d.data() }) as HeldSale)
          .sort((a, b) => ((b.createdAt as Timestamp)?.toMillis?.() ?? 0) - ((a.createdAt as Timestamp)?.toMillis?.() ?? 0))
      ),
    () => onData([])
  );
}

// Takes the held sale for this till. One transaction: if another till took
// (or discarded) it a moment earlier, this one fails instead of both
// carrying on with the same cart.
export async function resumeHeldSale(fs: Firestore, id: string, session: RegisterSession, actor: { uid: string; name: string }): Promise<HeldSale> {
  const ref = doc(fs, "heldSales", id);
  return runTransaction(fs, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new HeldSaleError("missing");
    const h = { id: snap.id, ...snap.data() } as HeldSale;
    if (h.status !== "held") throw new HeldSaleError("taken", h.resumedByName ?? h.cancelledByName);
    if (h.branchId !== session.branchId) throw new HeldSaleError("otherBranch");
    if (heldSaleExpired(h)) throw new HeldSaleError("expired");
    tx.update(ref, {
      status: "resumed",
      resumedByUid: actor.uid,
      resumedByName: actor.name,
      resumedSessionId: session.id,
      resumedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return h;
  });
}

export async function discardHeldSale(fs: Firestore, id: string, actor: { uid: string; name: string }): Promise<HeldSale> {
  const ref = doc(fs, "heldSales", id);
  return runTransaction(fs, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new HeldSaleError("missing");
    const h = { id: snap.id, ...snap.data() } as HeldSale;
    if (h.status !== "held") throw new HeldSaleError("taken", h.resumedByName ?? h.cancelledByName);
    tx.update(ref, { status: "cancelled", cancelledByUid: actor.uid, cancelledByName: actor.name, cancelledAt: serverTimestamp(), updatedAt: serverTimestamp() });
    return h;
  });
}
