import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { openRegister, RegisterSessionError } from "../firebase/registerSession";
import { adminsApi, branchesApi, registersApi } from "../firebase/collections";
import { useLanguage } from "../context/LanguageContext";
import { useAdminAuth } from "../admin/AdminAuthContext";
import { logActivity } from "../admin/logActivity";
import { PageLoading } from "../admin/components/ui";
import type { AdminUser, Branch, Register, RegisterSession } from "../admin/types";
import { localizedName } from "../data/localize";
import { NumberInput, type NumericValue } from "../components/ui/NumberInput";
import { pickerUrl, tillUrl } from "./posPaths";

export interface OpenRegisterPreset {
  branchCode: string | null;
  registerId: string | null;
  cashierId: string | null;
}

// Who may sell on a given register: owner/admin anywhere; a cashier only at
// their assigned branches (and, if narrowed, registers) -- the same rule
// firestore.rules enforces when the session is opened.
export function canSellOn(user: AdminUser, branchId: string, registerId: string | null): boolean {
  if (!user.active) return false;
  if (user.role === "owner" || user.role === "admin") return true;
  if (user.role !== "cashier" || !user.branchIds?.includes(branchId)) return false;
  return !registerId || !user.registerIds?.length || user.registerIds.includes(registerId);
}

// Start of a shift: branch -> register -> cashier -> float -> open. Each pick
// is mirrored into the URL (/pos/<branchCode>/<registerId>?cashier=<uid>), so
// a deep link or reload comes back to the same selection.
//
// Picking a cashier other than whoever is signed in asks for THAT person's
// password and signs them in on this device first: every sale records the
// signed-in user as its cashier (enforced by firestore.rules), so the name in
// the dropdown has to be the person actually signed in -- never just a label.
export default function OpenRegister({ preset, onOpened }: { preset: OpenRegisterPreset; onOpened: (session: RegisterSession) => void }) {
  const { t, lang } = useLanguage();
  const navigate = useNavigate();
  const { profile, hasRole, signIn } = useAdminAuth();
  const [branches, setBranches] = useState<Branch[] | null>(null);
  const [registers, setRegisters] = useState<Register[]>([]);
  const [staff, setStaff] = useState<AdminUser[]>([]);
  const [cashierId, setCashierId] = useState<string | null>(preset.cashierId);
  const [password, setPassword] = useState("");
  const [startingCash, setStartingCash] = useState<NumericValue>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isManager = hasRole(["owner", "admin"]);

  useEffect(() => {
    branchesApi.list().then(setBranches).catch(() => setBranches([]));
    const u1 = registersApi.subscribe(setRegisters); // live: "In use" updates as others open tills
    const u2 = adminsApi.subscribe(setStaff);
    return () => {
      u1();
      u2();
    };
  }, []);

  const allowedBranches = useMemo(() => {
    if (!branches || !profile) return [];
    const active = branches.filter((b) => b.active).sort((a, b) => a.name.localeCompare(b.name));
    return isManager ? active : active.filter((b) => profile.branchIds?.includes(b.id));
  }, [branches, profile, isManager]);

  // Selection comes from the URL; with exactly one branch there's nothing to choose.
  const branch =
    allowedBranches.find((b) => b.code === preset.branchCode) ?? (allowedBranches.length === 1 ? allowedBranches[0] : null);

  const branchRegisters = useMemo(() => {
    if (!branch) return [];
    const narrowed = !isManager && profile?.registerIds?.length ? profile.registerIds : null;
    return registers
      .filter((r) => r.branchId === branch.id && r.active && (!narrowed || narrowed.includes(r.id)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [registers, branch, isManager, profile]);

  const register = branchRegisters.find((r) => r.id === preset.registerId) ?? null;
  // A register picked a moment ago can be taken by someone else meanwhile.
  const registerBusy = !!register?.openSessionId;

  const eligibleCashiers = useMemo(() => {
    if (!branch) return [];
    return staff
      // Device identities have no password: never offered as a cashier.
      .filter((u) => !u.posLink && canSellOn(u, branch.id, register?.id ?? null))
      .sort((a, b) => (a.id === profile?.id ? -1 : b.id === profile?.id ? 1 : a.displayName.localeCompare(b.displayName)));
  }, [staff, branch, register, profile]);

  // Default the cashier to whoever is signed in (when they can sell here).
  const cashier = eligibleCashiers.find((u) => u.id === cashierId) ?? eligibleCashiers.find((u) => u.id === profile?.id) ?? null;
  const switchingUser = !!cashier && cashier.id !== profile?.id;

  function go(branchCode: string | null, registerId: string | null, cashierUid: string | null) {
    setError(null);
    navigate(pickerUrl(branchCode, registerId, cashierUid), { replace: true });
  }

  // Keep the URL's cashier in step with the dropdown's effective value.
  useEffect(() => {
    if (branch && register && cashier && preset.cashierId !== cashier.id) go(branch.code, register.id, cashier.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branch?.code, register?.id, cashier?.id]);

  // NumberInput's own char-filter (min={0} below) already keeps a negative
  // value from ever being typed or pasted in, but this stays as a real,
  // explicit guard rather than trusting that alone — a negative opening
  // float would silently corrupt reconciliation later ("Expected cash:
  // -50.00₪" on close).
  const invalidCash = startingCash !== null && startingCash < 0;
  const ready = !!branch && !!register && !!cashier && !registerBusy && startingCash !== null && !invalidCash && (!switchingUser || password.length > 0);

  async function handleOpen() {
    if (!ready || !branch || !register || !cashier) return;
    setSubmitting(true);
    setError(null);
    try {
      if (switchingUser) {
        try {
          await signIn(cashier.email, password);
        } catch {
          setError(t("pos.branch.wrongPassword").replace("{name}", cashier.displayName));
          return;
        }
      }
      const session = await openRegister({ id: cashier.id, name: cashier.displayName }, branch, register, startingCash ?? 0);
      // Phase A section 14: supplemental activity-log entry -- the session
      // document's own cashierId/cashierName remain the source of truth.
      await logActivity(
        { id: cashier.id, email: cashier.email, displayName: cashier.displayName },
        "pos.registerOpened",
        `${branch.name} · ${register.name}`
      );
      onOpened(session);
      navigate(tillUrl(session), { replace: true });
    } catch (err) {
      setError(err instanceof RegisterSessionError ? err.message : t("pos.branch.openFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  if (branches === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <PageLoading />
      </div>
    );
  }

  if (allowedBranches.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <h1 className="font-display text-2xl font-bold text-ink">{isManager ? t("pos.branch.noBranchesTitle") : t("pos.branch.notAssignedTitle")}</h1>
        <p className="max-w-sm text-sm text-ink-soft">{isManager ? t("pos.branch.noBranchesBody") : t("pos.branch.notAssignedBody")}</p>
        {isManager && (
          <Link to="/admin/branches" className="mt-2 rounded-full bg-wine px-6 py-3 text-sm font-semibold text-on-accent hover:bg-wine-dark">
            {t("pos.branch.setUpBranches")}
          </Link>
        )}
      </div>
    );
  }

  const step = "mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-ink-faint";
  const stepNum = "flex h-5 w-5 items-center justify-center rounded-full bg-wine text-[11px] text-on-accent";

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6 sm:p-10">
        <div>
          <h1 className="font-display text-2xl font-bold text-ink">{t("pos.openRegister.title")}</h1>
          <p className="mt-1 text-sm text-ink-soft">{t("pos.branch.startShiftSubtitle")}</p>
        </div>

        <section>
          <h2 className={step}>
            <span className={stepNum}>1</span>
            {t("pos.branch.branch")}
          </h2>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {allowedBranches.map((b) => (
              <button
                key={b.id}
                onClick={() => go(b.code, null, cashierId)}
                className={`flex items-center justify-between rounded-xl border-2 px-4 py-3 text-start transition-colors ${
                  branch?.id === b.id ? "border-wine bg-wine-light" : "border-line bg-paper hover:border-wine/50"
                }`}
              >
                <span>
                  <span className="block font-semibold text-ink">{localizedName(b.name, b.nameAr, lang)}</span>
                  {b.address && <span className="block text-xs text-ink-faint">{b.address}</span>}
                </span>
                <span className="rounded-md bg-cream-dim px-2 py-1 font-mono text-xs font-bold text-ink-soft">{b.code}</span>
              </button>
            ))}
          </div>
        </section>

        {branch && (
          <section>
            <h2 className={step}>
              <span className={stepNum}>2</span>
              {t("pos.branch.register")}
            </h2>
            {branchRegisters.length === 0 ? (
              <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-ink-soft">{t("pos.branch.noRegisters")}</p>
            ) : (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {branchRegisters.map((r) => {
                  const busy = !!r.openSessionId;
                  return (
                    <button
                      key={r.id}
                      disabled={busy}
                      onClick={() => go(branch.code, r.id, cashierId)}
                      className={`flex flex-col items-start gap-0.5 rounded-xl border-2 px-4 py-3 text-start transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                        register?.id === r.id ? "border-wine bg-wine-light" : "border-line bg-paper hover:border-wine/50"
                      }`}
                    >
                      <span className="font-semibold text-ink">{r.name}</span>
                      <span className={`text-xs font-semibold ${busy ? "text-wine" : "text-olive"}`}>{busy ? t("pos.branch.inUse") : t("pos.branch.available")}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {branch && register && (
          <section className="flex flex-col gap-4">
            <div>
              <h2 className={step}>
                <span className={stepNum}>3</span>
                {t("pos.branch.cashier")}
              </h2>
              {eligibleCashiers.length === 0 ? (
                <p className="rounded-xl border border-dashed border-line px-4 py-4 text-center text-sm text-ink-soft">{t("pos.branch.noCashiers")}</p>
              ) : (
                <select
                  value={cashier?.id ?? ""}
                  onChange={(e) => {
                    setCashierId(e.target.value);
                    setPassword("");
                    go(branch.code, register.id, e.target.value);
                  }}
                  className="w-full rounded-xl border border-line bg-paper px-4 py-3 text-base text-ink outline-none focus:border-wine"
                >
                  {eligibleCashiers.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.displayName}
                      {u.id === profile?.id ? ` (${t("admin.team.you")})` : ""} · {t(`admin.role.${u.role}`)}
                    </option>
                  ))}
                </select>
              )}
              {switchingUser && cashier && (
                <label className="mt-3 flex flex-col gap-1.5">
                  <span className="text-sm font-semibold text-ink">{t("pos.branch.cashierPassword").replace("{name}", cashier.displayName)}</span>
                  <input
                    type="password"
                    autoComplete="off"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="rounded-xl border border-line bg-paper px-4 py-3 text-base outline-none focus:border-wine"
                  />
                  <span className="text-xs text-ink-faint">{t("pos.branch.switchNote").replace("{name}", cashier.displayName)}</span>
                </label>
              )}
            </div>

            <label className="flex flex-col gap-1.5">
              <span className={step}>
                <span className={stepNum}>4</span>
                {t("pos.openRegister.startingCash")}
              </span>
              <NumberInput
                min={0}
                nullable
                value={startingCash}
                onChange={setStartingCash}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleOpen();
                }}
                className={`rounded-xl border bg-paper px-4 py-3 text-lg outline-none focus:border-wine ${invalidCash ? "border-wine" : "border-line"}`}
              />
              {invalidCash && <span className="text-xs font-semibold text-wine">{t("pos.openRegister.negativeCash")}</span>}
              <span className="text-xs text-ink-faint">{t("pos.openRegister.subtitle")}</span>
            </label>

            {error && <p className="rounded-lg bg-wine-light px-3 py-2 text-sm font-semibold text-wine">{error}</p>}
            <button
              onClick={() => void handleOpen()}
              disabled={submitting || !ready}
              className="rounded-full bg-wine py-4 text-base font-semibold text-on-accent hover:bg-wine-dark disabled:cursor-not-allowed disabled:opacity-40"
            >
              {submitting
                ? t("pos.openRegister.opening")
                : `${t("pos.openRegister.title")} · ${branch.code} · ${register.name}${cashier ? ` · ${cashier.displayName}` : ""}`}
            </button>
          </section>
        )}
      </div>
    </div>
  );
}
