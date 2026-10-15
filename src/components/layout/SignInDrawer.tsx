import { AnimatePresence, motion } from "motion/react";
import { useState, type FormEvent } from "react";
import { useCustomerAuth } from "../../context/CustomerAuthContext";
import { useLanguage } from "../../context/LanguageContext";
import Button from "../ui/Button";

function friendlyAuthError(code: string, t: (key: string) => string): string {
  switch (code) {
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
      return t("account.errorInvalidCredential");
    case "auth/email-already-in-use":
    case "auth/credential-already-in-use":
      return t("account.errorEmailInUse");
    case "auth/weak-password":
      return t("account.errorWeakPassword");
    default:
      return t("account.errorGeneric");
  }
}

export default function SignInDrawer() {
  const { signInOpen, closeSignIn, signInWithGoogle, signInWithEmail, signUpWithEmail } = useCustomerAuth();
  const { dir, t } = useLanguage();
  const [mode, setMode] = useState<"signIn" | "signUp">("signIn");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);

  function reset() {
    setName("");
    setEmail("");
    setPassword("");
    setError(null);
    setLoading(false);
    setGoogleLoading(false);
    setMode("signIn");
  }

  function handleClose() {
    closeSignIn();
    reset();
  }

  async function handleGoogle() {
    setError(null);
    setGoogleLoading(true);
    try {
      await signInWithGoogle();
    } catch (err) {
      setError(friendlyAuthError((err as { code?: string }).code ?? "", t));
    } finally {
      setGoogleLoading(false);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (mode === "signUp") {
        await signUpWithEmail(email.trim(), password, name.trim());
      } else {
        await signInWithEmail(email.trim(), password);
      }
    } catch (err) {
      setError(friendlyAuthError((err as { code?: string }).code ?? "", t));
    } finally {
      setLoading(false);
    }
  }

  return (
    <AnimatePresence>
      {signInOpen && (
        <>
          <motion.div
            key="signin-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="fixed inset-0 z-[70] bg-black/40 backdrop-blur-[2px]"
            onClick={handleClose}
          />
          <motion.aside
            key="signin-drawer"
            initial={{ x: dir === "rtl" ? "-100%" : "100%" }}
            animate={{ x: 0 }}
            exit={{ x: dir === "rtl" ? "-100%" : "100%" }}
            transition={{ type: "spring", stiffness: 340, damping: 36 }}
            className="fixed end-0 top-0 z-[71] flex h-full w-full max-w-md flex-col bg-paper shadow-lift"
            role="dialog"
            aria-modal="true"
            aria-label={mode === "signUp" ? t("account.signUpTitle") : t("account.signInTitle")}
          >
            <div className="flex shrink-0 items-center justify-between border-b border-line px-6 py-5 short:py-3">
              <h2 className="font-display text-2xl font-bold">
                {mode === "signUp" ? t("account.signUpTitle") : t("account.signInTitle")}
              </h2>
              <button
                onClick={handleClose}
                aria-label={t("account.close")}
                className="flex h-11 w-11 items-center justify-center rounded-full text-wine transition-colors hover:bg-cream-dim"
              >
                <svg className="h-5 w-5" viewBox="0 0 18 18" fill="none">
                  <path d="M1 1L17 17M17 1L1 17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            </div>

            {/* data-lenis-prevent: the global smooth-scroll instance (useLenis)
                otherwise swallows wheel events, so this panel could never be
                scrolled to its submit button on short windows. */}
            <div
              data-lenis-prevent
              className="thin-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-6 py-6 short:py-4"
            >
              <p className="mb-6 text-base short:mb-4 text-ink-soft">
                {mode === "signUp" ? t("account.signUpSubtitle") : t("account.signInSubtitle")}
              </p>

              <Button
                type="button"
                variant="outline"
                fullWidth
                onClick={handleGoogle}
                disabled={googleLoading}
                className="gap-2.5"
              >
                <GoogleIcon />
                {t("account.continueWithGoogle")}
              </Button>

              <div className="my-6 flex items-center gap-3 short:my-4">
                <span className="h-px flex-1 bg-line" />
                <span className="text-sm font-semibold uppercase tracking-wide text-ink-faint">{t("account.orDivider")}</span>
                <span className="h-px flex-1 bg-line" />
              </div>

              <form onSubmit={handleSubmit} className="flex flex-col gap-4 short:gap-3">
                {mode === "signUp" && (
                  <label className="flex flex-col gap-1.5">
                    <span className="text-sm font-semibold text-ink">{t("account.nameLabel")}</span>
                    <input
                      required
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder={t("account.namePlaceholder")}
                      autoComplete="name"
                      className="rounded-xl border border-line bg-paper px-4 py-3 text-base short:py-2.5 outline-none placeholder:text-ink-faint focus:border-wine"
                    />
                  </label>
                )}

                <label className="flex flex-col gap-1.5">
                  <span className="text-sm font-semibold text-ink">{t("account.emailLabel")}</span>
                  <input
                    required
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder={t("account.emailPlaceholder")}
                    autoComplete="email"
                    className="rounded-xl border border-line bg-paper px-4 py-3 text-base short:py-2.5 outline-none placeholder:text-ink-faint focus:border-wine"
                  />
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className="text-sm font-semibold text-ink">{t("account.passwordLabel")}</span>
                  <input
                    required
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={t("account.passwordPlaceholder")}
                    autoComplete={mode === "signUp" ? "new-password" : "current-password"}
                    minLength={6}
                    className="rounded-xl border border-line bg-paper px-4 py-3 text-base short:py-2.5 outline-none placeholder:text-ink-faint focus:border-wine"
                  />
                </label>

                {error && <p className="rounded-lg bg-wine-light px-3.5 py-2.5 text-sm font-semibold text-wine">{error}</p>}

                <Button type="submit" variant="primary" fullWidth disabled={loading} className="mt-1">
                  {loading
                    ? mode === "signUp"
                      ? t("account.signingUp")
                      : t("account.signingIn")
                    : mode === "signUp"
                      ? t("account.signUpButton")
                      : t("account.signInButton")}
                </Button>
              </form>

              <p className="mt-6 text-center text-sm text-ink-soft short:mt-4">
                {mode === "signUp" ? t("account.haveAccount") : t("account.noAccount")}{" "}
                <button
                  type="button"
                  onClick={() => {
                    setMode((m) => (m === "signUp" ? "signIn" : "signUp"));
                    setError(null);
                  }}
                  className="font-semibold text-wine underline-offset-2 hover:underline"
                >
                  {mode === "signUp" ? t("account.switchToSignIn") : t("account.switchToSignUp")}
                </button>
              </p>
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

function GoogleIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 20 20" fill="none">
      <path
        d="M19.6 10.23c0-.68-.06-1.33-.17-1.96H10v3.71h5.38a4.6 4.6 0 01-2 3.02v2.5h3.24c1.9-1.75 2.98-4.33 2.98-7.27z"
        fill="#4285F4"
      />
      <path
        d="M10 20c2.7 0 4.96-.89 6.62-2.42l-3.24-2.5c-.9.6-2.05.96-3.38.96-2.6 0-4.8-1.75-5.59-4.11H1.06v2.59A10 10 0 0010 20z"
        fill="#34A853"
      />
      <path
        d="M4.41 11.93A5.99 5.99 0 014.1 10c0-.67.12-1.32.32-1.93V5.48H1.06A10 10 0 000 10c0 1.61.39 3.14 1.06 4.52l3.35-2.59z"
        fill="#FBBC05"
      />
      <path
        d="M10 3.96c1.47 0 2.79.5 3.83 1.49l2.87-2.87C14.95.99 12.7 0 10 0 6.09 0 2.72 2.24 1.06 5.48l3.35 2.59C5.2 5.71 7.4 3.96 10 3.96z"
        fill="#EA4335"
      />
    </svg>
  );
}
