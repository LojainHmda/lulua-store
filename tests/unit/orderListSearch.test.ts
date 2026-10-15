import { describe, expect, it } from "vitest";
import { orderMatchesListSearch } from "../../src/admin/orderListSearch";

function order(overrides: Partial<{ orderNumber: string; customerName: string; customerEmail?: string; customerPhone?: string }> = {}) {
  return {
    orderNumber: "SIS-ABC123",
    customerName: "Jane Doe",
    customerEmail: "jane@example.com",
    customerPhone: "+972-50-123-4567",
    ...overrides,
  };
}

describe("orderMatchesListSearch", () => {
  it("matches an empty query unconditionally", () => {
    expect(orderMatchesListSearch(order(), "")).toBe(true);
  });

  it("still matches by order number (regression -- must not break existing search)", () => {
    expect(orderMatchesListSearch(order(), "abc123")).toBe(true);
    expect(orderMatchesListSearch(order(), "SIS-ABC")).toBe(true);
  });

  it("still matches by customer name, case-insensitively (regression)", () => {
    expect(orderMatchesListSearch(order(), "jane")).toBe(true);
    expect(orderMatchesListSearch(order(), "DOE")).toBe(true);
  });

  it("still matches by customer email (regression)", () => {
    expect(orderMatchesListSearch(order(), "jane@example")).toBe(true);
  });

  it("does not match an unrelated word", () => {
    expect(orderMatchesListSearch(order(), "nablus")).toBe(false);
  });

  describe("phone search (new behavior)", () => {
    it("matches when the query is typed with no formatting at all", () => {
      expect(orderMatchesListSearch(order(), "0501234567")).toBe(true);
    });

    it("matches when the query includes the country code", () => {
      expect(orderMatchesListSearch(order({ customerPhone: "+972-50-123-4567" }), "972501234567")).toBe(true);
    });

    it("matches a partial phone number (substring, not exact)", () => {
      expect(orderMatchesListSearch(order(), "1234567")).toBe(true);
    });

    it("matches regardless of the stored phone's own formatting (spaces, parens, dashes)", () => {
      expect(orderMatchesListSearch(order({ customerPhone: "(050) 123 4567" }), "0501234567")).toBe(true);
    });

    it("matches a local-format query (leading 0) against a phone stored in international format (country code replaces the 0)", () => {
      // +972-50-123-4567 normalizes to 972501234567 -- a plain substring
      // check for "0501234567" fails here since the country code REPLACES
      // the leading 0 rather than prefixing it; this is the exact case
      // phoneContainsQuery()'s leading-zero-strip fallback exists for.
      expect(orderMatchesListSearch(order({ customerPhone: "+972-50-123-4567" }), "0501234567")).toBe(true);
    });

    it("does not match a phone number that isn't actually a substring", () => {
      expect(orderMatchesListSearch(order(), "9999999")).toBe(false);
    });

    it("does not false-positive a plain word query against the phone field", () => {
      // "jane" has no digits at all, so it must never accidentally match via the phone path.
      expect(orderMatchesListSearch(order({ customerPhone: "0501234567" }), "jane")).toBe(true); // matches by name, not phone
      expect(orderMatchesListSearch(order({ customerName: "Someone Else", customerEmail: "x@y.com" }), "jane")).toBe(false);
    });

    it("gracefully handles an order with no phone at all", () => {
      expect(orderMatchesListSearch(order({ customerPhone: undefined }), "0501234567")).toBe(false);
      // Non-phone fields still work normally for such an order.
      expect(orderMatchesListSearch(order({ customerPhone: undefined }), "jane")).toBe(true);
    });
  });

  it("combines with a status filter correctly when used the way OrderList.tsx uses it (search AND status, checked separately)", () => {
    // orderMatchesListSearch only covers the search half -- this test just
    // documents that an order failing search should short-circuit before
    // any status check would run, matching OrderList.tsx's filter order.
    expect(orderMatchesListSearch(order(), "no-such-order")).toBe(false);
  });
});
