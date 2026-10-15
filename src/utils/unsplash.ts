export function unsplash(id: string, width: number, aspect?: { w: number; h: number }): string {
  const params = new URLSearchParams({
    q: "85",
    w: String(width),
    auto: "format",
    fit: "crop",
  });
  if (aspect) {
    params.set("h", String(Math.round((width * aspect.h) / aspect.w)));
  }
  return `https://images.unsplash.com/photo-${id}?${params.toString()}`;
}
