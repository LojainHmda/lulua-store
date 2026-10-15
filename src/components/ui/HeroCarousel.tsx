import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useLanguage } from "../../context/LanguageContext";
import { localizedName } from "../../data/localize";
import { HERO_SLIDES, type HeroSlide } from "../../data/heroSlides";
import Logo from "./Logo";
import ProductPhoto from "./ProductPhoto";

const IMAGE_DURATION = 5200;
const VIDEO_FALLBACK_DURATION = 9000;

// This is the specific fix for the mobile "blank page for 20-30s" bug this
// session diagnosed earlier: an autoplaying hero video with preload="auto"
// was fetched in full the instant the page loaded, regardless of connection
// quality. Data-saver mode and 2G/slow-2G are the only signals a browser
// exposes for "this connection can't afford that" — on those, the carousel
// starts pre-paused (see `paused` below) instead of autoplaying, so nothing
// is fetched until the shopper explicitly presses play via the existing
// play/pause control. Feature-detected: absent in Safari and older browsers,
// where this simply evaluates to false and behavior is unchanged.
function isConnectionConstrained(): boolean {
  if (typeof navigator === "undefined") return false;
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  if (!conn) return false;
  return conn.saveData === true || conn.effectiveType === "slow-2g" || conn.effectiveType === "2g";
}

export default function HeroCarousel({ children, slides }: { children?: ReactNode; slides?: HeroSlide[] }) {
  const activeSlides = slides && slides.length > 0 ? slides : HERO_SLIDES;
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(isConnectionConstrained);
  const [videoReady, setVideoReady] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const { t, lang } = useLanguage();

  const reducedMotion = useMemo(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    []
  );

  useEffect(() => {
    setIndex((i) => (i >= activeSlides.length ? 0 : i));
  }, [activeSlides.length]);

  const slide = activeSlides[index] ?? activeSlides[0];
  // Falls back to English when set but no Arabic variant exists yet (same
  // precedent as product/category names elsewhere) — undefined stays
  // undefined so a slide with no badge/title renders exactly as before.
  const slideBadge = slide.badge ? localizedName(slide.badge, slide.badgeAr, lang) : undefined;
  const slideTitle = slide.title ? localizedName(slide.title, slide.titleAr, lang) : undefined;

  const next = useCallback(() => {
    setIndex((i) => (i + 1) % activeSlides.length);
  }, [activeSlides.length]);

  useEffect(() => {
    setVideoReady(false);
  }, [index]);

  useEffect(() => {
    if (paused || reducedMotion) return;

    if (slide.type === "image") {
      const t = window.setTimeout(next, IMAGE_DURATION);
      return () => window.clearTimeout(t);
    }

    const video = videoRef.current;
    if (!video) return;
    const t = window.setTimeout(next, VIDEO_FALLBACK_DURATION);
    const onEnded = () => next();
    video.addEventListener("ended", onEnded);
    video.play().catch(() => {});
    return () => {
      window.clearTimeout(t);
      video.removeEventListener("ended", onEnded);
    };
  }, [index, paused, reducedMotion, slide.type, next]);

  return (
    <section className="relative h-[82vh] min-h-[620px] max-h-[860px] w-full overflow-hidden bg-black">
      <AnimatePresence>
        <motion.div
          key={index}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}
          className="absolute inset-0"
        >
          {slide.type === "video" ? (
            <video
              ref={videoRef}
              key={slide.src}
              className={`h-full w-full object-cover transition-opacity duration-700 ${
                // A poster shows immediately regardless of load state — that's
                // the whole point of one (see isConnectionConstrained above).
                // Without a poster, keep the original behavior: stay invisible
                // over the section's black background until a real frame is
                // ready, so there's never a flash of a blank/black video frame.
                videoReady || slide.poster ? "opacity-100" : "opacity-0"
              }`}
              src={slide.src}
              poster={slide.poster}
              muted
              playsInline
              autoPlay={!reducedMotion && !paused}
              preload="metadata"
              aria-label={slide.alt}
              onCanPlay={() => setVideoReady(true)}
            />
          ) : slide.imageId ? (
            <ProductPhoto
              imageId={slide.imageId}
              alt={slide.alt}
              width={1600}
              aspect={{ w: 16, h: 10 }}
              className="h-full w-full"
              priority={index === 0}
            />
          ) : (
            <img src={slide.src} alt={slide.alt} className="h-full w-full object-cover" />
          )}
        </motion.div>
      </AnimatePresence>

      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/75 via-black/15 to-black/35" />

      {/* Per-slide badge/headline — admin-authored, optional. Keyed with the
          same index as the media above so it crossfades in step with it;
          z-10 keeps it above the gradient (which itself has no z-index) so
          text stays sharp regardless of DOM order. Anchored near the top
          (below the transparent header, matching the carousel's own
          pt-28/pt-32 reserve) rather than the bottom, which is already
          occupied by the centered "Shop Now" button and, further down, the
          play/pause + slide-dot controls. */}
      {(slideBadge || slideTitle) && (
        <AnimatePresence>
          <motion.div
            key={index}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
            className="pointer-events-none absolute inset-x-6 top-28 z-10 max-w-lg sm:inset-x-10 md:top-32"
          >
            {slideBadge && (
              <span className="inline-block rounded-full border border-on-accent/40 bg-black/20 px-3.5 py-1.5 text-xs font-bold uppercase tracking-wide text-on-accent backdrop-blur-sm">
                {slideBadge}
              </span>
            )}
            {slideTitle && (
              <h2 className="mt-3 font-display text-2xl font-semibold leading-tight text-on-accent sm:text-3xl">
                {slideTitle}
              </h2>
            )}
          </motion.div>
        </AnimatePresence>
      )}

      <div className="relative z-10 flex h-full flex-col justify-end pt-28 md:pt-32">{children}</div>

      <div className="absolute inset-x-0 bottom-16 z-20 flex justify-center sm:bottom-20">
        <Link
          to="/shop"
          className="flex h-20 w-40 flex-col items-center justify-center gap-1 rounded-full border border-on-accent/30 bg-transparent px-3 shadow-lift backdrop-blur-lg transition-transform duration-300 hover:-translate-y-1 hover:scale-105 sm:h-24 sm:w-48 sm:gap-2 sm:px-4"
        >
          <Logo className="h-8 w-auto sm:h-9" />
          <span className="max-w-full text-center text-xs font-bold leading-tight uppercase tracking-wide text-on-accent sm:text-sm">
            {t("hero.ctaShopNow")}
          </span>
        </Link>
      </div>

      <div className="absolute bottom-4 end-4 z-20 flex items-center gap-2 sm:bottom-8 sm:end-10 sm:gap-3">
        <button
          onClick={() => setPaused((p) => !p)}
          aria-label={paused ? t("hero.play") : t("hero.pause")}
          className="flex h-9 w-9 items-center justify-center rounded-full border border-on-accent/40 text-on-accent transition-colors hover:bg-on-accent/15"
        >
          {paused ? <PlayIcon /> : <PauseIcon />}
        </button>
        <div className="flex items-center gap-2.5">
          {activeSlides.map((s, i) => (
            <button
              key={i}
              onClick={() => setIndex(i)}
              aria-label={`${t("hero.goToSlide")} ${i + 1}`}
              aria-current={i === index}
              className="group relative h-2 w-9 overflow-hidden rounded-full bg-on-accent/30"
            >
              {i === index && (
                <motion.span
                  key={index}
                  className="absolute inset-y-0 start-0 bg-on-accent"
                  initial={{ width: "0%" }}
                  animate={{ width: "100%" }}
                  transition={{
                    duration: (s.type === "image" ? IMAGE_DURATION : VIDEO_FALLBACK_DURATION) / 1000,
                    ease: "linear",
                  }}
                />
              )}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

function PlayIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 14 14" fill="currentColor">
      <path d="M2 1.3c0-.9 1-1.5 1.8-1L12 5.2c.8.5.8 1.6 0 2.1L3.8 12.2c-.8.5-1.8-.1-1.8-1V1.3z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 14 14" fill="currentColor">
      <rect x="2" y="1" width="4" height="12" rx="1" />
      <rect x="8" y="1" width="4" height="12" rx="1" />
    </svg>
  );
}
