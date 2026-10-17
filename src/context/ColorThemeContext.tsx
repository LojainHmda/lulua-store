import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { DEFAULT_COLOR_THEME, getColorTheme, getLogoFilter } from "../data/colorThemes";
import { subscribeSingletonDoc } from "../firebase/firestore";
import { isBackendConfigured } from "../firebase/config";
import { useTheme } from "./ThemeContext";

interface AppearanceSettingsSlice {
  colorTheme?: string;
  customColor?: string;
}

interface ColorThemeContextValue {
  colorTheme: string;
  logoFilter: string;
}

const ColorThemeContext = createContext<ColorThemeContextValue>({ colorTheme: DEFAULT_COLOR_THEME, logoFilter: "none" });

// Applies the selected accent-color preset (or a custom hex color, derived
// into a full light/dark trio on the fly) as CSS custom-property overrides
// on the root element, reacting to both the saved setting and the current
// light/dark mode. This is global — the storefront, admin dashboard, and
// POS all read the same --color-wine/-wine-dark/-wine-light tokens, so one
// selection here recolors all three consistently. It also derives a filter
// for the logo image (see getLogoFilter) so the one static asset on the
// site follows the same selection as everything else.
export function ColorThemeProvider({ children }: { children: ReactNode }) {
  const { theme } = useTheme();
  const [colorTheme, setColorTheme] = useState(DEFAULT_COLOR_THEME);
  const [customColor, setCustomColor] = useState<string | undefined>(undefined);
  const [logoFilter, setLogoFilter] = useState("none");

  useEffect(() => {
    if (!isBackendConfigured) return;
    return subscribeSingletonDoc<AppearanceSettingsSlice>("settings", "appearance", (doc) => {
      setColorTheme(doc?.colorTheme ?? DEFAULT_COLOR_THEME);
      setCustomColor(doc?.customColor);
    });
  }, []);

  useEffect(() => {
    const preset = getColorTheme(colorTheme, customColor);
    const values = theme === "dark" ? preset.dark : preset.light;
    const root = document.documentElement.style;
    root.setProperty("--color-wine", values.wine);
    root.setProperty("--color-wine-dark", values.wineDark);
    root.setProperty("--color-wine-light", values.wineLight);
    setLogoFilter(getLogoFilter(colorTheme, values.wine));
  }, [colorTheme, customColor, theme]);

  return <ColorThemeContext.Provider value={{ colorTheme, logoFilter }}>{children}</ColorThemeContext.Provider>;
}

export function useColorTheme() {
  return useContext(ColorThemeContext).colorTheme;
}

export function useLogoFilter() {
  return useContext(ColorThemeContext).logoFilter;
}
