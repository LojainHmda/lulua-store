import { where } from "firebase/firestore";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useAdminAuth } from "../admin/AdminAuthContext";
import { PageLoading } from "../admin/components/ui";
import { useToast } from "../admin/components/ToastContext";
import { logActivity } from "../admin/logActivity";
import type { Branch, Register, RegisterSession } from "../admin/types";
import { useLanguage } from "../context/LanguageContext";
import { localizedName } from "../data/localize";
import { branchesApi, registersApi, registerSessionsApi } from "../firebase/collections";
import { issuePosLink, posLinkUrl, subscribeActivePosLinks, type PosLink } from "../firebase/posLinks";
import { copyText } from "../utils/copyText";
import { pickerUrl } from "./posPaths";

// /pos for owner/admin: they never ring up sales themselves. They pick a
// branch, then a POS, and copy that POS's link to send to the device the
// cashier will use. Selection lives in the URL (/pos/<branchCode>/<registerId>).
export default function PosLinkPicker() {
  const { t, lang } = useLanguage();
  const navigate = useNavigate();
  const toast = useToast();
  const { profile } = useAdminAuth();
  const { branchCode, registerId } = useParams();
  const [branches, setBranches] = useState<Branch[] | null>(null);
  const [registers, setRegisters] = useState<Register[]>([]);
  const [openSessions, setOpenSessions] = useState<RegisterSession[]>([]);
  // null until the first snapshot arrives, so "no link yet" is never
  // confused with "not loaded yet" (or a failed read).
  const [links, setLinks] = useState<PosLink[] | null>(null);
  const [linksFailed, setLinksFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  // Registers this screen already tried to issue a link for, so a failed or
  // still-propagating issue never loops.
  const autoIssued = useRef(new Set<string>());

  useEffect(() => {
    const u1 = branchesApi.subscribe(setBranches);
    const u2 = registersApi.subscribe(setRegisters);
    const u3 = registerSessionsApi.subscribe(setOpenSessions, [where("status", "==", "open")]);
    const u4 = subscribeActivePosLinks(
      (l) => {
        setLinks(l);
        setLinksFailed(false);
      },
      () => setLinksFailed(true)
    );
    return () => {
      u1();
      u2();
      u3();
      u4();
    };
  }, []);

  const activeBranches = useMemo(() => (branches ?? []).filter((b) => b.active).sort((a, b) => a.name.localeCompare(b.name)), [branches]);
  const branch = activeBranches.find((b) => b.code === branchCode) ?? (activeBranches.length === 1 ? activeBranches[0] : null);
  const branchRegisters = useMemo(
    () => (branch ? registers.filter((r) => r.branchId === branch.id && r.active).sort((a, b) => a.name.localeCompare(b.name)) : []),
    [registers, branch]
  );
  const register = branchRegisters.find((r) => r.id === registerId) ?? null;
  const link = register && links ? links.find((l) => l.registerId === register.id) : undefined;
  const sessionById = useMemo(() => new Map(openSessions.map((s) => [s.id, s])), [openSessions]);

  async function copy(token: string) {
    if (await copyText(posLinkUrl(token))) toast.success(t("admin.branches.posLinkCopied"));
    else toast.error(t("admin.branches.posLinkCopyFailed"));
  }

  // `copyAfter` is false for the automatic first link: no click, so the
  // clipboard would refuse the write anyway.
  async function makeLink(copyAfter = true) {
    if (!branch || !register || !profile) return;
    setBusy(true);
    try {
      const token = await issuePosLink(register, branch, profile.id);
      await logActivity(profile, "register.saved", `${register.name}: POS link issued`);
      if (copyAfter) await copy(token);
    } catch {
      toast.error(t("admin.branches.posLinkFailed"));
    } finally {
      setBusy(false);
    }
  }

  // Every register simply has a link: picking one that has none yet issues
  // it once, right away. Only after the live link list has loaded without
  // error -- issuing revokes any existing link, so acting on a not-yet-loaded
  // (empty) list would kill a link that is in use. Regenerate stays manual.
  const needsLink = !!register && links !== null && !linksFailed && !link;
  useEffect(() => {
    if (!needsLink || !register || busy || autoIssued.current.has(register.id)) return;
    autoIssued.current.add(register.id);
    void makeLink(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsLink, register?.id, busy]);

  if (branches === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <PageLoading />
      </div>
    );
  }

  const step = "mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-ink-faint";
  const stepNum = "flex h-5 w-5 items-center justify-center rounded-full bg-wine text-[11px] text-on-accent";

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6 sm:p-10">
        <div>
          <h1 className="font-display text-2xl font-bold text-ink">{t("pos.links.title")}</h1>
          <p className="mt-1 text-sm text-ink-soft">{t("pos.links.subtitle")}</p>
        </div>

        {activeBranches.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-ink-soft">{t("pos.branch.noBranchesBody")}</p>
        ) : (
          <section>
            <h2 className={step}>
              <span className={stepNum}>1</span>
              {t("pos.branch.branch")}
            </h2>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {activeBranches.map((b) => (
                <button
                  key={b.id}
                  onClick={() => navigate(pickerUrl(b.code), { replace: true })}
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
        )}

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
                  const s = r.openSessionId ? sessionById.get(r.openSessionId) : undefined;
                  return (
                    <button
                      key={r.id}
                      onClick={() => navigate(pickerUrl(branch.code, r.id), { replace: true })}
                      className={`flex flex-col items-start gap-0.5 rounded-xl border-2 px-4 py-3 text-start transition-colors ${
                        register?.id === r.id ? "border-wine bg-wine-light" : "border-line bg-paper hover:border-wine/50"
                      }`}
                    >
                      <span className="font-semibold text-ink">{r.name}</span>
                      <span className={`text-xs font-semibold ${r.openSessionId ? "text-wine" : "text-olive"}`}>
                        {r.openSessionId ? `${t("pos.branch.inUse")}${s ? ` · ${s.cashierName}` : ""}` : t("pos.branch.available")}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {branch && register && (
          <section>
            <h2 className={step}>
              <span className={stepNum}>3</span>
              {t("admin.branches.posLink")}
            </h2>
            {link ? (
              <div className="flex flex-col gap-2 rounded-xl border border-line bg-paper p-4">
                <code dir="ltr" className="select-all break-all rounded-lg bg-cream-dim px-3 py-2.5 text-sm text-ink">
                  {posLinkUrl(link.id)}
                </code>
                <p className={`text-xs font-semibold ${register.openSessionId ? "text-olive" : "text-ink-faint"}`}>
                  {register.openSessionId ? t("admin.branches.posLinkBound") : t("admin.branches.posLinkUnbound")}
                </p>
                <div className="flex gap-2">
                  <button onClick={() => void copy(link.id)} className="flex-1 rounded-full bg-wine py-3 text-sm font-semibold text-on-accent hover:bg-wine-dark">
                    {t("admin.branches.copy")}
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => void makeLink()}
                    className="rounded-full border border-line px-5 py-3 text-sm font-semibold text-ink hover:bg-cream-dim disabled:opacity-50"
                  >
                    {t("admin.branches.posLinkRegenerate")}
                  </button>
                </div>
              </div>
            ) : busy || (links === null && !linksFailed) ? (
              // The link is loading or being issued automatically.
              <div className="flex flex-col gap-2 rounded-xl border border-line bg-paper p-4" aria-busy>
                <div className="h-10 animate-pulse rounded-lg bg-cream-dim" />
                <div className="h-3 w-32 animate-pulse rounded bg-cream-dim" />
                <div className="h-11 animate-pulse rounded-full bg-cream-dim" />
              </div>
            ) : (
              // Fallback only: automatic issuing failed (or the list couldn't load).
              <button
                disabled={busy}
                onClick={() => void makeLink()}
                className="w-full rounded-full bg-wine py-3.5 text-sm font-semibold text-on-accent hover:bg-wine-dark disabled:opacity-50"
              >
                {t("admin.branches.posLinkCreate")}
              </button>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
