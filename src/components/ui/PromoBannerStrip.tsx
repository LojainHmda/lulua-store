import { useLanguage } from "../../context/LanguageContext";
import { localizedName } from "../../data/localize";
import type { PromoBanner } from "../../admin/types";

// Renders the admin-authored content.banners list (already fully built in
// HomepageContent.tsx — title/ctaLabel/active, both bilingual) as a simple
// stacked text strip. The admin form has no ctaHref field today, so the
// button reads as a plain label, not a link — adding real destinations is a
// separate, later decision, not something to invent here.
export default function PromoBannerStrip({ banners }: { banners: PromoBanner[] }) {
  const { lang } = useLanguage();
  const active = banners.filter((b) => b.active).sort((a, b) => a.order - b.order);
  if (active.length === 0) return null;

  return (
    <section className="container-page py-6">
      <div className="flex flex-col gap-3">
        {active.map((b) => (
          <div
            key={b.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-cream-dim px-6 py-4"
          >
            <p className="font-display text-lg font-semibold text-ink">{localizedName(b.title, b.titleAr, lang)}</p>
            {b.ctaLabel && (
              <span className="rounded-full border border-ink/20 px-4 py-2 text-sm font-bold uppercase tracking-wide text-ink">
                {localizedName(b.ctaLabel, b.ctaLabelAr, lang)}
              </span>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
