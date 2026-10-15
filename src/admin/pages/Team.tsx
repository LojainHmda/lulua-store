import { deleteApp, initializeApp } from "firebase/app";
import { connectAuthEmulator, createUserWithEmailAndPassword, getAuth, signInWithEmailAndPassword, updatePassword, updateProfile } from "firebase/auth";
import { useEffect, useState } from "react";
import { adminsApi, branchesApi, registersApi } from "../../firebase/collections";
import { emulatorPorts, firebaseConfig, useFirebaseEmulators } from "../../firebase/config";
import { useLanguage } from "../../context/LanguageContext";
import { copyText } from "../../utils/copyText";
import { toAuthEmail, useAdminAuth } from "../AdminAuthContext";
import AdminIcon from "../components/AdminIcons";
import { ConfirmDialog, Modal } from "../components/Modal";
import { useToast } from "../components/ToastContext";
import { AdminButton, AdminInput, AdminSelect, Badge, EmptyState, Field, PageHeader, PageLoading, Toggle } from "../components/ui";
import { logActivity } from "../logActivity";
import type { AdminRole, AdminUser, Branch, Register } from "../types";
import { localizedName } from "../../data/localize";

const ROLE_TONE: Record<AdminRole, "danger" | "warning" | "info" | "neutral"> = {
  owner: "danger",
  admin: "warning",
  editor: "info",
  viewer: "neutral",
  cashier: "info",
};

function randomPassword(): string {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2, 8).toUpperCase() + "!1";
}

export default function Team() {
  const toast = useToast();
  const { t, lang } = useLanguage();
  const { profile: currentProfile } = useAdminAuth();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [registers, setRegisters] = useState<Register[]>([]);
  // Cashier branch/register assignment (multi-branch POS). Enforced by
  // firestore.rules via admins/{uid}.branchIds, not just by the POS UI.
  const [assigning, setAssigning] = useState<{ admin: AdminUser; branchIds: string[]; registerIds: string[] } | null>(null);
  const [savingAssign, setSavingAssign] = useState(false);
  const [admins, setAdmins] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInvite, setShowInvite] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<AdminRole>("editor");
  const [inviteBranchIds, setInviteBranchIds] = useState<string[]>([]);
  const [inviting, setInviting] = useState(false);
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [createdEmail, setCreatedEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<AdminUser | null>(null);
  const [confirmRoleChange, setConfirmRoleChange] = useState<{ admin: AdminUser; newRole: AdminRole } | null>(null);
  const [copied, setCopied] = useState(false);
  const [editingName, setEditingName] = useState<AdminUser | null>(null);
  const [nameInput, setNameInput] = useState("");
  const [savingName, setSavingName] = useState(false);

  useEffect(() => {
    const unsub = adminsApi.subscribe((data) => {
      // POS device identities (opened from a register's link) aren't people;
      // they're managed from Branches -> the register's POS link.
      setAdmins(data.filter((a) => !a.posLink));
      setLoading(false);
    });
    const u2 = branchesApi.subscribe((b) => setBranches(b.sort((x, y) => x.name.localeCompare(y.name))));
    const u3 = registersApi.subscribe((r) => setRegisters(r.sort((x, y) => x.name.localeCompare(y.name))));
    return () => {
      unsub();
      u2();
      u3();
    };
  }, []);

  async function saveAssignment() {
    if (!assigning) return;
    setSavingAssign(true);
    try {
      // A register only counts while its branch is assigned too.
      const registerIds = assigning.registerIds.filter((rid) => assigning.branchIds.includes(registers.find((r) => r.id === rid)?.branchId ?? ""));
      await adminsApi.update(assigning.admin.id, { branchIds: assigning.branchIds, registerIds });
      if (currentProfile) {
        const names = branches.filter((b) => assigning.branchIds.includes(b.id)).map((b) => b.code).join(", ") || "—";
        await logActivity(currentProfile, "team.branchesAssigned", assigning.admin.email, names);
      }
      toast.success(t("admin.team.branchesSaved"));
      setAssigning(null);
    } finally {
      setSavingAssign(false);
    }
  }

  const ownerCount = admins.filter((a) => a.role === "owner" && a.active).length;

  async function handleInvite() {
    if (!name.trim() || !email.trim()) {
      toast.error(t("admin.team.errRequired"));
      return;
    }
    // A cashier with no branch can sign in but can't sell anywhere.
    if (role === "cashier" && inviteBranchIds.length === 0) {
      toast.error(t("admin.team.errBranchRequired"));
      return;
    }
    setInviting(true);
    const password = randomPassword();
    const secondaryApp = initializeApp(firebaseConfig, `admin-invite-${Date.now()}`);
    try {
      const secondaryAuth = getAuth(secondaryApp);
      if (useFirebaseEmulators) connectAuthEmulator(secondaryAuth, `http://127.0.0.1:${emulatorPorts.auth}`, { disableWarnings: true });
      const cred = await createUserWithEmailAndPassword(secondaryAuth, toAuthEmail(email.trim()), password);
      await updateProfile(cred.user, { displayName: name.trim() });
      await secondaryAuth.signOut();

      await adminsApi.createWithId(cred.user.uid, {
        email: toAuthEmail(email.trim()),
        displayName: name.trim(),
        role,
        active: true,
        ...(role === "cashier" ? { branchIds: inviteBranchIds, registerIds: [] } : {}),
      });

      if (currentProfile) await logActivity(currentProfile, "team.invited", email.trim());
      setTempPassword(password);
      setCreatedEmail(toAuthEmail(email.trim()));
      setNewPassword("");
      setName("");
      setEmail("");
      setRole("editor");
      setInviteBranchIds([]);
      toast.success(t("admin.team.accountCreated"));
    } catch (err) {
      const code = (err as { code?: string }).code ?? "";
      toast.error(code === "auth/email-already-in-use" ? t("admin.team.errEmailInUse") : t("admin.team.errCreateFailed"));
    } finally {
      await deleteApp(secondaryApp).catch(() => {});
      setInviting(false);
    }
  }

  function openEditName(admin: AdminUser) {
    setEditingName(admin);
    setNameInput(admin.displayName);
  }

  // Deliberately touches only displayName — auth identity (email/uid) and
  // role/active are edited through their own separate, already-existing
  // controls, never through this one, so a name edit can never accidentally
  // change what an employee can do or how they sign in.
  // Right after creating an account: swap the generated password for one the
  // owner picks. Signs in as the new account on a throwaway app instance (so
  // the owner's own session is untouched) and updates its password.
  async function changeNewPassword() {
    if (!tempPassword || !createdEmail) return;
    if (newPassword.length < 6) {
      toast.error(t("admin.team.passwordTooShort"));
      return;
    }
    setSavingPassword(true);
    const secondaryApp = initializeApp(firebaseConfig, `admin-password-${Date.now()}`);
    try {
      const secondaryAuth = getAuth(secondaryApp);
      if (useFirebaseEmulators) connectAuthEmulator(secondaryAuth, `http://127.0.0.1:${emulatorPorts.auth}`, { disableWarnings: true });
      const cred = await signInWithEmailAndPassword(secondaryAuth, createdEmail, tempPassword);
      await updatePassword(cred.user, newPassword);
      await secondaryAuth.signOut();
      setTempPassword(newPassword);
      setNewPassword("");
      toast.success(t("admin.team.passwordChanged"));
    } catch {
      toast.error(t("admin.team.passwordChangeFailed"));
    } finally {
      await deleteApp(secondaryApp).catch(() => {});
      setSavingPassword(false);
    }
  }

  async function saveName() {
    if (!editingName) return;
    const trimmed = nameInput.trim();
    if (!trimmed) {
      toast.error(t("admin.team.errNameRequired"));
      return;
    }
    setSavingName(true);
    try {
      await adminsApi.update(editingName.id, { displayName: trimmed });
      if (currentProfile) {
        await logActivity(currentProfile, "team.nameChanged", editingName.email, `"${editingName.displayName}" → "${trimmed}"`);
      }
      toast.success(t("admin.team.nameUpdated"));
      setEditingName(null);
    } finally {
      setSavingName(false);
    }
  }

  function requestRoleChange(admin: AdminUser, newRole: AdminRole) {
    if (newRole === admin.role) return;
    if (admin.role === "owner" && newRole !== "owner" && ownerCount <= 1) {
      toast.error(t("admin.team.errLastOwnerDemote"));
      return;
    }
    setConfirmRoleChange({ admin, newRole });
  }

  async function confirmUpdateRole() {
    if (!confirmRoleChange) return;
    const { admin, newRole } = confirmRoleChange;
    await adminsApi.update(admin.id, { role: newRole });
    if (currentProfile) await logActivity(currentProfile, "team.roleChanged", `${admin.email} → ${t(`admin.role.${newRole}`)}`);
    toast.success(t("admin.team.roleUpdated"));
    setConfirmRoleChange(null);
  }

  async function toggleActive(admin: AdminUser) {
    if (admin.role === "owner" && admin.active && ownerCount <= 1) {
      toast.error(t("admin.team.errLastOwnerDeactivate"));
      return;
    }
    await adminsApi.update(admin.id, { active: !admin.active });
    if (currentProfile) await logActivity(currentProfile, admin.active ? "team.deactivated" : "team.reactivated", admin.email);
    toast.success(admin.active ? t("admin.team.deactivated") : t("admin.team.reactivated"));
  }

  async function handleRemove() {
    if (!confirmRemove) return;
    if (confirmRemove.role === "owner" && ownerCount <= 1) {
      toast.error(t("admin.team.errLastOwnerRemove"));
      setConfirmRemove(null);
      return;
    }
    await adminsApi.remove(confirmRemove.id);
    if (currentProfile) await logActivity(currentProfile, "team.removed", confirmRemove.email);
    toast.success(t("admin.team.removed"));
    setConfirmRemove(null);
  }

  if (loading) return <PageLoading />;

  return (
    <div>
      <PageHeader
        title={t("admin.nav.team")}
        description={t("admin.team.subtitle")}
        actions={<AdminButton variant="primary" icon="plus" onClick={() => setShowInvite(true)}>{t("admin.team.addAdmin")}</AdminButton>}
      />

      {admins.length === 0 ? (
        <EmptyState icon="users" title={t("admin.team.noneYet")} />
      ) : (
        <div className="flex flex-col gap-2">
          {admins.map((admin) => (
            <div key={admin.id} className="flex flex-wrap items-center gap-4 rounded-xl border border-line bg-paper p-4 shadow-soft">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-wine text-sm font-bold text-on-accent">
                {admin.displayName.slice(0, 1).toUpperCase()}
              </div>
              <div className="min-w-[160px] flex-1">
                <p className="flex items-center gap-1.5 font-semibold text-ink">
                  {admin.displayName} {admin.id === currentProfile?.id && <span className="text-xs font-normal text-ink-faint">({t("admin.team.you")})</span>}
                  <button
                    onClick={() => openEditName(admin)}
                    aria-label={t("admin.team.editName")}
                    title={t("admin.team.editName")}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-faint hover:bg-cream-dim hover:text-wine"
                  >
                    <AdminIcon name="edit" className="h-3.5 w-3.5" />
                  </button>
                </p>
                <p className="text-sm text-ink-soft">{admin.email}</p>
              </div>
              <Badge tone={ROLE_TONE[admin.role]}>{t(`admin.role.${admin.role}`)}</Badge>
              {!admin.active && <Badge tone="neutral">{t("admin.team.inactive")}</Badge>}
              {admin.role === "cashier" && (
                <button
                  onClick={() => setAssigning({ admin, branchIds: admin.branchIds ?? [], registerIds: admin.registerIds ?? [] })}
                  className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-sm font-semibold text-ink hover:border-wine"
                >
                  <AdminIcon name="map" className="h-4 w-4" />
                  {admin.branchIds?.length
                    ? branches.filter((b) => admin.branchIds?.includes(b.id)).map((b) => b.code).join(", ") || t("admin.team.branches")
                    : <span className="text-wine">{t("admin.team.noBranch")}</span>}
                </button>
              )}

              <AdminSelect value={admin.role} onChange={(e) => requestRoleChange(admin, e.target.value as AdminRole)} className="w-auto">
                <option value="owner">{t("admin.role.owner")}</option>
                <option value="admin">{t("admin.role.admin")}</option>
                <option value="editor">{t("admin.role.editor")}</option>
                <option value="cashier">{t("admin.role.cashier")}</option>
                <option value="viewer">{t("admin.role.viewer")}</option>
              </AdminSelect>

              <label className="flex items-center gap-2 text-sm text-ink-soft">
                <Toggle checked={admin.active} onChange={() => toggleActive(admin)} />
                {t("admin.discounts.active")}
              </label>

              <button onClick={() => setConfirmRemove(admin)} className="flex h-9 w-9 items-center justify-center rounded-lg text-ink-faint hover:bg-wine-light hover:text-wine">
                <AdminIcon name="trash" className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      <Modal
        open={showInvite}
        onClose={() => {
          setShowInvite(false);
          setTempPassword(null);
          setCopied(false);
        }}
        title={t("admin.team.addAdmin")}
      >
        {tempPassword ? (
          <div className="text-center">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-olive-light text-olive">
              <AdminIcon name="check" className="h-6 w-6" />
            </div>
            <p className="font-semibold text-ink">{t("admin.team.accountCreated")}</p>
            <p className="mt-2 text-sm text-ink-soft">{t("admin.team.sharePasswordNote")}</p>
            <div className="mt-3 flex items-center gap-2 rounded-lg bg-cream-dim px-4 py-2.5">
              <p className="flex-1 select-all font-mono text-sm font-semibold text-ink">{tempPassword}</p>
              <button
                type="button"
                onClick={() => {
                  void copyText(tempPassword ?? "").then((ok) => {
                    if (!ok) return;
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  });
                }}
                className="shrink-0 rounded-md px-2 py-1 text-xs font-semibold text-wine hover:bg-wine-light"
              >
                {copied ? t("admin.team.copied") : t("admin.team.copy")}
              </button>
            </div>
            <div className="mt-3 flex gap-2">
              <AdminInput
                dir="ltr"
                type="text"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void changeNewPassword()}
                placeholder={t("admin.team.newPasswordPlaceholder")}
                className="font-mono"
              />
              <AdminButton variant="secondary" loading={savingPassword} disabled={!newPassword} className="shrink-0" onClick={() => void changeNewPassword()}>
                {t("admin.team.changePassword")}
              </AdminButton>
            </div>
            <AdminButton
              variant="primary"
              className="mt-4 w-full justify-center"
              onClick={() => {
                setShowInvite(false);
                setTempPassword(null);
              }}
            >
              {t("admin.team.done")}
            </AdminButton>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <Field label={t("admin.categories.name")} required>
              <AdminInput value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label={t("admin.login.email")} required>
              <AdminInput type="text" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label={t("admin.team.role")} required>
              <AdminSelect value={role} onChange={(e) => setRole(e.target.value as AdminRole)}>
                <option value="admin">{t("admin.team.roleDescAdmin")}</option>
                <option value="editor">{t("admin.team.roleDescEditor")}</option>
                <option value="cashier">{t("admin.team.roleDescCashier")}</option>
                <option value="viewer">{t("admin.team.roleDescViewer")}</option>
                <option value="owner">{t("admin.team.roleDescOwner")}</option>
              </AdminSelect>
            </Field>
            {role === "cashier" && (
              <Field label={t("admin.team.assignBranches")} required>
                {branches.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-line px-4 py-3 text-center text-sm text-ink-faint">{t("admin.branches.emptyTitle")}</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {branches.map((b) => {
                      const on = inviteBranchIds.includes(b.id);
                      return (
                        <label
                          key={b.id}
                          className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold text-ink ${on ? "border-wine bg-wine-light/40" : "border-line"}`}
                        >
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() => setInviteBranchIds(on ? inviteBranchIds.filter((x) => x !== b.id) : [...inviteBranchIds, b.id])}
                            className="h-4 w-4 accent-wine"
                          />
                          <span className="font-mono text-xs text-wine">{b.code}</span>
                          {localizedName(b.name, b.nameAr, lang)}
                        </label>
                      );
                    })}
                  </div>
                )}
              </Field>
            )}
            <AdminButton variant="primary" loading={inviting} className="mt-1 w-full justify-center" onClick={handleInvite}>
              {t("admin.team.createAccount")}
            </AdminButton>
          </div>
        )}
      </Modal>

      <Modal open={!!assigning} onClose={() => setAssigning(null)} title={t("admin.team.assignBranches")}>
        {assigning && (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-ink-soft">
              {assigning.admin.displayName} · {t("admin.team.assignBranchesHint")}
            </p>
            {branches.length === 0 ? (
              <p className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-sm text-ink-faint">{t("admin.branches.emptyTitle")}</p>
            ) : (
              <div className="flex flex-col gap-2">
                {branches.map((b) => {
                  const on = assigning.branchIds.includes(b.id);
                  const regs = registers.filter((r) => r.branchId === b.id);
                  return (
                    <div key={b.id} className={`rounded-xl border p-3 ${on ? "border-wine bg-wine-light/40" : "border-line"}`}>
                      <label className="flex cursor-pointer items-center gap-2 font-semibold text-ink">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() =>
                            setAssigning({
                              ...assigning,
                              branchIds: on ? assigning.branchIds.filter((x) => x !== b.id) : [...assigning.branchIds, b.id],
                            })
                          }
                          className="h-4 w-4 accent-wine"
                        />
                        <span className="font-mono text-xs text-wine">{b.code}</span>
                        {localizedName(b.name, b.nameAr, lang)}
                      </label>
                      {on && regs.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5 ps-6">
                          {regs.map((r) => {
                            const rOn = assigning.registerIds.includes(r.id);
                            return (
                              <button
                                key={r.id}
                                onClick={() =>
                                  setAssigning({
                                    ...assigning,
                                    registerIds: rOn ? assigning.registerIds.filter((x) => x !== r.id) : [...assigning.registerIds, r.id],
                                  })
                                }
                                className={`rounded-full border px-3 py-1 text-xs font-semibold ${rOn ? "border-wine bg-wine text-on-accent" : "border-line text-ink-soft"}`}
                              >
                                {r.name}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
                <p className="text-xs text-ink-faint">{t("admin.team.registersHint")}</p>
              </div>
            )}
            <AdminButton variant="primary" loading={savingAssign} className="w-full justify-center" onClick={() => void saveAssignment()}>
              {t("admin.common.save")}
            </AdminButton>
          </div>
        )}
      </Modal>

      <Modal open={!!editingName} onClose={() => setEditingName(null)} title={t("admin.team.editName")} width="sm">
        <div className="flex flex-col gap-4">
          <Field label={t("admin.categories.name")} required>
            <AdminInput value={nameInput} onChange={(e) => setNameInput(e.target.value)} />
          </Field>
          <AdminButton variant="primary" loading={savingName} className="w-full justify-center" onClick={saveName}>
            {t("admin.team.saveName")}
          </AdminButton>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!confirmRemove}
        onClose={() => setConfirmRemove(null)}
        onConfirm={handleRemove}
        title={t("admin.team.removeAdmin")}
        body={`${confirmRemove?.email} ${t("admin.team.removeBody")}`}
        confirmLabel={t("admin.team.remove")}
        danger
      />

      <ConfirmDialog
        open={!!confirmRoleChange}
        onClose={() => setConfirmRoleChange(null)}
        onConfirm={confirmUpdateRole}
        title={t("admin.team.changeRole")}
        body={
          confirmRoleChange
            ? `${confirmRoleChange.admin.email} — ${t(`admin.role.${confirmRoleChange.admin.role}`)} → ${t(`admin.role.${confirmRoleChange.newRole}`)}`
            : ""
        }
        confirmLabel={t("admin.team.changeRole")}
      />
    </div>
  );
}
