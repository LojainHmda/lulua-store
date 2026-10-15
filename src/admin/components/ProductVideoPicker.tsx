import { useEffect, useMemo, useState } from "react";
import { mediaApi, productsApi } from "../../firebase/collections";
import { useLanguage } from "../../context/LanguageContext";
import { localizedName } from "../../data/localize";
import AdminIcon from "./AdminIcons";
import { Modal } from "./Modal";
import { AdminButton, EmptyState, SearchInput, Spinner } from "./ui";

export interface VideoLibraryItem {
  key: string;
  url: string;
  label: string;
  sourceLabel: string;
  // Only ever set for a product-sourced item (that product's own primary
  // photo) — lets a consumer like the Hero editor show a real frame
  // instantly instead of a blank one while the video itself loads, without
  // asking the admin to separately pick a poster image.
  posterUrl?: string;
}

interface ProductVideoPickerProps {
  open: boolean;
  onClose: () => void;
  onSelect: (item: VideoLibraryItem) => void;
}

// The reusable "video library" — every product that has a migrated/assigned
// video, plus any video ever uploaded straight into Media Library, in one
// searchable place. Deliberately separate from MediaPicker (src/admin/
// components/MediaPicker.tsx): MediaPicker's library tab is sourced only
// from the `media` Firestore collection, which is exactly what makes it
// unsuitable here — the 87 migrated product videos were written directly to
// `products/{id}.videoUrl` during the sisley.ps import and were never
// registered there (confirmed while investigating this). Reusing MediaPicker
// as-is would mean this picker (and by extension the product-video field and
// the homepage Hero editor) simply couldn't see them. This component reads
// both sources and never uploads or moves anything — selecting an item hands
// back the existing URL as-is, so nothing is duplicated in Storage.
export default function ProductVideoPicker({ open, onClose, onSelect }: ProductVideoPickerProps) {
  const { t, lang } = useLanguage();
  const [items, setItems] = useState<VideoLibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<VideoLibraryItem | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setSelected(null);
    setQuery("");
    Promise.all([productsApi.list(), mediaApi.list()]).then(([products, media]) => {
      const fromProducts: VideoLibraryItem[] = products
        .filter((p) => p.videoUrl)
        .map((p) => ({
          key: `product:${p.id}`,
          url: p.videoUrl!,
          label: localizedName(p.name, p.nameAr, lang) || p.name,
          sourceLabel: t("admin.videoPicker.fromProduct"),
          posterUrl: p.colorVariants?.[0]?.imageUrl,
        }));
      const fromMedia: VideoLibraryItem[] = media
        .filter((m) => m.type === "video")
        .map((m) => ({
          key: `media:${m.id}`,
          url: m.url,
          label: m.name,
          sourceLabel: t("admin.videoPicker.uploadedMedia"),
        }));
      setItems([...fromProducts, ...fromMedia]);
      setLoading(false);
    });
  }, [open, lang, t]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((i) => i.label.toLowerCase().includes(q));
  }, [items, query]);

  function confirm() {
    if (!selected) return;
    onSelect(selected);
  }

  return (
    <Modal open={open} onClose={onClose} title={t("admin.videoPicker.title")} width="lg">
      {selected && (
        <div className="mb-4 rounded-xl border border-line p-3">
          <p className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-faint">{t("admin.videoPicker.preview")}</p>
          <video key={selected.url} src={selected.url} controls playsInline preload="metadata" className="max-h-64 w-full rounded-lg bg-cream-dim" />
          <div className="mt-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-ink">{selected.label}</p>
              <p className="text-xs text-ink-faint">{selected.sourceLabel}</p>
            </div>
            <AdminButton variant="primary" size="sm" onClick={confirm} className="shrink-0">
              {t("admin.videoPicker.useThisVideo")}
            </AdminButton>
          </div>
        </div>
      )}

      <SearchInput value={query} onChange={setQuery} placeholder={t("admin.videoPicker.searchPlaceholder")} />

      <div className="mt-4">
        {loading ? (
          <div className="flex justify-center py-14">
            <Spinner className="h-6 w-6 text-wine" />
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState icon="video" title={t("admin.videoPicker.noVideos")} body={t("admin.videoPicker.noVideosBody")} />
        ) : (
          <div className="grid max-h-[45vh] grid-cols-3 gap-3 overflow-y-auto thin-scrollbar sm:grid-cols-4">
            {filtered.map((item) => (
              <button
                key={item.key}
                onClick={() => setSelected(item)}
                className={`group relative aspect-square overflow-hidden rounded-lg border transition-colors ${
                  selected?.key === item.key ? "border-wine ring-2 ring-wine/30" : "border-line bg-cream-dim hover:border-ink-faint"
                }`}
              >
                <video src={item.url} className="h-full w-full object-cover" muted playsInline preload="metadata" />
                <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-ink/15 opacity-0 transition-opacity group-hover:opacity-100">
                  <AdminIcon name="play" className="h-6 w-6 text-paper" />
                </span>
                <span className="absolute inset-x-0 bottom-0 truncate bg-ink/70 px-1.5 py-1 text-start text-[11px] font-medium text-paper">
                  {item.label}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
