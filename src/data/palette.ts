export interface Swatch {
  name: string;
  hex: string;
}

export const SWATCHES: Record<string, Swatch> = {
  black: { name: "Black", hex: "#1c1a17" },
  white: { name: "White", hex: "#f5f1ea" },
  ivory: { name: "Ivory", hex: "#efe6d4" },
  beige: { name: "Beige", hex: "#d9cbb4" },
  camel: { name: "Camel", hex: "#b08d57" },
  charcoal: { name: "Charcoal", hex: "#4a453f" },
  navy: { name: "Navy", hex: "#2b3244" },
  olive: { name: "Olive", hex: "#6b7052" },
  sage: { name: "Sage", hex: "#9caa8c" },
  brown: { name: "Brown", hex: "#6b4a34" },
  gray: { name: "Gray", hex: "#8b8981" },
  blue: { name: "Blue", hex: "#4c6c93" },
};
