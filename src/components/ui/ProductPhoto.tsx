import { useEffect, useState } from "react";
import { unsplash } from "../../utils/unsplash";
import { ImageOffIcon } from "./Icons";

interface ProductPhotoProps {
  imageId: string;
  imageUrl?: string;
  alt: string;
  width?: number;
  aspect?: { w: number; h: number };
  className?: string;
  imgClassName?: string;
  priority?: boolean;
  focus?: string;
}

export default function ProductPhoto({
  imageId,
  imageUrl,
  alt,
  width = 800,
  aspect = { w: 4, h: 5 },
  className,
  imgClassName,
  priority,
  focus,
}: ProductPhotoProps) {
  const hasImage = Boolean(imageUrl || imageId);
  const src = imageUrl || (imageId ? unsplash(imageId, width, aspect) : undefined);
  const srcSet = imageUrl || !imageId ? undefined : `${unsplash(imageId, width, aspect)} 1x, ${unsplash(imageId, width * 2, aspect)} 2x`;

  // Tracks a failed image load (bad/expired URL) separately from "no image
  // assigned" (hasImage=false) — a genuinely unset photo keeps rendering the
  // plain empty background exactly as before, only a broken src swaps to
  // the fallback icon. Resets on src change so switching to a working image
  // (e.g. a different variant) retries the load instead of staying stuck.
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);

  return (
    <div className={`overflow-hidden bg-cream-dim dark:ring-1 dark:ring-white/10 ${className ?? ""}`}>
      {hasImage && !broken && (
        <img
          src={src}
          srcSet={srcSet}
          alt={alt}
          loading={priority ? "eager" : "lazy"}
          decoding="async"
          className={`h-full w-full object-cover ${imgClassName ?? ""}`}
          style={focus ? { objectPosition: focus } : undefined}
          onError={() => setBroken(true)}
        />
      )}
      {hasImage && broken && (
        <div className="flex h-full w-full items-center justify-center text-ink-faint">
          <ImageOffIcon className="h-8 w-8" />
        </div>
      )}
    </div>
  );
}
