import { doc, setDoc } from "../../src/db/firestore";
import { getTestEnv } from "./setup";

// Multi-branch POS fixtures: a branch, one register in it, a staff member
// (cashier by default) assigned to that branch, and an open register session
// on that register owned by them -- the state a real cashier is in while
// selling (see src/firebase/registerSession.ts openRegister()).
export interface BranchSetup {
  uid: string;
  role?: string;
  branchId?: string;
  registerId?: string;
  sessionId?: string;
  // Extra branches assigned to the user beyond branchId.
  extraBranchIds?: string[];
  withSession?: boolean;
}

export async function seedBranchSetup(opts: BranchSetup): Promise<Required<Pick<BranchSetup, "branchId" | "registerId" | "sessionId">>> {
  const branchId = opts.branchId ?? "b1";
  const registerId = opts.registerId ?? `${branchId}-r1`;
  const sessionId = opts.sessionId ?? `${opts.uid}-session`;
  const withSession = opts.withSession ?? true;
  const env = await getTestEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const fs = ctx.firestore();
    await setDoc(doc(fs, `branches/${branchId}`), { name: `Branch ${branchId}`, code: branchId.toUpperCase(), active: true });
    await setDoc(doc(fs, `registers/${registerId}`), { branchId, name: "Register 1", active: true, openSessionId: withSession ? sessionId : null });
    await setDoc(doc(fs, `admins/${opts.uid}`), {
      email: `${opts.uid}@example.com`,
      displayName: opts.uid,
      role: opts.role ?? "cashier",
      active: true,
      branchIds: [branchId, ...(opts.extraBranchIds ?? [])],
    });
    if (withSession) {
      await setDoc(doc(fs, `registerSessions/${sessionId}`), {
        cashierId: opts.uid,
        cashierName: opts.uid,
        branchId,
        branchName: `Branch ${branchId}`,
        registerId,
        registerName: "Register 1",
        status: "open",
        startingCash: 0,
        salesCount: 0,
        cashTotal: 0,
        cardTotal: 0,
        discountTotal: 0,
        grossTotal: 0,
      });
    }
  });
  return { branchId, registerId, sessionId };
}

export async function seedBranchStock(branchId: string, productId: string, stockByCell: Record<string, { qty: number }>) {
  const env = await getTestEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `branchStock/${branchId}__${productId}`), { branchId, productId, stockByCell });
  });
}
