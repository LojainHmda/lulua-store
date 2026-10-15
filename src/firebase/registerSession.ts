import { collection, doc, getDocs, limit, query, runTransaction, serverTimestamp, where } from "firebase/firestore";
import type { Actor } from "../admin/actor";
import type { Branch, Register, RegisterSession } from "../admin/types";
import { db } from "./config";

export class RegisterSessionError extends Error {}

// What should physically be in the drawer: the opening float, plus cash
// taken on sales (the session's running cashTotal, kept by placeOrder()),
// minus cash withdrawn during the shift. The one place this is computed.
export function sessionExpectedCash(s: Pick<RegisterSession, "startingCash" | "cashTotal" | "cashOutTotal">): number {
  return Math.round((s.startingCash + s.cashTotal - (s.cashOutTotal ?? 0)) * 100) / 100;
}

export async function findOpenSession(cashierId: string): Promise<RegisterSession | null> {
  const q = query(collection(db, "registerSessions"), where("cashierId", "==", cashierId), where("status", "==", "open"), limit(1));
  const snap = await getDocs(q);
  if (snap.empty) return null;
  const d = snap.docs[0];
  return { id: d.id, ...d.data() } as RegisterSession;
}

// Opens a session on one register of one branch. The register's
// `openSessionId` lock is taken in the SAME transaction as the session is
// created (firestore.rules checks both sides with getAfter), so two cashiers
// racing for the same till can never both succeed -- the loser gets a clear
// error instead of a second, silently parallel session.
export async function openRegister(
  // operatorId: on a POS device (cashier.id = the device), the staff member
  // who picked their name at the start of the shift.
  cashier: { id: string; name: string; operatorId?: string },
  branch: Branch,
  register: Register,
  startingCash: number
): Promise<RegisterSession> {
  const sessionRef = doc(collection(db, "registerSessions"));
  const registerRef = doc(db, "registers", register.id);
  const session: Omit<RegisterSession, "id"> = {
    cashierId: cashier.id,
    cashierName: cashier.name,
    ...(cashier.operatorId ? { operatorId: cashier.operatorId } : {}),
    branchId: branch.id,
    branchName: branch.name,
    branchCode: branch.code,
    registerId: register.id,
    registerName: register.name,
    startingCash,
    status: "open",
    salesCount: 0,
    cashTotal: 0,
    cardTotal: 0,
    discountTotal: 0,
    grossTotal: 0,
    cashOutTotal: 0,
    openedAt: serverTimestamp(),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  await runTransaction(db, async (tx) => {
    const regSnap = await tx.get(registerRef);
    if (!regSnap.exists()) throw new RegisterSessionError("This register no longer exists.");
    const reg = regSnap.data() as Omit<Register, "id">;
    if (!reg.active) throw new RegisterSessionError("This register is disabled.");
    if (reg.branchId !== branch.id) throw new RegisterSessionError("This register belongs to a different branch.");
    if (reg.openSessionId) throw new RegisterSessionError("This register is already open on another session.");
    tx.set(sessionRef, session);
    tx.update(registerRef, { openSessionId: sessionRef.id, updatedAt: serverTimestamp() });
  });
  return { id: sessionRef.id, ...session };
}

// `actor` is always the employee actually clicking Close, which today's UI
// only ever lets be the cashier who owns the open session -- but this
// function itself never assumes that; it records whoever really performed
// the close, distinct from (and never overwriting) the opener identity
// (cashierId/cashierName) already on the session. firestore.rules
// separately enforces closedByUid == request.auth.uid and freezes
// cashierId/cashierName on every update, so the opener's identity can never
// be silently rewritten here either. Also releases the register's lock (when
// this session still holds it), in the same transaction. Used both by the
// cashier's own Close Register screen and by an admin force-closing a
// session left open (POS Sales page). Expected cash is computed here from
// the session as it stands inside the transaction (never from a possibly
// stale copy the caller holds) and returned.
// countedCash null = closed without a count (an admin force close): only the
// cashier at the POS counts the drawer, so counted/variance stay empty.
export async function closeRegister(sessionId: string, countedCash: number | null, actor: Actor): Promise<number> {
  const sessionRef = doc(db, "registerSessions", sessionId);
  return runTransaction(db, async (tx) => {
    const sessionSnap = await tx.get(sessionRef);
    if (!sessionSnap.exists()) throw new RegisterSessionError("This register session no longer exists.");
    const session = sessionSnap.data() as Omit<RegisterSession, "id">;
    if (session.status !== "open") throw new RegisterSessionError("This register session is already closed.");
    const expectedCash = sessionExpectedCash(session);
    const registerRef = session.registerId ? doc(db, "registers", session.registerId) : null;
    const regSnap = registerRef ? await tx.get(registerRef) : null;
    tx.update(sessionRef, {
      status: "closed",
      ...(countedCash === null ? {} : { countedCash, variance: countedCash - expectedCash }),
      expectedCash,
      closedByUid: actor.uid,
      closedByEmail: actor.email,
      closedByName: actor.displayName || actor.email,
      closedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    if (registerRef && regSnap?.exists() && regSnap.get("openSessionId") === sessionId) {
      tx.update(registerRef, { openSessionId: null, updatedAt: serverTimestamp() });
    }
    return expectedCash;
  });
}

// Cash taken out of the drawer mid-shift: an immutable cashMovements record
// plus the session's running cashOutTotal, in one transaction, so the
// expected cash at close always matches the recorded withdrawals.
export async function recordCashWithdrawal(sessionId: string, amount: number, reason: string, actor: { uid: string; name: string }): Promise<void> {
  if (!(amount > 0)) throw new RegisterSessionError("Enter an amount greater than zero.");
  const sessionRef = doc(db, "registerSessions", sessionId);
  const movementRef = doc(collection(db, "cashMovements"));
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(sessionRef);
    if (!snap.exists()) throw new RegisterSessionError("This register session no longer exists.");
    const session = snap.data() as Omit<RegisterSession, "id">;
    if (session.status !== "open") throw new RegisterSessionError("This register session is already closed.");
    if (amount > sessionExpectedCash(session) + 0.005) throw new RegisterSessionError("That is more cash than the drawer should hold.");
    tx.set(movementRef, {
      sessionId,
      branchId: session.branchId ?? "",
      registerId: session.registerId ?? "",
      type: "withdrawal",
      amount,
      ...(reason.trim() ? { reason: reason.trim().slice(0, 200) } : {}),
      actorUid: actor.uid,
      actorName: actor.name,
      createdAt: serverTimestamp(),
    });
    tx.update(sessionRef, {
      cashOutTotal: Math.round(((session.cashOutTotal ?? 0) + amount) * 100) / 100,
      updatedAt: serverTimestamp(),
    });
  });
}
