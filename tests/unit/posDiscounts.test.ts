import { describe, expect, it } from "vitest";
import { discountNote, manualDiscount } from "../../src/admin/posDiscounts";

describe("manualDiscount", () => {
  it("works out percent and amount discounts", () => {
    expect(manualDiscount(250, "percent", 10, 10)).toEqual({ amount: 25, error: null, maxAmount: 25 });
    expect(manualDiscount(250, "amount", 20, 10)).toEqual({ amount: 20, error: null, maxAmount: 25 });
    expect(manualDiscount(99.99, "percent", 10, 100).amount).toBe(10);
  });

  it("refuses anything above the user's limit or the sale", () => {
    expect(manualDiscount(250, "percent", 11, 10).error).toBe("overLimit");
    expect(manualDiscount(250, "amount", 25.01, 10).error).toBe("overLimit");
    expect(manualDiscount(250, "amount", 300, 100).error).toBe("overTotal");
    expect(manualDiscount(250, "percent", -5, 100).error).toBe("negative");
    expect(manualDiscount(250, "percent", 11, 10).amount).toBe(0);
  });

  it("nothing entered = no discount", () => {
    expect(manualDiscount(250, "percent", null, 10)).toEqual({ amount: 0, error: null, maxAmount: 25 });
    expect(manualDiscount(250, "percent", 5, 0).error).toBe("overLimit");
  });

  it("labels percent discounts", () => {
    expect(discountNote("percent", 10)).toBe("10%");
    expect(discountNote("amount", 10)).toBe("");
  });
});
