import { signInAnonymously } from "../db/auth";
import { collection, doc, getDoc, getDocs, onSnapshot, query, serverTimestamp, setDoc, where, writeBatch } from "../db/firestore";
import type { Branch, Register } from "../admin/types";
import { auth } from "./auth";
import { db } from "./config";

// POS device links. Each register can have one active secret link,
// /pos/<token>. Whoever opens it gets that register's till on that device
// without any staff login: the device signs in anonymously and registers
// itself (admins/{uid}) as a cashier pinned to exactly that link's branch
// and register -- firestore.rules' isValidPosDeviceClaim() is what checks
// the link is real, active and matches. From then on the device is just a
// cashier to every other rule (sessions, sales, branch stock).
//
// Revoking a link deactivates every device registered through it in the
// same batch; a deactivated admins doc fails every role check, so the
// device is cut off immediately.

export interface PosLink {
  id: string; // the token itself
  branchId: string;
  registerId: string;
  // "<register> · <branch>" — becomes the device's display/cashier name.
  label: string;
  active: boolean;
  // Legacy: links used to be bound to the first device that opened them.
  // Ignored now -- only an open shift reserves a register.
  deviceUid?: string;
  claimedAt?: unknown;
  createdAt?: unknown;
  createdByUid?: string;
}

// Distinguishes /pos/<token> from /pos/<branchCode> (codes are ≤ 6 chars).
export const POS_TOKEN_RE = /^[A-Za-z0-9_-]{32,}$/;

// 240 random bits, URL-safe.
function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(30));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function posLinkUrl(token: string): string {
  return `${window.location.origin}/pos/${token}`;
}

// A failed read reports an empty list unless onError is given -- callers
// that act on "this register has no link" pass onError so a read failure is
// never mistaken for "no link".
export function subscribeActivePosLinks(onData: (links: PosLink[]) => void, onError?: () => void) {
  return onSnapshot(
    query(collection(db, "posLinks"), where("active", "==", true)),
    (snap) => onData(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as PosLink)),
    () => (onError ? onError() : onData([]))
  );
}

// Revokes the link and deactivates every device registered through it.
export async function revokePosLink(token: string): Promise<void> {
  const devices = await getDocs(query(collection(db, "admins"), where("posLink", "==", token)));
  const batch = writeBatch(db);
  batch.update(doc(db, "posLinks", token), { active: false, revokedAt: serverTimestamp(), updatedAt: serverTimestamp() });
  devices.forEach((d) => batch.update(d.ref, { active: false, updatedAt: serverTimestamp() }));
  await batch.commit();
}

// A fresh link for the register; any link it already had is revoked first
// (so a leaked link is dead the moment a new one is issued).
export async function issuePosLink(register: Register, branch: Branch, createdByUid: string): Promise<string> {
  const existing = await getDocs(query(collection(db, "posLinks"), where("registerId", "==", register.id), where("active", "==", true)));
  for (const d of existing.docs) await revokePosLink(d.id);
  const token = newToken();
  await setDoc(doc(db, "posLinks", token), {
    branchId: branch.id,
    registerId: register.id,
    label: `${register.name} · ${branch.name}`,
    active: true,
    createdByUid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return token;
}

export type PosLinkErrorCode = "invalid" | "revoked" | "inUse";

export class PosLinkError extends Error {
  code: PosLinkErrorCode;
  constructor(code: PosLinkErrorCode) {
    super(code);
    this.code = code;
  }
}

// Device side: sign in anonymously (if not already) and register this device
// for the link. Opening a link reserves nothing: any device holding it can
// reach the till's start screen. A register is only taken once a cashier
// starts a shift on it (registers.openSessionId -- one open shift per
// register), and is free again the moment that shift is closed. The
// anonymous identity persists in this browser, so closing and reopening the
// POS keeps the same device (and its open shift).
export async function claimPosLink(token: string): Promise<void> {
  if (!auth.currentUser) await signInAnonymously(auth);
  const uid = auth.currentUser!.uid;
  const snap = await getDoc(doc(db, "posLinks", token));
  if (!snap.exists()) throw new PosLinkError("invalid");
  const link = snap.data() as Omit<PosLink, "id">;
  if (!link.active) throw new PosLinkError("revoked");
  await setDoc(doc(db, "admins", uid), {
    email: "",
    displayName: (link.label || "POS").slice(0, 80),
    role: "cashier",
    active: true,
    branchIds: [link.branchId],
    registerIds: [link.registerId],
    posLink: token,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}