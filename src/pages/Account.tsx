import { doc, serverTimestamp, updateDoc } from "firebase/firestore";
import { useEffect, useState, type FormEvent } from "react";
import AccountShell from "../components/account/AccountShell";
import Button from "../components/ui/Button";
import { useCustomerAuth } from "../context/CustomerAuthContext";
import { useLanguage, type Lang } from "../context/LanguageContext";
import { db } from "../firebase/config";

function formatMemberSince(value: unknown, lang: Lang): string {
  const ts = value as { toDate?: () => Date } | undefined;
  const date = ts?.toDate ? ts.toDate() : null;
  return date ? date.toLocaleDateString(lang === "ar" ? "ar" : "en-US", { year: "numeric", month: "long" }) : "";
}

export default function Account() {
  const { firebaseUser, profile, signOutCustomer } = useCustomerAuth();
  const { lang, t } = useLanguage();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setName(profile?.name ?? "");
    setPhone(profile?.phone ?? "");
  }, [profile?.name, profile?.phone]);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    if (!firebaseUser) return;
    setSaving(true);
    setSaved(false);
    try {
      await updateDoc(doc(db, "customers", firebaseUser.uid), {
        name: name.trim(),
        phone: phone.trim(),
        updatedAt: serverTimestamp(),
      });
      setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <AccountShell title={t("account.myAccount")}>
      <div className="max-w-lg rounded-2xl bg-paper p-6 shadow-soft">
        <form onSubmit={handleSave} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-semibold text-ink">{t("account.nameLabel")}</span>
            <input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setSaved(false);
              }}
              className="rounded-xl border border-line bg-paper px-4 py-3 text-base outline-none focus:border-wine"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-semibold text-ink">{t("account.emailLabel")}</span>
            <input
              disabled
              value={profile?.email ?? firebaseUser?.email ?? ""}
              className="rounded-xl border border-line bg-cream-dim px-4 py-3 text-base text-ink-faint outline-none"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-semibold text-ink">{t("account.phoneLabel")}</span>
            <input
              value={phone}
              onChange={(e) => {
                setPhone(e.target.value);
                setSaved(false);
              }}
              placeholder={t("account.phonePlaceholder")}
              className="rounded-xl border border-line bg-paper px-4 py-3 text-base outline-none placeholder:text-ink-faint focus:border-wine"
            />
          </label>

          {!!profile?.createdAt && (
            <p className="text-sm text-ink-faint">
              {t("account.memberSince")} {formatMemberSince(profile.createdAt, lang)}
            </p>
          )}

          <div className="mt-2 flex items-center gap-4">
            <Button type="submit" variant="primary" disabled={saving}>
              {saved ? t("account.saved") : t("account.saveChanges")}
            </Button>
            <button
              type="button"
              onClick={() => void signOutCustomer()}
              className="text-sm font-semibold text-ink-faint underline-offset-2 hover:text-wine hover:underline"
            >
              {t("account.signOut")}
            </button>
          </div>
        </form>
      </div>
    </AccountShell>
  );
}
