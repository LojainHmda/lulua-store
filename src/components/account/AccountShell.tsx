import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { useCustomerAuth } from "../../context/CustomerAuthContext";
import { useLanguage } from "../../context/LanguageContext";
import Button from "../ui/Button";

export default function AccountShell({ title, children }: { title: string; children: ReactNode }) {
  const { loading, isSignedIn, openSignIn } = useCustomerAuth();
  const { t } = useLanguage();

  if (loading) {
    return (
      <div className="container-page flex min-h-[50vh] items-center justify-center py-16">
        <span className="h-8 w-8 animate-spin rounded-full border-2 border-wine border-t-transparent" />
      </div>
    );
  }

  if (!isSignedIn) {
    return (
      <div className="container-page flex min-h-[50vh] flex-col items-center justify-center gap-5 py-20 text-center">
        <h1 className="font-display text-3xl font-semibold tracking-tight">{t("account.myAccount")}</h1>
        <p className="max-w-sm text-base text-ink-soft">{t("account.signInPrompt")}</p>
        <Button variant="primary" onClick={openSignIn}>
          {t("account.signIn")}
        </Button>
      </div>
    );
  }

  return (
    <div className="container-page py-12 md:py-16">
      <h1 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
      <nav className="mt-6 flex gap-6 border-b border-line">
        <NavLink
          to="/account"
          end
          className={({ isActive }) =>
            `border-b-2 pb-3 text-base font-semibold ${isActive ? "border-wine text-wine" : "border-transparent text-wine/70 hover:text-wine"}`
          }
        >
          {t("account.profile")}
        </NavLink>
        <NavLink
          to="/account/orders"
          className={({ isActive }) =>
            `border-b-2 pb-3 text-base font-semibold ${isActive ? "border-wine text-wine" : "border-transparent text-wine/70 hover:text-wine"}`
          }
        >
          {t("account.orders")}
        </NavLink>
        <NavLink
          to="/account/addresses"
          className={({ isActive }) =>
            `border-b-2 pb-3 text-base font-semibold ${isActive ? "border-wine text-wine" : "border-transparent text-wine/70 hover:text-wine"}`
          }
        >
          {t("account.addresses")}
        </NavLink>
      </nav>
      <div className="mt-8">{children}</div>
    </div>
  );
}
