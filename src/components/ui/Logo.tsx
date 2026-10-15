import { useId, useLayoutEffect, useRef, useState } from "react";
import { useLogoFilter } from "../../context/ColorThemeContext";
import { useLanguage } from "../../context/LanguageContext";

interface LogoProps {
  className?: string;
  // On light chrome (the header/POS topbar, which sit on the `cream` token)
  // the wordmark is drawn in the palette's wine — the same color as the
  // header icons — via currentColor, so it follows the light/dark tokens and
  // the color theme automatically. Without it, the gold gradient is used,
  // which was designed for dark surfaces (the wine footer, the hero pill).
  onLight?: boolean;
}

// Handwritten wordmark. One font stack serves both languages: Ms Madi (a
// signature script) has Latin glyphs only, so Arabic text falls through to
// Aref Ruqaa — Ruqaa being the everyday handwritten Arabic style.
const SCRIPT_FONT = "'Ms Madi', 'Aref Ruqaa', cursive";
const WORDMARK = { ar: "لؤلؤة", en: "Lulua" } as const;
const FALLBACK_VIEWBOX = "0 0 200 80";

export default function Logo({ className, onLight }: LogoProps) {
  const themeFilter = useLogoFilter();
  const gradientId = useId();
  const { lang } = useLanguage();
  const textRef = useRef<SVGTextElement>(null);
  const [viewBox, setViewBox] = useState(FALLBACK_VIEWBOX);
  const word = WORDMARK[lang];

  // Script glyphs have long swashes, so the box is fitted to the rendered
  // text once the web fonts are in rather than hard-coded per language.
  useLayoutEffect(() => {
    let cancelled = false;
    const fit = () => {
      const el = textRef.current;
      if (cancelled || !el) return;
      const box = el.getBBox();
      if (!box.width) return;
      const pad = 4;
      setViewBox(`${box.x - pad} ${box.y - pad} ${box.width + pad * 2} ${box.height + pad * 2}`);
    };
    fit();
    document.fonts
      ?.load(`64px ${SCRIPT_FONT}`, word)
      .then(fit)
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [word]);

  return (
    <svg
      viewBox={viewBox}
      role="img"
      aria-label={word}
      className={`h-8 w-auto overflow-visible ${onLight ? "text-wine" : ""} ${className ?? ""}`}
      style={onLight || themeFilter === "none" ? undefined : { filter: themeFilter }}
    >
      {!onLight && (
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#f3dfa2" />
            <stop offset="0.5" stopColor="#d4af5a" />
            <stop offset="1" stopColor="#a87f2e" />
          </linearGradient>
        </defs>
      )}
      <text
        ref={textRef}
        x="100"
        y="56"
        textAnchor="middle"
        direction={lang === "ar" ? "rtl" : "ltr"}
        fontFamily={SCRIPT_FONT}
        fontSize={lang === "ar" ? 50 : 64}
        fontWeight={400}
        fill={onLight ? "currentColor" : `url(#${gradientId})`}
      >
        {word}
      </text>
    </svg>
  );
}
