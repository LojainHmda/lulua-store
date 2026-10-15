import LinkButton from "../components/ui/LinkButton";
import ProductPhoto from "../components/ui/ProductPhoto";
import { useLanguage } from "../context/LanguageContext";

export default function NotFound() {
  const { t } = useLanguage();
  return (
    <div className="container-page flex flex-col items-center gap-6 py-24 text-center md:py-32">
      <ProductPhoto
        imageId="1691480150204-66dd1eb77391"
        alt=""
        width={320}
        aspect={{ w: 1, h: 1 }}
        className="h-32 w-32 rounded-full grayscale"
      />
      <p className="font-display text-6xl font-semibold text-wine">404</p>
      <h1 className="font-display text-2xl font-semibold text-ink sm:text-3xl">{t("notFound.title")}</h1>
      <p className="max-w-sm text-ink-soft">{t("notFound.body")}</p>
      <LinkButton to="/" size="lg">
        {t("notFound.backHome")}
      </LinkButton>
    </div>
  );
}
