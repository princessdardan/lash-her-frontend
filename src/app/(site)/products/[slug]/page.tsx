import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { loaders } from "@/data/loaders";
import { ProductDetailSections } from "@/components/commerce/product-detail-sections";
import { ProductDetailPurchaseControls } from "@/components/commerce/product-detail-purchase-controls";
import { ProductDetailGallery } from "@/components/commerce/product-detail-gallery";
import { ProductGalleryProvider } from "@/components/commerce/product-gallery-context";
import { getProductCheckoutAvailability } from "@/lib/shipping/config";
import { resolveEffectivePrice } from "@/lib/commerce/cart";
import { formatCad } from "@/lib/commerce/money";
import { JsonLd, buildProductJsonLd } from "@/lib/structured-data";
import type { TProduct } from "@/types";

export const revalidate = 300;

const PRICE_UNAVAILABLE_LABEL = "Price unavailable";

function formatDisplayPrice(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  try {
    return formatCad(value);
  } catch {
    return null;
  }
}

interface ProductPriceDisplay {
  currentLabel: string;
  originalLabel?: string;
}

function formatPriceRange(prices: number[]): string | null {
  if (prices.length === 0) return null;

  const lowestPrice = Math.min(...prices);
  const highestPrice = Math.max(...prices);
  const lowestPriceLabel = formatDisplayPrice(lowestPrice);
  const highestPriceLabel = formatDisplayPrice(highestPrice);

  if (!lowestPriceLabel || !highestPriceLabel) {
    return PRICE_UNAVAILABLE_LABEL;
  }

  return lowestPrice === highestPrice
    ? lowestPriceLabel
    : `${lowestPriceLabel} - ${highestPriceLabel}`;
}

function getProductPriceDisplay(product: {
  price?: number | null;
  discountPrice?: number | null;
  variants?: Array<{ price?: number | null; discountPrice?: number | null }>;
}): ProductPriceDisplay {
  const variantPrices =
    product.variants
      ?.map((variant) => {
        if (
          typeof variant.price !== "number" ||
          !Number.isFinite(variant.price)
        )
          return null;

        try {
          const resolved = resolveEffectivePrice(
            variant.price,
            variant.discountPrice,
          );
          return { current: resolved.price, original: variant.price };
        } catch {
          return null;
        }
      })
      .filter(
        (price): price is { current: number; original: number } =>
          price !== null,
      ) ?? [];

  if (variantPrices.length > 0) {
    const currentLabel =
      formatPriceRange(variantPrices.map((price) => price.current)) ??
      PRICE_UNAVAILABLE_LABEL;
    const hasManualDiscount = variantPrices.some(
      (price) => price.current < price.original,
    );
    const originalLabel = hasManualDiscount
      ? formatPriceRange(variantPrices.map((price) => price.original))
      : null;

    return {
      currentLabel,
      ...(originalLabel ? { originalLabel } : {}),
    };
  }

  if (typeof product.price !== "number" || !Number.isFinite(product.price)) {
    return { currentLabel: PRICE_UNAVAILABLE_LABEL };
  }

  let currentPrice: number;
  try {
    currentPrice = resolveEffectivePrice(
      product.price,
      product.discountPrice,
    ).price;
  } catch {
    return { currentLabel: PRICE_UNAVAILABLE_LABEL };
  }
  const currentLabel =
    formatDisplayPrice(currentPrice) ?? PRICE_UNAVAILABLE_LABEL;
  const originalLabel =
    currentPrice < product.price ? formatDisplayPrice(product.price) : null;

  return {
    currentLabel,
    ...(originalLabel ? { originalLabel } : {}),
  };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const data = await loaders.getProductBySlug(slug);

  const title = data?.seo?.title || data?.title || "Product";
  const description =
    data?.seo?.description ||
    data?.shortDescription ||
    data?.description ||
    "Premium lash product";

  return {
    title,
    description,
    openGraph: { title, description },
    twitter: { title, description },
  };
}

export async function generateStaticParams() {
  const products = await loaders.getAllProductSlugs();
  return products.map((p) => ({ slug: p.slug }));
}

function getAvailabilityLabel(product: TProduct): string {
  return (
    product.availabilityLabel ||
    (product.isAvailable ? "Available now" : "Currently unavailable")
  );
}

export default async function ProductDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const product = await loaders.getProductBySlug(slug);

  if (!product) notFound();

  const availabilityLabel = getAvailabilityLabel(product);
  const collections =
    product.collections?.filter((collection) => collection.title).slice(0, 3) ??
    [];
  const priceDisplay = getProductPriceDisplay(product);
  const productJsonLd = await buildProductJsonLd(product);

  return (
    <section className="min-h-screen bg-lh-neutral-2">
      <JsonLd id="lash-her-product-json-ld" data={productJsonLd} />
      <section className="section-shell-soft pt-12 md:pt-16 lg:pt-20">
        <div className="content-container">
          <Link
            href="/products"
            className="mb-8 inline-flex items-center gap-2 font-body text-sm font-bold uppercase tracking-[0.12em] text-lh-primary transition-colors hover:text-lh-accent"
          >
            <span aria-hidden="true">←</span> Back to Catalog
          </Link>

          <ProductGalleryProvider>
            <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1.05fr)_minmax(22rem,0.95fr)] lg:items-start xl:gap-12">
              <ProductDetailGallery
                product={product}
                availabilityLabel={availabilityLabel}
              />

              <aside className="lg:sticky lg:top-28">
                <section className="soft-panel bg-lh-white/90 p-6 backdrop-blur md:p-8 lg:p-9">
                  <div className="mb-7 border-b border-lh-line pb-7">
                    <p className="eyebrow-label mb-3">Product</p>
                    <h1 className="display-heading text-5xl md:text-7xl lg:text-8xl">
                      {product.title}
                    </h1>

                    {product.cardSubtitle ? (
                      <p className="mt-4 font-body text-sm font-bold uppercase tracking-[0.16em] text-lh-primary">
                        {product.cardSubtitle}
                      </p>
                    ) : null}

                    <div className="mt-6 flex flex-wrap items-baseline gap-x-3 gap-y-1 font-body text-2xl font-bold text-lh-shadow md:text-3xl">
                      {priceDisplay.originalLabel ? (
                        <span className="text-base text-lh-muted line-through md:text-lg">
                          {priceDisplay.originalLabel}
                        </span>
                      ) : null}
                      <span>{priceDisplay.currentLabel}</span>
                    </div>
                  </div>

                  {product.description && (
                    <p className="body-lead text-lh-shadow/80">
                      {product.description}
                    </p>
                  )}

                  {(collections.length > 0 || product.isAvailable) && (
                    <div className="mt-7 flex flex-wrap gap-2">
                      {product.isAvailable ? (
                        <span className="rounded-full border border-lh-line px-3 py-1.5 font-body text-xs font-bold uppercase tracking-[0.12em] text-lh-muted">
                          {availabilityLabel}
                        </span>
                      ) : null}
                      {collections.map((collection) => (
                        <span
                          key={collection._id}
                          className="rounded-full border border-lh-line px-3 py-1.5 font-body text-xs font-bold uppercase tracking-[0.12em] text-lh-shadow/70"
                        >
                          {collection.title}
                        </span>
                      ))}
                    </div>
                  )}

                  {product.fulfillmentNote ? (
                    <div className="mt-8 border-l-2 border-lh-light bg-lh-light-soft/60 px-5 py-4">
                      <p className="font-body text-sm font-bold leading-7 text-lh-shadow/78">
                        <span className="mr-2 uppercase tracking-[0.12em] text-lh-primary">
                          Fulfillment
                        </span>
                        {product.fulfillmentNote}
                      </p>
                    </div>
                  ) : null}

                  {product.isAvailable ? (
                    <ProductDetailPurchaseControls
                      product={product}
                      checkoutAvailability={getProductCheckoutAvailability()}
                    />
                  ) : (
                    <div className="mt-8 border-t border-lh-line pt-6">
                      <div className="rounded-full border border-lh-accent px-6 py-4 text-center font-body text-sm font-bold uppercase tracking-[0.12em] text-lh-accent">
                        {availabilityLabel}
                      </div>
                      <p className="mt-4 font-body text-xs font-bold leading-6 text-lh-muted">
                        This piece is not available for online checkout right
                        now. Return to the catalog to browse available
                        selections.
                      </p>
                    </div>
                  )}
                </section>
              </aside>
            </div>
          </ProductGalleryProvider>
        </div>
      </section>

      {product.detailSections && product.detailSections.length > 0 && (
        <section
          className="section-shell bg-lh-white py-12 md:py-16 lg:py-20"
          aria-labelledby="product-detail-sections-heading"
        >
          <div className="content-container">
            <header className="mb-10 max-w-3xl">
              <p className="eyebrow-label mb-3">Product Notes</p>
              <h2
                id="product-detail-sections-heading"
                className="section-heading text-4xl md:text-5xl"
              >
                Details for a precise purchase.
              </h2>
            </header>
            <ProductDetailSections sections={product.detailSections} />
          </div>
        </section>
      )}
    </section>
  );
}
