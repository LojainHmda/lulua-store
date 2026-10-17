import { collection, doc, getDocs, writeBatch } from "../../db/firestore";
import { useRef, useState } from "react";
import { db } from "../../firebase/config";
import { useLanguage } from "../../context/LanguageContext";
import { useAdminAuth } from "../AdminAuthContext";
import AdminIcon from "../components/AdminIcons";
import { ConfirmDialog } from "../components/Modal";
import { useToast } from "../components/ToastContext";
import { AdminButton, Card, PageHeader } from "../components/ui";
import { logActivity } from "../logActivity";

const BACKUP_COLLECTIONS = ["products", "categories", "orders", "customers", "discounts", "reviews", "media"];
const BACKUP_DOCS: [string, string][] = [
  ["siteContent", "homepage"],
  ["settings", "general"],
  ["settings", "appearance"],
  ["settings", "language"],
  ["settings", "seo"],
  ["settings", "contact"],
  ["settings", "shipping"],
  ["settings", "payment"],
  ["settings", "search"],
  ["settings", "notifications"],
];

interface BackupFile {
  createdAt: string;
  collections: Record<string, Record<string, unknown>[]>;
  docs: Record<string, Record<string, unknown>>;
}

export default function Backup() {
  const toast = useToast();
  const { t } = useLanguage();
  const { profile } = useAdminAuth();
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [pendingFile, setPendingFile] = useState<BackupFile | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function handleExport() {
    setExporting(true);
    try {
      const collections: Record<string, Record<string, unknown>[]> = {};
      for (const name of BACKUP_COLLECTIONS) {
        const snap = await getDocs(collection(db, name));
        collections[name] = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      }
      const docs: Record<string, Record<string, unknown>> = {};
      for (const [path, id] of BACKUP_DOCS) {
        const snap = await getDocs(collection(db, path));
        const found = snap.docs.find((d) => d.id === id);
        if (found) docs[`${path}/${id}`] = found.data();
      }

      const backup: BackupFile = { createdAt: new Date().toISOString(), collections, docs };
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `lulua-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);

      if (profile) await logActivity(profile, "backup.exported", "");
      toast.success(t("admin.backup.downloaded"));
    } catch {
      toast.error(t("admin.backup.exportFailed"));
    } finally {
      setExporting(false);
    }
  }

  function handleFileChosen(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result as string) as BackupFile;
        if (!parsed.collections) throw new Error("invalid");
        setPendingFile(parsed);
      } catch {
        toast.error(t("admin.backup.invalidFile"));
      }
    };
    reader.readAsText(file);
  }

  async function handleRestore() {
    if (!pendingFile) return;
    setImporting(true);
    try {
      // Only ever write collections/docs this app actually knows about and
      // exports itself — an uploaded file is untrusted input, and without
      // this whitelist any collection/doc name present in the JSON would be
      // written verbatim, including ones this app never intended to expose
      // to a restore (e.g. admins, activityLogs).
      const allowedDocs = new Set(BACKUP_DOCS.map(([path, id]) => `${path}/${id}`));
      let skipped = 0;
      const ops: { path: string; id: string; data: Record<string, unknown> }[] = [];
      for (const [name, rows] of Object.entries(pendingFile.collections)) {
        if (!BACKUP_COLLECTIONS.includes(name)) {
          skipped += rows.length;
          continue;
        }
        for (const row of rows) {
          const { id, ...rest } = row;
          if (typeof id === "string") ops.push({ path: name, id, data: rest });
        }
      }
      for (const [key, data] of Object.entries(pendingFile.docs ?? {})) {
        if (!allowedDocs.has(key)) {
          skipped++;
          continue;
        }
        const [path, id] = key.split("/");
        ops.push({ path, id, data });
      }
      for (let i = 0; i < ops.length; i += 400) {
        const batch = writeBatch(db);
        ops.slice(i, i + 400).forEach((op) => batch.set(doc(db, op.path, op.id), op.data, { merge: true }));
        await batch.commit();
      }

      if (profile) await logActivity(profile, "backup.restored", `${ops.length} ${t("admin.backup.records")}`);
      const restoredMessage = `${t("admin.backup.restored")} ${ops.length} ${t("admin.backup.records")}`;
      if (skipped > 0) {
        toast.warning(restoredMessage, `${skipped} ${t("admin.backup.skippedUnknown")}`);
      } else {
        toast.success(restoredMessage);
      }
      setPendingFile(null);
    } catch {
      toast.error(t("admin.backup.restoreFailed"));
    } finally {
      setImporting(false);
    }
  }

  return (
    <div>
      <PageHeader title={t("admin.nav.backup")} description={t("admin.backup.subtitle")} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card className="p-5">
          <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-wine-light text-wine">
            <AdminIcon name="download" className="h-5 w-5" />
          </div>
          <h2 className="font-display text-base font-bold text-ink">{t("admin.backup.exportTitle")}</h2>
          <p className="mt-1.5 text-sm text-ink-soft">{t("admin.backup.exportBody")}</p>
          <AdminButton variant="primary" icon="download" loading={exporting} className="mt-4" onClick={handleExport}>
            {t("admin.backup.downloadBackup")}
          </AdminButton>
        </Card>

        <Card className="p-5">
          <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-wine-light text-wine">
            <AdminIcon name="upload" className="h-5 w-5" />
          </div>
          <h2 className="font-display text-base font-bold text-ink">{t("admin.backup.restoreTitle")}</h2>
          <p className="mt-1.5 text-sm text-ink-soft">{t("admin.backup.restoreBody")}</p>
          <input ref={fileRef} type="file" accept="application/json" hidden onChange={(e) => handleFileChosen(e.target.files)} />
          <AdminButton variant="secondary" icon="upload" className="mt-4" onClick={() => fileRef.current?.click()}>
            {t("admin.backup.chooseFile")}
          </AdminButton>
        </Card>
      </div>

      <p className="mt-6 flex items-start gap-2 text-xs text-ink-faint">
        <AdminIcon name="info" className="h-4 w-4 shrink-0" />
        {t("admin.backup.note")}
      </p>

      <ConfirmDialog
        open={!!pendingFile}
        onClose={() => setPendingFile(null)}
        onConfirm={handleRestore}
        title={t("admin.backup.restoreTitle")}
        body={`${t("admin.backup.confirmBody")} ${pendingFile ? new Date(pendingFile.createdAt).toLocaleString() : ""}. ${t("admin.backup.confirmBody2")}`}
        confirmLabel={importing ? t("admin.backup.restoring") : t("admin.backup.restore")}
        danger
        loading={importing}
      />
    </div>
  );
}
