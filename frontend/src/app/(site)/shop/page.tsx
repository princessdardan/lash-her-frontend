import type { ReactElement } from "react";
import { loaders } from "@/data/loaders";
import { CartPanel } from "@/components/commerce/cart-panel";

export const revalidate = 300;

export default async function ShopPage(): Promise<ReactElement> {
  const products = await loaders.getSellableProducts();

  return (
    <main className="min-h-screen bg-brand-cream py-12 lg:py-24">
      <div className="content-container">
        <div className="text-container max-w-3xl mx-auto mb-16">
          <h1 className="section-heading-red-center text-4xl md:text-5xl lg:text-6xl mb-6">
            Shop
          </h1>
          <p className="section-description text-center text-lg">
            Discover our curated selection of premium lash products and training materials. 
            Elevate your artistry with the same tools we use in our studio.
          </p>
        </div>

        <CartPanel products={products} />
      </div>
    </main>
  );
}
