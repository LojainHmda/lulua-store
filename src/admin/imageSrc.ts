import { unsplash } from "../utils/unsplash";
import type { AdminProduct } from "./types";

export function resolveImageSrc(item: { imageUrl?: string; imageId?: string }, width = 200): string {
  if (item.imageUrl) return item.imageUrl;
  if (item.imageId) return unsplash(item.imageId, width, { w: 1, h: 1 });
  return "";
}

export function resolveProductImageSrc(product: AdminProduct, width = 200): string {
  const variant = product.colorVariants[0];
  return variant ? resolveImageSrc(variant, width) : "";
}
