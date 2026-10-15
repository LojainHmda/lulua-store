import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAdminAuth } from "../admin/AdminAuthContext";
import { PageLoading } from "../admin/components/ui";
import { logActivity } from "../admin/logActivity";
import type { AdminUser, Branch, Register, RegisterSession } from "../admin/types";
import { NumberInput, type NumericValue } from "../components/ui/NumberInput";
import { useLanguage } from "../context/LanguageContext";
import { localizedName } from "../data/localize";
import { adminsApi, branchesApi, registersApi, registerSessionsApi } from "../firebase/collections";
import { openRegister, RegisterSessionError } from "../firebase/registerSession";
import { canSellOn } from "./OpenRegister";
import { tillUrl } from "./posPaths";

// Start of a shift on a POS device (opened from its register's link): the
// branch and register are fixed by the link, so the cashier only picks
// their name, counts the float and starts. No password -- the device itself
// is the signed-in identity; the picked name is recorded on the session and
// therefore on every sale of the shift (see orderTransaction.ts).
export default function DeviceStartShift({ onOpened }: { onOpened: (session: RegisterSession) => void }) {
  const { t, lang } = useLanguage();
  const navigate = useNavigate();
  const { profile } = useAdminAuth();
  const [branch, setBranch] = useState<Branch | null | undefined>(undefined);
  const [register, setRegister] = useState<Register | null | undefined>(undefined);
  const [staff, setStaff] = useState<AdminUser[]>([]);
  const [cashierId, setCashierId] = useState<string | null>(null);
  const [startingCash, setStartingCash] = useState<NumericValue>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A shift already open on this register under another identity (e.g. a
  // previous device before the link was re-issued): never start a second one.
  const [heldBy, setHeldBy] = useState<RegisterSession | null>(null);

  const branchId = profile?.branchIds?.[0];
  const registerId = profile?.registerIds?.[0];

  useEffect(() => {
    if (!branchId || !registerId) return;
    branchesApi.get(branchId).then((b) => setBranch(b ?? null)).catch(() => setBranch(null));
    const u1 = registersApi.subscribe((rs) => setRegister(rs.find((r) => r.id === registerId) ?? null));
    const u2 = adminsApi.subscribe(setStaff);
    return () => {
      u1();
      u2();
    };
  }, [branchId, registerId]);

  // Cashiers who may sell on this register -- never device identities, and
  // never owner/admin (they manage POS links, they don't run tills).
  const cashiers = useMemo(
    () =>
      branchId && registerId
        ? staff.filter((u) => !u.posLink && u.role === "cashier" && canSellOn(u, branchId, registerId)).sort((a, b) => a.displayName.localeCompare(b.displayName))
        : [],
    [staff, branchId, registerId]
  );
  const openSessionId = register?.openSessionId ?? null;
  useEffect(() => {
    if (!openSessionId) {
      setHeldBy(null);
      return;
    }
    registerSessionsApi
      .get(openSessionId)
      .then((s) => setHeldBy(s && s.status === "open" ? s : null))
      .catch(() => setHeldBy(null));
  }, [openSessionId]);

  const cashier = cashiers.find((c) => c.id === cashierId) ?? null;
  const ready = !!branch && !!register && !openSessionId && !!cashier && startingCash !== null && startingCash >= 0 && !submitting;

  async function start() {
    if (!ready || !branch || !register || !cashier || !profile) return;
    setSubmitting(true);
    setError(null);
    try {
      const session = await openRegister({ id: profile.id, name: cashier.displayName, operatorId: cashier.id }, branch, register, startingCash ?? 0);
      await logActivity({ id: profile.id, email: "", displayName: cashier.displayName }, "pos.registerOpened", `${branch.name} · ${register.name}`);
      onOpened(session);
      navigate(tillUrl(session), { replace: true });
    } catch (err) {
      setError(err instanceof RegisterSessionError ? err.message : t("pos.branch.openFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  if (branch === undefined || register === undefined) {
    return (
      <div className="flex h-full items-center justify-center">
        <PageLoading />
      </div>
    );
  }

  const label = "mb-3 flex items-center gap-2 text-sm font-bold text-ink";
  const num = "flex h-6 w-6 items-center justify-center rounded-full bg-wine text-xs text-on-accent";

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-xl flex-col gap-7 p-5 sm:p-10">
        <div>
          <h1 className="font-display text-2xl font-bold text-ink">{t("pos.device.title")}</h1>
          <p className="mt-1 text-sm text-ink-soft">
            {register?.name}
            {branch && <> · {localizedName(branch.name, branch.nameAr, lang)}</>}
          </p>
        </div>

        {!branch || !branch.active || !register || !register.active ? (
          <p className="rounded-xl bg-wine-light px-4 py-3 text-sm font-semibold text-wine">{t("pos.device.registerUnavailable")}</p>
        ) : openSessionId ? (
          <div className="rounded-xl border border-line bg-paper px-4 py-4 text-sm text-ink">
            <p className="font-semibold">{t("pos.device.shiftOpenTitle")}</p>
            {heldBy && (
              <p className="mt-1 text-ink-soft">
                {t("pos.branch.cashier")}: <b className="text-ink">{heldBy.cashierName}</b>
                {(() => {
                  const d = (heldBy.openedAt as { toDate?: () => Date } | undefined)?.toDate?.();
                  return d ? ` · ${d.toLocaleString(lang === "ar" ? "ar" : "en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : "";
                })()}
              </p>
            )}
            <p className="mt-2 text-ink-soft">{t("pos.device.shiftOpenBody")}</p>
          </div>
        ) : (
          <>
            <section>
              <h2 className={label}>
                <span className={num}>1</span>
                {t("pos.device.pickName")}
              </h2>
              {cashiers.length === 0 ? (
                <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-ink-soft">{t("pos.device.noCashiers")}</p>
              ) : (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {cashiers.map((c) => {
                    const on = c.id === cashierId;
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => setCashierId(c.id)}
                        aria-pressed={on}
                        className={`flex min-h-[3.5rem] items-center gap-2.5 rounded-xl border-2 px-3 py-2 text-start transition-colors active:scale-[0.98] ${
                          on ? "border-wine bg-wine-light" : "border-line bg-paper hover:border-wine/50"
                        }`}
                      >
                        <span
                          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold ${
                            on ? "bg-wine text-on-accent" : "bg-cream-dim text-ink-soft"
                          }`}
                        >
                          {c.displayName.trim().charAt(0).toUpperCase()}
                        </span>
                        <span className="min-w-0 truncate font-semibold text-ink">{c.displayName}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </section>

            <section>
              <h2 className={label}>
                <span className={num}>2</span>
                {t("pos.device.startingCash")}
              </h2>
              <NumberInput
                min={0}
                nullable
                value={startingCash}
                onChange={setStartingCash}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void start();
                }}
                placeholder="0.00"
                className="w-full rounded-xl border border-line bg-paper px-4 py-3.5 text-xl font-semibold outline-none focus:border-wine"
              />
            </section>

            {error && <p className="rounded-lg bg-wine-light px-3 py-2 text-sm font-semibold text-wine">{error}</p>}

            <button
              onClick={() => void start()}
              disabled={!ready}
              className="rounded-full bg-wine py-4 text-base font-bold text-on-accent hover:bg-wine-dark disabled:cursor-not-allowed disabled:opacity-40"
            >
              {submitting ? t("pos.device.starting") : t("pos.device.start")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
