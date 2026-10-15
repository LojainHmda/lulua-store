import { useEffect, useMemo, useState } from "react";
import { getSingletonDoc, setSingletonDoc } from "../../firebase/firestore";
import { productsApi } from "../../firebase/collections";
import { useLanguage } from "../../context/LanguageContext";
import { localizedName } from "../../data/localize";
import { DEFAULT_VALUE_STRIP, VALUE_STRIP_ICONS } from "../../data/valueStrip";
import { useAdminAuth } from "../AdminAuthContext";
import AdminIcon from "../components/AdminIcons";
import MediaPicker from "../components/MediaPicker";
import ProductVideoPicker from "../components/ProductVideoPicker";
import { useToast } from "../components/ToastContext";
import { AdminButton, AdminInput, Card, Field, PageHeader, PageLoading, Toggle } from "../components/ui";
import { logActivity } from "../logActivity";
import type { AdminProduct, HeroSlideContent, HomepageContentDoc, PromoBanner, ValueStripItemId } from "../types";

const EMPTY: HomepageContentDoc = {
  heroSlides: [],
  banners: [],
  featuredProductIds: [],
  promoBarText: "",
  promoBarActive: false,
  valueStrip: DEFAULT_VALUE_STRIP,
};

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

export default function HomepageContent() {
  const toast = useToast();
  const { t, lang } = useLanguage();
  const { profile, hasRole } = useAdminAuth();
  const canWrite = hasRole(["owner", "admin", "editor"]);
  const [content, setContent] = useState<HomepageContentDoc>(EMPTY);
  const [products, setProducts] = useState<AdminProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [videoPickerFor, setVideoPickerFor] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getSingletonDoc<HomepageContentDoc>("siteContent", "homepage"), productsApi.list()]).then(([doc, prods]) => {
      if (doc) setContent({ ...EMPTY, ...doc });
      setProducts(prods);
      setLoading(false);
    });
  }, []);

  const featuredSet = useMemo(() => new Set(content.featuredProductIds), [content.featuredProductIds]);

  async function handleSave() {
    setSaving(true);
    try {
      await setSingletonDoc("siteContent", "homepage", content);
      if (profile) await logActivity(profile, "homepage.updated", "");
      toast.success(t("admin.homepage.saved"));
    } catch {
      toast.error(t("admin.homepage.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  function addSlide() {
    const slide: HeroSlideContent = { id: uid(), type: "image", src: "", alt: "" };
    setContent((c) => ({ ...c, heroSlides: [...c.heroSlides, slide] }));
  }

  function updateSlide(id: string, patch: Partial<HeroSlideContent>) {
    setContent((c) => ({ ...c, heroSlides: c.heroSlides.map((s) => (s.id === id ? { ...s, ...patch } : s)) }));
  }

  function removeSlide(id: string) {
    setContent((c) => ({ ...c, heroSlides: c.heroSlides.filter((s) => s.id !== id) }));
  }

  // Swaps adjacent array positions — the storefront renders heroSlides in
  // exact array order (see Home.tsx's mapping), so this is the entire
  // mechanism; no separate `order` field needed the way PromoBanner has one.
  function moveSlide(id: string, direction: "up" | "down") {
    setContent((c) => {
      const index = c.heroSlides.findIndex((s) => s.id === id);
      const targetIndex = direction === "up" ? index - 1 : index + 1;
      if (index === -1 || targetIndex < 0 || targetIndex >= c.heroSlides.length) return c;
      const next = [...c.heroSlides];
      [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
      return { ...c, heroSlides: next };
    });
  }

  function addBanner() {
    const banner: PromoBanner = { id: uid(), title: "", active: true, order: content.banners.length };
    setContent((c) => ({ ...c, banners: [...c.banners, banner] }));
  }

  function updateBanner(id: string, patch: Partial<PromoBanner>) {
    setContent((c) => ({ ...c, banners: c.banners.map((b) => (b.id === id ? { ...b, ...patch } : b)) }));
  }

  function removeBanner(id: string) {
    setContent((c) => ({ ...c, banners: c.banners.filter((b) => b.id !== id) }));
  }

  // A fixed 4-slot set — never added to, removed from, or reordered, unlike
  // hero slides/banners above. `id` picks which slot changes.
  function updateValueStripItem(id: ValueStripItemId, patch: Partial<{ text: string; textAr: string; active: boolean }>) {
    setContent((c) => ({
      ...c,
      valueStrip: (c.valueStrip ?? DEFAULT_VALUE_STRIP).map((item) => (item.id === id ? { ...item, ...patch } : item)),
    }));
  }

  function toggleFeatured(id: string) {
    setContent((c) => ({
      ...c,
      featuredProductIds: featuredSet.has(id) ? c.featuredProductIds.filter((x) => x !== id) : [...c.featuredProductIds, id],
    }));
  }

  if (loading) return <PageLoading />;

  return (
    <div className="pb-16">
      <PageHeader
        title={t("admin.nav.homepage")}
        description={t("admin.homepage.subtitle")}
        actions={canWrite && <AdminButton variant="primary" loading={saving} onClick={handleSave}>{t("admin.settings.save")}</AdminButton>}
      />

      <div className="flex flex-col gap-6">
        <Card className="p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-display text-base font-bold text-ink">{t("admin.homepage.promoBar")}</h2>
            {canWrite && <Toggle checked={content.promoBarActive} onChange={(v) => setContent((c) => ({ ...c, promoBarActive: v }))} />}
          </div>
          <Field label={t("admin.homepage.message")}>
            <AdminInput
              disabled={!canWrite}
              value={content.promoBarText ?? ""}
              onChange={(e) => setContent((c) => ({ ...c, promoBarText: e.target.value }))}
              placeholder={t("admin.homepage.messagePlaceholder")}
            />
          </Field>
        </Card>

        <Card className="p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-display text-base font-bold text-ink">{t("admin.homepage.heroSlides")}</h2>
            {canWrite && <AdminButton variant="secondary" size="sm" icon="plus" onClick={addSlide}>{t("admin.homepage.addSlide")}</AdminButton>}
          </div>
          {content.heroSlides.length === 0 ? (
            <p className="text-sm text-ink-faint">{t("admin.homepage.noSlides")}</p>
          ) : (
            <div className="flex flex-col gap-4">
              {content.heroSlides.map((slide, index) => (
                <div key={slide.id} className="flex flex-col gap-3 rounded-xl border border-line p-4 sm:flex-row">
                  <div className="aspect-video w-full shrink-0 overflow-hidden rounded-lg bg-cream-dim sm:w-48">
                    {slide.src ? (
                      slide.type === "video" ? (
                        <video src={slide.src} poster={slide.poster} className="h-full w-full object-cover" muted />
                      ) : (
                        <img src={slide.src} alt="" className="h-full w-full object-cover" />
                      )
                    ) : (
                      <div className="flex h-full items-center justify-center text-ink-faint">
                        <AdminIcon name="image" className="h-6 w-6" />
                      </div>
                    )}
                  </div>
                  <div className="flex-1 space-y-2.5">
                    <div className="flex flex-wrap gap-2">
                      <AdminButton size="sm" variant="secondary" onClick={() => setPickerFor(slide.id)} disabled={!canWrite}>
                        {slide.src ? t("admin.homepage.changeMedia") : t("admin.homepage.chooseMedia")}
                      </AdminButton>
                      <AdminButton size="sm" variant="ghost" icon="video" onClick={() => setVideoPickerFor(slide.id)} disabled={!canWrite}>
                        {t("admin.homepage.chooseProductVideo")}
                      </AdminButton>
                    </div>
                    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                      <AdminInput disabled={!canWrite} value={slide.badge ?? ""} onChange={(e) => updateSlide(slide.id, { badge: e.target.value })} placeholder={t("admin.homepage.badgePlaceholder")} />
                      <AdminInput disabled={!canWrite} dir="rtl" value={slide.badgeAr ?? ""} onChange={(e) => updateSlide(slide.id, { badgeAr: e.target.value })} placeholder={t("admin.homepage.badgePlaceholderAr")} />
                      <AdminInput disabled={!canWrite} value={slide.title ?? ""} onChange={(e) => updateSlide(slide.id, { title: e.target.value })} placeholder={t("admin.homepage.headlinePlaceholder")} />
                      <AdminInput disabled={!canWrite} dir="rtl" value={slide.titleAr ?? ""} onChange={(e) => updateSlide(slide.id, { titleAr: e.target.value })} placeholder={t("admin.homepage.headlinePlaceholderAr")} />
                    </div>
                    <AdminInput disabled={!canWrite} value={slide.alt} onChange={(e) => updateSlide(slide.id, { alt: e.target.value })} placeholder={t("admin.homepage.altTextPlaceholder")} />
                  </div>
                  {canWrite && (
                    <div className="flex shrink-0 flex-row gap-1 self-start sm:flex-col">
                      <button
                        onClick={() => moveSlide(slide.id, "up")}
                        disabled={index === 0}
                        aria-label={t("admin.homepage.moveUp")}
                        className="rounded-lg p-2 text-ink-faint hover:bg-cream-dim hover:text-ink disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
                      >
                        <AdminIcon name="arrowUp" className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => moveSlide(slide.id, "down")}
                        disabled={index === content.heroSlides.length - 1}
                        aria-label={t("admin.homepage.moveDown")}
                        className="rounded-lg p-2 text-ink-faint hover:bg-cream-dim hover:text-ink disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
                      >
                        <AdminIcon name="arrowDown" className="h-4 w-4" />
                      </button>
                      <button onClick={() => removeSlide(slide.id)} className="rounded-lg p-2 text-ink-faint hover:bg-wine-light hover:text-wine">
                        <AdminIcon name="trash" className="h-4 w-4" />
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card className="p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-display text-base font-bold text-ink">{t("admin.homepage.promoBanners")}</h2>
            {canWrite && <AdminButton variant="secondary" size="sm" icon="plus" onClick={addBanner}>{t("admin.homepage.addBanner")}</AdminButton>}
          </div>
          {content.banners.length === 0 ? (
            <p className="text-sm text-ink-faint">{t("admin.homepage.noBanners")}</p>
          ) : (
            <div className="flex flex-col gap-3">
              {content.banners.map((b) => (
                <div key={b.id} className="flex flex-col gap-2.5 rounded-xl border border-line p-3 sm:flex-row sm:items-start">
                  <div className="grid flex-1 grid-cols-1 gap-2.5 sm:grid-cols-2">
                    <AdminInput disabled={!canWrite} value={b.title} onChange={(e) => updateBanner(b.id, { title: e.target.value })} placeholder={t("admin.homepage.bannerTitlePlaceholder")} />
                    <AdminInput disabled={!canWrite} dir="rtl" value={b.titleAr ?? ""} onChange={(e) => updateBanner(b.id, { titleAr: e.target.value })} placeholder={t("admin.homepage.bannerTitlePlaceholderAr")} />
                    <AdminInput disabled={!canWrite} value={b.ctaLabel ?? ""} onChange={(e) => updateBanner(b.id, { ctaLabel: e.target.value })} placeholder={t("admin.homepage.buttonLabelPlaceholder")} />
                    <AdminInput disabled={!canWrite} dir="rtl" value={b.ctaLabelAr ?? ""} onChange={(e) => updateBanner(b.id, { ctaLabelAr: e.target.value })} placeholder={t("admin.homepage.buttonLabelPlaceholderAr")} />
                  </div>
                  <div className="flex items-center gap-3 sm:flex-col sm:items-end">
                    {canWrite && <Toggle checked={b.active} onChange={(v) => updateBanner(b.id, { active: v })} />}
                    {canWrite && (
                      <button onClick={() => removeBanner(b.id)} className="rounded-lg p-2 text-ink-faint hover:bg-wine-light hover:text-wine">
                        <AdminIcon name="trash" className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card className="p-5">
          <h2 className="font-display text-base font-bold text-ink">{t("admin.homepage.valueStrip")}</h2>
          <p className="mb-4 mt-1 text-sm text-ink-soft">{t("admin.homepage.valueStripHint")}</p>
          <div className="flex flex-col gap-3">
            {(content.valueStrip ?? DEFAULT_VALUE_STRIP).map((item) => {
              const Icon = VALUE_STRIP_ICONS[item.id];
              return (
                <div key={item.id} className="flex flex-col gap-2.5 rounded-xl border border-line p-3 sm:flex-row sm:items-center">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-cream-dim text-wine">
                    <Icon className="h-5 w-5" />
                  </div>
                  <div className="grid flex-1 grid-cols-1 gap-2.5 sm:grid-cols-2">
                    <AdminInput
                      disabled={!canWrite}
                      value={item.text}
                      onChange={(e) => updateValueStripItem(item.id, { text: e.target.value })}
                      placeholder={t("admin.homepage.valueStripTextPlaceholder")}
                    />
                    <AdminInput
                      disabled={!canWrite}
                      dir="rtl"
                      value={item.textAr}
                      onChange={(e) => updateValueStripItem(item.id, { textAr: e.target.value })}
                      placeholder={t("admin.homepage.valueStripTextPlaceholderAr")}
                    />
                  </div>
                  {canWrite && <Toggle checked={item.active} onChange={(v) => updateValueStripItem(item.id, { active: v })} />}
                </div>
              );
            })}
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="mb-4 font-display text-base font-bold text-ink">{t("admin.homepage.featuredProducts")}</h2>
          <p className="mb-3 text-sm text-ink-soft">{content.featuredProductIds.length} {t("admin.common.selected")}</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {products.map((p) => (
              <button
                key={p.id}
                disabled={!canWrite}
                onClick={() => toggleFeatured(p.id)}
                className={`flex items-center gap-2 rounded-lg border p-2 text-left transition-colors ${
                  featuredSet.has(p.id) ? "border-wine bg-wine-light" : "border-line hover:border-ink-faint"
                }`}
              >
                <div className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${featuredSet.has(p.id) ? "border-wine bg-wine text-on-accent" : "border-line"}`}>
                  {featuredSet.has(p.id) && <AdminIcon name="check" className="h-3 w-3" />}
                </div>
                <span className="truncate text-sm text-ink">{localizedName(p.name, p.nameAr, lang)}</span>
              </button>
            ))}
          </div>
        </Card>
      </div>

      <MediaPicker
        open={!!pickerFor}
        onClose={() => setPickerFor(null)}
        accept="image/*,video/*"
        // A plain upload/library pick never has a known poster — clearing it
        // here matters when a slide previously had one auto-filled from a
        // product video (below) and is now being replaced with different
        // media, so a stale poster can never end up paired with the wrong
        // video.
        onSelect={(asset) => pickerFor && updateSlide(pickerFor, { src: asset.url, type: asset.type, poster: undefined })}
      />

      <ProductVideoPicker
        open={!!videoPickerFor}
        onClose={() => setVideoPickerFor(null)}
        onSelect={(item) => {
          if (videoPickerFor) updateSlide(videoPickerFor, { src: item.url, type: "video", poster: item.posterUrl });
          setVideoPickerFor(null);
        }}
      />
    </div>
  );
}
