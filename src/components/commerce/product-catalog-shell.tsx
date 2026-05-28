import { type ReactElement } from "react";
import { SanityImage } from "@/components/ui/sanity-image";
import { ProductCard } from "./product-card";
import { ProductSort } from "./product-sort";
import type { ProductSort as ProductSortValue } from "@/data/loaders";
import type { TProduct, TProductsPage } from "@/types";

interface ProductCatalogShellProps {
  pageData: TProductsPage | null;
  products: TProduct[];
  sort: ProductSortValue;
}

export function ProductCatalogShell({
  pageData,
  products,
  sort,
}: ProductCatalogShellProps): ReactElement {
  const title = pageData?.title || "Catalog";
  const eyebrow = pageData?.eyebrow || "Lash Her Edit";
  const description = pageData?.description || "Discover our curated selection of premium lash products, training materials, and services.";
  const emptyStateTitle = pageData?.emptyStateTitle || "Check Back Soon";
  const emptyStateDescription = pageData?.emptyStateDescription || "We are currently updating our product catalog. Please check back later for our curated selection of premium lash products.";

  return (
    <div className="min-h-screen bg-lh-white">
      <section className="relative isolate overflow-hidden bg-lh-shadow text-lh-neutral-2">
        <div className="absolute inset-0 z-0">
          {pageData?.heroImage ? (
            <SanityImage
              image={pageData.heroImage}
              alt={pageData.heroImage.alt || title}
              fill
              priority
              sizes="100vw"
              className="object-cover"
            />
          ) : (
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_76%_18%,var(--lh-light-soft),transparent_30%),linear-gradient(135deg,var(--lh-shadow),var(--lh-accent)_52%,var(--lh-primary))]" />
          )}
          <div className="absolute inset-0 bg-gradient-to-br from-lh-shadow/70 via-lh-accent/58 to-lh-primary/50 mix-blend-multiply" />
          <div className="absolute inset-0 bg-gradient-to-t from-lh-shadow via-lh-shadow/82 to-lh-shadow/16" />
          <div className="absolute -right-32 bottom-[-10rem] h-[30rem] w-[30rem] rounded-full border border-lh-light/35" aria-hidden="true" />
        </div>

        <div className="content-container relative z-10 flex min-h-[520px] items-end py-14 md:min-h-[620px] md:py-20">
          <div className="max-w-4xl">
            <p className="eyebrow-label mb-4 text-lh-light">{eyebrow}</p>
            <h1 className="display-heading text-lh-neutral-2 text-balance">{title}</h1>
            <p className="mt-6 max-w-3xl font-body text-base font-bold leading-8 text-lh-neutral-2/85 md:text-lg lg:text-xl">
              {description}
            </p>
          </div>
        </div>
      </section>

      <section className="section-shell-soft" aria-labelledby="products-heading">
        <div className="content-container">
          <div className="mx-auto max-w-7xl">
            <div className="min-w-0">
              <div className="mb-8 flex flex-col gap-5 border-b border-lh-line pb-6 lg:flex-row lg:items-end lg:justify-between">
                <div>
                  <p className="eyebrow-label mb-2">Products</p>
                  <h2 id="products-heading" className="section-heading text-4xl md:text-5xl">
                    The Product Edit
                  </h2>
                  <p className="mt-3 font-heading text-xs font-normal uppercase tracking-[0.28em] text-lh-muted" aria-live="polite">
                    Showing {products.length} Products
                  </p>
                </div>
                <ProductSort sort={sort} />
              </div>

              {products.length === 0 ? (
                <div className="soft-panel bg-lh-white py-16 text-center">
                  <h3 className="section-subheading mb-4 text-3xl">{emptyStateTitle}</h3>
                  <p className="mx-auto max-w-md font-body text-sm font-bold leading-7 text-lh-muted md:text-base">
                    {emptyStateDescription}
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
                  {products.map((product) => (
                    <ProductCard key={product._id} product={product} />
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
