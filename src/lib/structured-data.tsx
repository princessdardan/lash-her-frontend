import { createImageUrlBuilder } from "@sanity/image-url";
import { client } from "@/sanity/lib/client";
import type { THomePage, TContactPage, TProduct, TService, TTrainingProgram, TSanityImage } from "@/types";

const SITE_URL = "https://lashher.com";
const BUSINESS_NAME = "Lash Her by Nataliea";
const BUSINESS_DESCRIPTION = "Elevating beauty through bespoke lash artistry and professional education.";
const BUSINESS_ID = `${SITE_URL}/#organization`;

const imageBuilder = createImageUrlBuilder(client);

type JsonLdValue = string | number | boolean | null | JsonLdObject | JsonLdValue[];
type JsonLdObject = { [key: string]: JsonLdValue | undefined };

interface JsonLdProps {
  readonly id: string;
  readonly data: JsonLdObject;
}

export function JsonLd({ id, data }: JsonLdProps) {
  return (
    <script
      id={id}
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(cleanJsonLd(data)).replace(/</g, "\\u003c") }}
    />
  );
}

export function buildOrganizationJsonLd(homeData: THomePage, contactData: TContactPage | null): JsonLdObject {
  const contact = getPrimaryContact(contactData);
  const hours = getOpeningHours(contactData);
  const description = homeData.blocks.find((block) => block._type === "heroSection")?.description
    || homeData.description
    || contactData?.description
    || BUSINESS_DESCRIPTION;

  return {
    "@context": "https://schema.org",
    "@type": ["Organization", "BeautySalon"],
    "@id": BUSINESS_ID,
    name: BUSINESS_NAME,
    url: SITE_URL,
    description,
    email: contact?.email,
    telephone: isRequestOnlyValue(contact?.phone) ? undefined : contact?.phone,
    address: contact?.location
      ? {
          "@type": "PostalAddress",
          streetAddress: contact.location,
          addressLocality: "Toronto",
          addressRegion: "ON",
          addressCountry: "CA",
        }
      : undefined,
    openingHours: hours,
    sameAs: [
      "https://www.instagram.com/lav_lashher/",
      "https://www.fresha.com/a/lash-her-by-nataliea-toronto-646-oakwood-avenue-tvrir5sx/all-offer?menu=true&share=true&pId=1106337",
    ],
  };
}

export function buildProductCollectionJsonLd(products: TProduct[]): JsonLdObject | null {
  const itemListElement = products.map((product, index) => ({
    "@type": "ListItem",
    position: index + 1,
    url: `${SITE_URL}/products/${product.slug}`,
    item: {
      "@type": "Product",
      name: product.title,
      description: product.shortDescription || product.description,
      image: getImageUrl(product.image),
      offers: buildProductOffer(product),
    },
  }));

  if (itemListElement.length === 0) return null;

  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "@id": `${SITE_URL}/products#product-list`,
    name: "Lash Her products",
    itemListElement,
  };
}

export function buildProductJsonLd(product: TProduct): JsonLdObject {
  const imageUrls = getProductImageUrls(product);

  return {
    "@context": "https://schema.org",
    "@type": "Product",
    "@id": `${SITE_URL}/products/${product.slug}#product`,
    name: product.title,
    description: product.seo?.description || product.shortDescription || product.description,
    image: imageUrls,
    sku: product.sku,
    brand: businessReference(),
    category: product.collections?.map((collection) => collection.title).filter(Boolean).join(", "),
    offers: buildProductOffer(product),
  };
}

export function buildServiceCollectionJsonLd(services: TService[]): JsonLdObject | null {
  const itemListElement = services.map((service, index) => ({
    "@type": "ListItem",
    position: index + 1,
    url: getServiceUrl(service),
    item: {
      "@type": "Service",
      "@id": `${getServiceUrl(service)}#service`,
      name: service.title,
      description: service.shortDescription || service.description,
      image: getImageUrl(service.image),
      provider: businessReference(),
      offers: buildServiceOffer(service),
    },
  }));

  if (itemListElement.length === 0) return null;

  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "@id": `${SITE_URL}/services#service-list`,
    name: "Lash Her services",
    itemListElement,
  };
}

export function buildServiceJsonLd(service: TService): JsonLdObject {
  return {
    "@context": "https://schema.org",
    "@type": "Service",
    "@id": `${SITE_URL}/services/${service.slug}#service`,
    name: service.title,
    description: service.seo?.description || service.shortDescription || service.description,
    image: getImageUrl(service.image),
    provider: businessReference(),
    areaServed: {
      "@type": "City",
      name: "Toronto",
    },
    offers: buildServiceOffer(service),
  };
}

export function buildTrainingProgramCollectionJsonLd(programs: TTrainingProgram[]): JsonLdObject | null {
  const itemListElement = programs.map((program, index) => ({
    "@type": "ListItem",
    position: index + 1,
    url: `${SITE_URL}/training-programs/${program.slug}`,
    item: {
      "@type": "Course",
      "@id": `${SITE_URL}/training-programs/${program.slug}#course`,
      name: program.title,
      description: program.seo?.description || program.description,
      image: getImageUrl(program.seo?.image || program.image || program.heroImage),
      provider: businessReference(),
      offers: buildTrainingProgramOffer(program),
    },
  }));

  if (itemListElement.length === 0) return null;

  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "@id": `${SITE_URL}/training-programs#course-list`,
    name: "Lash Her training programs",
    itemListElement,
  };
}

export function buildTrainingProgramJsonLd(program: TTrainingProgram): JsonLdObject {
  return {
    "@context": "https://schema.org",
    "@type": "Course",
    "@id": `${SITE_URL}/training-programs/${program.slug}#course`,
    name: program.title,
    description: program.seo?.description || program.description,
    image: getImageUrl(program.seo?.image || program.image || program.heroImage),
    provider: businessReference(),
    offers: buildTrainingProgramOffer(program),
  };
}

function businessReference(): JsonLdObject {
  return {
    "@type": "Organization",
    "@id": BUSINESS_ID,
    name: BUSINESS_NAME,
    url: SITE_URL,
  };
}

function getPrimaryContact(contactData: TContactPage | null) {
  return contactData?.blocks
    .find((block) => block._type === "contactInfo")
    ?.contact?.find((contact) => contact.email || contact.phone || contact.location);
}

function getOpeningHours(contactData: TContactPage | null): string[] | undefined {
  const hours = contactData?.blocks
    .find((block) => block._type === "schedule")
    ?.hours
    ?.map((entry) => [entry.days, entry.times].filter(Boolean).join(" ").trim())
    .filter(Boolean);

  return hours && hours.length > 0 ? hours : undefined;
}

function isRequestOnlyValue(value: string | undefined): boolean {
  return value?.toLowerCase().includes("request") ?? false;
}

function getProductImageUrls(product: TProduct): string[] {
  return [product.seo?.image, product.image, ...(product.gallery ?? [])]
    .map((image) => getImageUrl(image))
    .filter((url): url is string => Boolean(url));
}

function buildProductOffer(product: TProduct): JsonLdObject | undefined {
  const variantPrices = (product.variants ?? [])
    .map((variant) => ({
      price: getCommercePrice(variant.price, variant.discountPrice),
      isAvailable: variant.isAvailable,
    }))
    .filter((variant): variant is { price: number; isAvailable: boolean } => typeof variant.price === "number");

  if (variantPrices.length === 1) {
    return buildOffer({
      availability: product.isAvailable && variantPrices[0].isAvailable,
      price: variantPrices[0].price,
      priceCurrency: product.currency,
      url: `${SITE_URL}/products/${product.slug}`,
    });
  }

  if (variantPrices.length > 1) {
    const prices = variantPrices.map((variant) => variant.price);
    const lowPrice = Math.min(...prices);
    const highPrice = Math.max(...prices);

    if (lowPrice === highPrice) {
      return buildOffer({
        availability: product.isAvailable && variantPrices.some((variant) => variant.isAvailable),
        price: lowPrice,
        priceCurrency: product.currency,
        url: `${SITE_URL}/products/${product.slug}`,
      });
    }

    return {
      "@type": "AggregateOffer",
      url: `${SITE_URL}/products/${product.slug}`,
      lowPrice,
      highPrice,
      priceCurrency: product.currency,
      offerCount: variantPrices.length,
      availability: product.isAvailable && variantPrices.some((variant) => variant.isAvailable)
        ? "https://schema.org/InStock"
        : "https://schema.org/OutOfStock",
      seller: businessReference(),
    };
  }

  const price = getCommercePrice(product.price, product.discountPrice);
  if (typeof price !== "number") return undefined;

  return buildOffer({
    availability: product.isAvailable,
    price,
    priceCurrency: product.currency,
    url: `${SITE_URL}/products/${product.slug}`,
  });
}

function buildServiceOffer(service: TService): JsonLdObject | undefined {
  if (typeof service.fullPrice !== "number" || !Number.isFinite(service.fullPrice)) return undefined;

  return buildOffer({
    availability: service.isAvailable,
    price: service.fullPrice,
    priceCurrency: service.currency,
    url: getServiceUrl(service),
  });
}

function buildTrainingProgramOffer(program: TTrainingProgram): JsonLdObject | undefined {
  const price = getCommercePrice(program.price, program.discountPrice);
  if (program.checkoutEnabled !== true || program.isAvailable !== true || typeof price !== "number") return undefined;

  return buildOffer({
    availability: true,
    price,
    priceCurrency: program.currency || "CAD",
    url: `${SITE_URL}/training-programs/${program.slug}/checkout`,
  });
}

function buildOffer({
  availability,
  price,
  priceCurrency,
  url,
}: {
  availability: boolean;
  price: number;
  priceCurrency: string;
  url: string;
}): JsonLdObject {
  return {
    "@type": "Offer",
    url,
    price,
    priceCurrency,
    availability: availability ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
    seller: businessReference(),
  };
}

function getServiceUrl(service: TService): string {
  return service.showDetailPage ? `${SITE_URL}/services/${service.slug}` : `${SITE_URL}/services/${service.slug}/booking`;
}

function getImageUrl(image: TSanityImage | undefined): string | undefined {
  if (!image?.asset?._ref) return undefined;

  return imageBuilder.image(image).width(1200).fit("max").auto("format").url();
}

function getCommercePrice(price: unknown, discountPrice: unknown): number | undefined {
  if (typeof price !== "number" || !Number.isFinite(price)) return undefined;

  return typeof discountPrice === "number" && Number.isFinite(discountPrice) && discountPrice < price
    ? discountPrice
    : price;
}

function cleanJsonLd(value: JsonLdValue | undefined): JsonLdValue | undefined {
  if (Array.isArray(value)) {
    const cleaned = value
      .map((item) => cleanJsonLd(item))
      .filter((item): item is JsonLdValue => item !== undefined && item !== null && item !== "");

    return cleaned.length > 0 ? cleaned : undefined;
  }

  if (!value || typeof value !== "object") {
    return value === "" ? undefined : value;
  }

  const entries = Object.entries(value)
    .map(([key, entryValue]) => [key, cleanJsonLd(entryValue)] as const)
    .filter(([, entryValue]) => entryValue !== undefined && entryValue !== null && entryValue !== "");

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
