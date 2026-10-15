import { useLanguage } from "../../context/LanguageContext";
import { PageHeader, EmptyState } from "../components/ui";

export default function ComingSoon({ title, description }: { title: string; description?: string }) {
  const { t } = useLanguage();
  return (
    <div>
      <PageHeader title={title} description={description} />
      <EmptyState icon="settings" title={t("admin.comingSoon.title")} body={t("admin.comingSoon.body")} />
    </div>
  );
}
