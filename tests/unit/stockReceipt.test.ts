import { describe, expect, it } from "vitest";
import { checkLine, parseQty, receiptAllocations, validateReceipt, type ReceiptLineDraft } from "../../src/admin/stockReceipt";

const LOCS = ["online", "A", "B", "C"];
const line = (total: string, allocations: Record<string, string>, size = "M"): ReceiptLineDraft => ({ variantId: "black-p1", colorName: "Black", size, total, allocations });

describe("parseQty", () => {
  it("accepts whole non-negative numbers, empty = 0", () => {
    expect(parseQty("")).toEqual({ ok: true, value: 0 });
    expect(parseQty(" 40 ")).toEqual({ ok: true, value: 40 });
  });
  it("rejects negatives, fractions, junk and absurd sizes", () => {
    expect(parseQty("-3")).toEqual({ ok: false, error: "negative" });
    expect(parseQty("2.5")).toEqual({ ok: false, error: "fraction" });
    expect(parseQty("1e3")).toEqual({ ok: false, error: "invalid" });
    expect(parseQty("abc")).toEqual({ ok: false, error: "invalid" });
    expect(parseQty("1000001")).toEqual({ ok: false, error: "tooLarge" });
  });
});

describe("validateReceipt", () => {
  it("accepts the 100 = 40 + 35 + 25 example", () => {
    const v = validateReceipt([line("100", { A: "40", B: "35", C: "25" })], LOCS);
    expect(v.canSave).toBe(true);
    expect(v.grandTotal).toBe(100);
    expect(v.allocatedByLocation).toEqual({ online: 0, A: 40, B: 35, C: 25 });
  });
  it("blocks under- and over-allocation", () => {
    expect(validateReceipt([line("100", { A: "40", B: "35" })], LOCS)).toMatchObject({ canSave: false, problem: "mismatch" });
    expect(validateReceipt([line("100", { A: "60", B: "60" })], LOCS)).toMatchObject({ canSave: false, problem: "mismatch" });
    expect(checkLine(line("100", { A: "60", B: "60" }), LOCS).remaining).toBe(-20);
  });
  it("blocks invalid numbers anywhere", () => {
    expect(validateReceipt([line("10", { A: "-10", B: "20" })], LOCS)).toMatchObject({ canSave: false, problem: "invalidNumber" });
    expect(validateReceipt([line("1.5", { A: "1.5" })], LOCS)).toMatchObject({ canSave: false, problem: "invalidNumber" });
  });
  it("blocks a receipt that adds nothing, allows untouched rows", () => {
    expect(validateReceipt([line("", {}), line("0", {}, "L")], LOCS)).toMatchObject({ canSave: false, problem: "nothing" });
    expect(validateReceipt([line("5", { A: "5" }), line("", {}, "L")], LOCS).canSave).toBe(true);
  });
});

describe("receiptAllocations", () => {
  it("drops zero allocations and keeps one entry per location and size", () => {
    const out = receiptAllocations([line("5", { A: "5", B: "0" }), line("3", { online: "1", C: "2" }, "L")], LOCS);
    expect(out).toEqual([
      { locationId: "A", variantId: "black-p1", colorName: "Black", size: "M", qty: 5 },
      { locationId: "online", variantId: "black-p1", colorName: "Black", size: "L", qty: 1 },
      { locationId: "C", variantId: "black-p1", colorName: "Black", size: "L", qty: 2 },
    ]);
  });
  it("refuses to produce writes for an invalid receipt", () => {
    expect(() => receiptAllocations([line("5", { A: "4" })], LOCS)).toThrow();
  });
});
