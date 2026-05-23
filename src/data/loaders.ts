import { client } from "@/sanity/lib/client";
import { groq } from "next-sanity";
import type { BookingSettings } from "@/lib/booking/types";
import type {
  THomePage,
  TContactPage,
  TGalleryPage,
  TTrainingPage,
  TTrainingProgramsPage,
  TTrainingProgram,
  TGlobalSettings,
  TMainMenu,
  TMetaData,
  TBookingOffering,
  TProduct,
  TProductCollection,
  TProductFilterAttribute,
  TProductsPage,
  TProductsGroupedCatalog,
  TService,
  TSellableProduct,
  TTrainingProgramCatalogItem,
} from "@/types";

const isVercelPreview = process.env.VERCEL_ENV === "preview";

export type SellableProductSort = "default" | "titleAsc" | "priceAsc" | "priceDesc";

export interface SellableProductFilters {
  collection?: string;
  attributes?: string[];
  sort?: SellableProductSort;
}

const PRODUCT_COLLECTION_PROJECTION = groq`{
  _id,
  _key,
  title,
  "slug": slug.current,
  description,
  displayOrder
}`;

const PRODUCT_PROJECTION = groq`{
  _id,
  title,
  description,
  shortDescription,
  cardSubtitle,
  badgeLabel,
  "slug": slug.current,
  kind,
  price,
  sku,
  currency,
  collections[]{
    _key,
    "_id": @->_id,
    "title": @->title,
    "slug": @->slug.current,
    "description": @->description,
    "displayOrder": @->displayOrder
  },
  filterAttributes[]{ _key, label, value },
  optionGroups[]{ _key, name, values },
  variants[]{ _key, title, sku, price, isAvailable, availabilityLabel, options[]{ _key, name, value } },
  isAvailable,
  availabilityLabel,
  fulfillmentNote,
  displayOrder,
  image{ asset, hotspot, crop, alt },
  gallery[]{ asset, hotspot, crop, alt },
  detailSections[]{ _key, heading, content, body[]{ ..., _key } },
  seo{ title, description, image{ asset, hotspot, crop, alt } }
}`;

const SERVICE_PROJECTION = groq`{
  _id,
  title,
  description,
  shortDescription,
  "slug": slug.current,
  showDetailPage,
  bookingType,
  durationMinutes,
  slotIntervalMinutes,
  bufferBeforeMinutes,
  bufferAfterMinutes,
  minimumLeadTimeHoursOverride,
  fullPrice,
  depositAmount,
  currency,
  isAvailable,
  availabilityLabel,
  displayOrder,
  image{ asset, hotspot, crop, alt },
  gallery[]{ asset, hotspot, crop, alt },
  detailSections[]{ _key, heading, content },
  seo{ title, description, image{ asset, hotspot, crop, alt } }
}`;

const TRAINING_PROGRAM_CATALOG_PROJECTION = groq`{
  _id,
  title,
  description,
  "slug": slug.current,
  checkoutEnabled,
  price,
  "currency": "CAD",
  isAvailable,
  availabilityLabel,
  fulfillmentNote,
  displayOrder,
  image{ asset, hotspot, crop, alt },
  checkoutCtaLabel,
  seo{ title, description, image{ asset, hotspot, crop, alt } }
}`;

function sanityFetchOptions(tags: string[]) {
  if (isVercelPreview) {
    return { cache: "no-store" as const };
  }

  return { next: { tags } };
}

async function getHomePageData(): Promise<THomePage | null> {
  const query = groq`*[_type == "homePage"][0]{
    title,
    description,
    blocks[]{
      _type,
      _key,
      heading,
      subHeading,
      description,
      onHomepage,
      heroSize,
      autoRotate,
      rotationIntervalMs,
      slides[]{ _key, image{ asset, hotspot, crop, alt }, heading, subHeading, description, link[]{ _key, href, label, isExternal } },
      image{ asset, hotspot, crop, alt },
      link[]{ _key, href, label, isExternal },
      title,
      features[]{ _key, heading, subHeading, icon }
    }
  }`;
  return client.fetch<THomePage | null>(query, {}, sanityFetchOptions(['homePage']));
}

async function getContactPageData(): Promise<TContactPage | null> {
  const query = groq`*[_type == "contactPage"][0]{
    title,
    subTitle,
    description,
    blocks[]{
      _type,
      _key,
      heading,
      subHeading,
      hours[]{ _key, days, times },
      contact[]{ _key, phone, email, location },
      name,
      email,
      phone,
      location,
      instagram,
      experience,
      interest,
      clients,
      info,
      message
    }
  }`;
  return client.fetch<TContactPage | null>(query, {}, sanityFetchOptions(['contactPage']));
}

async function getGalleryPageData(): Promise<TGalleryPage | null> {
  const query = groq`*[_type == "galleryPage"][0]{
    title,
    description,
    blocks[]{
      _type,
      _key,
      heading,
      subHeading,
      description,
      onHomepage,
      heroSize,
      autoRotate,
      rotationIntervalMs,
      slides[]{ _key, image{ asset, hotspot, crop, alt }, heading, subHeading, description, link[]{ _key, href, label, isExternal } },
      image{ asset, hotspot, crop, alt },
      link[]{ _key, href, label, isExternal },
      images[]{ asset, hotspot, crop, alt }
    }
  }`;
  return client.fetch<TGalleryPage | null>(query, {}, sanityFetchOptions(['galleryPage']));
}

async function getTrainingsPageData(): Promise<TTrainingPage | null> {
  const query = groq`*[_type == "trainingPage"][0]{
    title,
    description,
    blocks[]{
      _type,
      _key,
      heading,
      subHeading,
      description,
      image{ asset, hotspot, crop, alt },
      orientation,
      perks,
      features[]{ _key, format, image{ asset, hotspot, crop, alt }, heading, subHeading, location, tier, features, link{ href, label, isExternal }, icon, mostPopular }
    }
  }`;
  return client.fetch<TTrainingPage | null>(query, {}, sanityFetchOptions(['trainingPage']));
}

async function getGlobalData(): Promise<TGlobalSettings | null> {
  const query = groq`*[_type == "globalSettings"][0]{
    title,
    description,
    header{
      logoText{ href, label, isExternal },
      ctaButton[]{ _key, href, label, isExternal }
    },
    footer{
      logoText{ href, label, isExternal },
      text,
      socialLink[]{ _key, href, label, isExternal }
    },
    contactPopup{
      enabled,
      variant,
      heading,
      description,
      privacyText,
      privacyLinkLabel,
      privacyLinkHref,
      submitLabel,
      successMessage,
      cookieExpiryDays
    }
  }`;
  return client.fetch<TGlobalSettings | null>(query, {}, sanityFetchOptions(['global']));
}

async function getMainMenuData(): Promise<TMainMenu | null> {
  const query = groq`*[_type == "mainMenu"][0]{
    items[]{
      _type,
      _key,
      title,
      url,
      sections[]{ _key, heading, links[]{ _key, name, url, description } }
    }
  }`;
  return client.fetch<TMainMenu | null>(query, {}, sanityFetchOptions(['menu']));
}

async function getMetaData(): Promise<TMetaData | null> {
  const query = groq`*[_type == "globalSettings"][0]{
    title,
    description,
    "ogImageUrl": ogImage.asset->url
  }`;
  return client.fetch<TMetaData | null>(query, {}, sanityFetchOptions(['global']));
}

async function getProductsPageData(): Promise<TProductsPage | null> {
  const query = groq`*[_type == "productsPage"][0]{
    title,
    eyebrow,
    description,
    heroImage{ asset, hotspot, crop, alt },
    featuredCollections[]->${PRODUCT_COLLECTION_PROJECTION},
    emptyStateTitle,
    emptyStateDescription
  }`;
  return client.fetch<TProductsPage | null>(query, {}, sanityFetchOptions(["productsPage", "productCollection"]));
}

async function getTrainingProgramBySlug(slug: string): Promise<TTrainingProgram | null> {
  const query = groq`*[_type == "trainingProgram" && slug.current == $slug][0]{
    _id,
    title,
    description,
    "slug": slug.current,
    heroSubtitle,
    heroImage{ asset, hotspot, crop, alt },
    heroBadges,
    detailHeading,
    detailEyebrow,
    detailDescription,
    detailHeroImage{ asset, hotspot, crop, alt },
    detailMainImage{ asset, hotspot, crop, alt },
    detailItems[]{ _key, title, description, image{ asset, hotspot, crop, alt } },
    factList,
    primaryCta{ label, href },
    secondaryCta{ label, href },
    enrollmentTitle,
    enrollmentDescription,
    enrollmentBackgroundImage{ asset, hotspot, crop, alt },
    enrollmentInclusions,
    linkedProduct->{ _id, title, "slug": slug.current, price, currency, isAvailable, availabilityLabel },
    checkoutEnabled,
    price,
    "currency": "CAD",
    isAvailable,
    availabilityLabel,
    fulfillmentNote,
    displayOrder,
    image{ asset, hotspot, crop, alt },
    checkoutCtaLabel,
    checkoutDisabledBookingCta{ label, href },
    postPurchaseInstructions,
    introCallAppointmentScheduleUrl,
    "introCallAppointmentScheduleEmbedMode": coalesce(introCallAppointmentScheduleEmbedMode, "link"),
    introCallSchedulingInstructions,
    seo{ title, description, image{ asset, hotspot, crop, alt } },
    blocks[]{
      _type,
      _key,
      heading,
      subHeading,
      description,
      onHomepage,
      heroSize,
      autoRotate,
      rotationIntervalMs,
      slides[]{ _key, image{ asset, hotspot, crop, alt }, heading, subHeading, description, link[]{ _key, href, label, isExternal } },
      image{ asset, hotspot, crop, alt },
      link[]{ _key, href, label, isExternal },
      info,
      name,
      email,
      phone,
      location,
      instagram,
      experience,
      interest,
      clients
    }
  }`;
  return client.fetch<TTrainingProgram | null>(query, { slug }, sanityFetchOptions(['trainingProgram']));
}

async function getTrainingProgramsPageData(): Promise<TTrainingProgramsPage | null> {
  const query = groq`*[_type == "trainingProgramsPage"][0]{
    title,
    description,
    trainingPrograms[]->{
      _id,
      title,
      description,
      "slug": slug.current,
      heroSubtitle,
      heroImage{ asset, hotspot, crop, alt },
      heroBadges,
      detailHeading,
      detailEyebrow,
      detailDescription,
      detailHeroImage{ asset, hotspot, crop, alt },
      detailMainImage{ asset, hotspot, crop, alt },
      detailItems[]{ _key, title, description, image{ asset, hotspot, crop, alt } },
      factList,
      primaryCta{ label, href },
      secondaryCta{ label, href },
      enrollmentTitle,
      enrollmentDescription,
      enrollmentBackgroundImage{ asset, hotspot, crop, alt },
      enrollmentInclusions,
      linkedProduct->{ _id, title, "slug": slug.current, price, currency, isAvailable, availabilityLabel },
      checkoutEnabled,
      price,
      "currency": "CAD",
      isAvailable,
      availabilityLabel,
      fulfillmentNote,
      displayOrder,
      image{ asset, hotspot, crop, alt },
      checkoutCtaLabel,
      checkoutDisabledBookingCta{ label, href },
      postPurchaseInstructions,
      introCallAppointmentScheduleUrl,
      "introCallAppointmentScheduleEmbedMode": coalesce(introCallAppointmentScheduleEmbedMode, "link"),
      introCallSchedulingInstructions,
      seo{ title, description, image{ asset, hotspot, crop, alt } },
      blocks[]{
        _type,
        _key,
        heading,
        subHeading,
        description,
        onHomepage,
        heroSize,
        autoRotate,
        rotationIntervalMs,
        slides[]{ _key, image{ asset, hotspot, crop, alt }, heading, subHeading, description, link[]{ _key, href, label, isExternal } },
        image{ asset, hotspot, crop, alt },
        link[]{ _key, href, label, isExternal },
        info,
        name,
        email,
        phone,
        location,
        instagram,
        experience,
        interest,
        clients
      }
    }
  }`;
  return client.fetch<TTrainingProgramsPage | null>(query, {}, sanityFetchOptions(['trainingProgramsPage', 'trainingProgram']));
}

async function getAllTrainingPrograms(): Promise<TTrainingProgram[]> {
  const query = groq`*[_type == "trainingProgram"]{
    _id,
    title,
    description,
    "slug": slug.current,
    heroSubtitle,
    heroImage{ asset, hotspot, crop, alt },
    heroBadges,
    detailHeading,
    detailEyebrow,
    detailDescription,
    detailHeroImage{ asset, hotspot, crop, alt },
    detailMainImage{ asset, hotspot, crop, alt },
    detailItems[]{ _key, title, description, image{ asset, hotspot, crop, alt } },
    factList,
    primaryCta{ label, href },
    secondaryCta{ label, href },
    enrollmentTitle,
    enrollmentDescription,
    enrollmentBackgroundImage{ asset, hotspot, crop, alt },
    enrollmentInclusions,
    linkedProduct->{ _id, title, "slug": slug.current, price, currency, isAvailable, availabilityLabel },
    checkoutEnabled,
    price,
    "currency": "CAD",
    isAvailable,
    availabilityLabel,
    fulfillmentNote,
    displayOrder,
    image{ asset, hotspot, crop, alt },
    checkoutCtaLabel,
    checkoutDisabledBookingCta{ label, href },
    postPurchaseInstructions,
    introCallAppointmentScheduleUrl,
    "introCallAppointmentScheduleEmbedMode": coalesce(introCallAppointmentScheduleEmbedMode, "link"),
    introCallSchedulingInstructions,
    seo{ title, description, image{ asset, hotspot, crop, alt } },
    blocks[]{
      _type,
      _key,
      heading,
      subHeading,
      description,
      onHomepage,
      heroSize,
      autoRotate,
      rotationIntervalMs,
      slides[]{ _key, image{ asset, hotspot, crop, alt }, heading, subHeading, description, link[]{ _key, href, label, isExternal } },
      image{ asset, hotspot, crop, alt },
      link[]{ _key, href, label, isExternal },
      info,
      name,
      email,
      phone,
      location,
      instagram,
      experience,
      interest,
      clients
    }
  }`;
  return client.fetch<TTrainingProgram[]>(query, {}, sanityFetchOptions(['trainingProgram']));
}

async function getAllTrainingProgramSlugs(): Promise<Array<{ slug: string }>> {
  const query = groq`*[_type == "trainingProgram"]{
    "slug": slug.current
  }`;
  return client.fetch<Array<{ slug: string }>>(query, {}, sanityFetchOptions(['trainingProgram']));
}

async function getBookingSettings(): Promise<BookingSettings | null> {
  const query = groq`*[_type == "bookingSettings"][0]{
    calendarId,
    availabilityMarkerTitle,
    bookingHorizonDays,
    minimumLeadTimeHours,
    timezone,
    marketingOptInLabel,
    bookingTypes[]{
      _key,
      type,
      label,
      description,
      durationMinutes,
      slotIntervalMinutes,
      bufferBeforeMinutes,
      bufferAfterMinutes,
      "questions": coalesce(questions[]{ _key, id, label, inputType, required, options }, [])
    }
  }`;
  return client.fetch<BookingSettings | null>(query, {}, sanityFetchOptions(["bookingSettings"]));
}

const BOOKING_OFFERING_PROJECTION = groq`{
  _id,
  title,
  description,
  "slug": slug.current,
  service->{
    _id,
    title,
    description,
    "slug": slug.current,
    image{ asset, hotspot, crop, alt }
  },
  isActive,
  bookingType,
  durationMinutes,
  slotIntervalMinutes,
  bufferBeforeMinutes,
  bufferAfterMinutes,
  minimumLeadTimeHoursOverride,
  depositAmount,
  fullPrice,
  currency,
  displayOrder
}`;

const SERVICE_BOOKING_OFFERING_PROJECTION = groq`{
  _id,
  title,
  description,
  "slug": slug.current,
  "isActive": isAvailable,
  bookingType,
  durationMinutes,
  slotIntervalMinutes,
  bufferBeforeMinutes,
  bufferAfterMinutes,
  minimumLeadTimeHoursOverride,
  fullPrice,
  depositAmount,
  currency,
  displayOrder
}`;

async function getActiveBookingOfferings(): Promise<TBookingOffering[]> {
  const bookingOfferingsQuery = groq`*[_type == "bookingOffering" && isActive == true] | order(displayOrder asc, title asc) ${BOOKING_OFFERING_PROJECTION}`;
  const servicesQuery = groq`*[_type == "service" && isAvailable == true] | order(displayOrder asc, title asc) ${SERVICE_BOOKING_OFFERING_PROJECTION}`;
  const [bookingOfferings, services] = await Promise.all([
    client.fetch<TBookingOffering[]>(bookingOfferingsQuery, {}, sanityFetchOptions(["bookingOffering"])),
    client.fetch<TBookingOffering[]>(servicesQuery, {}, sanityFetchOptions(["service"])),
  ]);
  const configuredBookingOfferings = bookingOfferings.filter(isPaymentConfiguredBookingOffering);
  const configuredServices = services.filter(isPaymentConfiguredBookingOffering);
  const bookingOfferingSlugs = new Set(configuredBookingOfferings.map((offering) => offering.slug));
  const serviceOfferings = configuredServices.filter((service) => !bookingOfferingSlugs.has(service.slug));

  return [...configuredBookingOfferings, ...serviceOfferings].sort(compareBookingOfferings);
}

async function getBookingOfferingBySlug(slug: string): Promise<TBookingOffering | null> {
  const bookingOfferingQuery = groq`*[_type == "bookingOffering" && slug.current == $slug && isActive == true][0] ${BOOKING_OFFERING_PROJECTION}`;
  const bookingOffering = await client.fetch<TBookingOffering | null>(
    bookingOfferingQuery,
    { slug },
    sanityFetchOptions(["bookingOffering"]),
  );

  if (bookingOffering !== null && isPaymentConfiguredBookingOffering(bookingOffering)) {
    return bookingOffering;
  }

  const serviceQuery = groq`*[_type == "service" && slug.current == $slug && isAvailable == true][0] ${SERVICE_BOOKING_OFFERING_PROJECTION}`;
  const service = await client.fetch<TBookingOffering | null>(serviceQuery, { slug }, sanityFetchOptions(["service"]));

  return service !== null && isPaymentConfiguredBookingOffering(service) ? service : null;
}

function isPaymentConfiguredBookingOffering(offering: TBookingOffering): boolean {
  return isPositiveAmount(offering.depositAmount) &&
    isPositiveAmount(offering.fullPrice) &&
    offering.depositAmount < offering.fullPrice;
}

function isPositiveAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function compareBookingOfferings(first: TBookingOffering, second: TBookingOffering): number {
  const firstOrder = first.displayOrder ?? Number.MAX_SAFE_INTEGER;
  const secondOrder = second.displayOrder ?? Number.MAX_SAFE_INTEGER;

  if (firstOrder !== secondOrder) {
    return firstOrder - secondOrder;
  }

  return first.title.localeCompare(second.title);
}


function getSellableProductOrder(sort: SellableProductSort | undefined): string {
  switch (sort) {
    case "titleAsc":
      return "title asc";
    case "priceAsc":
      return "price asc, title asc";
    case "priceDesc":
      return "price desc, title asc";
    default:
      return "displayOrder asc, title asc";
  }
}

function normalizeProductFilters(filters: SellableProductFilters): Required<SellableProductFilters> {
  return {
    collection: filters.collection?.trim() ?? "",
    attributes: filters.attributes?.map((attribute) => attribute.trim()).filter(Boolean) ?? [],
    sort: filters.sort ?? "default",
  };
}

async function getProductsPageCollections(): Promise<TProductCollection[]> {
  const query = groq`*[_type == "productCollection"] | order(displayOrder asc, title asc) ${PRODUCT_COLLECTION_PROJECTION}`;
  return client.fetch<TProductCollection[]>(query, {}, sanityFetchOptions(["productCollection"]));
}

async function getSellableProductFilterAttributes(): Promise<TProductFilterAttribute[]> {
  const query = groq`*[_type == "sellableProduct" && isAvailable == true].filterAttributes[]{ _key, label, value }`;
  return client.fetch<TProductFilterAttribute[]>(query, {}, sanityFetchOptions(["sellableProduct"]));
}

async function getSellableProducts(filters: SellableProductFilters = {}): Promise<TSellableProduct[]> {
  const normalizedFilters = normalizeProductFilters(filters);
  const order = getSellableProductOrder(normalizedFilters.sort);
  const query = groq`*[
    _type == "sellableProduct" &&
    isAvailable == true &&
    ($collection == "" || collections[]._ref in *[_type == "productCollection" && slug.current == $collection]._id) &&
    (count($attributes) == 0 || count(filterAttributes[value in $attributes]) == count($attributes))
  ] | order(${order}) ${PRODUCT_PROJECTION}`;

  return client.fetch<TSellableProduct[]>(
    query,
    { collection: normalizedFilters.collection, attributes: normalizedFilters.attributes },
    sanityFetchOptions(["sellableProduct", "productCollection"]),
  );
}

async function getSellableProductsByIds(ids: string[]): Promise<TSellableProduct[]> {
  const query = groq`*[_type == "sellableProduct" && _id in $ids] ${PRODUCT_PROJECTION}`;
  return client.fetch<TSellableProduct[]>(query, { ids }, sanityFetchOptions(["sellableProduct"]));
}

async function getSellableProductBySlug(slug: string): Promise<TSellableProduct | null> {
  const query = groq`*[_type == "sellableProduct" && slug.current == $slug && isAvailable == true][0] ${PRODUCT_PROJECTION}`;
  return client.fetch<TSellableProduct | null>(query, { slug }, sanityFetchOptions(["sellableProduct"]));
}

async function getAllSellableProductSlugs(): Promise<Array<{ slug: string }>> {
  const query = groq`*[_type == "sellableProduct" && isAvailable == true]{
    "slug": slug.current
  }`;
  return client.fetch<Array<{ slug: string }>>(query, {}, sanityFetchOptions(["sellableProduct"]));
}

async function getProducts(): Promise<TProduct[]> {
  const query = groq`*[_type == "product" && isAvailable == true] | order(displayOrder asc, title asc) ${PRODUCT_PROJECTION}`;
  return client.fetch<TProduct[]>(query, {}, sanityFetchOptions(["product"]));
}

async function getProductsByIds(ids: string[]): Promise<TProduct[]> {
  const query = groq`*[_type == "product" && _id in $ids] ${PRODUCT_PROJECTION}`;
  return client.fetch<TProduct[]>(query, { ids }, sanityFetchOptions(["product"]));
}

async function getServices(): Promise<TService[]> {
  const query = groq`*[_type == "service" && isAvailable == true] | order(displayOrder asc, title asc) ${SERVICE_PROJECTION}`;
  return client.fetch<TService[]>(query, {}, sanityFetchOptions(["service"]));
}

async function getTrainingProgramCatalogItems(): Promise<TTrainingProgramCatalogItem[]> {
  const query = groq`*[_type == "trainingProgram" && checkoutEnabled == true] | order(displayOrder asc, title asc) ${TRAINING_PROGRAM_CATALOG_PROJECTION}`;
  return client.fetch<TTrainingProgramCatalogItem[]>(query, {}, sanityFetchOptions(["trainingProgram"]));
}

async function getProductsGroupedCatalog(): Promise<TProductsGroupedCatalog> {
  const [products, trainingPrograms, services] = await Promise.all([
    getProducts(),
    getTrainingProgramCatalogItems(),
    getServices(),
  ]);

  return { products, trainingPrograms, services };
}

async function getProductBySlug(slug: string): Promise<TProduct | null> {
  const query = groq`*[_type == "product" && slug.current == $slug && isAvailable == true][0] ${PRODUCT_PROJECTION}`;
  return client.fetch<TProduct | null>(query, { slug }, sanityFetchOptions(["product"]));
}

async function getAllProductSlugs(): Promise<Array<{ slug: string }>> {
  const query = groq`*[_type == "product" && isAvailable == true]{
    "slug": slug.current
  }`;
  return client.fetch<Array<{ slug: string }>>(query, {}, sanityFetchOptions(["product"]));
}

async function getServiceBySlug(slug: string): Promise<TService | null> {
  const query = groq`*[_type == "service" && slug.current == $slug && isAvailable == true][0] ${SERVICE_PROJECTION}`;
  return client.fetch<TService | null>(query, { slug }, sanityFetchOptions(["service"]));
}

async function getAllServiceSlugs(): Promise<Array<{ slug: string }>> {
  const query = groq`*[_type == "service" && isAvailable == true]{
    "slug": slug.current
  }`;
  return client.fetch<Array<{ slug: string }>>(query, {}, sanityFetchOptions(["service"]));
}

export const loaders = {
  getHomePageData,
  getContactPageData,
  getGalleryPageData,
  getTrainingsPageData,
  getGlobalData,
  getMainMenuData,
  getMetaData,
  getProductsPageData,
  getTrainingProgramBySlug,
  getTrainingProgramsPageData,
  getAllTrainingPrograms,
  getAllTrainingProgramSlugs,
  getBookingSettings,
  getActiveBookingOfferings,
  getBookingOfferingBySlug,
  getProductsPageCollections,
  getSellableProductFilterAttributes,
  getSellableProducts,
  getSellableProductsByIds,
  getSellableProductBySlug,
  getAllSellableProductSlugs,
  getProducts,
  getProductsByIds,
  getServices,
  getTrainingProgramCatalogItems,
  getProductsGroupedCatalog,
  getProductBySlug,
  getAllProductSlugs,
  getServiceBySlug,
  getAllServiceSlugs,
};
