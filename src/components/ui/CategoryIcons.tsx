import type { ComponentType } from "react";

interface IconProps {
  className?: string;
}

export type CategoryIconComponent = ComponentType<IconProps>;

const common = {
  fill: "none" as const,
  stroke: "currentColor" as const,
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function DressGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className}>
      <path d="M12.5 5v3.5M19.5 5v3.5" {...common} />
      <path
        d="M12.5 8.5c1 1.2 2.2 1.7 3.5 1.7s2.5-.5 3.5-1.7c2.6 3 4 7.6 4 13a2 2 0 01-2 2H10.5a2 2 0 01-2-2c0-5.4 1.4-10 4-13z"
        {...common}
      />
    </svg>
  );
}

export function TopGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className}>
      <path
        d="M12.3 6.5L6.5 11l3 3 2.3-1.8v11.6c0 .9.7 1.6 1.6 1.6h5.2c.9 0 1.6-.7 1.6-1.6V12.2L22.5 14l3-3-5.8-4.5c-.4 1.9-2 3-3.7 3s-3.3-1.1-3.7-3z"
        {...common}
      />
    </svg>
  );
}

export function PantsGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className}>
      <rect x="9.5" y="5.5" width="13" height="4" rx="1.2" {...common} />
      <path d="M10.3 9.5l0.9 17h2.8l1.7-12.5 1.7 12.5h2.8l0.9-17" {...common} />
    </svg>
  );
}

export function SetGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className}>
      <path
        d="M12.7 5.3L9 8l2 2 1.7-1.3v3.6c0 .6.5 1 1 1h4.6c.6 0 1-.4 1-1V8.7L21 10l2-2-3.7-2.7c-.3 1.3-1.6 2-3.3 2s-3-.7-3.3-2z"
        {...common}
      />
      <path d="M11.8 16.5l-1.8 3.6v6.4c0 .6.4 1 1 1h10c.6 0 1-.4 1-1v-6.4l-1.8-3.6z" {...common} />
    </svg>
  );
}

export function OuterwearGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className}>
      <path
        d="M13.3 5.5L11.5 7v1.8L6 13l2.7 2.7L11.5 14v11.5c0 .8.7 1.5 1.5 1.5h6c.8 0 1.5-.7 1.5-1.5V14l2.8 2.7L26 13l-5.5-4.2V7l-1.8-1.5"
        {...common}
      />
      <path d="M16 11.5v15.5" {...common} />
    </svg>
  );
}

export function AccessoriesGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className}>
      <path d="M10.5 13.5v-2a5.5 5.5 0 0111 0v2" {...common} />
      <rect x="7.5" y="13.5" width="17" height="12.5" rx="2.2" {...common} />
    </svg>
  );
}

export function ShoesGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className}>
      <path
        d="M6 24.5v-6.2c0-1 .5-1.9 1.4-2.4l5.7-3.3c.5-.3 1-.5 1.6-.5h1.3c.8 0 1.5.4 2 1l1.6 2.1c.4.5 1 .9 1.6 1l4.4 1c1 .2 1.7 1.1 1.7 2.1v2.7c0 1.2-1 2.2-2.2 2.2H8.2A2.2 2.2 0 016 24.5z"
        {...common}
      />
      <path d="M13 15.6v3.2M17.5 14v4.3" {...common} />
    </svg>
  );
}

export function SkirtGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className}>
      <path d="M12 5.5h8l1.2 4.3" {...common} />
      <path d="M11 9.8h10l4 16.7a1 1 0 01-1 1.2H8a1 1 0 01-1-1.2z" {...common} />
      <path d="M16 9.8v6.4" {...common} />
    </svg>
  );
}

export function BagGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className}>
      <path d="M11 12V9a5 5 0 0110 0v3" {...common} />
      <rect x="7" y="12" width="18" height="14.5" rx="2.2" {...common} />
    </svg>
  );
}

export function JewelryGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className}>
      <circle cx="16" cy="12.5" r="5" {...common} />
      <path d="M12.3 16.8L9 26.5h14l-3.3-9.7" {...common} />
    </svg>
  );
}

export function SwimwearGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className}>
      <path
        d="M6 12.5c2-2 4.5-3 6.5-1.5S16 15 16 15s1.5-2.5 3.5-4S24 8.5 26 10.5"
        {...common}
      />
      <path d="M8 15l3 11.5h3.5L16 18l1.5 8.5H21L24 15" {...common} />
    </svg>
  );
}

export function GenericTagGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className}>
      <path
        d="M17.5 6H9.8A1.8 1.8 0 008 7.8v7.7c0 .5.2 1 .5 1.3l11 11c.7.7 1.9.7 2.6 0l6.4-6.4c.7-.7.7-1.9 0-2.6l-11-11c-.3-.3-.8-.5-1.3-.5z"
        {...common}
      />
      <circle cx="13" cy="12" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

// ---- Store taxonomy glyphs (lingerie / bath / home) -------------------
// Same 32-unit grid, stroke weight and round joins as the glyphs above so
// the whole set reads as one icon family on POS tiles and the admin picker.

export function AllGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className}>
      <rect x="6.5" y="6.5" width="8" height="8" rx="2" {...common} />
      <rect x="17.5" y="6.5" width="8" height="8" rx="2" {...common} />
      <rect x="6.5" y="17.5" width="8" height="8" rx="2" {...common} />
      <rect x="17.5" y="17.5" width="8" height="8" rx="2" {...common} />
    </svg>
  );
}

export function HangerGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className}>
      <path d="M13.5 9a2.5 2.5 0 115 0c0 1.3-1 1.9-2.5 2.6v1.4" {...common} />
      <path d="M16 13L5.8 20.7c-.8.6-.4 1.8.6 1.8h19.2c1 0 1.4-1.2.6-1.8z" {...common} />
    </svg>
  );
}

export function HomeGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className}>
      <path d="M5.5 15.5L16 6.5l10.5 9" {...common} />
      <path d="M8.5 13v12.5h15V13" {...common} />
      <path d="M13.5 25.5v-6h5v6" {...common} />
    </svg>
  );
}

export function PajamasGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className}>
      <path
        d="M12 8L6.5 11.5l2.5 3.5 2-1.3V25c0 .6.4 1 1 1h8c.6 0 1-.4 1-1V13.7l2 1.3 2.5-3.5L20 8l-4 3.5z"
        {...common}
      />
      <circle cx="16" cy="15.5" r=".9" fill="currentColor" stroke="none" />
      <circle cx="16" cy="19" r=".9" fill="currentColor" stroke="none" />
      <circle cx="16" cy="22.5" r=".9" fill="currentColor" stroke="none" />
      <path d="M24.2 3.5a2.8 2.8 0 102.6 3.9 2.3 2.3 0 01-2.6-3.9z" {...common} />
    </svg>
  );
}

export function ShirtGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className}>
      <path d="M12 6.5L7 9 5 21.5h3.5L10 14v12h12V14l1.5 7.5H27L25 9l-5-2.5" {...common} />
      <path d="M12 6.5l4 4.5 4-4.5" {...common} />
      <path d="M16 11v15" {...common} />
    </svg>
  );
}

export function UnderwearGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className}>
      <path d="M6 9.5h20V13c-4.5 1-7.2 4.8-8 10h-4c-.8-5.2-3.5-9-8-10z" {...common} />
      <path d="M6 13h20" {...common} />
    </svg>
  );
}

export function BraGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className}>
      <path d="M5 21.5h22" {...common} />
      <path d="M5.5 21.5c0-4.5 2.4-8 5-9 3 1 5 4.6 5.5 9" {...common} />
      <path d="M16 21.5c.5-4.4 2.5-8 5.5-9 2.6 1 5 4.5 5 9" {...common} />
      <path d="M10.5 12.5l-1-6M21.5 12.5l1-6" {...common} />
    </svg>
  );
}

export function NightgownGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className}>
      <path d="M12.5 5v4.5M19.5 5v4.5" {...common} />
      <path d="M12 9.5c1.3 1 2.6 1.4 4 1.4s2.7-.4 4-1.4l1.2 4.3-.7 1.2 3 10.5h-15l3-10.5-.7-1.2z" {...common} />
      <path
        d="M8.5 25.5c.75.9 1.5.9 2.25 0s1.5-.9 2.25 0 1.5.9 2.25 0 1.5-.9 2.25 0 1.5.9 2.25 0 1.5-.9 2.25 0 1.5.9 2.25 0"
        {...common}
      />
    </svg>
  );
}

export function RingGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className}>
      <circle cx="16" cy="19.5" r="6.5" {...common} />
      <path d="M13 10l3-4 3 4-3 3z" {...common} />
    </svg>
  );
}

export function HeartGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className}>
      <path d="M16 25.5s-9.5-5.6-9.5-12.1A5 5 0 0116 10.8a5 5 0 019.5 2.6c0 6.5-9.5 12.1-9.5 12.1z" {...common} />
    </svg>
  );
}

export function CamisoleGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className}>
      <path d="M12 5.5V9c0 1 1.8 2.5 4 2.5s4-1.5 4-2.5V5.5" {...common} />
      <path d="M12 9c-1.5 1.3-2.5 3-2.5 5.5V26h13V14.5c0-2.5-1-4.2-2.5-5.5" {...common} />
    </svg>
  );
}

export function CorsetGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className}>
      <path d="M10 6c1.5 3 1.5 6.5 0 10s-1.5 7 0 10h12c-1.5-3-1.5-6.5 0-10s1.5-7 0-10z" {...common} />
      <path d="M14 9.5l4 3M18 9.5l-4 3M14 19.5l4 3M18 19.5l-4 3" {...common} />
    </svg>
  );
}

export function ShortsGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className}>
      <path d="M8 7.5h16l1.5 16.5h-7L16 15l-2.5 9h-7z" {...common} />
      <path d="M8 10.5h16" {...common} />
    </svg>
  );
}

export function LeggingsGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className}>
      <path d="M10.5 5.5h11l-1 21H17L16 13l-1 13.5h-3.5z" {...common} />
      <path d="M10.6 8.5h10.8" {...common} />
    </svg>
  );
}

export function TracksuitGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className}>
      <path d="M12.5 7.5a3.5 3.5 0 017 0" {...common} />
      <path d="M12 7.5L7 10 5.5 23H9l1-8v11h12V15l1 8h3.5L25 10l-5-2.5" {...common} />
      <path d="M16 10v16" {...common} />
      <path d="M12.5 15.5h1.5M18 15.5h1.5" {...common} />
    </svg>
  );
}

export function BathtubGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className}>
      <path d="M5 16h22v3a5 5 0 01-5 5H10a5 5 0 01-5-5z" {...common} />
      <path d="M9 24l-1 2.5M23 24l1 2.5" {...common} />
      <path d="M8.5 16V8.5a2.5 2.5 0 015 0" {...common} />
    </svg>
  );
}

export function ShowerGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className}>
      <path d="M7 26V10a4 4 0 018 0v2.5" {...common} />
      <path d="M11 12.5h8" {...common} />
      <path d="M12.5 16v1.5M15 16v1.5M17.5 16v1.5M13.7 20v1.5M16.3 20v1.5" {...common} />
    </svg>
  );
}

export function SoapGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className}>
      <path d="M11 13.5h10v11a2 2 0 01-2 2h-6a2 2 0 01-2-2z" {...common} />
      <path d="M14 13.5v-3h4v3" {...common} />
      <path d="M16 10.5V7h-3.5M16 7h2" {...common} />
      <path d="M14 19h4" {...common} />
    </svg>
  );
}

export function PillowGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className}>
      <path d="M7 9.5c3-1.3 15-1.3 18 0 1.3 3.5 1.3 9.5 0 13-3 1.3-15 1.3-18 0-1.3-3.5-1.3-9.5 0-13z" {...common} />
      <path d="M11 13.5c1.2.8 1.6 1.6 1.6 2.5s-.4 1.7-1.6 2.5M21 13.5c-1.2.8-1.6 1.6-1.6 2.5s.4 1.7 1.6 2.5" {...common} />
    </svg>
  );
}

export function BucketGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className}>
      <path d="M7 12h18" {...common} />
      <path d="M8 12l1.6 13a1.5 1.5 0 001.5 1.3h9.8a1.5 1.5 0 001.5-1.3L24 12" {...common} />
      <path d="M8.5 12c0-6 15-6 15 0" {...common} />
    </svg>
  );
}

export function KitchenGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className}>
      <path d="M7 13.5h18v8a4 4 0 01-4 4H11a4 4 0 01-4-4z" {...common} />
      <path d="M6 13.5h20M7 16H4.5M25 16h2.5" {...common} />
      <path d="M14 10.5h4M16 10.5V9" {...common} />
    </svg>
  );
}

export function BeddingGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className}>
      <path d="M5 7.5v18M27 17v8.5M5 21h22M5 17h22" {...common} />
      <path d="M8 13h5a1.5 1.5 0 011.5 1.5V17h-8v-2.5A1.5 1.5 0 018 13z" {...common} />
    </svg>
  );
}

export function SocksGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className}>
      <path d="M12 5.5h7V17l-6.5 6.6a3.6 3.6 0 01-5.1-5.1L12 14z" {...common} />
      <path d="M12 9h7" {...common} />
    </svg>
  );
}

export function RugGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className}>
      <rect x="7" y="8" width="18" height="16" rx="1.5" {...common} />
      <path d="M16 11.5l4.5 4.5-4.5 4.5-4.5-4.5z" {...common} />
      <path
        d="M9.5 8V5.5M13 8V5.5M16 8V5.5M19 8V5.5M22.5 8V5.5M9.5 26.5V24M13 26.5V24M16 26.5V24M19 26.5V24M22.5 26.5V24"
        {...common}
      />
    </svg>
  );
}

export type CategoryIconKey =
  | "dress"
  | "top"
  | "pants"
  | "set"
  | "outerwear"
  | "accessories"
  | "shoes"
  | "skirt"
  | "bag"
  | "jewelry"
  | "swimwear"
  | "hanger"
  | "pajamas"
  | "shirt"
  | "underwear"
  | "bra"
  | "nightgown"
  | "ring"
  | "heart"
  | "camisole"
  | "corset"
  | "shorts"
  | "leggings"
  | "tracksuit"
  | "home"
  | "bathtub"
  | "shower"
  | "soap"
  | "pillow"
  | "bucket"
  | "kitchen"
  | "bedding"
  | "socks"
  | "rug"
  | "tag";

// The single source of truth for every icon a category can be assigned —
// both the admin icon picker (CategoryList.tsx) and every storefront/POS
// surface that renders category icons (SearchWithCategoryIcons.tsx, the
// POS CategoryBrowser, anything added later) resolve through this same
// registry, so there is exactly one place that maps a key to a glyph. Keys
// are intentionally decoupled from category slugs (an admin can put the
// "shoes" glyph on a category called anything) — see resolveCategoryIcon()
// below for the fallback used when a category has no icon set at all, or
// an unrecognized key (e.g. one from a design that's since been removed
// from this list).
export const CATEGORY_ICONS: Record<CategoryIconKey, CategoryIconComponent> = {
  dress: DressGlyph,
  top: TopGlyph,
  pants: PantsGlyph,
  set: SetGlyph,
  outerwear: OuterwearGlyph,
  accessories: AccessoriesGlyph,
  shoes: ShoesGlyph,
  skirt: SkirtGlyph,
  bag: BagGlyph,
  jewelry: JewelryGlyph,
  swimwear: SwimwearGlyph,
  hanger: HangerGlyph,
  pajamas: PajamasGlyph,
  shirt: ShirtGlyph,
  underwear: UnderwearGlyph,
  bra: BraGlyph,
  nightgown: NightgownGlyph,
  ring: RingGlyph,
  heart: HeartGlyph,
  camisole: CamisoleGlyph,
  corset: CorsetGlyph,
  shorts: ShortsGlyph,
  leggings: LeggingsGlyph,
  tracksuit: TracksuitGlyph,
  home: HomeGlyph,
  bathtub: BathtubGlyph,
  shower: ShowerGlyph,
  soap: SoapGlyph,
  pillow: PillowGlyph,
  bucket: BucketGlyph,
  kitchen: KitchenGlyph,
  bedding: BeddingGlyph,
  socks: SocksGlyph,
  rug: RugGlyph,
  tag: GenericTagGlyph,
};

export const CATEGORY_ICON_KEYS = Object.keys(CATEGORY_ICONS) as CategoryIconKey[];

// Never returns nothing: an unset or unrecognized icon key falls back to a
// generic tag glyph rather than rendering a blank gap in the row — this is
// what guarantees "every category has an appropriate icon" holds even for
// a category created before this system existed, or one whose saved icon
// key was since removed from the registry.
export function resolveCategoryIcon(key: string | undefined | null): CategoryIconComponent {
  if (key && key in CATEGORY_ICONS) return CATEGORY_ICONS[key as CategoryIconKey];
  return GenericTagGlyph;
}
