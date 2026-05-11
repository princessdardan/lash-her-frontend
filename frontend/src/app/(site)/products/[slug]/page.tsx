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

  const title = data?.seo?.title || data?.title || "Product";
  const description = data?.seo?.description || data?.shortDescription || data?.description || "Premium lash product";

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
    <div className="min-h-screen bg-lh-neutral-2 py-12 lg:py-24">
      <div className="content-container">
        <div className="mb-8 pt-8">
          <Link href="/products" className="text-lh-primary hover:underline font-medium flex items-center gap-2">
            <span>←</span> Back to Catalog
          </Link>
        </div>

        <div className="max-w-5xl mx-auto card-white p-8 md:p-12 flex flex-col md:flex-row gap-8 md:gap-12">
          <div className="w-full md:w-1/2 flex flex-col gap-4">
            {product.image ? (
              <div className="aspect-square relative rounded-md overflow-hidden bg-lh-primary-soft/10">
                <SanityImage
                  image={product.image}
                  alt={product.title}
                  fill
                  className="object-cover"
                />
              </div>
            ) : (
              <div className="aspect-square relative rounded-md overflow-hidden bg-lh-primary-soft/20 flex items-center justify-center">
                <span className="text-lh-muted font-medium">No image available</span>
              </div>
            )}

            {product.gallery && product.gallery.length > 0 && (
              <div className="grid grid-cols-4 gap-4 mt-4">
                {product.gallery.map((img, idx) => (
                  <div key={idx} className="aspect-square relative rounded-md overflow-hidden bg-lh-primary-soft/10">
                    <SanityImage
                      image={img}
                      alt={img.alt || `${product.title} gallery image ${idx + 1}`}
                      fill
                      className="object-cover"
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
          
          <div className="w-full md:w-1/2 flex flex-col">
            {product.kind && (
              <span className="text-sm font-bold text-lh-primary uppercase tracking-wider mb-2 block">
                {product.kind}
              </span>
            )}
            <h1 className="card-heading-red text-3xl md:text-4xl mb-4">
              {product.title}
            </h1>
            
            <div className="text-2xl font-medium text-lh-muted mb-6">
              {formatCad(product.price)}
            </div>
            
            {product.description && (
              <div className="text-black font-light text-lg mb-8 space-y-4">
                <p>{product.description}</p>
              </div>
            )}

            {product.detailSections && product.detailSections.length > 0 && (
              <div className="mb-8 space-y-6">
                {product.detailSections.map((section, idx) => (
                  <div key={section._key || idx}>
                    <h3 className="font-bold text-lh-shadow mb-2">{section.heading}</h3>
                    <p className="text-black font-light">{section.content}</p>
                  </div>
                ))}
              </div>
            )}
            
            <div className="mt-auto pt-6 border-t border-lh-line/30">
              {product.fulfillmentNote && (
                <div className="bg-lh-neutral/30 p-4 rounded-md mb-6">
                  <p className="text-sm text-lh-shadow italic">
                    <span className="font-bold not-italic mr-2">Note:</span>
                    {product.fulfillmentNote}
                  </p>
                </div>
              )}

              {!product.isAvailable ? (
                <div className="text-lh-primary font-medium py-3 text-center border border-lh-primary rounded-md">
                  {product.availabilityLabel || "Currently Unavailable"}
                </div>
              ) : (
                <Link href="/products" className="btn-primary-red w-full text-center block">
                  Back to Catalog to Purchase
                </Link>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
