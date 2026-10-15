import { Link } from "react-router-dom";
import type { Category } from "../../types";
import ProductPhoto from "./ProductPhoto";

export default function CategoryCard({ category, className }: { category: Category; className?: string }) {
  return (
    <Link
      to={`/shop/${category.slug}`}
      className={`group relative flex shrink-0 snap-start flex-col overflow-hidden rounded-2xl ${className ?? ""}`}
    >
      <ProductPhoto
        imageId={category.imageId}
        imageUrl={category.imageUrl}
        alt={category.name}
        width={640}
        aspect={{ w: 3, h: 4 }}
        className="aspect-[3/4] w-full"
        imgClassName="transition-transform duration-500 group-hover:scale-105"
      />
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 via-black/15 to-transparent p-5 pt-14">
        <h3 className="font-display text-2xl font-semibold text-on-accent">{category.name}</h3>
        <p className="mt-1 text-base text-on-accent/80">{category.tagline}</p>
      </div>
      <span className="absolute end-4 top-4 flex h-11 w-11 items-center justify-center rounded-full bg-paper/90 text-lg text-ink transition-transform duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 rtl:-scale-x-100">
        ↗
      </span>
    </Link>
  );
}
