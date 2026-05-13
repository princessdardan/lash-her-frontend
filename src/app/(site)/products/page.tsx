import type { ReactElement } from "react";
import { loaders } from "@/data/loaders";
import { CartPanel } from "@/components/commerce/cart-panel";

export const revalidate = 300;

export default async function ProductsPage(): Promise<ReactElement> {
  const products = await loaders.getSellableProducts();

  return (
    <div className="min-h-screen bg-lh-neutral-2 py-12 lg:py-24">
      <div className="content-container">
        <div className="text-container max-w-3xl mx-auto mb-16">
          <h1 className="section-heading-red-center text-4xl md:text-5xl lg:text-6xl mb-6">
            Products
          </h1>
          <p className="section-description text-center text-lg">
            Discover our curated selection of premium lash products and training materials.
            Elevate your artistry with the same tools we use in our studio.
          </p>
        </div>

        {products.length === 0 ? (
          <div className="text-center py-16 bg-lh-white rounded-2xl border border-lh-line">
            <h2 className="text-2xl font-serif text-lh-shadow mb-4">Check Back Soon</h2>
            <p className="text-lh-muted max-w-md mx-auto">
              We are currently updating our product catalog. Please check back later for our curated selection of premium lash products.
            </p>
          </div>
        ) : (
          <CartPanel products={products} />
        )}
      </div>
    </div>
  );
}
