import type { ComponentType } from "react";
import type { ValueStripItem, ValueStripItemId } from "../admin/types";
import { LeafIcon, ReturnIcon, ShipIcon, StarIcon } from "../components/ui/Icons";

// Shared by the storefront (Home.tsx, as both the fallback when no
// Firestore value exists yet and the source of localized text/icon per
// item) and the admin editor (HomepageContent.tsx, as the pre-filled seed
// shown the first time this section is opened). Text here must match the
// pre-existing home.valueShipping/valueReturns/valueFabrics/valueRating
// translation strings exactly, so a document with no `valueStrip` field
// renders byte-identical to the homepage's previous (fully hardcoded) copy.
export const DEFAULT_VALUE_STRIP: ValueStripItem[] = [
  { id: "shipping", text: "Free shipping over ₪500", textAr: "شحن مجاني للطلبات فوق 500₪", active: true },
  { id: "returns", text: "Easy 30-day returns", textAr: "إرجاع سهل خلال 30 يوماً", active: true },
  { id: "fabrics", text: "Responsibly sourced fabrics", textAr: "أقمشة مصدرها مسؤول", active: true },
  { id: "rating", text: "4.8 average rating", textAr: "تقييم 4.8 من عملائنا", active: true },
];

export const VALUE_STRIP_ICONS: Record<ValueStripItemId, ComponentType<{ className?: string }>> = {
  shipping: ShipIcon,
  returns: ReturnIcon,
  fabrics: LeafIcon,
  rating: StarIcon,
};
