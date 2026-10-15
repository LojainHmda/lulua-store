// Single source of truth for how a price is displayed, anywhere in the
// app. Sisley's prices are in Israeli shekels (₪ / ILS) — the source site
// itself renders the symbol after the number (e.g. "129.99₪"), which this
// matches rather than the leading "$"-style placement used for USD.
export function formatPrice(amount: number): string {
  return `${amount.toFixed(2)}₪`;
}
