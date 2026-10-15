// "Add stock" (stock receipt): new units arriving for one product, split
// across the online store and the branches, per color/size. Pure logic only
// — firebase/stockReceipt.ts does the atomic write, StockReceiptModal.tsx the UI.

import { ONLINE_LOCATION } from "./locationStock";

export { ONLINE_LOCATION };

// One color/size of the product being received. `total` and every
// allocation are kept as the raw text the admin typed, so validation can
// tell "left empty" (0) apart from "typed something invalid".
export interface ReceiptLineDraft {
  variantId: string;
  colorName: string;
  size: string;
  total: string;
  allocations: Record<string, string>; // locationId -> qty text
}

export type QtyParse = { ok: true; value: number } | { ok: false; error: "invalid" | "negative" | "fraction" | "tooLarge" };

// Products are sold as whole units: only non-negative integers are allowed.
// Empty means 0.
export const MAX_RECEIPT_QTY = 100_000;
export function parseQty(text: string): QtyParse {
  const s = text.trim();
  if (s === "") return { ok: true, value: 0 };
  if (!/^-?\d+(\.\d+)?$/.test(s)) return { ok: false, error: "invalid" };
  const n = Number(s);
  if (n < 0) return { ok: false, error: "negative" };
  if (!Number.isInteger(n)) return { ok: false, error: "fraction" };
  if (n > MAX_RECEIPT_QTY) return { ok: false, error: "tooLarge" };
  return { ok: true, value: n };
}

export interface ReceiptLineCheck {
  total: QtyParse;
  allocations: Record<string, QtyParse>;
  allocated: number;
  // total - allocated (only meaningful when every field parsed)
  remaining: number;
  valid: boolean;
}

export function checkLine(line: ReceiptLineDraft, locationIds: string[]): ReceiptLineCheck {
  const total = parseQty(line.total);
  const allocations: Record<string, QtyParse> = {};
  let allocated = 0;
  let allParsed = total.ok;
  for (const id of locationIds) {
    const p = parseQty(line.allocations[id] ?? "");
    allocations[id] = p;
    if (p.ok) allocated += p.value;
    else allParsed = false;
  }
  const totalValue = total.ok ? total.value : 0;
  const remaining = totalValue - allocated;
  return { total, allocations, allocated, remaining, valid: allParsed && remaining === 0 };
}

export interface ReceiptValidation {
  lines: ReceiptLineCheck[];
  grandTotal: number;
  allocatedByLocation: Record<string, number>;
  // Every line valid AND at least one unit is being added.
  canSave: boolean;
  problem: null | "nothing" | "invalidNumber" | "mismatch";
}

export function validateReceipt(lines: ReceiptLineDraft[], locationIds: string[]): ReceiptValidation {
  const checks = lines.map((l) => checkLine(l, locationIds));
  const allocatedByLocation: Record<string, number> = Object.fromEntries(locationIds.map((id) => [id, 0]));
  let grandTotal = 0;
  let invalidNumber = false;
  let mismatch = false;
  checks.forEach((c) => {
    if (!c.total.ok || Object.values(c.allocations).some((a) => !a.ok)) invalidNumber = true;
    else if (c.remaining !== 0) mismatch = true;
    if (c.total.ok) grandTotal += c.total.value;
    for (const id of locationIds) {
      const a = c.allocations[id];
      if (a.ok) allocatedByLocation[id] += a.value;
    }
  });
  const problem = invalidNumber ? "invalidNumber" : mismatch ? "mismatch" : grandTotal === 0 ? "nothing" : null;
  return { lines: checks, grandTotal, allocatedByLocation, canSave: problem === null, problem };
}

// What actually gets written: one entry per (location, color/size) that
// receives at least one unit. Zero allocations are dropped — adding 0 to a
// branch changes nothing and records nothing.
export interface ReceiptAllocation {
  locationId: string;
  variantId: string;
  colorName: string;
  size: string;
  qty: number;
}

export function receiptAllocations(lines: ReceiptLineDraft[], locationIds: string[]): ReceiptAllocation[] {
  const v = validateReceipt(lines, locationIds);
  if (!v.canSave) throw new Error("Receipt is not valid");
  const out: ReceiptAllocation[] = [];
  lines.forEach((l, i) => {
    for (const id of locationIds) {
      const a = v.lines[i].allocations[id];
      if (a.ok && a.value > 0) out.push({ locationId: id, variantId: l.variantId, colorName: l.colorName, size: l.size, qty: a.value });
    }
  });
  return out;
}

export function newReceiptId(): string {
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `RCV-${Date.now().toString(36).toUpperCase()}-${rand}`;
}
