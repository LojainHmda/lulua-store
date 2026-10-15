import LinkButton from "../components/ui/LinkButton";
import ProductCard from "../components/ui/ProductCard";
import { useCatalog } from "../context/CatalogContext";
import { useLanguage } from "../context/LanguageContext";
import { useWishlist } from "../context/WishlistContext";
import { getLocalizedProductById } from "../data/localize";

export default function Wishlist() {
  const { t, lang } = useLanguage();
  const wishlist = useWishlist();
  const catalog = useCatalog();

  // A saved id can outlive its product (deleted or archived from the
  // catalog, which only ever loads status:"active" docs — see
  // CatalogContext). Such ids are simply skipped here rather than pruned
  // from storage: catalog.products arrives across more than one onSnapshot
  // batch (an initial partial/cached read, then the full server read), so
  // there's no reliable "the catalog is now complete" signal to gate a
  // destructive localStorage write on — one was tried and confirmed capable
  // of wrongly deleting a still-valid id during that partial-load window.
  const products = wishlist.ids.map((id) => getLocalizedProductById(catalog.products, id, lang)).filter((p) => p !== undefined);

  return (
    <div className="container-page py-10 md:py-14">
      <h1 className="font-display text-3xl font-bold text-ink md:text-4xl">
        {t("wishlist.title")} {products.length > 0 && <span className="text-wine">({products.length})</span>}
      </h1>

      {products.length === 0 ? (
        <div className="flex flex-col items-center gap-4 px-8 py-20 text-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-sand text-wine">
            <svg className="h-8 w-8" viewBox="0 0 20 20" fill="none">
              <path
                d="M10 17.5s-6.7-4.1-9-8.4C-0.4 5.5 2 2 5.4 2c2 0 3.6 1.2 4.6 2.7C11 3.2 12.6 2 14.6 2 18 2 20.4 5.5 19 9.1c-2.3 4.3-9 8.4-9 8.4z"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <p className="font-display text-xl font-bold text-ink">{t("wishlist.empty")}</p>
          <p className="text-base text-ink-soft">{t("wishlist.emptySub")}</p>
          <LinkButton to="/shop" variant="primary">
            {t("cart.keepBrowsing")}
          </LinkButton>
        </div>
      ) : (
        <div className="mt-8 grid grid-cols-2 gap-x-4 gap-y-9 sm:gap-x-6 lg:grid-cols-4">
          {products.map((p) => (
            <ProductCard key={p.id} product={p} />
          ))}
        </div>
      )}
    </div>
  );
}
