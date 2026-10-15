import type { ExchangePolicySettingsDoc } from "../admin/types";

// Single source of truth for the exchange-policy content used when
// settings/exchangePolicy hasn't been written yet, following the same
// shared-defaults pattern as SHIPPING_DEFAULTS (shippingDefaults.ts) — both
// the checkout consent modal and the admin Settings form read from here, so
// the admin form always shows exactly what checkout would otherwise fall
// back to before an admin ever saves a custom version.
//
// Content is Catchy's own ExchangePolicyModal copy, reproduced verbatim
// (title included — deliberately NOT title-cased to Sisley's usual heading
// style; the user confirmed the policy text itself should match Catchy
// exactly, word for word). version starts at 1 so the very first real order
// ever placed still carries a traceable, non-zero policyVersion.
export const EXCHANGE_POLICY_DEFAULTS: ExchangePolicySettingsDoc = {
  enabled: true,
  title: "Exchange policy",
  titleAr: "سياسة الاستبدال",
  subtitle: "Please read before completing your order.",
  subtitleAr: "يرجى القراءة قبل إتمام الطلب.",
  points: [
    "Exchanges are accepted only within the first 24 hours from delivery for unworn items with original tags attached.",
    "Items must be returned in their original condition and packaging.",
    "Exchanges are for items of equal value only. If your size is unavailable, you may exchange for another item at the same price.",
    "Delivery fees for the exchange must be paid again by the customer.",
  ],
  pointsAr: [
    "يُقبل الاستبدال خلال أول 24 ساعة فقط من التوصيل للقطع غير المستخدمة مع البطاقات الأصلية.",
    "يجب إرجاع القطع بحالتها الأصلية وفي تغليفها.",
    "الاستبدال بقطعة بنفس القيمة فقط. إذا لم يتوفر المقاس، يمكن الاستبدال بقطعة أخرى بنفس السعر.",
    "يجب على العميل دفع رسوم التوصيل مرة أخرى مقابل الاستبدال.",
  ],
  version: 1,
};
