import { useEffect, useState } from "react";
import type { HomepageContentDoc } from "../../admin/types";
import { getSingletonDoc } from "../../firebase/firestore";

// Reads the exact same siteContent/homepage doc the admin Homepage Content
// editor already writes (promoBarActive/promoBarText) — those fields have
// been fully built and saveable in admin since before this component
// existed, with nothing on the storefront ever reading them. This is the
// one missing read step; no new doc, field, or write path.
export default function PromoBar() {
  const [content, setContent] = useState<HomepageContentDoc | null>(null);

  useEffect(() => {
    getSingletonDoc<HomepageContentDoc>("siteContent", "homepage").then((doc) => setContent(doc ?? null));
  }, []);

  if (!content?.promoBarActive || !content.promoBarText?.trim()) return null;

  return (
    <div className="bg-wine px-4 py-2.5 text-center text-sm font-semibold text-on-accent">
      {content.promoBarText}
    </div>
  );
}
