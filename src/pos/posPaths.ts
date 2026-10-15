import type { RegisterSession } from "../admin/types";

// POS URLs carry where the till is: /pos/<branchCode>/<registerId>, with the
// cashier on the till itself as ?cashier=<uid>. Sub-screens hang off the
// same base (…/sales, …/close). A session from before branches existed has
// no branch/register, so it lives under a fixed placeholder base.
export const LEGACY_TILL_BASE = "/pos/-/-";

export function tillBase(session: Pick<RegisterSession, "branchCode" | "registerId">): string {
  return session.branchCode && session.registerId
    ? `/pos/${encodeURIComponent(session.branchCode)}/${encodeURIComponent(session.registerId)}`
    : LEGACY_TILL_BASE;
}

export function tillUrl(session: Pick<RegisterSession, "branchCode" | "registerId" | "cashierId">): string {
  return `${tillBase(session)}?cashier=${encodeURIComponent(session.cashierId)}`;
}

// The start screen's URL for a (partial) selection, so the picks show in
// the address bar as they're made and a deep link pre-selects them.
export function pickerUrl(branchCode?: string | null, registerId?: string | null, cashierId?: string | null): string {
  let path = "/pos";
  if (branchCode) path += `/${encodeURIComponent(branchCode)}`;
  if (branchCode && registerId) path += `/${encodeURIComponent(registerId)}`;
  return cashierId ? `${path}?cashier=${encodeURIComponent(cashierId)}` : path;
}
