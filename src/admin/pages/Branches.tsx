import { where } from "../../db/firestore";
import { Link } from "react-router-dom";
import { useEffect, useMemo, useRef, useState } from "react";
import { adminsApi, branchesApi, registersApi, registerSessionsApi } from "../../firebase/collections";
import { useLanguage } from "../../context/LanguageContext";
import { localizedName } from "../../data/localize";
import { useAdminAuth } from "../AdminAuthContext";
import { ConfirmDialog, Modal } from "../components/Modal";
import { useToast } from "../components/ToastContext";
import { AdminButton, AdminInput, Badge, Card, EmptyState, Field, PageHeader, PageLoading, Toggle } from "../components/ui";
import AdminIcon from "../components/AdminIcons";
import { logActivity } from "../logActivity";
import type { AdminUser, Branch, Register, RegisterSession } from "../types";
import { formatPrice } from "../../utils/currency";
import { RegisterHistoryModal, ShiftDetailModal } from "../components/ShiftHistory";
import { issuePosLink, posLinkUrl, revokePosLink, subscribeActivePosLinks, type PosLink } from "../../firebase/posLinks";
import { copyText } from "../../utils/copyText";
import { closeRegister, RegisterSessionError, sessionExpectedCash } from "../../firebase/registerSession";
import { NumberInput, type NumericValue } from "../../components/ui/NumberInput";

type BranchForm = { name: string; code: string; active: boolean };
const EMPTY_BRANCH: BranchForm = { name: "", code: "", active: true };

function tsToDate(v: unknown): Date | null {
  const ts = v as { toDate?: () => Date } | undefined;
  return ts?.toDate ? ts.toDate() : null;
}

// Branches and the POS registers (tills) inside each one, with live status:
// which register is open right now, by whom, since when and how much it has
// taken. Owner/admin only (route + firestore.rules).
export default function Branches() {
  const toast = useToast();
  const { t, lang } = useLanguage();
  const { profile } = useAdminAuth();
  const [branches, setBranches] = useState<Branch[] | null>(null);
  const [registers, setRegisters] = useState<Register[]>([]);
  const [staff, setStaff] = useState<AdminUser[]>([]);
  const [openSessions, setOpenSessions] = useState<RegisterSession[]>([]);
  const [branchForm, setBranchForm] = useState<{ id: string | null; data: BranchForm } | null>(null);
  const [registerForm, setRegisterForm] = useState<{ id: string | null; branchId: string; name: string; active: boolean; number?: number } | null>(null);
  const numbering = useRef(false);
  const [confirmDelete, setConfirmDelete] = useState<{ kind: "branch"; item: Branch } | { kind: "register"; item: Register } | null>(null);
  const [saving, setSaving] = useState(false);
  // null until the first snapshot; linksFailed when it couldn't be read, so
  // an unreadable list is never mistaken for "this register has no link".
  const [posLinks, setPosLinks] = useState<PosLink[] | null>(null);
  const [linksFailed, setLinksFailed] = useState(false);
  const autoIssued = useRef(new Set<string>());
  const [linkBusy, setLinkBusy] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<{ register: Register; link: PosLink } | null>(null);
  const [historyFor, setHistoryFor] = useState<Register | null>(null);
  const [shiftDetail, setShiftDetail] = useState<RegisterSession | null>(null);
  const [forceClose, setForceClose] = useState<RegisterSession | null>(null);
  const [countedCash, setCountedCash] = useState<NumericValue>(null);
  const [closing, setClosing] = useState(false);

  // Same as POS Sales' force close: ends a shift left open on a till.
  async function handleForceClose() {
    if (!forceClose || !profile) return;
    setClosing(true);
    try {
      await closeRegister(forceClose.id, countedCash, { uid: profile.id, email: profile.email, displayName: profile.displayName });
      await logActivity(profile, "pos.registerForceClosed", `${forceClose.branchName ?? ""} · ${forceClose.registerName ?? ""} · ${forceClose.cashierName}`);
      toast.success(t("pos.closeRegister.closed"));
      setForceClose(null);
    } catch (err) {
      toast.error(err instanceof RegisterSessionError ? err.message : t("admin.posSales.closeFailed"));
    } finally {
      setClosing(false);
    }
  }

  useEffect(() => {
    const u1 = branchesApi.subscribe(setBranches);
    const u2 = registersApi.subscribe(setRegisters);
    const u3 = registerSessionsApi.subscribe(setOpenSessions, [where("status", "==", "open")]);
    const u4 = subscribeActivePosLinks(
      (links) => {
        setLinksFailed(false);
        setPosLinks(links);
      },
      () => setLinksFailed(true)
    );
    const u5 = adminsApi.subscribe(setStaff);
    return () => {
      u5();
      u4();
      u1();
      u2();
      u3();
    };
  }, []);

  const sorted = useMemo(() => [...(branches ?? [])].sort((a, b) => a.name.localeCompare(b.name)), [branches]);
  const sessionById = useMemo(() => new Map(openSessions.map((s) => [s.id, s])), [openSessions]);
  const linkByRegister = useMemo(() => new Map((posLinks ?? []).map((l) => [l.registerId, l])), [posLinks]);

  // Every active register always has a POS link: any that lacks one (older
  // registers, or one whose link was just revoked) gets a fresh link issued
  // automatically, once per register per visit, so the card shows the URL
  // instead of a "Create link" button. Same rule as PosLinkPicker.
  useEffect(() => {
    if (!profile || !branches || posLinks === null || linksFailed) return;
    const missing = registers.filter((r) => r.active && !linkByRegister.has(r.id) && !autoIssued.current.has(r.id));
    for (const register of missing) {
      const branch = branches.find((b) => b.id === register.branchId);
      if (!branch) continue;
      autoIssued.current.add(register.id);
      issuePosLink(register, branch, profile.id)
        .then(() => logActivity(profile, "register.saved", `${register.name}: POS link issued`))
        .catch(() => toast.error(t("admin.branches.posLinkFailed")));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, branches, registers, posLinks, linksFailed, linkByRegister]);

  // Registers created before numbers existed get the next free numbers, once,
  // oldest first -- after that a register's number never changes.
  const nextRegisterNumber = useMemo(() => registers.reduce((max, r) => Math.max(max, r.number ?? 0), 0) + 1, [registers]);
  useEffect(() => {
    if (!profile || numbering.current) return;
    const missing = registers.filter((r) => typeof r.number !== "number");
    if (missing.length === 0) return;
    numbering.current = true;
    const created = (r: Register) => tsToDate(r.createdAt)?.getTime() ?? 0;
    let next = nextRegisterNumber;
    Promise.all([...missing].sort((a, b) => created(a) - created(b)).map((r) => registersApi.update(r.id, { number: next++ }))).catch(() => {
      numbering.current = false;
    });
  }, [profile, registers, nextRegisterNumber]);

  // Each register's own POS link: opens that till directly on any device,
  // no staff login (src/firebase/posLinks.ts). Issuing a new one revokes the
  // old one, so a leaked link is dead the moment it's replaced.
  async function makeLink(register: Register) {
    const branch = branches?.find((b) => b.id === register.branchId);
    if (!branch || !profile) return;
    setLinkBusy(register.id);
    try {
      const token = await issuePosLink(register, branch, profile.id);
      await logActivity(profile, "register.saved", `${register.name}: POS link issued`);
      await copyLink(token);
    } catch {
      toast.error(t("admin.branches.posLinkFailed"));
    } finally {
      setLinkBusy(null);
    }
  }

  async function copyLink(token: string) {
    if (await copyText(posLinkUrl(token))) toast.success(t("admin.branches.posLinkCopied"));
    else toast.error(t("admin.branches.posLinkCopyFailed"));
  }

  async function doRevoke() {
    if (!confirmRevoke || !profile) return;
    setLinkBusy(confirmRevoke.register.id);
    try {
      await revokePosLink(confirmRevoke.link.id);
      // Let the auto-issue effect give this register a fresh link: the old
      // URL (and any device using it) is dead, the register never sits linkless.
      autoIssued.current.delete(confirmRevoke.register.id);
      await logActivity(profile, "register.saved", `${confirmRevoke.register.name}: POS link revoked`);
      toast.success(t("admin.branches.posLinkRevoked"));
      setConfirmRevoke(null);
    } catch {
      toast.error(t("admin.branches.posLinkFailed"));
    } finally {
      setLinkBusy(null);
    }
  }

  async function saveBranch() {
    if (!branchForm || !profile) return;
    const d = branchForm.data;
    const code = d.code.trim().toUpperCase();
    if (!d.name.trim() || !code) {
      toast.error(t("admin.branches.errRequired"));
      return;
    }
    if (sorted.some((b) => b.code === code && b.id !== branchForm.id)) {
      toast.error(t("admin.branches.errCodeTaken"));
      return;
    }
    setSaving(true);
    try {
      // One name for both languages: clear any older Arabic name so a rename
      // shows everywhere. Address/phone are no longer edited here.
      const data = { name: d.name.trim(), nameAr: "", code, active: d.active };
      if (branchForm.id) {
        await branchesApi.update(branchForm.id, data);
        await logActivity(profile, "branch.updated", data.name);
      } else {
        await branchesApi.create(data);
        await logActivity(profile, "branch.created", data.name);
      }
      toast.success(t("admin.branches.saved"));
      setBranchForm(null);
    } finally {
      setSaving(false);
    }
  }

  async function saveRegister() {
    if (!registerForm || !profile) return;
    if (!registerForm.name.trim()) {
      toast.error(t("admin.branches.errRequired"));
      return;
    }
    setSaving(true);
    try {
      if (registerForm.id) {
        await registersApi.update(registerForm.id, { name: registerForm.name.trim(), active: registerForm.active });
      } else {
        // Its POS link is issued by the auto-issue effect above as soon as
        // the new register arrives in the live list.
        await registersApi.create({ branchId: registerForm.branchId, number: nextRegisterNumber, name: registerForm.name.trim(), active: true, openSessionId: null });
      }
      await logActivity(profile, "register.saved", registerForm.name.trim());
      toast.success(t("admin.branches.saved"));
      setRegisterForm(null);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!confirmDelete || !profile) return;
    if (confirmDelete.kind === "branch") {
      if (registers.some((r) => r.branchId === confirmDelete.item.id)) {
        toast.error(t("admin.branches.errBranchHasRegisters"));
        setConfirmDelete(null);
        return;
      }
      await branchesApi.remove(confirmDelete.item.id);
      await logActivity(profile, "branch.deleted", confirmDelete.item.name);
    } else {
      if (confirmDelete.item.openSessionId) {
        toast.error(t("admin.branches.errRegisterOpen"));
        setConfirmDelete(null);
        return;
      }
      await registersApi.remove(confirmDelete.item.id);
      await logActivity(profile, "register.deleted", confirmDelete.item.name);
    }
    toast.success(t("admin.branches.deleted"));
    setConfirmDelete(null);
  }

  if (branches === null) return <PageLoading />;

  return (
    <div>
      <PageHeader
        title={t("admin.nav.branches")}
        description={t("admin.branches.subtitle")}
        actions={
          <AdminButton variant="primary" icon="plus" onClick={() => setBranchForm({ id: null, data: EMPTY_BRANCH })}>
            {t("admin.branches.addBranch")}
          </AdminButton>
        }
      />

      {sorted.length === 0 ? (
        <EmptyState
          icon="map"
          title={t("admin.branches.emptyTitle")}
          body={t("admin.branches.emptyBody")}
          action={
            <AdminButton variant="primary" icon="plus" onClick={() => setBranchForm({ id: null, data: EMPTY_BRANCH })}>
              {t("admin.branches.addBranch")}
            </AdminButton>
          }
        />
      ) : (
        <div className="flex flex-col gap-4">
          {sorted.map((b) => {
            const regs = registers.filter((r) => r.branchId === b.id).sort((x, y) => x.name.localeCompare(y.name));
            // People assigned to this branch on the Team page (never POS device identities).
            const branchStaff = staff.filter((u) => !u.posLink && u.branchIds?.includes(b.id)).sort((x, y) => x.displayName.localeCompare(y.displayName));
            return (
              <Card key={b.id} className="p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="flex items-center gap-2 font-display text-lg font-bold text-ink">
                      <span className="rounded-md bg-cream-dim px-2 py-0.5 font-mono text-xs text-wine">{b.code}</span>
                      {localizedName(b.name, b.nameAr, lang)}
                      {!b.active && <Badge tone="neutral">{t("admin.team.inactive")}</Badge>}
                    </p>                  </div>
                  <div className="flex gap-2">
                    <Link
                      to={`/admin/branches/${b.id}/day`}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-wine px-3 py-1.5 text-sm font-semibold text-on-accent hover:bg-wine-dark"
                    >
                      <AdminIcon name="chart" className="h-4 w-4" />
                      {t("admin.dayEnd.title")}
                    </Link>
                    <AdminButton
                      size="sm"
                      icon="edit"
                      onClick={() =>
                        setBranchForm({
                          id: b.id,
                          data: { name: b.name, code: b.code, active: b.active },
                        })
                      }
                    >
                      {t("admin.common.edit")}
                    </AdminButton>
                    <AdminButton size="sm" icon="plus" onClick={() => setRegisterForm({ id: null, branchId: b.id, name: `${t("pos.branch.register")} ${regs.length + 1}`, active: true })}>
                      {t("admin.branches.addRegister")}
                    </AdminButton>
                    <button
                      onClick={() => setConfirmDelete({ kind: "branch", item: b })}
                      aria-label={t("admin.common.delete")}
                      className="flex h-9 w-9 items-center justify-center rounded-lg text-ink-faint hover:bg-wine-light hover:text-wine"
                    >
                      <AdminIcon name="trash" className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  <span className="me-1 flex items-center gap-1.5 text-xs font-bold text-ink-faint">
                    <AdminIcon name="users" className="h-3.5 w-3.5" />
                    {t("admin.branches.staff")} ({branchStaff.length})
                  </span>
                  {branchStaff.length === 0 ? (
                    <span className="text-xs text-ink-faint">{t("admin.branches.noStaff")}</span>
                  ) : (
                    branchStaff.map((u) => {
                      const only = regs.filter((r) => u.registerIds?.includes(r.id)).map((r) => r.name);
                      return (
                        <span
                          key={u.id}
                          title={u.email}
                          className={`inline-flex items-center gap-1 rounded-full border border-line bg-paper px-2.5 py-1 text-xs text-ink ${u.active ? "" : "opacity-50"}`}
                        >
                          <span className="font-semibold">{u.displayName || u.email}</span>
                          <span className="text-ink-faint">· {t(`admin.role.${u.role}`)}</span>
                          {only.length > 0 && <span className="text-ink-faint">· {only.join("، ")}</span>}
                          {!u.active && <span className="text-ink-faint">· {t("admin.team.inactive")}</span>}
                        </span>
                      );
                    })
                  )}
                </div>

                {regs.length === 0 ? (
                  <p className="mt-4 rounded-lg border border-dashed border-line px-4 py-4 text-center text-sm text-ink-faint">{t("admin.branches.noRegisters")}</p>
                ) : (
                  <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {regs.map((r) => {
                      const s = r.openSessionId ? sessionById.get(r.openSessionId) : undefined;
                      return (
                        <div key={r.id} className={`rounded-xl border p-3 ${s ? "border-olive/40 bg-olive-light/40" : "border-line"}`}>
                          <div className="flex items-center justify-between gap-2">
                            <p className="font-semibold text-ink">
                              {typeof r.number === "number" && <span className="me-1.5 rounded-md bg-cream-dim px-1.5 py-0.5 font-mono text-xs text-wine">#{r.number}</span>}
                              {r.name} {!r.active && <span className="text-xs font-normal text-ink-faint">({t("admin.team.inactive")})</span>}
                            </p>
                            <div className="flex items-center gap-1">
                              {s && (
                                <button
                                  onClick={() => {
                                setForceClose(s);
                                setCountedCash(null);
                              }}
                                  aria-label={t("admin.posSales.forceClose")}
                                  title={t("admin.posSales.forceClose")}
                                  className="flex h-7 w-7 items-center justify-center rounded-md text-ink-faint hover:bg-wine-light hover:text-wine"
                                >
                                  <AdminIcon name="logout" className="h-3.5 w-3.5" />
                                </button>
                              )}
                              <button
                                onClick={() => setHistoryFor(r)}
                                aria-label={t("admin.shifts.historyTitle")}
                                title={t("admin.shifts.historyTitle")}
                                className="flex h-7 w-7 items-center justify-center rounded-md text-ink-faint hover:bg-cream-dim hover:text-wine"
                              >
                                <AdminIcon name="history" className="h-3.5 w-3.5" />
                              </button>
                              <button
                                onClick={() => setRegisterForm({ id: r.id, branchId: r.branchId, name: r.name, active: r.active, number: r.number })}
                                aria-label={t("admin.common.edit")}
                                className="flex h-7 w-7 items-center justify-center rounded-md text-ink-faint hover:bg-cream-dim hover:text-wine"
                              >
                                <AdminIcon name="edit" className="h-3.5 w-3.5" />
                              </button>
                              <button
                                onClick={() => setConfirmDelete({ kind: "register", item: r })}
                                aria-label={t("admin.common.delete")}
                                className="flex h-7 w-7 items-center justify-center rounded-md text-ink-faint hover:bg-wine-light hover:text-wine"
                              >
                                <AdminIcon name="trash" className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </div>
                          {s ? (
                            <p className="mt-1 text-xs text-ink-soft">
                              <button onClick={() => setShiftDetail(s)} className="font-semibold text-olive hover:underline">
                                {t("admin.posSales.open")}
                              </button>{" "}
                              · {s.cashierName} ·{" "}
                              {tsToDate(s.openedAt)?.toLocaleTimeString(lang === "ar" ? "ar" : "en-US", { hour: "2-digit", minute: "2-digit" })} · {s.salesCount}{" "}
                              {t("admin.branches.salesShort")} · {formatPrice(s.grossTotal)}
                            </p>
                          ) : (
                            <p className="mt-1 text-xs text-ink-faint">
                              {r.openSessionId ? t("pos.branch.inUse") : r.active ? t("pos.branch.available") : t("admin.team.inactive")}
                            </p>
                          )}
                          {(() => {
                            const link = linkByRegister.get(r.id);
                            const busy = linkBusy === r.id;
                            return (
                              <div className="mt-3 border-t border-line/70 pt-3">
                                <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-ink-faint">
                                  <AdminIcon name="globe" className="h-3.5 w-3.5" />
                                  {t("admin.branches.posLink")}
                                </p>
                                {link ? (
                                  <>
                                    <div className="flex items-center gap-1.5">
                                      <code dir="ltr" className="min-w-0 flex-1 select-all truncate rounded-md bg-cream-dim px-2 py-1.5 text-[11px] text-ink-soft" title={posLinkUrl(link.id)}>
                                        {posLinkUrl(link.id)}
                                      </code>
                                      <AdminButton size="sm" variant="primary" icon="copy" onClick={() => void copyLink(link.id)}>
                                        {t("admin.branches.copy")}
                                      </AdminButton>
                                    </div>
                                    <p className={`mt-1.5 text-[11px] font-semibold ${r.openSessionId ? "text-olive" : "text-ink-faint"}`}>
                                      {r.openSessionId ? t("admin.branches.posLinkBound") : t("admin.branches.posLinkUnbound")}
                                    </p>
                                    <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                                      <button disabled={busy} onClick={() => void makeLink(r)} className="font-semibold text-ink-soft hover:text-wine disabled:opacity-50">
                                        {t("admin.branches.posLinkRegenerate")}
                                      </button>
                                      <button disabled={busy} onClick={() => setConfirmRevoke({ register: r, link })} className="font-semibold text-ink-soft hover:text-wine disabled:opacity-50">
                                        {t("admin.branches.posLinkRevoke")}
                                      </button>
                                    </div>
                                  </>
                                ) : (
                                  <AdminButton size="sm" icon="plus" loading={busy} disabled={!r.active} onClick={() => void makeLink(r)}>
                                    {t("admin.branches.posLinkCreate")}
                                  </AdminButton>
                                )}
                              </div>
                            );
                          })()}
                        </div>
                      );
                    })}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      <Modal open={!!branchForm} onClose={() => setBranchForm(null)} title={branchForm?.id ? t("admin.branches.editBranch") : t("admin.branches.addBranch")}>
        {branchForm && (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_8rem]">
              <Field label={t("admin.branches.name")} required>
                <AdminInput value={branchForm.data.name} onChange={(e) => setBranchForm({ ...branchForm, data: { ...branchForm.data, name: e.target.value } })} />
              </Field>
              <Field label={t("admin.branches.code")} required hint={t("admin.branches.codeHint")}>
                <AdminInput
                  value={branchForm.data.code}
                  maxLength={6}
                  onChange={(e) => setBranchForm({ ...branchForm, data: { ...branchForm.data, code: e.target.value.toUpperCase() } })}
                />
              </Field>
            </div>
            {branchForm.id && (
              <Toggle
                checked={branchForm.data.active}
                onChange={(v) => setBranchForm({ ...branchForm, data: { ...branchForm.data, active: v } })}
                label={t("admin.discounts.active")}
              />
            )}
            <AdminButton variant="primary" loading={saving} className="w-full justify-center" onClick={() => void saveBranch()}>
              {t("admin.common.save")}
            </AdminButton>
          </div>
        )}
      </Modal>

      <Modal open={!!registerForm} onClose={() => setRegisterForm(null)} title={registerForm?.id ? t("admin.branches.editRegister") : t("admin.branches.addRegister")} width="sm">
        {registerForm && (
          <div className="flex flex-col gap-4">
            <Field label={t("admin.branches.registerName")} required>
              <AdminInput autoFocus value={registerForm.name} onChange={(e) => setRegisterForm({ ...registerForm, name: e.target.value })} />
            </Field>
            <Field label={t("admin.branches.registerNumber")} hint={t("admin.branches.registerNumberHint")}>
              <AdminInput dir="ltr" readOnly disabled value={`#${registerForm.id ? registerForm.number ?? "—" : nextRegisterNumber}`} className="font-mono" />
            </Field>
            {registerForm.id && <Toggle checked={registerForm.active} onChange={(v) => setRegisterForm({ ...registerForm, active: v })} label={t("admin.discounts.active")} />}
            <AdminButton variant="primary" loading={saving} className="w-full justify-center" onClick={() => void saveRegister()}>
              {t("admin.common.save")}
            </AdminButton>
          </div>
        )}
      </Modal>

      <Modal open={!!forceClose} onClose={() => setForceClose(null)} title={t("admin.posSales.forceClose")} width="sm">
        {forceClose && (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-ink-soft">
              {forceClose.branchName} · {forceClose.registerName} · {forceClose.cashierName}
            </p>
            <p className="text-sm text-ink">
              {t("pos.closeRegister.expectedCash")}: <b>{formatPrice(sessionExpectedCash(forceClose))}</b>
            </p>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-semibold text-ink">{t("admin.posSales.countedOptional")}</span>
              <NumberInput
                min={0}
                nullable
                autoFocus
                value={countedCash}
                onChange={setCountedCash}
                placeholder="—"
                className="rounded-lg border border-line bg-paper px-3 py-2.5 outline-none focus:border-wine"
              />
              <span className="text-xs text-ink-faint">{t("admin.posSales.countedOptionalHint")}</span>
            </label>
            <AdminButton variant="primary" loading={closing} className="w-full justify-center" onClick={() => void handleForceClose()}>
              {t("pos.layout.closeRegister")}
            </AdminButton>
          </div>
        )}
      </Modal>

      <RegisterHistoryModal register={historyFor} onClose={() => setHistoryFor(null)} onOpenShift={setShiftDetail} />
      <ShiftDetailModal session={shiftDetail} onClose={() => setShiftDetail(null)} />

      <ConfirmDialog
        open={!!confirmRevoke}
        onClose={() => setConfirmRevoke(null)}
        onConfirm={() => void doRevoke()}
        title={t("admin.branches.posLinkRevoke")}
        body={`${confirmRevoke?.register.name ?? ""} — ${t("admin.branches.posLinkRevokeBody")}`}
        confirmLabel={t("admin.branches.posLinkRevoke")}
        loading={!!linkBusy}
        danger
      />

      <ConfirmDialog
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => void handleDelete()}
        title={confirmDelete?.kind === "branch" ? t("admin.branches.deleteBranch") : t("admin.branches.deleteRegister")}
        body={`${confirmDelete?.item.name ?? ""} — ${t("admin.branches.deleteBody")}`}
        confirmLabel={t("admin.common.delete")}
        danger
      />
    </div>
  );
}
