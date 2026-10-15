// Mirrors the shape Catchy validates checkout contact/shipping fields with
// (name/phone/address length checks + an email regex, first failing field
// only) — but the phone rule is adapted rather than copied: real orders in
// this store already use international formats with a country code and
// dashes (e.g. "+972-50-123-4567"), so this checks digit COUNT after
// stripping formatting instead of Catchy's stricter "exactly 10 digits",
// which would reject phone numbers this store's own customers already use.
export interface CheckoutFieldValues {
  name: string;
  email: string;
  phone: string;
  address: string;
  // The selected deliveryZones/{id} id, or "" when nothing is picked yet --
  // required exactly like the other fields here, checked last so a
  // shopper who hasn't filled in their contact info yet sees that error
  // first, matching the existing top-to-bottom field order on the page.
  deliveryZoneId: string;
}

// The failing field is returned alongside its message (not just the message
// string) so the caller can focus/scroll to that exact input — Checkout.tsx
// keeps a ref per field for exactly this.
export interface CheckoutValidationError {
  field: keyof CheckoutFieldValues;
  message: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PHONE_DIGITS = 7;

// Returns the first failing field (and its translated message), or null if
// every field passes — same "first-failure-only, shown inline" shape the
// audit recommended, reusing the single error slot Checkout.tsx already
// renders (no new per-field inline error UI invented for this).
export function validateCheckoutFields(values: CheckoutFieldValues, t: (key: string) => string): CheckoutValidationError | null {
  if (values.name.trim().length < 2) return { field: "name", message: t("checkout.errNameTooShort") };
  // Email is optional — only validated (as a real email shape) when the
  // shopper actually typed something. An empty field is never a failure.
  if (values.email.trim() && !EMAIL_RE.test(values.email.trim())) return { field: "email", message: t("checkout.errEmailInvalid") };
  const phoneDigits = values.phone.replace(/\D/g, "");
  if (phoneDigits.length < MIN_PHONE_DIGITS) return { field: "phone", message: t("checkout.errPhoneInvalid") };
  if (values.address.trim().length < 8) return { field: "address", message: t("checkout.errAddressTooShort") };
  if (!values.deliveryZoneId) return { field: "deliveryZoneId", message: t("checkout.errZoneRequired") };
  return null;
}
