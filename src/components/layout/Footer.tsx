import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { ContactSettingsDoc } from "../../admin/types";
import { useCatalog } from "../../context/CatalogContext";
import { useLanguage } from "../../context/LanguageContext";
import { getLocalizedCategories } from "../../data/localize";
import { addNewsletterSubscriber, getSingletonDoc } from "../../firebase/firestore";
import Logo from "../ui/Logo";
import Button from "../ui/Button";
import { ShippingReturnsModal, SizeGuideModal } from "../ui/InfoModals";

export default function Footer() {
  const [submitted, setSubmitted] = useState(false);
  const [email, setEmail] = useState("");
  const { lang, t } = useLanguage();
  const catalog = useCatalog();
  const categories = useMemo(() => getLocalizedCategories(catalog.categories, lang), [catalog.categories, lang]);
  const [contact, setContact] = useState<ContactSettingsDoc | null>(null);
  const [sizeGuideOpen, setSizeGuideOpen] = useState(false);
  const [shippingOpen, setShippingOpen] = useState(false);

  useEffect(() => {
    getSingletonDoc<ContactSettingsDoc>("settings", "contact").then((doc) => setContact(doc ?? null));
  }, []);

  const socialLinks = [
    { label: "IG", href: contact?.instagram },
    { label: "TT", href: contact?.tiktok },
    { label: "PIN", href: contact?.pinterest },
    { label: "FB", href: contact?.facebook },
  ].filter((s) => s.href);
  const displaySocials = socialLinks.length > 0 ? socialLinks : [{ label: "IG", href: undefined }, { label: "TT", href: undefined }, { label: "PIN", href: undefined }];

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const value = email.trim();
    if (!value) return;
    // Optimistic: the visitor sees the confirmation immediately either way.
    // A failed write (offline, rules) is intentionally not surfaced — there's
    // nothing useful for a shopper to do about it, and the address is never
    // theirs to lose. It IS persisted now, though: this used to be pure local
    // state and every signup was silently thrown away.
    setSubmitted(true);
    addNewsletterSubscriber(value).catch(() => {});
  }

  return (
    <footer className="bg-wine text-on-accent">
      <div className="container-page grid grid-cols-1 gap-12 py-16 md:grid-cols-[1.3fr_1fr_1fr_1.2fr]">
        <div>
          <Logo className="h-8" />
          <p className="mt-4 max-w-xs text-sm leading-relaxed text-on-accent/60">{t("footer.description")}</p>
          <div className="mt-6 flex gap-2.5">
            {/* No configured URL (admin hasn't filled in Settings → Contact)
                means no <a> at all — a href="#" here was a dead link that
                looked clickable and jumped the page to the top. */}
            {displaySocials.map((s) =>
              s.href ? (
                <a
                  key={s.label}
                  href={s.href}
                  target="_blank"
                  rel="noreferrer"
                  className="flex h-9 w-9 items-center justify-center rounded-full border border-on-accent/20 text-xs font-semibold transition-colors hover:border-on-accent/60 hover:bg-on-accent/10"
                >
                  {s.label}
                </a>
              ) : (
                <span
                  key={s.label}
                  aria-disabled="true"
                  className="flex h-9 w-9 cursor-default items-center justify-center rounded-full border border-on-accent/10 text-xs font-semibold text-on-accent/40"
                >
                  {s.label}
                </span>
              )
            )}
          </div>
          {contact?.email && (
            <a href={`mailto:${contact.email}`} className="mt-4 block text-sm text-on-accent/70 hover:text-on-accent">
              {contact.email}
            </a>
          )}
        </div>

        <div>
          <h3 className="mb-4 text-sm font-bold uppercase tracking-wide text-on-accent/50">{t("footer.shop")}</h3>
          <ul className="space-y-3 text-sm">
            {categories.map((cat) => (
              <li key={cat.slug}>
                <Link to={`/shop/${cat.slug}`} className="text-on-accent/85 transition-colors hover:text-on-accent">
                  {cat.name}
                </Link>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <h3 className="mb-4 text-sm font-bold uppercase tracking-wide text-on-accent/50">{t("footer.company")}</h3>
          <ul className="space-y-3 text-sm">
            <li>
              <Link to="/about" className="text-on-accent/85 transition-colors hover:text-on-accent">
                {t("footer.ourStory")}
              </Link>
            </li>
            <li>
              <Link to="/shop" className="text-on-accent/85 transition-colors hover:text-on-accent">
                {t("footer.shopAll")}
              </Link>
            </li>
            <li>
              <button
                type="button"
                onClick={() => setShippingOpen(true)}
                className="text-start text-on-accent/85 transition-colors hover:text-on-accent"
              >
                {t("footer.shippingReturns")}
              </button>
            </li>
            <li>
              <button
                type="button"
                onClick={() => setSizeGuideOpen(true)}
                className="text-start text-on-accent/85 transition-colors hover:text-on-accent"
              >
                {t("footer.sizeGuide")}
              </button>
            </li>
          </ul>
        </div>

        <div>
          <h3 className="mb-4 text-sm font-bold uppercase tracking-wide text-on-accent/50">{t("footer.stayInLoop")}</h3>
          <p className="mb-4 text-sm text-on-accent/60">{t("footer.newsletterBlurb")}</p>
          {submitted ? (
            <p className="rounded-full bg-on-accent/10 px-4 py-2.5 text-sm font-semibold text-on-accent">{t("footer.onList")}</p>
          ) : (
            <form onSubmit={handleSubmit} className="flex gap-2">
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t("footer.emailPlaceholder")}
                className="w-full min-w-0 rounded-full border border-on-accent/25 bg-transparent px-4 py-2.5 text-sm outline-none placeholder:text-on-accent/40 focus:border-on-accent"
              />
              <Button type="submit" variant="dark" size="sm" className="shrink-0">
                {t("footer.join")}
              </Button>
            </form>
          )}
        </div>
      </div>

      <div className="border-t border-on-accent/10">
        <div className="container-page flex flex-col items-center justify-between gap-3 py-6 text-sm text-on-accent/60 md:flex-row">
          <p>© {new Date().getFullYear()} لؤلؤة. {t("footer.rights")}</p>
          <p>{t("footer.tagline")}</p>
          <Link to="/admin" className="text-on-accent/60 transition-colors hover:text-on-accent">
            {t("footer.staffLogin")}
          </Link>
        </div>
      </div>

      <SizeGuideModal open={sizeGuideOpen} onClose={() => setSizeGuideOpen(false)} />
      <ShippingReturnsModal open={shippingOpen} onClose={() => setShippingOpen(false)} />
    </footer>
  );
}
