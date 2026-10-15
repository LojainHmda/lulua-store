interface IconProps {
  className?: string;
}

const paths: Record<string, string> = {
  grid: "M4 4h7v7H4V4zm9 0h7v7h-7V4zM4 13h7v7H4v-7zm9 0h7v7h-7v-7z",
  barcode: "M4 4v16M8 4v16M11 4v10M14 4v16M17 4v10M20 4v16",
  shirt: "M8 4L4 7l2 3 2-1v11h8V9l2 1 2-3-4-3-2 2h-4L8 4z",
  layers: "M12 4l8 4-8 4-8-4 8-4zM4 12l8 4 8-4M4 16l8 4 8-4",
  box: "M3 8l9-5 9 5-9 5-9-5zm0 0v9l9 5 9-5V8M12 13v9",
  bag: "M6 8h12l1 12a2 2 0 01-2 2H7a2 2 0 01-2-2L6 8zM9 8V6a3 3 0 016 0v2",
  users: "M8 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zm9 0a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM2 21c0-4 3-6.5 6-6.5s6 2.5 6 6.5M13 14.7c2.6.3 5 2.6 5 6.3",
  tag: "M3 11.5V4h7.5L21 14.5 13.5 22 3 11.5zM7.5 8a1 1 0 100-2 1 1 0 000 2z",
  layout: "M3 4h18v5H3V4zm0 7h8v9H3v-9zm10 0h8v9h-8v-9z",
  image: "M4 5h16v14H4V5zm3 10l4-4 3 3 3-4 3 5H5",
  star: "M12 2.5l3.1 6.7 7.4.7-5.5 4.9 1.6 7.2L12 18l-6.6 4 1.6-7.2-5.5-4.9 7.4-.7L12 2.5z",
  chart: "M4 20V10m6 10V4m6 16v-7m6 7V8",
  bell: "M6 10a6 6 0 1112 0c0 4 1.5 5.5 2 6H4c.5-.5 2-2 2-6zM10 20a2 2 0 004 0",
  history: "M4 12a8 8 0 118 8M4 12V6m0 6h6M12 8v4l3 2",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z",
  database: "M12 5c4.4 0 8-1.3 8-3s-3.6-3-8-3-8 1.3-8 3 3.6 3 8 3zm8-3v14c0 1.7-3.6 3-8 3s-8-1.3-8-3V2m16 7c0 1.7-3.6 3-8 3s-8-1.3-8-3",
  settings:
    "M12 15.5a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM19.4 13.5a1.7 1.7 0 00.34 1.87l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.7 1.7 0 00-1.87-.34 1.7 1.7 0 00-1 1.55V20a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1-1.55 1.7 1.7 0 00-1.87.34l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.7 1.7 0 00.34-1.87 1.7 1.7 0 00-1.55-1H4a2 2 0 110-4h.1a1.7 1.7 0 001.55-1 1.7 1.7 0 00-.34-1.87l-.06-.06a2 2 0 112.83-2.83l.06.06a1.7 1.7 0 001.87.34H10a1.7 1.7 0 001-1.55V4a2 2 0 114 0v.1a1.7 1.7 0 001 1.55 1.7 1.7 0 001.87-.34l.06-.06a2 2 0 112.83 2.83l-.06.06a1.7 1.7 0 00-.34 1.87V10a1.7 1.7 0 001.55 1H20a2 2 0 110 4h-.1a1.7 1.7 0 00-1.55 1z",
  menu: "M3 6h18M3 12h18M3 18h18",
  chevronDown: "M6 9l6 6 6-6",
  chevronLeft: "M15 18l-6-6 6-6",
  chevronRight: "M9 18l6-6-6-6",
  search: "M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.35-4.35",
  sun: "M12 4.5V2m0 20v-2.5M4.5 12H2m20 0h-2.5M5.6 5.6L4 4m16 16l-1.6-1.6M18.4 5.6L20 4M4 20l1.6-1.6M12 7.5a4.5 4.5 0 100 9 4.5 4.5 0 000-9z",
  moon: "M20.5 14.5A8.5 8.5 0 119.5 3.5a7 7 0 0011 11z",
  logout: "M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9",
  plus: "M12 5v14M5 12h14",
  edit: "M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4L16.5 3.5z",
  trash: "M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0l-1 14a2 2 0 01-2 2H7a2 2 0 01-2-2L4 6h16z",
  copy: "M8 8h11a1 1 0 011 1v11a1 1 0 01-1 1H8a1 1 0 01-1-1V9a1 1 0 011-1zM5 16H4a1 1 0 01-1-1V4a1 1 0 011-1h11a1 1 0 011 1v1",
  archive: "M3 4h18v4H3V4zm1 4h16v12H4V8zm5 4h6",
  x: "M6 6l12 12M18 6L6 18",
  check: "M4 12l6 6L20 6",
  upload: "M12 16V4m0 0L7 9m5-5l5 5M4 16v3a2 2 0 002 2h12a2 2 0 002-2v-3",
  filter: "M4 5h16l-6 8v6l-4-2v-4L4 5z",
  more: "M5 12a1 1 0 102 0 1 1 0 00-2 0zm6 0a1 1 0 102 0 1 1 0 00-2 0zm6 0a1 1 0 102 0 1 1 0 00-2 0z",
  drag: "M8 6h.01M8 12h.01M8 18h.01M16 6h.01M16 12h.01M16 18h.01",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7zM12 15a3 3 0 100-6 3 3 0 000 6z",
  eyeOff: "M3 3l18 18M10.6 10.6a3 3 0 004.2 4.2M9.5 5.2A10.7 10.7 0 0112 5c6.5 0 10 7 10 7a13.6 13.6 0 01-3.1 3.9M6.1 6.1C3.6 7.8 2 12 2 12a13.5 13.5 0 004.4 4.9",
  arrowUp: "M12 19V5M5 12l7-7 7 7",
  arrowDown: "M12 5v14M19 12l-7 7-7-7",
  home: "M3 11l9-8 9 8M5 10v10h14V10",
  refresh: "M4 12a8 8 0 0114-5.3M20 12a8 8 0 01-14 5.3M4 4v5h5M20 20v-5h-5",
  download: "M12 4v12m0 0l-5-5m5 5l5-5M4 20h16",
  info: "M12 22a10 10 0 100-20 10 10 0 000 20zM12 11v6m0-9.5v.5",
  alertTriangle: "M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0zM12 9v4m0 4h.01",
  globe: "M12 2a15 15 0 010 20M12 2a15 15 0 000 20M2 12h20M3 7h18M3 17h18M12 2a10 10 0 100 20 10 10 0 000-20z",
  mail: "M3 5h18v14H3V5zm0 0l9 7 9-7",
  phone: "M6 3h3l2 5-2.5 1.5a12 12 0 006 6L16 13l5 2v3a2 2 0 01-2 2A16 16 0 013 5a2 2 0 012-2z",
  map: "M9 3l6 2 6-2v16l-6 2-6-2-6 2V5l6-2zM9 3v16m6-14v16",
  play: "M7 4l13 8-13 8V4z",
  video: "M3 6h12v12H3V6zm12 4l6-3v10l-6-3v-4z",
  // Added for the Sisely AI trigger/page (AdminLayout.tsx, AssistantPage.tsx)
  // -- a two-point sparkle/twinkle, the common "AI" visual marker. Explicitly
  // NOT a speech-bubble/chat icon -- the trigger's own "AI" text is the
  // primary visual, this is just a small accent alongside it.
  sparkle: "M12 3l1.6 4.8L18 9l-4.4 1.7L12 15l-1.6-4.3L6 9l4.4-1.2L12 3zM19 14.5l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9.9-2.6z",
};

export default function AdminIcon({ name, className }: { name: string } & IconProps) {
  const d = paths[name];
  if (!d) return null;
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}
