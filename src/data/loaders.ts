import { client } from "@/sanity/lib/client";
import { stegaClean } from "@sanity/client/stega";
import { draftMode } from "next/headers";
import { groq, type QueryParams } from "next-sanity";
import { getSanityApiReadToken } from "@/sanity/env";
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
  TProduct,
  TProductsPage,
  TProductsGroupedCatalog,
  TPromotionCode,
  TService,
  TTrainingProgramCatalogItem,
} from "@/types";

const isVercelPreview = process.env.VERCEL_ENV === "preview";
const STUDIO_URL = "/studio";

type SanityFetchOptions = {
  mode?: "auto" | "published";
  stega?: boolean;
};

const CONTROL_STRING_KEYS = new Set([
  "_id",
  "_key",
  "_ref",
  "_type",
  "currency",
  "heroSize",
  "layout",
  "orientation",
  "sku",
  "value",
]);

export type ProductSort = "default" | "titleAsc" | "priceAsc" | "priceDesc";

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
  price,
  discountPrice,
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
  optionGroups[]{ _key, name, values },
  variants[]{ _key, title, sku, price, discountPrice, isAvailable, availabilityLabel, options[]{ _key, name, value } },
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
  durationMinutes,
  fullPrice,
  depositAmount,
  currency,
  isAvailable,
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
  discountPrice,
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

async function sanityFetch<T>(
  query: string,
  params: QueryParams,
  tags: string[],
  options: SanityFetchOptions = {},
): Promise<T> {
  if (options.mode === "published") {
    return client.fetch<T>(query, params, sanityFetchOptions(tags));
  }

  const { isEnabled } = await draftMode();

  if (isEnabled) {
    const stegaEnabled = options.stega !== false;
    const data = await client
      .withConfig({
        useCdn: false,
        perspective: "drafts",
        token: getSanityApiReadToken(),
        stega: stegaEnabled
          ? { enabled: true, studioUrl: STUDIO_URL }
          : { enabled: false },
      })
      .fetch<T>(query, params, { cache: "no-store" as const });

    return stegaEnabled ? cleanStegaControlStrings(data) : data;
  }

  return client.fetch<T>(query, params, sanityFetchOptions(tags));
}

function cleanStegaControlStrings<T>(value: T): T {
  return cleanStegaControlValue(value, "") as T;
}

function cleanStegaControlValue(value: unknown, key: string): unknown {
  if (typeof value === "string") {
    return isControlStringKey(key) ? stegaClean(value) : value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => cleanStegaControlValue(item, key));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
      entryKey,
      cleanStegaControlValue(entryValue, entryKey),
    ]),
  );
}

function isControlStringKey(key: string): boolean {
  const normalizedKey = key.toLowerCase();

  return CONTROL_STRING_KEYS.has(key)
    || normalizedKey.endsWith("href")
    || normalizedKey.endsWith("mode")
    || normalizedKey.endsWith("slug")
    || normalizedKey.endsWith("type")
    || normalizedKey.endsWith("url");
}

function sanityStaticFetch<T>(
  query: string,
  params: QueryParams,
  tags: string[],
): Promise<T> {
  return client.fetch<T>(query, params, sanityFetchOptions(tags));
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
      layout,
      enableCarousel,
      carouselIntervalMs,
      items[]{ _key, image{ asset, hotspot, crop, alt }, heading, subHeading, description, link{ href, label, isExternal }, product->{ _id, title, "slug": slug.current, shortDescription, description, cardSubtitle, image{ asset, hotspot, crop, alt } } }
    }
  }`;
  return sanityFetch<THomePage | null>(query, {}, ["homePage"]);
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
  return sanityFetch<TContactPage | null>(query, {}, ["contactPage"]);
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
  return sanityFetch<TGalleryPage | null>(query, {}, ["galleryPage"]);
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
  return sanityFetch<TTrainingPage | null>(query, {}, ["trainingPage"]);
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
  return sanityFetch<TGlobalSettings | null>(query, {}, ["global"]);
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
  return sanityFetch<TMainMenu | null>(query, {}, ["menu"]);
}

async function getMetaData(): Promise<TMetaData | null> {
  const query = groq`*[_type == "globalSettings"][0]{
    title,
    description,
    "ogImageUrl": ogImage.asset->url
  }`;
  return sanityFetch<TMetaData | null>(query, {}, ["global"], { stega: false });
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
  return sanityFetch<TProductsPage | null>(query, {}, ["productsPage", "productCollection"]);
}

async function getTrainingProgramBySlug(
  slug: string,
  options: SanityFetchOptions = {},
): Promise<TTrainingProgram | null> {
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
    detailItems[]{ _key, eyelash, title, description },
    factList,
    primaryCta{ label, href },
    secondaryCta{ label, href },
    enrollmentTitle,
    enrollmentDescription,
    enrollmentBackgroundImage{ asset, hotspot, crop, alt },
    checkoutEnabled,
    price,
    discountPrice,
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
    trainingContact{
      _type,
      enabled,
      heading,
      subHeading,
      name,
      email,
      phone,
      location,
      instagram,
      submitLabel,
      successMessage
    },
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
  return sanityFetch<TTrainingProgram | null>(query, { slug }, ["trainingProgram"], options);
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
    detailItems[]{ _key, eyelash, title, description },
    factList,
    primaryCta{ label, href },
    secondaryCta{ label, href },
    enrollmentTitle,
    enrollmentDescription,
    enrollmentBackgroundImage{ asset, hotspot, crop, alt },
      checkoutEnabled,
      price,
      discountPrice,
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
    trainingContact{
      _type,
      enabled,
      heading,
      subHeading,
      name,
      email,
      phone,
      location,
      instagram,
      submitLabel,
      successMessage,
      privacyPolicyText[]{ ..., _key }
    },
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
  return sanityFetch<TTrainingProgramsPage | null>(query, {}, ["trainingProgramsPage", "trainingProgram"]);
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
    detailItems[]{ _key, eyelash, title, description },
    factList,
    primaryCta{ label, href },
    secondaryCta{ label, href },
    enrollmentTitle,
    enrollmentDescription,
    enrollmentBackgroundImage{ asset, hotspot, crop, alt },
    checkoutEnabled,
    price,
    discountPrice,
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
    trainingContact{
      _type,
      enabled,
      heading,
      subHeading,
      name,
      email,
      phone,
      location,
      instagram,
      submitLabel,
      successMessage,
      privacyPolicyText[]{ ..., _key }
    },
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
  return sanityFetch<TTrainingProgram[]>(query, {}, ["trainingProgram"]);
}

async function getAllTrainingProgramSlugs(): Promise<Array<{ slug: string }>> {
  const query = groq`*[_type == "trainingProgram"]{
    "slug": slug.current
  }`;
  return sanityStaticFetch<Array<{ slug: string }>>(query, {}, ["trainingProgram"]);
}

async function getBookingSettings(options: SanityFetchOptions = {}): Promise<BookingSettings | null> {
  const query = groq`*[_type == "bookingSettings" && !(_id in path("drafts.**"))]{
    "singletonPriority": select(_id == "bookingSettings" => 0, 1),
    calendarId,
    bookingHorizonDays,
    minimumLeadTimeHours,
    timezone,
    bufferMinutes,
    slotIntervalMinutes,
    hoursOfOperation[]{ _key, day, isOpen, opensAt, closesAt },
    "intakeQuestions": coalesce(intakeQuestions[]{ _key, id, label, inputType, required, options }, []),
    marketingOptInLabel
  } | order(singletonPriority asc, _updatedAt desc)[0]{
    calendarId,
    bookingHorizonDays,
    minimumLeadTimeHours,
    timezone,
    bufferMinutes,
    slotIntervalMinutes,
    hoursOfOperation[]{ _key, day, isOpen, opensAt, closesAt },
    intakeQuestions,
    marketingOptInLabel
  }`;
  return sanityFetch<BookingSettings | null>(query, {}, ["bookingSettings"], { ...options, stega: false });
}

async function getBookableServices(options: SanityFetchOptions = {}): Promise<TService[]> {
  const services = await getServices(options);
  return services.filter(isPaymentConfiguredService).sort(compareServices);
}

async function getBookableServiceBySlug(
  slug: string,
  options: SanityFetchOptions = {},
): Promise<TService | null> {
  const service = await getServiceBySlug(slug, options);
  return service !== null && isPaymentConfiguredService(service) ? service : null;
}

function isPaymentConfiguredService(service: TService): boolean {
  return isPositiveAmount(service.depositAmount) &&
    isPositiveAmount(service.fullPrice) &&
    service.depositAmount < service.fullPrice;
}

function isPositiveAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function compareServices(first: TService, second: TService): number {
  const firstOrder = first.displayOrder ?? Number.MAX_SAFE_INTEGER;
  const secondOrder = second.displayOrder ?? Number.MAX_SAFE_INTEGER;

  if (firstOrder !== secondOrder) {
    return firstOrder - secondOrder;
  }

  return first.title.localeCompare(second.title);
}


function getProductOrder(sort: ProductSort | undefined): string {
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

async function getProducts(sort: ProductSort = "default"): Promise<TProduct[]> {
  const order = getProductOrder(sort);
  const query = groq`*[
    _type == "product" &&
    isAvailable == true
  ] | order(${order}) ${PRODUCT_PROJECTION}`;

  return sanityFetch<TProduct[]>(
    query,
    {},
    ["product", "productCollection"],
  );
}

async function getProductsByIds(ids: string[]): Promise<TProduct[]> {
  const query = groq`*[_type == "product" && _id in $ids] ${PRODUCT_PROJECTION}`;
  return sanityFetch<TProduct[]>(query, { ids }, ["product"], { mode: "published", stega: false });
}

async function getPromotionCode(code: string): Promise<TPromotionCode | null> {
  const query = groq`*[_type == "promotionCode" && code == $code][0]{
    _id,
    title,
    code,
    isEnabled,
    discountType,
    amount,
    appliesTo,
    products[]->{ _id },
    trainingPrograms[]->{ _id }
  }`;
  return sanityFetch<TPromotionCode | null>(query, { code }, ["promotionCode", "product", "trainingProgram"], { mode: "published", stega: false });
}

async function getServices(options: SanityFetchOptions = {}): Promise<TService[]> {
  const query = groq`*[_type == "service" && isAvailable == true] | order(displayOrder asc, title asc) ${SERVICE_PROJECTION}`;
  return sanityFetch<TService[]>(query, {}, ["service"], options);
}

async function getTrainingProgramCatalogItems(): Promise<TTrainingProgramCatalogItem[]> {
  const query = groq`*[_type == "trainingProgram" && checkoutEnabled == true] | order(displayOrder asc, title asc) ${TRAINING_PROGRAM_CATALOG_PROJECTION}`;
  return sanityFetch<TTrainingProgramCatalogItem[]>(query, {}, ["trainingProgram"]);
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
  return sanityFetch<TProduct | null>(query, { slug }, ["product"]);
}

async function getAllProductSlugs(): Promise<Array<{ slug: string }>> {
  const query = groq`*[_type == "product" && isAvailable == true]{
    "slug": slug.current
  }`;
  return sanityStaticFetch<Array<{ slug: string }>>(query, {}, ["product"]);
}

async function getServiceBySlug(
  slug: string,
  options: SanityFetchOptions = {},
): Promise<TService | null> {
  const query = groq`*[_type == "service" && slug.current == $slug && isAvailable == true][0] ${SERVICE_PROJECTION}`;
  return sanityFetch<TService | null>(query, { slug }, ["service"], options);
}

async function getAllServiceSlugs(): Promise<Array<{ slug: string }>> {
  const query = groq`*[_type == "service" && isAvailable == true]{
    "slug": slug.current
  }`;
  return sanityStaticFetch<Array<{ slug: string }>>(query, {}, ["service"]);
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
  getBookableServices,
  getBookableServiceBySlug,
  getProducts,
  getProductsByIds,
  getPromotionCode,
  getServices,
  getTrainingProgramCatalogItems,
  getProductsGroupedCatalog,
  getProductBySlug,
  getAllProductSlugs,
  getServiceBySlug,
  getAllServiceSlugs,
};
