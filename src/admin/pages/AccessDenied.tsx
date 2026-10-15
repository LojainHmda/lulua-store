import { useLanguage } from "../../context/LanguageContext";
import { useAdminAuth } from "../AdminAuthContext";
import AdminIcon from "../components/AdminIcons";
import { AdminButton } from "../components/ui";

export default function AccessDenied() {
  const { firebaseUser, signOutAdmin } = useAdminAuth();
  const { dir, t } = useLanguage();

  return (
    <div dir={dir} className="admin-root flex min-h-screen items-center justify-center bg-cream px-4 py-10">
      <div className="w-full max-w-md rounded-2xl border border-line bg-paper p-8 text-center shadow-card">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-wine-light text-wine">
          <AdminIcon name="shield" className="h-6 w-6" />
        </div>
        <h1 className="font-display text-xl font-bold text-ink">{t("admin.accessDenied.title")}</h1>
        <p className="mt-2 text-sm text-ink-soft">
          <span className="font-semibold text-ink">{firebaseUser?.email}</span> {t("admin.accessDenied.body")}
        </p>
        <AdminButton variant="secondary" className="mx-auto mt-6" onClick={() => signOutAdmin()}>
          {t("admin.nav.signOut")}
        </AdminButton>
      </div>
    </div>
  );
}
