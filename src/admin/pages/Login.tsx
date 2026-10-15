import { useState, type FormEvent } from "react";
import LanguageToggle from "../../components/ui/LanguageToggle";
import { useLanguage } from "../../context/LanguageContext";
import { useAdminAuth } from "../AdminAuthContext";
import { AdminButton, AdminInput, Field } from "../components/ui";
import AdminIcon from "../components/AdminIcons";

function friendlyAuthError(code: string, t: (key: string) => string): string {
  switch (code) {
    case "auth/invalid-email":
      return t("admin.login.errInvalidEmail");
    case "auth/user-disabled":
      return t("admin.login.errDisabled");
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
      return t("admin.login.errBadCredential");
    case "auth/email-already-in-use":
      return t("admin.login.errEmailInUse");
    case "auth/weak-password":
      return t("admin.login.errWeakPassword");
    case "auth/too-many-requests":
      return t("admin.login.errTooMany");
    default:
      return t("admin.login.errGeneric");
  }
}

export default function Login() {
  const { bootstrapNeeded, signIn, bootstrapOwner } = useAdminAuth();
  const { dir, t } = useLanguage();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (bootstrapNeeded) {
      if (password !== confirmPassword) {
        setError(t("admin.login.errPasswordMismatch"));
        return;
      }
      if (!displayName.trim()) {
        setError(t("admin.login.errNameRequired"));
        return;
      }
    }

    setLoading(true);
    try {
      if (bootstrapNeeded) {
        await bootstrapOwner(email.trim(), password, displayName.trim());
      } else {
        await signIn(email.trim(), password);
      }
    } catch (err) {
      const code = (err as { code?: string }).code ?? "";
      setError(friendlyAuthError(code, t));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div dir={dir} className="admin-root relative flex min-h-screen items-center justify-center bg-cream px-4 py-10">
      <LanguageToggle className="absolute end-4 top-4" />
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-wine text-on-accent">
            <AdminIcon name="shield" className="h-6 w-6" />
          </div>
          <h1 className="font-display text-2xl font-bold text-ink">{t("admin.brand")}</h1>
          <p className="mt-1 text-sm text-ink-soft">
            {bootstrapNeeded ? t("admin.login.bootstrapSubtitle") : t("admin.login.subtitle")}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="rounded-2xl border border-line bg-paper p-6 shadow-card">
          <div className="flex flex-col gap-4">
            {bootstrapNeeded && (
              <Field label={t("admin.login.yourName")} required>
                <AdminInput value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={t("admin.login.yourNamePlaceholder")} autoFocus />
              </Field>
            )}

            <Field label={t("admin.login.email")} required>
              <AdminInput
                type="text"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@lulua.com"
                autoFocus={!bootstrapNeeded}
                autoComplete="username"
              />
            </Field>

            <Field label={t("admin.login.password")} required>
              <div className="relative">
                <AdminInput
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  autoComplete={bootstrapNeeded ? "new-password" : "current-password"}
                  className="pe-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((s) => !s)}
                  className="absolute end-3 top-1/2 -translate-y-1/2 text-ink-faint hover:text-ink"
                  tabIndex={-1}
                >
                  <AdminIcon name={showPassword ? "eyeOff" : "eye"} className="h-4 w-4" />
                </button>
              </div>
            </Field>

            {bootstrapNeeded && (
              <Field label={t("admin.login.confirmPassword")} required>
                <AdminInput
                  type={showPassword ? "text" : "password"}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="new-password"
                />
              </Field>
            )}

            {error && (
              <p className="rounded-lg bg-wine-light px-3.5 py-2.5 text-sm font-semibold text-wine">{error}</p>
            )}

            <AdminButton type="submit" variant="primary" loading={loading} className="mt-1 w-full justify-center py-3">
              {bootstrapNeeded ? t("admin.login.createAccount") : t("admin.login.signIn")}
            </AdminButton>
          </div>
        </form>

        {bootstrapNeeded && (
          <p className="mt-4 text-center text-xs text-ink-faint">
            {t("admin.login.bootstrapNote")}
          </p>
        )}
      </div>
    </div>
  );
}
