import { orderBy } from "firebase/firestore";
import { useEffect, useMemo, useRef, useState } from "react";
import { mediaApi } from "../../firebase/collections";
import { deleteMediaFile, uploadMediaFile } from "../../firebase/storageUpload";
import { useLanguage } from "../../context/LanguageContext";
import { copyText } from "../../utils/copyText";
import { useAdminAuth } from "../AdminAuthContext";
import { ConfirmDialog, Modal } from "../components/Modal";
import { useToast } from "../components/ToastContext";
import { AdminButton, AdminSelect, EmptyState, PageHeader, PageLoading, SearchInput } from "../components/ui";
import type { MediaAsset } from "../types";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function MediaLibrary() {
  const toast = useToast();
  const { t } = useLanguage();
  const { hasRole } = useAdminAuth();
  const canWrite = hasRole(["owner", "admin", "editor"]);
  const [items, setItems] = useState<MediaAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | "image" | "video">("all");
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<MediaAsset | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<MediaAsset | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const unsub = mediaApi.subscribe((data) => {
      setItems(data);
      setLoading(false);
    }, [orderBy("createdAt", "desc")]);
    return unsub;
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((m) => {
      if (q && !m.name.toLowerCase().includes(q)) return false;
      if (typeFilter !== "all" && m.type !== typeFilter) return false;
      return true;
    });
  }, [items, search, typeFilter]);

  async function handleUpload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        await uploadMediaFile(file);
      }
      toast.success(files.length > 1 ? `${files.length} ${t("admin.media.filesUploaded")}` : t("admin.media.fileUploaded"));
    } catch {
      toast.error(t("admin.mediaLibrary.uploadFailed"));
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete() {
    if (!confirmDelete) return;
    await deleteMediaFile(confirmDelete);
    toast.success(t("admin.mediaLibrary.fileDeleted"));
    setConfirmDelete(null);
    setPreview(null);
  }

  async function copyUrl(url: string) {
    if (await copyText(url)) toast.success(t("admin.mediaLibrary.urlCopied"));
  }

  if (loading) return <PageLoading />;

  return (
    <div>
      <PageHeader
        title={t("admin.nav.media")}
        description={`${items.length} ${t("admin.mediaLibrary.files")}`}
        actions={
          canWrite && (
            <>
              <input ref={fileRef} type="file" accept="image/*,video/*" multiple hidden onChange={(e) => handleUpload(e.target.files)} />
              <AdminButton variant="primary" icon="upload" loading={uploading} onClick={() => fileRef.current?.click()}>
                {t("admin.mediaLibrary.upload")}
              </AdminButton>
            </>
          )
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SearchInput value={search} onChange={setSearch} placeholder={t("admin.mediaLibrary.searchFiles")} />
        <AdminSelect value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as typeof typeFilter)} className="w-auto">
          <option value="all">{t("admin.mediaLibrary.allTypes")}</option>
          <option value="image">{t("admin.mediaLibrary.images")}</option>
          <option value="video">{t("admin.mediaLibrary.videos")}</option>
        </AdminSelect>
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon="image" title={t("admin.media.noMediaYet")} body={t("admin.mediaLibrary.emptyBody")} action={canWrite && <AdminButton variant="primary" icon="upload" onClick={() => fileRef.current?.click()}>{t("admin.mediaLibrary.uploadFiles")}</AdminButton>} />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {filtered.map((item) => (
            <button key={item.id} onClick={() => setPreview(item)} className="group relative aspect-square overflow-hidden rounded-xl border border-line bg-cream-dim">
              {item.type === "video" ? (
                <video src={item.url} className="h-full w-full object-cover" muted />
              ) : (
                <img src={item.url} alt={item.name} className="h-full w-full object-cover transition-transform group-hover:scale-105" />
              )}
              {item.type === "video" && (
                <span className="absolute end-2 top-2 rounded-full bg-ink/70 px-2 py-0.5 text-[10px] font-bold uppercase text-paper">{t("admin.mediaLibrary.video")}</span>
              )}
            </button>
          ))}
        </div>
      )}

      <Modal open={!!preview} onClose={() => setPreview(null)} title={preview?.name ?? ""} width="md">
        {preview && (
          <div>
            <div className="aspect-video overflow-hidden rounded-xl bg-cream-dim">
              {preview.type === "video" ? (
                <video src={preview.url} className="h-full w-full object-contain" controls />
              ) : (
                <img src={preview.url} alt={preview.name} className="h-full w-full object-contain" />
              )}
            </div>
            <p className="mt-3 text-xs text-ink-faint">{formatBytes(preview.size)}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <AdminButton variant="secondary" icon="copy" onClick={() => copyUrl(preview.url)}>
                {t("admin.mediaLibrary.copyUrl")}
              </AdminButton>
              {canWrite && (
                <AdminButton variant="danger" icon="trash" onClick={() => setConfirmDelete(preview)}>
                  {t("admin.products.delete")}
                </AdminButton>
              )}
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={handleDelete}
        title={t("admin.mediaLibrary.deleteFile")}
        body={t("admin.mediaLibrary.deleteFileBody")}
        confirmLabel={t("admin.products.delete")}
        danger
      />
    </div>
  );
}
