import { useLanguage } from "../../context/LanguageContext";

export default function FirebaseSetupNeeded() {
  const { dir, t } = useLanguage();
  return (
    <div dir={dir} className="admin-root flex min-h-screen items-center justify-center bg-cream px-4 py-10">
      <div className="w-full max-w-xl rounded-2xl border border-line bg-paper p-8 shadow-card">
        <h1 className="font-display text-2xl font-bold text-ink">{t("admin.firebaseSetup.title")}</h1>
        <p className="mt-3 text-sm leading-relaxed text-ink-soft">
          {t("admin.firebaseSetup.introBeforeEnvLocal")}{" "}
          <code className="rounded bg-cream-dim px-1.5 py-0.5 font-mono text-xs">.env.local</code>{" "}
          {t("admin.firebaseSetup.introBeforeEnvExample")}{" "}
          <code className="rounded bg-cream-dim px-1.5 py-0.5 font-mono text-xs">.env.example</code>{" "}
          {t("admin.firebaseSetup.introAfterEnvExample")}
        </p>
        <ol className="mt-5 flex flex-col gap-2.5 text-sm text-ink-soft">
          <li className="flex gap-2.5">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-cream-dim text-xs font-bold text-ink">1</span>
            {t("admin.firebaseSetup.step1")} <span className="font-semibold text-ink">console.firebase.google.com</span>
          </li>
          <li className="flex gap-2.5">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-cream-dim text-xs font-bold text-ink">2</span>
            {t("admin.firebaseSetup.step2")} <span className="font-semibold text-ink">Authentication → Email/Password</span>
          </li>
          <li className="flex gap-2.5">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-cream-dim text-xs font-bold text-ink">3</span>
            {t("admin.firebaseSetup.step3Before")} <span className="font-semibold text-ink">Firestore database</span>{" "}
            {t("admin.firebaseSetup.step3And")} <span className="font-semibold text-ink">Storage</span> {t("admin.firebaseSetup.step3After")}
          </li>
          <li className="flex gap-2.5">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-cream-dim text-xs font-bold text-ink">4</span>
            {t("admin.firebaseSetup.step4Before")} <span className="font-semibold text-ink">firestore.rules</span>{" "}
            {t("admin.firebaseSetup.step4And")} <span className="font-semibold text-ink">storage.rules</span> {t("admin.firebaseSetup.step4After")}
          </li>
          <li className="flex gap-2.5">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-cream-dim text-xs font-bold text-ink">5</span>
            {t("admin.firebaseSetup.step5")} <span className="font-semibold text-ink">.env.local</span>
          </li>
        </ol>
        <p className="mt-5 text-xs text-ink-faint">{t("admin.firebaseSetup.seeDocs")}</p>
      </div>
    </div>
  );
}
