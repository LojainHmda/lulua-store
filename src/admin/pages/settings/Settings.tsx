import { useEffect, useState } from "react";
import { Link, NavLink, useParams } from "react-router-dom";
import { COLOR_THEMES, CUSTOM_COLOR_THEME, DEFAULT_COLOR_THEME, getColorTheme, isValidHexColor } from "../../../data/colorThemes";
import { SHIPPING_DEFAULTS } from "../../../data/deliveryZones";
import { useLanguage } from "../../../context/LanguageContext";
import { getSingletonDoc, setSingletonDoc } from "../../../firebase/firestore";
import { useAdminAuth } from "../../AdminAuthContext";
import AdminIcon from "../../components/AdminIcons";
import { useToast } from "../../components/ToastContext";
import { AdminButton, AdminInput, AdminNumberInput, AdminSelect, AdminTextarea, Card, Field, PageHeader, PageLoading, Toggle } from "../../components/ui";
import { logActivity } from "../../logActivity";
import { SETTINGS_TABS } from "../../navConfig";
import { EXCHANGE_POLICY_DEFAULTS } from "../../../data/exchangePolicyDefaults";
import type {
  AppearanceSettingsDoc,
  ContactSettingsDoc,
  ExchangePolicySettingsDoc,
  GeneralSettingsDoc,
  LanguageSettingsDoc,
  PaymentSettingsDoc,
  SearchSettingsDoc,
  SeoSettingsDoc,
  ShippingSettingsDoc,
} from "../../types";

const DEFAULTS = {
  general: { siteName: "لؤلؤة", tagline: "Designed for movement, made from better materials.", currency: "ILS", maintenanceMode: false } as GeneralSettingsDoc,
  appearance: { colorTheme: DEFAULT_COLOR_THEME, fontDisplay: "Archivo", fontSans: "Inter", defaultTheme: "system", allowUserThemeOverride: true } as AppearanceSettingsDoc,
  language: { defaultLanguage: "en", arabicEnabled: true } as LanguageSettingsDoc,
  seo: { metaTitle: "لؤلؤة — Contemporary Women's Fashion", metaDescription: "Dresses, tailoring, and matching sets designed with real fabrics.", robotsIndex: true } as SeoSettingsDoc,
  contact: { email: "", phone: "", address: "" } as ContactSettingsDoc,
  // Shared with the checkout transaction (src/data/shippingDefaults.ts) so the
  // rates this form falls back to are literally the ones checkout charges.
  shipping: SHIPPING_DEFAULTS,
  shippingPayment: { acceptedMethods: ["Cash on delivery", "Bank transfer"], checkoutNote: "Payment is collected on delivery — we'll confirm the details with you by email after you order." } as PaymentSettingsDoc,
  search: { availableTagFilters: ["new", "bestseller", "sale", "limited"], synonyms: {} } as SearchSettingsDoc,
  exchangePolicy: EXCHANGE_POLICY_DEFAULTS,
};

export default function Settings() {
  const { tab = "general" } = useParams();
  const { t } = useLanguage();
  return (
    <div>
      <PageHeader title={t("admin.settings.pageTitle")} description={t("admin.settings.pageDescription")} />
      <div className="flex flex-col gap-6 lg:flex-row">
        <nav className="flex shrink-0 gap-1 overflow-x-auto lg:w-56 lg:flex-col lg:overflow-visible">
          {SETTINGS_TABS.map((tabItem) => (
            <NavLink
              key={tabItem.path}
              to={`/admin/settings/${tabItem.path}`}
              className={({ isActive }) =>
                `whitespace-nowrap rounded-lg px-3 py-2.5 text-sm font-semibold transition-colors ${isActive ? "bg-wine text-on-accent" : "text-ink-soft hover:bg-cream-dim hover:text-ink"}`
              }
            >
              {t(tabItem.labelKey)}
            </NavLink>
          ))}
        </nav>
        <div className="min-w-0 flex-1">
          {tab === "general" && <GeneralTab />}
          {tab === "appearance" && <AppearanceTab />}
          {tab === "language" && <LanguageTab />}
          {tab === "seo" && <SeoTab />}
          {tab === "contact" && <ContactTab />}
          {tab === "shipping" && <ShippingTab />}
          {tab === "search" && <SearchTab />}
          {tab === "exchangePolicy" && <ExchangePolicyTab />}
        </div>
      </div>
    </div>
  );
}

function useSettingsDoc<T extends object>(docId: string, fallback: T) {
  const [value, setValue] = useState<T>(fallback);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    getSingletonDoc<T>("settings", docId).then((doc) => {
      if (!active) return;
      if (doc) setValue({ ...fallback, ...doc });
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [docId]);

  return { value, setValue, loading };
}

function SaveBar({ onSave, saving, disabled }: { onSave: () => void; saving: boolean; disabled?: boolean }) {
  const { hasRole } = useAdminAuth();
  const { t } = useLanguage();
  if (!hasRole(["owner", "admin"])) return null;
  return (
    <AdminButton variant="primary" loading={saving} disabled={disabled} onClick={onSave} className="mt-5">
      {t("admin.settings.save")}
    </AdminButton>
  );
}

function GeneralTab() {
  const toast = useToast();
  const { profile } = useAdminAuth();
  const { t } = useLanguage();
  const { value, setValue, loading } = useSettingsDoc<GeneralSettingsDoc>("general", DEFAULTS.general);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    await setSingletonDoc("settings", "general", value);
    if (profile) await logActivity(profile, "settings.generalUpdated", "");
    toast.success(t("admin.settings.saved"));
    setSaving(false);
  }

  if (loading) return <PageLoading />;
  return (
    <Card className="p-5">
      <h2 className="mb-4 font-display text-base font-bold text-ink">{t("admin.settings.generalTitle")}</h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={t("admin.settings.siteName")}>
          <AdminInput value={value.siteName} onChange={(e) => setValue({ ...value, siteName: e.target.value })} />
        </Field>
        <Field label={t("admin.settings.currency")}>
          <AdminInput value={value.currency} onChange={(e) => setValue({ ...value, currency: e.target.value })} />
        </Field>
      </div>
      <div className="mt-4">
        <Field label={t("admin.settings.tagline")}>
          <AdminInput value={value.tagline} onChange={(e) => setValue({ ...value, tagline: e.target.value })} />
        </Field>
      </div>
      <label className="mt-4 flex items-center justify-between rounded-lg border border-line px-3.5 py-2.5">
        <div>
          <p className="text-sm font-semibold text-ink">{t("admin.settings.maintenanceMode")}</p>
          <p className="text-xs text-ink-faint">{t("admin.settings.maintenanceModeHint")}</p>
        </div>
        <Toggle checked={value.maintenanceMode} onChange={(v) => setValue({ ...value, maintenanceMode: v })} />
      </label>
      <SaveBar onSave={save} saving={saving} />
    </Card>
  );
}

function AppearanceTab() {
  const toast = useToast();
  const { profile } = useAdminAuth();
  const { t, lang } = useLanguage();
  const { value, setValue, loading } = useSettingsDoc<AppearanceSettingsDoc>("appearance", DEFAULTS.appearance);
  const [saving, setSaving] = useState(false);
  const [applyingTheme, setApplyingTheme] = useState<string | null>(null);
  const [customDraft, setCustomDraft] = useState("#6e1e36");

  // Seed the picker's draft once the real saved value has loaded, so it
  // starts on whatever custom color (or current preset) is already active
  // instead of always resetting to the wine default.
  useEffect(() => {
    if (!loading) setCustomDraft(value.customColor && isValidHexColor(value.customColor) ? value.customColor : getColorTheme(value.colorTheme).light.wine);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  async function save() {
    setSaving(true);
    await setSingletonDoc("settings", "appearance", value);
    if (profile) await logActivity(profile, "settings.appearanceUpdated", "");
    toast.success(t("admin.settings.saved"));
    setSaving(false);
  }

  // Color theme applies immediately on click, separate from the rest of
  // this tab's deferred Save changes button — picking a color and seeing
  // it take effect right away is the whole point of "an easy way to
  // switch between them."
  async function selectColorTheme(key: string) {
    setApplyingTheme(key);
    const next = { ...value, colorTheme: key };
    setValue(next);
    try {
      await setSingletonDoc("settings", "appearance", next);
      const themeName = lang === "ar" ? getColorTheme(key).labelAr : getColorTheme(key).label;
      if (profile) await logActivity(profile, "settings.colorThemeChanged", themeName);
      toast.success(key === DEFAULT_COLOR_THEME ? t("admin.settings.themeRestored") : `${t("admin.settings.themeSwitchedTo")} ${themeName}`);
    } finally {
      setApplyingTheme(null);
    }
  }

  async function selectCustomColor(hex: string) {
    if (!isValidHexColor(hex)) return;
    setApplyingTheme(CUSTOM_COLOR_THEME);
    const next = { ...value, colorTheme: CUSTOM_COLOR_THEME, customColor: hex };
    setValue(next);
    try {
      await setSingletonDoc("settings", "appearance", next);
      if (profile) await logActivity(profile, "settings.colorThemeChanged", `${t("admin.settings.customColor")} (${hex})`);
      toast.success(`${t("admin.settings.themeSwitchedTo")} ${t("admin.settings.customColor")}`);
    } finally {
      setApplyingTheme(null);
    }
  }

  if (loading) return <PageLoading />;
  const customActive = value.colorTheme === CUSTOM_COLOR_THEME;
  return (
    <>
      <Card className="p-5">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="font-display text-base font-bold text-ink">{t("admin.settings.colorThemeTitle")}</h2>
          {value.colorTheme !== DEFAULT_COLOR_THEME && (
            <button
              onClick={() => selectColorTheme(DEFAULT_COLOR_THEME)}
              className="text-sm font-semibold text-wine hover:underline"
            >
              {t("admin.settings.resetToOriginal")}
            </button>
          )}
        </div>
        <p className="mb-4 text-sm text-ink-soft">{t("admin.settings.colorThemeHint")}</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {COLOR_THEMES.map((theme) => {
            const active = (value.colorTheme || DEFAULT_COLOR_THEME) === theme.key;
            return (
              <button
                key={theme.key}
                onClick={() => selectColorTheme(theme.key)}
                disabled={applyingTheme !== null}
                className={`flex flex-col items-center gap-2 rounded-xl border p-3.5 transition-colors disabled:cursor-wait ${
                  active ? "border-ink" : "border-line hover:border-ink-faint"
                }`}
                style={{ borderColor: active ? theme.light.wine : undefined }}
              >
                <span className="relative flex h-10 w-10 items-center justify-center rounded-full" style={{ backgroundColor: theme.light.wine }}>
                  {active && (
                    <svg className="h-5 w-5 text-paper" viewBox="0 0 20 20" fill="none">
                      <path d="M4 10l4 4 8-8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                  {applyingTheme === theme.key && !active && (
                    <span className="absolute inset-0 flex items-center justify-center rounded-full bg-ink/20">
                      <span className="h-4 w-4 animate-spin rounded-full border-2 border-paper border-t-transparent" />
                    </span>
                  )}
                </span>
                <span className="text-xs font-semibold text-ink">{lang === "ar" ? theme.labelAr : theme.label}</span>
              </button>
            );
          })}
        </div>

        <div className="mt-5 border-t border-line pt-4">
          <p className="mb-1 text-sm font-semibold text-ink">{t("admin.settings.customColor")}</p>
          <p className="mb-3 text-sm text-ink-soft">{t("admin.settings.customColorHint")}</p>
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="color"
              value={isValidHexColor(customDraft) ? customDraft : "#6e1e36"}
              onChange={(e) => setCustomDraft(e.target.value)}
              disabled={applyingTheme !== null}
              className="h-11 w-11 shrink-0 cursor-pointer rounded-lg border border-line bg-paper p-1 disabled:cursor-wait"
              aria-label={t("admin.settings.customColor")}
            />
            <AdminInput
              value={customDraft}
              onChange={(e) => {
                let v = e.target.value.trim();
                if (v && !v.startsWith("#")) v = "#" + v;
                setCustomDraft(v.slice(0, 7));
              }}
              placeholder="#RRGGBB"
              maxLength={7}
              className="w-32 font-mono uppercase"
            />
            <AdminButton
              variant="primary"
              size="sm"
              disabled={!isValidHexColor(customDraft) || applyingTheme !== null}
              loading={applyingTheme === CUSTOM_COLOR_THEME}
              onClick={() => selectCustomColor(customDraft)}
            >
              {t("admin.settings.applyCustomColor")}
            </AdminButton>
            {customActive && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-wine-light px-3 py-1 text-xs font-bold text-wine">
                <AdminIcon name="check" className="h-3.5 w-3.5" />
                {t("admin.settings.currentlyActive")}
              </span>
            )}
          </div>
        </div>
      </Card>

      <Card className="mt-6 p-5">
        <h2 className="mb-4 font-display text-base font-bold text-ink">{t("admin.settings.darkModeTitle")}</h2>
        <Field label={t("admin.settings.defaultThemeLabel")}>
          <AdminSelect value={value.defaultTheme} onChange={(e) => setValue({ ...value, defaultTheme: e.target.value as AppearanceSettingsDoc["defaultTheme"] })}>
            <option value="system">{t("admin.settings.systemOption")}</option>
            <option value="light">{t("admin.settings.lightOption")}</option>
            <option value="dark">{t("admin.settings.darkOption")}</option>
          </AdminSelect>
        </Field>
        <label className="mt-3 flex items-center justify-between rounded-lg border border-line px-3.5 py-2.5">
          <span className="text-sm font-semibold text-ink">{t("admin.settings.allowOverride")}</span>
          <Toggle checked={value.allowUserThemeOverride} onChange={(v) => setValue({ ...value, allowUserThemeOverride: v })} />
        </label>
        <SaveBar onSave={save} saving={saving} />
      </Card>
    </>
  );
}

function LanguageTab() {
  const toast = useToast();
  const { profile } = useAdminAuth();
  const { t } = useLanguage();
  const { value, setValue, loading } = useSettingsDoc<LanguageSettingsDoc>("language", DEFAULTS.language);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    await setSingletonDoc("settings", "language", value);
    if (profile) await logActivity(profile, "settings.languageUpdated", "");
    toast.success(t("admin.settings.saved"));
    setSaving(false);
  }

  if (loading) return <PageLoading />;
  return (
    <Card className="p-5">
      <h2 className="mb-4 font-display text-base font-bold text-ink">{t("admin.settings.languageTitle")}</h2>
      <Field label={t("admin.settings.defaultLanguageLabel")}>
        <AdminSelect value={value.defaultLanguage} onChange={(e) => setValue({ ...value, defaultLanguage: e.target.value as "en" | "ar" })}>
          <option value="en">{t("admin.settings.englishOption")}</option>
          <option value="ar">{t("admin.settings.arabicOption")}</option>
        </AdminSelect>
      </Field>
      <label className="mt-4 flex items-center justify-between rounded-lg border border-line px-3.5 py-2.5">
        <div>
          <p className="text-sm font-semibold text-ink">{t("admin.settings.arabicEnabled")}</p>
          <p className="text-xs text-ink-faint">{t("admin.settings.arabicEnabledHint")}</p>
        </div>
        <Toggle checked={value.arabicEnabled} onChange={(v) => setValue({ ...value, arabicEnabled: v })} />
      </label>
      <SaveBar onSave={save} saving={saving} />
    </Card>
  );
}

function SeoTab() {
  const toast = useToast();
  const { profile } = useAdminAuth();
  const { t } = useLanguage();
  const { value, setValue, loading } = useSettingsDoc<SeoSettingsDoc>("seo", DEFAULTS.seo);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    await setSingletonDoc("settings", "seo", value);
    if (profile) await logActivity(profile, "settings.seoUpdated", "");
    toast.success(t("admin.settings.saved"));
    setSaving(false);
  }

  if (loading) return <PageLoading />;
  return (
    <Card className="p-5">
      <h2 className="mb-4 font-display text-base font-bold text-ink">{t("admin.settings.seoTitle")}</h2>
      <Field label={t("admin.settings.metaTitle")}>
        <AdminInput value={value.metaTitle} onChange={(e) => setValue({ ...value, metaTitle: e.target.value })} />
      </Field>
      <div className="mt-4">
        <Field label={t("admin.settings.metaDescription")}>
          <AdminTextarea rows={3} value={value.metaDescription} onChange={(e) => setValue({ ...value, metaDescription: e.target.value })} />
        </Field>
      </div>
      <div className="mt-4">
        <Field label={t("admin.settings.keywords")} hint={t("admin.settings.keywordsHint")}>
          <AdminInput value={value.keywords ?? ""} onChange={(e) => setValue({ ...value, keywords: e.target.value })} />
        </Field>
      </div>
      <label className="mt-4 flex items-center justify-between rounded-lg border border-line px-3.5 py-2.5">
        <span className="text-sm font-semibold text-ink">{t("admin.settings.robotsIndex")}</span>
        <Toggle checked={value.robotsIndex} onChange={(v) => setValue({ ...value, robotsIndex: v })} />
      </label>
      <SaveBar onSave={save} saving={saving} />
    </Card>
  );
}

function ContactTab() {
  const toast = useToast();
  const { profile } = useAdminAuth();
  const { t } = useLanguage();
  const { value, setValue, loading } = useSettingsDoc<ContactSettingsDoc>("contact", { email: "", phone: "", address: "" });
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    await setSingletonDoc("settings", "contact", value);
    if (profile) await logActivity(profile, "settings.contactUpdated", "");
    toast.success(t("admin.settings.saved"));
    setSaving(false);
  }

  if (loading) return <PageLoading />;
  return (
    <Card className="p-5">
      <h2 className="mb-4 font-display text-base font-bold text-ink">{t("admin.settings.contactTitle")}</h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={t("admin.settings.supportEmail")}>
          <AdminInput type="email" value={value.email} onChange={(e) => setValue({ ...value, email: e.target.value })} />
        </Field>
        <Field label={t("admin.settings.phone")}>
          <AdminInput value={value.phone} onChange={(e) => setValue({ ...value, phone: e.target.value })} />
        </Field>
      </div>
      <div className="mt-4">
        <Field label={t("admin.settings.address")}>
          <AdminInput value={value.address} onChange={(e) => setValue({ ...value, address: e.target.value })} />
        </Field>
      </div>
      <div className="mt-5 grid grid-cols-1 gap-4 border-t border-line pt-5 sm:grid-cols-2">
        <Field label="Instagram">
          <AdminInput value={value.instagram ?? ""} onChange={(e) => setValue({ ...value, instagram: e.target.value })} placeholder="https://instagram.com/..." />
        </Field>
        <Field label="TikTok">
          <AdminInput value={value.tiktok ?? ""} onChange={(e) => setValue({ ...value, tiktok: e.target.value })} placeholder="https://tiktok.com/@..." />
        </Field>
        <Field label="Pinterest">
          <AdminInput value={value.pinterest ?? ""} onChange={(e) => setValue({ ...value, pinterest: e.target.value })} placeholder="https://pinterest.com/..." />
        </Field>
        <Field label="Facebook">
          <AdminInput value={value.facebook ?? ""} onChange={(e) => setValue({ ...value, facebook: e.target.value })} placeholder="https://facebook.com/..." />
        </Field>
      </div>
      <SaveBar onSave={save} saving={saving} />
    </Card>
  );
}

function ShippingTab() {
  const toast = useToast();
  const { profile } = useAdminAuth();
  const { t } = useLanguage();
  const shipping = useSettingsDoc<ShippingSettingsDoc>("shipping", DEFAULTS.shipping);
  const payment = useSettingsDoc<PaymentSettingsDoc>("payment", DEFAULTS.shippingPayment);
  const [saving, setSaving] = useState(false);

  // Same "min={0} is only a browser hint" reasoning as OpenRegister.tsx's
  // negative-cash guard — a negative or non-finite threshold here isn't just
  // cosmetically wrong: firestore.rules' isValidShippingForOrder
  // independently requires it to make sense, so a bad save here would make
  // every free-shipping determination behave unexpectedly until someone
  // notices and fixes the setting (audit finding B2 — the per-zone rate
  // itself is now validated on the Delivery Zones page instead).
  function isInvalidRate(n: number) {
    return !Number.isFinite(n) || n < 0;
  }
  const invalidThreshold = isInvalidRate(shipping.value.freeShippingThreshold);
  const hasInvalidShipping = invalidThreshold;

  async function save() {
    if (hasInvalidShipping) return;
    setSaving(true);
    await Promise.all([setSingletonDoc("settings", "shipping", shipping.value), setSingletonDoc("settings", "payment", payment.value)]);
    if (profile) await logActivity(profile, "settings.shippingPaymentUpdated", "");
    toast.success(t("admin.settings.saved"));
    setSaving(false);
  }

  if (shipping.loading || payment.loading) return <PageLoading />;
  return (
    <div className="flex flex-col gap-6">
      <Card className="p-5">
        <h2 className="mb-4 font-display text-base font-bold text-ink">{t("admin.settings.shippingTitle")}</h2>
        <p className="mb-4 text-sm text-ink-soft">
          {t("admin.settings.deliveryZonesMovedHint")}{" "}
          <Link to="/admin/delivery-zones" className="font-semibold text-wine hover:underline">
            {t("admin.nav.deliveryZones")}
          </Link>
          .
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            label={t("admin.settings.freeShippingThreshold")}
            hint={t("admin.settings.freeShippingThresholdHint")}
            error={invalidThreshold ? t("admin.settings.invalidShippingValue") : undefined}
          >
            <AdminNumberInput
              min={0}
              value={shipping.value.freeShippingThreshold}
              onChange={(v) => v !== null && shipping.setValue({ ...shipping.value, freeShippingThreshold: v })}
            />
          </Field>
          <Field label={t("admin.settings.returnWindow")}>
            <AdminNumberInput
              min={0}
              integerOnly
              value={shipping.value.returnWindowDays}
              onChange={(v) => v !== null && shipping.setValue({ ...shipping.value, returnWindowDays: v })}
            />
          </Field>
        </div>
      </Card>

      <Card className="p-5">
        <h2 className="mb-4 font-display text-base font-bold text-ink">{t("admin.settings.paymentTitle")}</h2>
        <Field label={t("admin.settings.acceptedMethods")} hint={t("admin.settings.acceptedMethodsHint")}>
          <AdminInput
            value={payment.value.acceptedMethods.join(", ")}
            onChange={(e) => payment.setValue({ ...payment.value, acceptedMethods: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
          />
        </Field>
        <div className="mt-4">
          <Field label={t("admin.settings.checkoutNote")}>
            <AdminTextarea rows={2} value={payment.value.checkoutNote} onChange={(e) => payment.setValue({ ...payment.value, checkoutNote: e.target.value })} />
          </Field>
        </div>
      </Card>

      <SaveBar onSave={save} saving={saving} disabled={hasInvalidShipping} />
    </div>
  );
}

function SearchTab() {
  const toast = useToast();
  const { profile } = useAdminAuth();
  const { t } = useLanguage();
  const { value, setValue, loading } = useSettingsDoc<SearchSettingsDoc>("search", DEFAULTS.search);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    await setSingletonDoc("settings", "search", value);
    if (profile) await logActivity(profile, "settings.searchUpdated", "");
    toast.success(t("admin.settings.saved"));
    setSaving(false);
  }

  if (loading) return <PageLoading />;
  return (
    <Card className="p-5">
      <h2 className="mb-4 font-display text-base font-bold text-ink">{t("admin.settings.searchTitle")}</h2>
      <Field label={t("admin.settings.tagFilters")} hint={t("admin.settings.tagFiltersHint")}>
        <AdminInput
          value={value.availableTagFilters.join(", ")}
          onChange={(e) => setValue({ ...value, availableTagFilters: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
        />
      </Field>
      <SaveBar onSave={save} saving={saving} />
    </Card>
  );
}

function formatUpdatedAt(value: unknown): string {
  const ts = value as { toDate?: () => Date } | undefined;
  return ts?.toDate ? ts.toDate().toLocaleString() : "—";
}

function pointsToText(points: string[]): string {
  return points.join("\n");
}

function textToPoints(text: string): string[] {
  return text.split("\n").map((s) => s.trim()).filter(Boolean);
}

// The exchange-policy consent step shown at checkout (src/components/
// checkout/ExchangePolicyModal.tsx) reads this same settings/exchangePolicy
// doc — see EXCHANGE_POLICY_DEFAULTS for why it's shared rather than
// duplicated. `version` is bumped on every save (not semantic, just
// monotonic) so an order's stored policyConsent.policyVersion can always be
// traced back to roughly when its content was current.
function ExchangePolicyTab() {
  const toast = useToast();
  const { profile } = useAdminAuth();
  const { t } = useLanguage();
  const { value, setValue, loading } = useSettingsDoc<ExchangePolicySettingsDoc>("exchangePolicy", DEFAULTS.exchangePolicy);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    const next = { ...value, version: value.version + 1 };
    await setSingletonDoc("settings", "exchangePolicy", next);
    setValue(next);
    if (profile) await logActivity(profile, "settings.exchangePolicyUpdated", "");
    toast.success(t("admin.settings.saved"));
    setSaving(false);
  }

  if (loading) return <PageLoading />;
  return (
    <Card className="p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-base font-bold text-ink">{t("admin.settings.exchangePolicyTitle")}</h2>
        <div className="flex items-center gap-4 text-xs text-ink-faint">
          <span>
            {t("admin.settings.exchangePolicyVersion")}: {value.version}
          </span>
          <span>
            {t("admin.settings.exchangePolicyLastUpdated")}: {formatUpdatedAt(value.updatedAt)}
          </span>
        </div>
      </div>

      <label className="mb-5 flex items-center justify-between rounded-xl border border-line px-4 py-3">
        <span className="text-sm font-semibold text-ink">{t("admin.settings.exchangePolicyEnabled")}</span>
        <Toggle checked={value.enabled} onChange={(v) => setValue({ ...value, enabled: v })} />
      </label>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={t("admin.settings.exchangePolicyTitleEn")}>
          <AdminInput value={value.title} onChange={(e) => setValue({ ...value, title: e.target.value })} />
        </Field>
        <Field label={t("admin.settings.exchangePolicyTitleArField")}>
          <AdminInput dir="rtl" value={value.titleAr} onChange={(e) => setValue({ ...value, titleAr: e.target.value })} />
        </Field>
        <Field label={t("admin.settings.exchangePolicySubtitleEn")}>
          <AdminInput value={value.subtitle} onChange={(e) => setValue({ ...value, subtitle: e.target.value })} />
        </Field>
        <Field label={t("admin.settings.exchangePolicySubtitleArField")}>
          <AdminInput dir="rtl" value={value.subtitleAr} onChange={(e) => setValue({ ...value, subtitleAr: e.target.value })} />
        </Field>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={t("admin.settings.exchangePolicyPointsEn")} hint={t("admin.settings.exchangePolicyPointsHint")}>
          <AdminTextarea
            rows={6}
            value={pointsToText(value.points)}
            onChange={(e) => setValue({ ...value, points: textToPoints(e.target.value) })}
          />
        </Field>
        <Field label={t("admin.settings.exchangePolicyPointsAr")} hint={t("admin.settings.exchangePolicyPointsHint")}>
          <AdminTextarea
            dir="rtl"
            rows={6}
            value={pointsToText(value.pointsAr)}
            onChange={(e) => setValue({ ...value, pointsAr: textToPoints(e.target.value) })}
          />
        </Field>
      </div>

      <SaveBar onSave={save} saving={saving} />
    </Card>
  );
}
