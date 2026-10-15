// Preset accent-color themes for the whole system (storefront, admin
// dashboard, and POS all share the same --color-wine/-wine-dark/-wine-light
// custom properties, so overriding them here recolors all three at once).
// "wine" is Sisley's original identity and always available as the reset
// target. Every other preset keeps the same warm cream/ink neutrals and
// only swaps the accent family, so the rest of the editorial look never
// changes shape — just its signature color.
export interface ColorTheme {
  key: string;
  label: string;
  labelAr: string;
  light: { wine: string; wineDark: string; wineLight: string };
  dark: { wine: string; wineDark: string; wineLight: string };
}

export const COLOR_THEMES: ColorTheme[] = [
  {
    key: "wine",
    label: "Wine (Original)",
    labelAr: "نبيذي (الأصلي)",
    light: { wine: "#6e1e36", wineDark: "#4f1526", wineLight: "#f3e2e6" },
    dark: { wine: "#a8425f", wineDark: "#c96385", wineLight: "#33141e" },
  },
  {
    key: "forest",
    label: "Forest",
    labelAr: "أخضر غابي",
    light: { wine: "#2f4a35", wineDark: "#1f3324", wineLight: "#dfe8e0" },
    dark: { wine: "#6fa383", wineDark: "#8fc0a3", wineLight: "#1c2a20" },
  },
  {
    key: "navy",
    label: "Navy",
    labelAr: "كحلي",
    light: { wine: "#25395c", wineDark: "#182740", wineLight: "#dde5f0" },
    dark: { wine: "#6690c4", wineDark: "#8aacd9", wineLight: "#1a2333" },
  },
  {
    key: "terracotta",
    label: "Terracotta",
    labelAr: "طيني",
    light: { wine: "#9c4a2e", wineDark: "#743620", wineLight: "#f2ded4" },
    dark: { wine: "#d98865", wineDark: "#e5a486", wineLight: "#2e1f18" },
  },
  {
    key: "plum",
    label: "Plum",
    labelAr: "خوخي داكن",
    light: { wine: "#5a2a5c", wineDark: "#3e1d40", wineLight: "#ecdcee" },
    dark: { wine: "#a066a3", wineDark: "#b98abb", wineLight: "#291a2a" },
  },
  {
    key: "charcoal",
    label: "Charcoal",
    labelAr: "رمادي غامق",
    light: { wine: "#2e2c29", wineDark: "#1a1917", wineLight: "#e4e2de" },
    dark: { wine: "#8f8a80", wineDark: "#a8a399", wineLight: "#232220" },
  },
];

export const DEFAULT_COLOR_THEME = "wine";
export const CUSTOM_COLOR_THEME = "custom";

export function isValidHexColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  const num = parseInt(clean, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function rgbToHex(r: number, g: number, b: number): string {
  return (
    "#" +
    [r, g, b]
      .map((x) => Math.round(Math.min(255, Math.max(0, x))).toString(16).padStart(2, "0"))
      .join("")
  );
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  const d = max - min;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    switch (max) {
      case r:
        h = 60 * (((g - b) / d) % 6);
        break;
      case g:
        h = 60 * ((b - r) / d + 2);
        break;
      default:
        h = 60 * ((r - g) / d + 4);
    }
  }
  if (h < 0) h += 360;
  return [h, s * 100, l * 100];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  s /= 100;
  l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let [r1, g1, b1] = [0, 0, 0];
  if (h < 60) [r1, g1, b1] = [c, x, 0];
  else if (h < 120) [r1, g1, b1] = [x, c, 0];
  else if (h < 180) [r1, g1, b1] = [0, c, x];
  else if (h < 240) [r1, g1, b1] = [0, x, c];
  else if (h < 300) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  return [(r1 + m) * 255, (g1 + m) * 255, (b1 + m) * 255];
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function fromHsl(h: number, s: number, l: number): string {
  return rgbToHex(...hslToRgb(h, s, l));
}

// WCAG relative luminance / contrast ratio, standard formulas.
function relativeLuminance(r: number, g: number, b: number): number {
  const [rs, gs, bs] = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

function contrastRatio(rgbA: [number, number, number], rgbB: [number, number, number]): number {
  const lA = relativeLuminance(...rgbA);
  const lB = relativeLuminance(...rgbB);
  const [lighter, darker] = lA > lB ? [lA, lB] : [lB, lA];
  return (lighter + 0.05) / (darker + 0.05);
}

const NEAR_WHITE: [number, number, number] = [255, 255, 255];
const MIN_ACCENT_CONTRAST = 4.5;

// --color-on-accent (the fixed near-white text/icon color used on every
// solid accent-fill control — buttons, active nav, badges) only stays
// readable if the accent color itself is dark enough. A custom color with
// no floor could be picked arbitrarily light (e.g. a bright yellow) and
// silently break every primary button sitewide with white-on-yellow text,
// exactly the failure mode this floor exists to prevent. Keeps the user's
// exact hue and saturation — only pulls lightness down, and only as far as
// contrast actually requires, so a color that already passes is untouched.
function ensureContrastFloor(h: number, s: number, l: number): number {
  let lightness = l;
  let rgb = hslToRgb(h, s, lightness);
  let iterations = 0;
  while (contrastRatio(rgb, NEAR_WHITE) < MIN_ACCENT_CONTRAST && lightness > 0 && iterations < 60) {
    lightness -= 1.5;
    rgb = hslToRgb(h, s, lightness);
    iterations++;
  }
  return clamp(lightness, 0, 100);
}

// Given any hex color the user picks, derive a full light/dark theme the
// same shape as the hand-tuned presets above: the base color stays exactly
// as chosen (subject to the contrast floor above), a darker shade covers
// hover/active states on light backgrounds, a pale tint covers light-
// background badges, and the dark-mode trio is re-balanced (brightened
// base, brighter hover, deep tint) so a color picked while looking at the
// light theme still reads well in dark mode.
export function deriveCustomTheme(hex: string): ColorTheme {
  const [r, g, b] = hexToRgb(hex);
  const [h, s, l] = rgbToHsl(r, g, b);
  const safeL = ensureContrastFloor(h, s, l);

  const lightWine = fromHsl(h, s, safeL);
  const lightDark = fromHsl(h, clamp(s + 5, 0, 100), clamp(safeL - 14, 6, 90));
  const lightLight = fromHsl(h, clamp(s * 0.5, 10, 60), 92);

  // Dark mode's base derives from the ORIGINAL picked lightness (a light
  // pick should still brighten further for dark-mode legibility against a
  // near-black page background), then gets its own, independent contrast
  // floor check — dark mode's on-accent text is a slightly different near-
  // white value, and the safe lightness a color needs differs by mode.
  const darkL = clamp(l + (100 - l) * 0.45, 45, 72);
  const safeDarkL = ensureContrastFloor(h, clamp(s * 0.9, 30, 85), darkL);
  const darkWine = fromHsl(h, clamp(s * 0.9, 30, 85), safeDarkL);
  const darkDark = fromHsl(h, clamp(s * 0.9, 30, 85), clamp(safeDarkL + 12, 0, 88));
  const darkLight = fromHsl(h, clamp(s * 0.55, 15, 55), 16);

  return {
    key: CUSTOM_COLOR_THEME,
    label: "Custom",
    labelAr: "مخصص",
    light: { wine: lightWine, wineDark: lightDark, wineLight: lightLight },
    dark: { wine: darkWine, wineDark: darkDark, wineLight: darkLight },
  };
}

export function getColorTheme(key: string | undefined, customColor?: string): ColorTheme {
  if (key === CUSTOM_COLOR_THEME && customColor && isValidHexColor(customColor)) {
    return deriveCustomTheme(customColor);
  }
  return COLOR_THEMES.find((t) => t.key === key) ?? COLOR_THEMES[0];
}

// The logo is a static image (its gold gradient is baked into the pixels,
// not CSS-driven), so it can't be recolored by simply swapping a variable
// like the rest of the UI. Since the artwork is a single hue with only
// lightness variation (highlights/shadows of the same gold), a hue-rotate +
// saturate filter can shift that one hue to match the active theme while
// preserving the gradient's shading — an approximation, not a pixel-exact
// recolor, but a close one for a monochrome-gradient asset like this.
// The original "wine" theme is the logo's true native color, so it gets no
// filter at all — switching themes away and back always restores the exact
// original artwork rather than a round-tripped approximation of it.
const LOGO_BASE_HUE = 42;
const LOGO_BASE_SATURATION = 52;

export function getLogoFilter(themeKey: string | undefined, wineHex: string): string {
  if (themeKey === DEFAULT_COLOR_THEME) return "none";
  const [r, g, b] = hexToRgb(wineHex);
  const [h, s] = rgbToHsl(r, g, b);
  let hueRotate = h - LOGO_BASE_HUE;
  if (hueRotate > 180) hueRotate -= 360;
  if (hueRotate < -180) hueRotate += 360;
  const saturateRatio = Math.min(3, Math.max(0.08, s / LOGO_BASE_SATURATION));
  return `hue-rotate(${hueRotate.toFixed(1)}deg) saturate(${saturateRatio.toFixed(2)})`;
}
