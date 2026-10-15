import type { CSSProperties } from "react";

type IconProps = { className?: string; style?: CSSProperties };

export function ShipIcon({ className, style }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className} style={style} fill="none">
      <path d="M4 20V9a1 1 0 011-1h13a1 1 0 011 1v11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M19 13h5.4a1 1 0 01.86.49l3.2 5.34a1 1 0 01.14.51V20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 20h24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="10" cy="24" r="2.6" stroke="currentColor" strokeWidth="2" />
      <circle cx="23" cy="24" r="2.6" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

export function ReturnIcon({ className, style }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className} style={style} fill="none">
      <path
        d="M6 16a10 10 0 1010-10"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path d="M6 8v6h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function LeafIcon({ className, style }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className} style={style} fill="none">
      <path
        d="M7 25C4 15 10 6 24 6c1 12-6 19-17 19z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M8 24C13 18 17 13 22 9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function StarIcon({ className, style }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" className={className} style={style} fill="currentColor">
      <path d="M10 1.5l2.6 5.6 6.1.6-4.6 4.1 1.3 6L10 14.9 4.6 17.8l1.3-6L1.3 7.7l6.1-.6z" />
    </svg>
  );
}

export function PlayIcon({ className, style }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className} style={style} fill="currentColor">
      <path d="M9 6.5a1.5 1.5 0 012.28-1.28l14 9.5a1.5 1.5 0 010 2.56l-14 9.5A1.5 1.5 0 019 25.5v-19z" />
    </svg>
  );
}

export function ImageOffIcon({ className, style }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className} style={style} fill="none">
      <path d="M5 7h22v18H5V7z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <circle cx="11" cy="12" r="1.8" stroke="currentColor" strokeWidth="2" />
      <path d="M9 20l5-5 4 4 4-5 3 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 3l26 26" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
