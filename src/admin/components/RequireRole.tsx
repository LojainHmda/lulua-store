import type { ReactNode } from "react";
import { useLanguage } from "../../context/LanguageContext";
import { useAdminAuth } from "../AdminAuthContext";
import type { AdminRole } from "../types";
import AdminIcon from "./AdminIcons";

export default function RequireRole({ roles, children }: { roles: AdminRole[]; children: ReactNode }) {
  const { hasRole } = useAdminAuth();
  const { t } = useLanguage();

  if (!hasRole(roles)) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-line px-6 py-20 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-wine-light text-wine">
          <AdminIcon name="shield" className="h-6 w-6" />
        </div>
        <p className="font-display text-lg font-bold text-ink">{t("admin.requireRole.title")}</p>
        <p className="max-w-sm text-sm text-ink-soft">{t("admin.requireRole.body")}</p>
      </div>
    );
  }

  return <>{children}</>;
}
