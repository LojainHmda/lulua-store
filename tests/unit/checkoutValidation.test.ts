import { describe, expect, it } from "vitest";
import { validateCheckoutFields, type CheckoutFieldValues } from "../../src/data/checkoutValidation";

// Passthrough translator so assertions check the exact key, matching the
// project's existing style for testing t()-dependent pure functions.
const t = (key: string) => key;

function values(overrides: Partial<CheckoutFieldValues> = {}): CheckoutFieldValues {
  return {
    name: "Jane Doe",
    email: "jane@example.com",
    phone: "+972-50-123-4567",
    address: "123 Example Street, Ramallah",
    deliveryZoneId: "zone-1",
    ...overrides,
  };
}

describe("validateCheckoutFields", () => {
  it("returns null when every field is valid", () => {
    expect(validateCheckoutFields(values(), t)).toBeNull();
  });

  it("returns null when email is empty -- it's an optional field", () => {
    expect(validateCheckoutFields(values({ email: "" }), t)).toBeNull();
  });

  describe("name", () => {
    it("rejects an empty name", () => {
      expect(validateCheckoutFields(values({ name: "" }), t)).toEqual({ field: "name", message: "checkout.errNameTooShort" });
    });

    it("rejects a single-character name", () => {
      expect(validateCheckoutFields(values({ name: "J" }), t)).toEqual({ field: "name", message: "checkout.errNameTooShort" });
    });

    it("rejects a name that is only whitespace", () => {
      expect(validateCheckoutFields(values({ name: "   " }), t)).toEqual({ field: "name", message: "checkout.errNameTooShort" });
    });

    it("accepts exactly the 2-character minimum", () => {
      expect(validateCheckoutFields(values({ name: "Jo" }), t)).toBeNull();
    });
  });

  describe("email (optional, validated only when provided)", () => {
    it("rejects a malformed email when provided", () => {
      expect(validateCheckoutFields(values({ email: "not-an-email" }), t)).toEqual({ field: "email", message: "checkout.errEmailInvalid" });
    });

    it("rejects an email missing a domain", () => {
      expect(validateCheckoutFields(values({ email: "jane@" }), t)).toEqual({ field: "email", message: "checkout.errEmailInvalid" });
    });

    it("rejects an email with a stray space", () => {
      expect(validateCheckoutFields(values({ email: "jane doe@example.com" }), t)).toEqual({ field: "email", message: "checkout.errEmailInvalid" });
    });

    it("accepts a well-formed email, including a plus tag and multi-part domain", () => {
      expect(validateCheckoutFields(values({ email: "jane.doe+order@example.co.uk" }), t)).toBeNull();
    });
  });

  describe("phone (international-format-tolerant, no rigid digit-count rule)", () => {
    it("rejects an empty phone number", () => {
      expect(validateCheckoutFields(values({ phone: "" }), t)).toEqual({ field: "phone", message: "checkout.errPhoneInvalid" });
    });

    it("rejects a too-short phone number", () => {
      expect(validateCheckoutFields(values({ phone: "12345" }), t)).toEqual({ field: "phone", message: "checkout.errPhoneInvalid" });
    });

    it("rejects letters/symbols with no real digits", () => {
      expect(validateCheckoutFields(values({ phone: "n/a" }), t)).toEqual({ field: "phone", message: "checkout.errPhoneInvalid" });
    });

    it("accepts an international format with a country code, dashes, and a plus sign", () => {
      expect(validateCheckoutFields(values({ phone: "+972-50-123-4567" }), t)).toBeNull();
    });

    it("accepts a local format with spaces and parentheses", () => {
      expect(validateCheckoutFields(values({ phone: "(059) 123 4567" }), t)).toBeNull();
    });

    it("does not impose an exact 10-digit requirement -- a 9-digit local number is accepted", () => {
      expect(validateCheckoutFields(values({ phone: "059-123-456" }), t)).toBeNull();
    });

    it("does not impose an upper bound -- a longer international number with an extension-style suffix is accepted", () => {
      expect(validateCheckoutFields(values({ phone: "+1 (415) 555-0132" }), t)).toBeNull();
    });
  });

  describe("address", () => {
    it("rejects a too-short address", () => {
      expect(validateCheckoutFields(values({ address: "short" }), t)).toEqual({ field: "address", message: "checkout.errAddressTooShort" });
    });

    it("rejects an address that is only whitespace", () => {
      expect(validateCheckoutFields(values({ address: "        " }), t)).toEqual({ field: "address", message: "checkout.errAddressTooShort" });
    });

    it("accepts exactly the 8-character minimum", () => {
      expect(validateCheckoutFields(values({ address: "12345678" }), t)).toBeNull();
    });
  });

  describe("delivery zone (required, checked last)", () => {
    it("rejects an empty selection", () => {
      expect(validateCheckoutFields(values({ deliveryZoneId: "" }), t)).toEqual({ field: "deliveryZoneId", message: "checkout.errZoneRequired" });
    });

    it("accepts any non-empty zone id", () => {
      expect(validateCheckoutFields(values({ deliveryZoneId: "inside-48" }), t)).toBeNull();
    });
  });

  it("returns only the first failing field when multiple are invalid -- name is checked before email/phone/address/zone", () => {
    expect(validateCheckoutFields({ name: "", email: "bad", phone: "1", address: "x", deliveryZoneId: "" }, t)).toEqual({
      field: "name",
      message: "checkout.errNameTooShort",
    });
  });

  it("returns the second failing field (email) when name is valid but email/phone/address/zone are not", () => {
    expect(validateCheckoutFields({ name: "Jane Doe", email: "bad", phone: "1", address: "x", deliveryZoneId: "" }, t)).toEqual({
      field: "email",
      message: "checkout.errEmailInvalid",
    });
  });

  it("returns the third failing field (phone) when name/email are valid but phone/address/zone are not", () => {
    expect(validateCheckoutFields({ name: "Jane Doe", email: "jane@example.com", phone: "1", address: "x", deliveryZoneId: "" }, t)).toEqual({
      field: "phone",
      message: "checkout.errPhoneInvalid",
    });
  });

  it("returns the zone field last, only once name/email/phone/address are all valid", () => {
    expect(
      validateCheckoutFields({ name: "Jane Doe", email: "jane@example.com", phone: "+972-50-123-4567", address: "123 Example Street", deliveryZoneId: "" }, t)
    ).toEqual({ field: "deliveryZoneId", message: "checkout.errZoneRequired" });
  });
});
