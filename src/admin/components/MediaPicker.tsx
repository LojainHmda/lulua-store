import { orderBy } from "firebase/firestore";
import { useEffect, useRef, useState } from "react";
import { mediaApi } from "../../firebase/collections";
import { uploadMediaFile } from "../../firebase/storageUpload";
import { useLanguage } from "../../context/LanguageContext";
import type { MediaAsset } from "../types";
import AdminIcon from "./AdminIcons";
import { Modal } from "./Modal";
import { AdminButton, EmptyState, Spinner } from "./ui";
import { useToast } from "./ToastContext";

export default function MediaPicker({
  open,
  onClose,
  onSelect,
  accept = "image/*,video/*",
}: {
  open: boolean;
  onClose: () => void;
  onSelect: (asset: MediaAsset) => void;
  accept?: string;
}) {
  const toast = useToast();
  const { t } = useLanguage();
  const [tab, setTab] = useState<"library" | "upload">("library");
  const [items, setItems] = useState<MediaAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    const unsub = mediaApi.subscribe((data) => {
      setItems(data);
      setLoading(false);
    }, [orderBy("createdAt", "desc")]);
    return unsub;
  }, [open]);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      let last: MediaAsset | null = null;
      for (const file of Array.from(files)) {
        last = await uploadMediaFile(file);
      }
      toast.success(files.length > 1 ? `${files.length} ${t("admin.media.filesUploaded")}` : t("admin.media.fileUploaded"));
      if (last) {
        onSelect(last);
        onClose();
      }
    } catch {
      toast.error(t("admin.media.uploadFailed"));
    } finally {
      setUploading(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={t("admin.media.selectMedia")} width="lg">
      <div className="mb-4 flex gap-1 rounded-lg bg-cream-dim p-1">
        <button
          onClick={() => setTab("library")}
          className={`flex-1 rounded-md py-2 text-sm font-semibold transition-colors ${tab === "library" ? "bg-paper text-ink shadow-soft" : "text-ink-soft"}`}
        >
          {t("admin.media.library")}
        </button>
        <button
          onClick={() => setTab("upload")}
          className={`flex-1 rounded-md py-2 text-sm font-semibold transition-colors ${tab === "upload" ? "bg-paper text-ink shadow-soft" : "text-ink-soft"}`}
        >
          {t("admin.media.uploadNew")}
        </button>
      </div>

      {tab === "upload" ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-line px-6 py-14 text-center">
          {uploading ? (
            <Spinner className="h-7 w-7 text-wine" />
          ) : (
            <>
              <AdminIcon name="upload" className="h-7 w-7 text-ink-faint" />
              <p className="text-sm text-ink-soft">{t("admin.media.dragHere")}</p>
              <AdminButton variant="primary" onClick={() => fileRef.current?.click()}>
                {t("admin.media.chooseFiles")}
              </AdminButton>
            </>
          )}
          <input ref={fileRef} type="file" accept={accept} multiple hidden onChange={(e) => handleFiles(e.target.files)} />
        </div>
      ) : loading ? (
        <div className="flex justify-center py-14">
          <Spinner className="h-6 w-6 text-wine" />
        </div>
      ) : items.length === 0 ? (
        <EmptyState icon="image" title={t("admin.media.noMediaYet")} body={t("admin.media.noMediaBody")} />
      ) : (
        <div className="grid max-h-[50vh] grid-cols-3 gap-3 overflow-y-auto thin-scrollbar sm:grid-cols-4">
          {items.map((item) => (
            <button
              key={item.id}
              onClick={() => {
                onSelect(item);
                onClose();
              }}
              className="group relative aspect-square overflow-hidden rounded-lg border border-line bg-cream-dim"
            >
              {item.type === "video" ? (
                <video src={item.url} className="h-full w-full object-cover" muted />
              ) : (
                <img src={item.url} alt={item.name} className="h-full w-full object-cover transition-transform group-hover:scale-105" />
              )}
              <span className="absolute inset-0 flex items-center justify-center bg-black/0 text-on-accent opacity-0 transition-all group-hover:bg-black/40 group-hover:opacity-100">
                <AdminIcon name="check" className="h-6 w-6" />
              </span>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}
