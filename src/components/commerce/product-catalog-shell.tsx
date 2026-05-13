"use client";

import { type ReactElement } from "react";
import { SanityImage } from "@/components/ui/sanity-image";
import { CartPanel } from "./cart-panel";
import { ProductFilters } from "./product-filters";
import { ProductSort } from "./product-sort";
import type { TProductsPage, TSellableProduct, TProductCollection, TSellableProductFilterAttribute } from "@/types";

interface ProductCatalogShellProps {
  pageData: TProductsPage | null;
  products: TSellableProduct[];
  collections: TProductCollection[];
  filterAttributes: TSellableProductFilterAttribute[];
}

export function ProductCatalogShell({ 
  pageData, 
  products, 
  collections, 
  filterAttributes 
}: ProductCatalogShellProps): ReactElement {
  const title = pageData?.title || "Products";
  const eyebrow = pageData?.eyebrow || "Definitive Excellence";
  const description = pageData?.description || "Discover our curated selection of premium lash products and training materials. Elevate your artistry with the same tools we use in our studio.";
  
  return (
    <div className="min-h-screen bg-lh-white">
      <section className="bg-lh-neutral-2 py-16 lg:py-24">
        <div className="max-w-[1180px] mx-auto px-6 grid grid-cols-1 md:grid-cols-12 gap-8">
          <div className="col-span-1 md:col-span-7 flex flex-col justify-center gap-6">
            <span className="font-label-caps text-xs text-lh-light tracking-widest uppercase">
              {eyebrow}
            </span>
            <h1 className="font-display text-5xl md:text-6xl lg:text-7xl text-lh-primary leading-none uppercase">
              {title}
            </h1>
            <p className="font-body text-lg text-lh-muted max-w-md">
              {description}
            </p>
          </div>
          {pageData?.heroImage && (
            <div className="hidden md:block col-span-5 relative">
              <div className="absolute -top-10 -right-10 w-full h-full bg-lh-light-soft -z-10 rounded-[28px]"></div>
              <div className="relative w-full h-[450px] rounded-[28px] overflow-hidden shadow-sm">
                <SanityImage
                  image={pageData.heroImage}
                  alt={title}
                  fill
                  className="object-cover"
                />
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="py-16 lg:py-24 max-w-[1180px] mx-auto px-6">
        <div className="flex flex-col md:flex-row gap-8">
          <ProductFilters collections={collections} filterAttributes={filterAttributes} />
          
          <div className="flex-grow">
            <div className="flex justify-between items-end mb-10">
              <p className="font-label-caps text-xs text-lh-muted uppercase tracking-widest">
                Showing {products.length} Products
              </p>
              <ProductSort />
            </div>
            
            {products.length === 0 ? (
              <div className="text-center py-16 bg-lh-neutral-2 rounded-2xl border border-lh-line">
                <h2 className="text-2xl font-display text-lh-shadow mb-4 uppercase">
                  {pageData?.emptyStateTitle || "Check Back Soon"}
                </h2>
                <p className="text-lh-muted max-w-md mx-auto">
                  {pageData?.emptyStateDescription || "We are currently updating our product catalog. Please check back later for our curated selection of premium lash products."}
                </p>
              </div>
            ) : (
              <CartPanel products={products} />
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
