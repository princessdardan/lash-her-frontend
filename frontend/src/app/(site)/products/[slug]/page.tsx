import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loaders } from "@/data/loaders";
import { SanityImage } from "@/components/ui/sanity-image";
import { formatCad } from "@/lib/commerce/money";
import Link from "next/link";

export const revalidate = 300;

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const data = await loaders.getSellableProductBySlug(slug);

  const title = data?.title ?? "Product";
  const description = data?.description ?? "Premium lash product";

  return {
    title,
    description,
    openGraph: { title, description },
    twitter: { title, description },
  };
}

export async function generateStaticParams() {
  const products = await loaders.getAllSellableProductSlugs();
  return products.map(p => ({ slug: p.slug }));
}

export default async function ProductDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const product = await loaders.getSellableProductBySlug(slug);

  if (!product) notFound();

  return (
    <main className="min-h-screen bg-brand-cream py-12 lg:py-24">
      <div className="content-container">
        <div className="max-w-4xl mx-auto card-white p-8 md:p-12 flex flex-col md:flex-row gap-8 md:gap-12">
          <div className="w-full md:w-1/2">
            {product.image ? (
              <div className="aspect-square relative rounded-md overflow-hidden bg-brand-pink/10">
                <SanityImage
                  image={product.image}
                  alt={product.title}
                  fill
                  className="object-cover"
                />
              </div>
            ) : (
              <div className="aspect-square relative rounded-md overflow-hidden bg-brand-pink/20 flex items-center justify-center">
                <span className="text-brand-dark-grey font-medium">No image available</span>
              </div>
            )}
          </div>
          
          <div className="w-full md:w-1/2 flex flex-col justify-center">
            {product.kind && (
              <span className="text-sm font-bold text-brand-red uppercase tracking-wider mb-2 block">
                {product.kind}
              </span>
            )}
            <h1 className="card-heading-red text-3xl md:text-4xl mb-4">
              {product.title}
            </h1>
            
            <div className="text-2xl font-medium text-brand-dark-grey mb-6">
              {formatCad(product.price)}
            </div>
            
            {product.description && (
              <div className="text-black font-light text-lg mb-8 space-y-4">
                <p>{product.description}</p>
              </div>
            )}
            
            <div className="mt-auto pt-6 border-t border-brand-pink/30">
              {!product.isAvailable ? (
                <div className="text-brand-red font-medium py-3">Currently Unavailable</div>
              ) : (
                <Link href="/products" className="btn-primary-red w-full text-center block">
                  Back to Products to Purchase
                </Link>
              )}
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
