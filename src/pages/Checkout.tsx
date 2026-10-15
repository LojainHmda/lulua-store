import { useEffect, useMemo, useRef, useState, type FormEvent, type RefObject } from "react";
import { where } from "firebase/firestore";
import { Link, useNavigate } from "react-router-dom";
import { ExchangePolicyModal } from "../components/checkout/ExchangePolicyModal";
import Button from "../components/ui/Button";
import LinkButton from "../components/ui/LinkButton";
import ProductPhoto from "../components/ui/ProductPhoto";
import { useCart } from "../context/CartContext";
import { useCatalog } from "../context/CatalogContext";
import { useCustomerAuth } from "../context/CustomerAuthContext";
import { useLanguage } from "../context/LanguageContext";
import { validateCheckoutFields, type CheckoutFieldValues } from "../data/checkoutValidation";
import { resolveDeliveryFee, SHIPPING_DEFAULTS } from "../data/deliveryZones";
import { EXCHANGE_POLICY_DEFAULTS } from "../data/exchangePolicyDefaults";
import { localizedName } from "../data/localize";
import { validateCartAvailability, type CartLineIssue } from "../data/variants";
import { deliveryZonesApi } from "../firebase/collections";
import { getSingletonDoc } from "../firebase/firestore";
import { lookupDiscountCode, recordDiscountUsage, DiscountCodeError, type AppliedDiscount } from "../firebase/discountCodes";
import { placeOrder, PlaceOrderError } from "../firebase/orderTransaction";
import type { CustomerAddress, DeliveryZone, ExchangePolicySettingsDoc, PaymentSettingsDoc, ShippingSettingsDoc } from "../admin/types";
import { formatPrice } from "../utils/currency";

function stockIssueMessage(issue: CartLineIssue, t: (key: string) => string): string {
  switch (issue.type) {
    case "product_unavailable":
      return t("checkout.stockIssueProductUnavailable");
    case "checkout_unsafe":
      // Same graceful "unavailable for online purchase" copy already used
      // on the product page and product grid for this exact condition.
      return t("product.checkoutUnavailable");
    case "variant_unavailable":
      return t("checkout.stockIssueVariantUnavailable");
    case "size_unavailable":
      return t("checkout.stockIssueSizeUnavailable");
    case "out_of_stock":
      return t("checkout.stockIssueOutOfStock");
    case "insufficient_stock":
      return `${t("checkout.stockIssueInsufficientPrefix")}${issue.available}${t("checkout.stockIssueInsufficientSuffix")}`;
  }
}

const PAYMENT_DEFAULTS: PaymentSettingsDoc = {
  acceptedMethods: [],
  checkoutNote: "",
};

export default function Checkout() {
  const { lines, subtotal, clearCart, removeLine, setQty } = useCart();
  const { firebaseUser, profile, ensureGuestSession } = useCustomerAuth();
  const { lang, t } = useLanguage();
  const navigate = useNavigate();
  const catalog = useCatalog();

  // Re-checked on every render against catalog.allProducts (every active
  // product, including ones now hidden from the store because they're out
  // of stock — a cart line for one of those must still get its precise
  // "out of stock" message rather than a vague "no longer available"),
  // which is itself a
  // live onSnapshot mirror of Firestore (see CatalogContext) — so this
  // stays fresh for as long as the customer sits on this page, not just at
  // the moment it first mounted. See data/variants.ts for what's checked
  // and why this can never be the authoritative check.
  //
  // While catalog.loading is true, catalog.allProducts is still the static
  // offline fallback catalog (see CatalogContext), which doesn't contain
  // real product ids — validating against it on a fresh page load would
  // flash every real item as "no longer available" for the split second
  // before the live snapshot arrives. Submit stays disabled during that
  // window (ok: false) without showing that false alarm.
  const availability = useMemo(
    () => (catalog.loading ? { ok: false, issues: new Map() } : validateCartAvailability(lines, catalog.allProducts)),
    [lines, catalog.allProducts, catalog.loading]
  );

  const [shippingSettings, setShippingSettings] = useState<ShippingSettingsDoc>(SHIPPING_DEFAULTS);
  const [paymentSettings, setPaymentSettings] = useState<PaymentSettingsDoc>(PAYMENT_DEFAULTS);
  const [policy, setPolicy] = useState<ExchangePolicySettingsDoc>(EXCHANGE_POLICY_DEFAULTS);
  const [policyModalOpen, setPolicyModalOpen] = useState(false);
  const [policyPreviewOpen, setPolicyPreviewOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  // "new" = the free-text option; a real id = a saved address is selected.
  // Null only until the one-time default-selection effect below runs (or
  // decides there's nothing to select), same "settle once" shape as the
  // name/email/phone autofill effect right after it.
  const [selectedAddressId, setSelectedAddressId] = useState<string | "new" | null>(null);
  const [deliveryZones, setDeliveryZones] = useState<DeliveryZone[]>([]);
  // "" = nothing picked yet -- required exactly like name/phone/address (see
  // checkoutValidation.ts). Never auto-selected even when only one zone
  // exists: the customer must always make an explicit choice, matching the
  // "customer selects/provides their delivery location" requirement.
  const [selectedZoneId, setSelectedZoneId] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discountCodeInput, setDiscountCodeInput] = useState("");
  const [appliedDiscount, setAppliedDiscount] = useState<AppliedDiscount | null>(null);
  const [discountError, setDiscountError] = useState<string | null>(null);
  const [applyingDiscount, setApplyingDiscount] = useState(false);

  // One ref per validated field, keyed the same way validateCheckoutFields'
  // own CheckoutFieldValues is — lets handlePlaceOrderClick focus/scroll to
  // whichever field actually failed, instead of only showing the message.
  const nameInputRef = useRef<HTMLInputElement>(null);
  const emailInputRef = useRef<HTMLInputElement>(null);
  const phoneInputRef = useRef<HTMLInputElement>(null);
  const addressInputRef = useRef<HTMLTextAreaElement>(null);
  const deliveryZoneSelectRef = useRef<HTMLSelectElement>(null);
  const fieldRefs: Record<keyof CheckoutFieldValues, RefObject<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null>> = {
    name: nameInputRef,
    email: emailInputRef,
    phone: phoneInputRef,
    address: addressInputRef,
    deliveryZoneId: deliveryZoneSelectRef,
  };

  useEffect(() => {
    ensureGuestSession().catch(() => {});
  }, [ensureGuestSession]);

  // A code applied before the bag changed size might no longer be valid
  // (e.g. it required a minimum subtotal) — dropping it here rather than
  // silently keeping a stale discount active is the honest behavior.
  useEffect(() => {
    setAppliedDiscount(null);
  }, [subtotal]);

  async function applyDiscountCode() {
    setDiscountError(null);
    setApplyingDiscount(true);
    try {
      const result = await lookupDiscountCode(discountCodeInput, subtotal);
      setAppliedDiscount(result);
    } catch (err) {
      setAppliedDiscount(null);
      setDiscountError(err instanceof DiscountCodeError ? err.message : t("checkout.errorGeneric"));
    } finally {
      setApplyingDiscount(false);
    }
  }

  useEffect(() => {
    getSingletonDoc<ShippingSettingsDoc>("settings", "shipping").then((doc) => {
      // Merged over the defaults rather than replacing them, the same way the
      // admin Settings form loads it: a partially-written settings doc must
      // never leave a rate undefined and turn the shipping/total maths into NaN.
      const resolved = doc ? { ...SHIPPING_DEFAULTS, ...doc } : SHIPPING_DEFAULTS;
      setShippingSettings(resolved);
    });
    // Active zones only -- an inactive zone must never be offered to a
    // customer, matching how an inactive discount code is never surfaced
    // either. Sorted client-side by sortOrder: a single where() with no
    // orderBy needs no composite index, and 14 zones is cheap to sort in
    // the browser.
    deliveryZonesApi.list([where("active", "==", true)]).then((zones) => {
      setDeliveryZones([...zones].sort((a, b) => a.sortOrder - b.sortOrder));
    });
    getSingletonDoc<PaymentSettingsDoc>("settings", "payment").then((doc) => {
      if (doc) setPaymentSettings(doc);
    });
    getSingletonDoc<ExchangePolicySettingsDoc>("settings", "exchangePolicy").then((doc) => {
      if (doc) setPolicy({ ...EXCHANGE_POLICY_DEFAULTS, ...doc });
    });
  }, []);

  useEffect(() => {
    if (profile) {
      setName((n) => n || profile.name || "");
      setEmail((e) => e || profile.email || "");
      setPhone((p) => p || profile.phone || "");
    } else if (firebaseUser?.email) {
      setEmail((e) => e || firebaseUser.email || "");
    }
  }, [profile, firebaseUser]);

  // Pre-selects the default saved address (or the first one) exactly once,
  // the same "fill once, never clobber further typing" shape as the effect
  // above — a second profile update later (e.g. editing the address book in
  // another tab) won't yank the field out from under whatever's now typed.
  // profile.addresses is only ever populated for an identified customer
  // (CustomerAuthContext never builds a profile for an anonymous guest), so
  // this never fires for guest checkout.
  useEffect(() => {
    if (selectedAddressId !== null || !profile?.addresses?.length) return;
    const def = profile.addresses.find((a) => a.isDefault) ?? profile.addresses[0];
    setSelectedAddressId(def.id);
    setAddress((a) => a || def.address);
    // Restores the saved zone too, when this address has one. An address
    // saved before delivery zones existed has none -- the select simply
    // stays unset, requiring the customer to pick one before checkout can
    // proceed (see validateCheckoutFields), same as any other new address.
    setSelectedZoneId((z) => z || def.deliveryZoneId || "");
  }, [profile, selectedAddressId]);

  function selectSavedAddress(a: CustomerAddress) {
    setSelectedAddressId(a.id);
    setAddress(a.address);
    setSelectedZoneId(a.deliveryZoneId ?? "");
  }

  function selectNewAddress() {
    setSelectedAddressId("new");
    setAddress("");
  }

  const selectedZone = useMemo(() => deliveryZones.find((z) => z.id === selectedZoneId), [deliveryZones, selectedZoneId]);

  // Live preview only -- the authoritative fee is always re-derived from
  // Firestore inside placeOrder()'s own transaction (see orderTransaction.ts),
  // never trusted from this calculation. A null result (no zone selected
  // yet, or a race where the selected zone vanished) previews as 0; the
  // real submit-time validation (validateCheckoutFields, then the server)
  // is what actually blocks placing the order, not this number.
  const shipping = useMemo(() => {
    return resolveDeliveryFee(selectedZone, subtotal, shippingSettings.freeShippingThreshold) ?? 0;
  }, [subtotal, selectedZone, shippingSettings]);

  const discountAmount = appliedDiscount?.amount ?? 0;
  const total = subtotal - discountAmount + shipping;

  // Gates the actual submission behind the exchange-policy consent step —
  // see ExchangePolicyModal's own comment for why "accept" both records
  // consent and places the order in one action rather than a separate
  // second click. When the policy is turned off in admin, there's nothing
  // to show or gate on, so this falls straight through to submitOrder().
  //
  // The field-shape check happens first and applies equally to both submit
  // paths (mobile's real form submit AND the desktop button, which is
  // type="button" outside the <form> and so never triggers native
  // required/type="email"/type="tel" validation at all) — this is the one
  // place both are guaranteed to pass through.
  function handlePlaceOrderClick() {
    const fieldError = validateCheckoutFields({ name, email, phone, address, deliveryZoneId: selectedZoneId }, t);
    if (fieldError) {
      setError(fieldError.message);
      // Bring the shopper's attention straight to the field that actually
      // failed, rather than leaving them to scan the whole form for it.
      fieldRefs[fieldError.field].current?.focus();
      return;
    }
    setError(null);
    if (policy.enabled) {
      setPolicyModalOpen(true);
      return;
    }
    void submitOrder();
  }

  async function submitOrder() {
    setError(null);
    // Belt-and-suspenders: the submit buttons are already disabled while
    // availability.ok is false, this only guards a direct call/race. The
    // real authority is still the transaction in placeOrder() below.
    if (!availability.ok) {
      setError(t("checkout.stockReviewBody"));
      return;
    }
    setSubmitting(true);
    try {
      await ensureGuestSession();
      const orderResult = await placeOrder({
        lines: lines.map((l) => ({ productId: l.productId, variantId: l.variantId, size: l.size, qty: l.qty, note: l.note })),
        customerName: name.trim(),
        customerEmail: email.trim(),
        customerPhone: phone.trim() || undefined,
        shippingAddress: address.trim(),
        deliveryZoneId: selectedZoneId,
        notes: notes.trim() || undefined,
        // The actual discount amount is re-derived server-side from this id
        // (see orderTransaction.ts) — discountAmount here is only ever used
        // for this page's own live price preview, never sent as-is.
        discountId: appliedDiscount?.id,
        // Always sent for the web flow, whether the customer explicitly
        // accepted via the modal or the policy is currently disabled in
        // admin (see handlePlaceOrderClick) — placeOrder()/Firestore rules
        // require this field to exist on every web order regardless.
        policyConsent: { policyVersion: policy.version, lang },
      });
      if (appliedDiscount) recordDiscountUsage(appliedDiscount.id);
      clearCart();
      setPolicyModalOpen(false);
      // The thank-you screen is a real route now (/checkout/confirmation/:orderId)
      // instead of local `result` state, so reloading or navigating back no
      // longer wipes the order number. `replace` keeps the back button from
      // dropping the shopper into a now-empty checkout form.
      navigate(`/checkout/confirmation/${orderResult.orderId}?number=${encodeURIComponent(orderResult.orderNumber)}`, {
        replace: true,
      });
    } catch (err) {
      setError(err instanceof PlaceOrderError ? err.message : t("checkout.errorGeneric"));
    } finally {
      setSubmitting(false);
    }
  }

  if (lines.length === 0) {
    return (
      <div className="container-page flex min-h-[60vh] flex-col items-center justify-center gap-4 py-20 text-center">
        <h1 className="font-display text-2xl font-bold">{t("checkout.emptyCart")}</h1>
        <p className="text-base text-ink-soft">{t("checkout.emptyCartSub")}</p>
        <LinkButton to="/shop" variant="primary">
          {t("checkout.backToShop")}
        </LinkButton>
      </div>
    );
  }

  return (
    <div className="container-page py-12 md:py-16">
      <h1 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">{t("checkout.title")}</h1>

      <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-3">
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            handlePlaceOrderClick();
          }}
          className="flex flex-col gap-6 lg:col-span-2"
        >
          <div className="rounded-2xl bg-paper p-6 shadow-soft">
            <h2 className="mb-4 font-display text-lg font-bold text-ink">{t("checkout.contactInfo")}</h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5 sm:col-span-2">
                <span className="text-sm font-semibold text-ink">{t("checkout.fullName")}</span>
                <input
                  ref={nameInputRef}
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="rounded-xl border border-line bg-paper px-4 py-3 text-base outline-none focus:border-wine"
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-semibold text-ink">{t("checkout.email")}</span>
                <input
                  ref={emailInputRef}
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="rounded-xl border border-line bg-paper px-4 py-3 text-base outline-none focus:border-wine"
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-semibold text-ink">{t("checkout.phone")}</span>
                <input
                  ref={phoneInputRef}
                  required
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className="rounded-xl border border-line bg-paper px-4 py-3 text-base outline-none focus:border-wine"
                />
              </label>
            </div>
          </div>

          <div className="rounded-2xl bg-paper p-6 shadow-soft">
            <h2 className="mb-4 font-display text-lg font-bold text-ink">{t("checkout.shippingAddressTitle")}</h2>

            {!!profile?.addresses?.length && (
              <div className="mb-4 flex flex-col gap-2.5">
                <h3 className="text-sm font-semibold text-ink">{t("checkout.savedAddresses")}</h3>
                {profile.addresses.map((a) => (
                  <label
                    key={a.id}
                    className="flex cursor-pointer items-start gap-3 rounded-xl border border-line px-4 py-3 has-[:checked]:border-wine"
                  >
                    <input
                      type="radio"
                      name="savedAddress"
                      checked={selectedAddressId === a.id}
                      onChange={() => selectSavedAddress(a)}
                      className="mt-1 accent-wine"
                    />
                    <span className="flex-1 text-sm">
                      {a.isDefault && (
                        <span className="mb-1 inline-block rounded-full bg-sand px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-wine-dark">
                          {t("account.defaultAddress")}
                        </span>
                      )}
                      <span className="block whitespace-pre-line text-ink">{a.address}</span>
                    </span>
                  </label>
                ))}
                <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-line px-4 py-3 has-[:checked]:border-wine">
                  <input
                    type="radio"
                    name="savedAddress"
                    checked={selectedAddressId === "new"}
                    onChange={selectNewAddress}
                    className="accent-wine"
                  />
                  <span className="text-sm font-semibold text-ink">{t("checkout.useNewAddress")}</span>
                </label>
              </div>
            )}

            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-semibold text-ink">{t("checkout.address")}</span>
              <textarea
                ref={addressInputRef}
                required
                rows={3}
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder={t("checkout.addressPlaceholder")}
                className="rounded-xl border border-line bg-paper px-4 py-3 text-base outline-none placeholder:text-ink-faint focus:border-wine"
              />
            </label>

            <label className="mt-5 flex flex-col gap-1.5">
              <span className="text-sm font-semibold text-ink">{t("checkout.deliveryZone")}</span>
              {deliveryZones.length === 0 ? (
                // Nothing configured yet — say so honestly instead of
                // presenting a dropdown with nothing real in it.
                <p className="rounded-xl bg-cream-dim px-4 py-3.5 text-sm text-ink-soft">{t("checkout.noDeliveryZones")}</p>
              ) : (
                <select
                  ref={deliveryZoneSelectRef}
                  required
                  value={selectedZoneId}
                  onChange={(e) => setSelectedZoneId(e.target.value)}
                  className="rounded-xl border border-line bg-paper px-4 py-3 text-base outline-none focus:border-wine"
                >
                  <option value="" disabled>
                    {t("checkout.deliveryZonePlaceholder")}
                  </option>
                  {deliveryZones.map((zone) => (
                    <option key={zone.id} value={zone.id}>
                      {localizedName(zone.name, zone.nameAr, lang)} — {formatPrice(zone.fee)}
                    </option>
                  ))}
                </select>
              )}
            </label>

            <label className="mt-5 flex flex-col gap-1.5">
              <span className="text-sm font-semibold text-ink">{t("checkout.notes")}</span>
              <textarea
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={t("checkout.notesPlaceholder")}
                className="rounded-xl border border-line bg-paper px-4 py-3 text-base outline-none placeholder:text-ink-faint focus:border-wine"
              />
            </label>
          </div>

          {error && <p className="rounded-lg bg-wine-light px-3.5 py-2.5 text-sm font-semibold text-wine">{error}</p>}

          <button
            type="button"
            onClick={() => setPolicyPreviewOpen(true)}
            className="self-start text-xs font-semibold text-wine underline-offset-2 hover:underline"
          >
            {t("checkout.exchangePolicyReadLink")}
          </button>

          <Button
            type="submit"
            variant="primary"
            size="lg"
            disabled={submitting || !availability.ok}
            className="lg:hidden"
          >
            {submitting ? t("checkout.placingOrder") : `${t("checkout.placeOrder")} — ${formatPrice(total)}`}
          </Button>
        </form>

        <div className="h-fit rounded-2xl bg-paper p-6 shadow-soft">
          <h2 className="mb-4 font-display text-lg font-bold text-ink">{t("checkout.orderSummary")}</h2>

          {!availability.ok && (
            <div className="mb-4 rounded-xl bg-wine-light px-3.5 py-2.5 text-sm">
              <p className="font-semibold text-wine">{t("checkout.stockReviewTitle")}</p>
              <p className="mt-0.5 text-wine">{t("checkout.stockReviewBody")}</p>
            </div>
          )}

          <ul className="flex flex-col gap-4">
            {lines.map((line) => {
              const issue = availability.issues.get(line.key);
              return (
                <li key={line.key} className="flex flex-col gap-2">
                  <div className="flex gap-3">
                    <ProductPhoto
                      imageId={line.imageId ?? ""}
                      imageUrl={line.imageUrl}
                      alt={line.name}
                      width={160}
                      aspect={{ w: 1, h: 1 }}
                      className="h-16 w-16 shrink-0 rounded-lg"
                    />
                    <div className="flex flex-1 flex-col">
                      <Link to={`/product/${line.slug}`} className="text-sm font-semibold text-ink hover:text-wine">
                        {line.name}
                      </Link>
                      <p className="text-xs text-ink-faint">
                        {line.color} · {line.size} · ×{line.qty}
                      </p>
                    </div>
                    <span className="whitespace-nowrap text-sm font-semibold text-ink">{formatPrice(line.price * line.qty)}</span>
                  </div>
                  {issue && (
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-wine-light px-3 py-2 text-xs">
                      <span className="font-semibold text-wine">{stockIssueMessage(issue, t)}</span>
                      <div className="flex gap-3">
                        {issue.type === "insufficient_stock" && (
                          <button
                            type="button"
                            onClick={() => setQty(line.key, issue.available)}
                            className="font-semibold text-wine underline-offset-2 hover:underline"
                          >
                            {t("checkout.stockIssueUpdateQuantity")}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => removeLine(line.key)}
                          className="font-semibold text-wine underline-offset-2 hover:underline"
                        >
                          {t("cart.remove")}
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>

          <div className="mt-5 border-t border-line pt-4">
            {appliedDiscount ? (
              <div className="flex items-center justify-between gap-2 rounded-xl bg-wine-light px-3.5 py-2.5 text-sm">
                <span className="font-semibold text-wine">
                  {t("checkout.discountApplied")} <span className="font-mono">{appliedDiscount.code}</span>
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setAppliedDiscount(null);
                    setDiscountCodeInput("");
                  }}
                  className="text-xs font-semibold text-wine underline-offset-2 hover:underline"
                >
                  {t("checkout.removeDiscount")}
                </button>
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                <div className="flex gap-2">
                  <input
                    value={discountCodeInput}
                    onChange={(e) => setDiscountCodeInput(e.target.value.toUpperCase())}
                    placeholder={t("checkout.discountCodePlaceholder")}
                    className="min-w-0 flex-1 rounded-xl border border-line bg-paper px-3.5 py-2.5 text-sm uppercase outline-none focus:border-wine"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={applyingDiscount || !discountCodeInput.trim()}
                    onClick={() => void applyDiscountCode()}
                  >
                    {applyingDiscount ? t("checkout.applyingDiscount") : t("checkout.applyDiscount")}
                  </Button>
                </div>
                {discountError && <p className="text-xs font-semibold text-wine">{discountError}</p>}
              </div>
            )}
          </div>

          <div className="mt-4 flex flex-col gap-1.5 border-t border-line pt-4 text-sm">
            <div className="flex justify-between text-ink-soft">
              <span>{t("cart.subtotal")}</span>
              <span>{formatPrice(subtotal)}</span>
            </div>
            {discountAmount > 0 && (
              <div className="flex justify-between text-wine">
                <span>{t("checkout.discountLabel")}</span>
                <span>-{formatPrice(discountAmount)}</span>
              </div>
            )}
            <div className="flex justify-between text-ink-soft">
              <span>{t("account.shippingCost")}</span>
              <span>{shipping === 0 ? t("checkout.free") : formatPrice(shipping)}</span>
            </div>
            <div className="mt-1 flex justify-between border-t border-line pt-2 font-display text-lg font-bold text-ink">
              <span>{t("account.orderTotal")}</span>
              <span>{formatPrice(total)}</span>
            </div>
          </div>

          <div className="mt-5 hidden lg:block">
            <Button
              type="button"
              variant="primary"
              size="lg"
              fullWidth
              disabled={submitting || !availability.ok}
              onClick={handlePlaceOrderClick}
            >
              {submitting ? t("checkout.placingOrder") : t("checkout.placeOrder")}
            </Button>
          </div>

          {paymentSettings.acceptedMethods.length > 0 && (
            <div className="mt-5 flex flex-wrap gap-2 border-t border-line pt-4">
              {paymentSettings.acceptedMethods.map((m) => (
                <span key={m} className="rounded-full bg-cream-dim px-3 py-1 text-xs font-semibold text-ink-soft">
                  {m}
                </span>
              ))}
            </div>
          )}
          {paymentSettings.checkoutNote && <p className="mt-3 text-xs text-ink-faint">{paymentSettings.checkoutNote}</p>}
        </div>
      </div>

      <ExchangePolicyModal
        open={policyModalOpen}
        policy={policy}
        submitting={submitting}
        error={error}
        onAccept={() => void submitOrder()}
        onClose={() => {
          if (submitting) return;
          setPolicyModalOpen(false);
        }}
      />
      <ExchangePolicyModal open={policyPreviewOpen} policy={policy} onClose={() => setPolicyPreviewOpen(false)} />
    </div>
  );
}
