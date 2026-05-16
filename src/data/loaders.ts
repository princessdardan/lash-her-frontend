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
  TSellableProduct,
} from "@/types";

const isVercelPreview = process.env.VERCEL_ENV === "preview";

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

async function getTrainingProgramBySlug(slug: string): Promise<TTrainingProgram | null> {
  const query = groq`*[_type == "trainingProgram" && slug.current == $slug][0]{
    _id,
    title,
    description,
    "slug": slug.current,
    detailHeading,
    detailDescription,
    detailItems[]{ _key, title, description, image{ asset, hotspot, crop, alt } },
    factList,
    primaryCta{ label, href },
    checkoutEnabled,
    checkoutProduct->{
      _id,
      title,
      "slug": slug.current,
      sku,
      kind,
      price,
      currency,
      variants[]{ _key, title, sku, price, isAvailable, availabilityLabel },
      isAvailable,
      availabilityLabel,
      fulfillmentNote
    },
    checkoutCtaLabel,
    checkoutDisabledBookingCta{ label, href },
    postPurchaseInstructions,
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
      detailHeading,
      detailDescription,
      detailItems[]{ _key, title, description, image{ asset, hotspot, crop, alt } },
      factList,
      primaryCta{ label, href },
      checkoutEnabled,
      checkoutProduct->{
        _id,
        title,
        "slug": slug.current,
        sku,
        kind,
        price,
        currency,
        variants[]{ _key, title, sku, price, isAvailable, availabilityLabel },
        isAvailable,
        availabilityLabel,
        fulfillmentNote
      },
      checkoutCtaLabel,
      checkoutDisabledBookingCta{ label, href },
      postPurchaseInstructions,
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
    detailHeading,
    detailDescription,
    detailItems[]{ _key, title, description, image{ asset, hotspot, crop, alt } },
    factList,
    primaryCta{ label, href },
    checkoutEnabled,
    checkoutProduct->{
      _id,
      title,
      "slug": slug.current,
      sku,
      kind,
      price,
      currency,
      variants[]{ _key, title, sku, price, isAvailable, availabilityLabel },
      isAvailable,
      availabilityLabel,
      fulfillmentNote
    },
    checkoutCtaLabel,
    checkoutDisabledBookingCta{ label, href },
    postPurchaseInstructions,
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

async function getSellableProducts(): Promise<TSellableProduct[]> {
  const query = groq`*[_type == "sellableProduct" && isAvailable == true] | order(displayOrder asc, title asc) {
    _id,
    title,
    description,
    shortDescription,
    "slug": slug.current,
    sku,
    kind,
    price,
    currency,
    variants[]{ _key, title, sku, price, isAvailable, availabilityLabel },
    isAvailable,
    availabilityLabel,
    fulfillmentNote,
    displayOrder,
    image{ asset, hotspot, crop, alt }
  }`;
  return client.fetch<TSellableProduct[]>(query, {}, sanityFetchOptions(['sellableProduct']));
}

async function getSellableProductsByIds(ids: string[]): Promise<TSellableProduct[]> {
  const query = groq`*[_type == "sellableProduct" && _id in $ids] {
    _id,
    title,
    description,
    shortDescription,
    "slug": slug.current,
    sku,
    kind,
    price,
    currency,
    variants[]{ _key, title, sku, price, isAvailable, availabilityLabel },
    isAvailable,
    availabilityLabel,
    fulfillmentNote,
    displayOrder,
    image{ asset, hotspot, crop, alt }
  }`;
  return client.fetch<TSellableProduct[]>(query, { ids }, sanityFetchOptions(['sellableProduct']));
}

async function getSellableProductBySlug(slug: string): Promise<TSellableProduct | null> {
  const query = groq`*[_type == "sellableProduct" && slug.current == $slug && isAvailable == true][0]{
    _id,
    title,
    description,
    shortDescription,
    "slug": slug.current,
    sku,
    kind,
    price,
    currency,
    variants[]{ _key, title, sku, price, isAvailable, availabilityLabel },
    isAvailable,
    availabilityLabel,
    fulfillmentNote,
    displayOrder,
    image{ asset, hotspot, crop, alt },
    gallery[]{ asset, hotspot, crop, alt },
    detailSections[]{ _key, heading, content },
    seo{ title, description, image{ asset, hotspot, crop, alt } }
  }`;
  return client.fetch<TSellableProduct | null>(query, { slug }, sanityFetchOptions(['sellableProduct']));
}

async function getAllSellableProductSlugs(): Promise<Array<{ slug: string }>> {
  const query = groq`*[_type == "sellableProduct" && isAvailable == true]{
    "slug": slug.current
  }`;
  return client.fetch<Array<{ slug: string }>>(query, {}, sanityFetchOptions(['sellableProduct']));
}

export const loaders = {
  getHomePageData,
  getContactPageData,
  getGalleryPageData,
  getTrainingsPageData,
  getGlobalData,
  getMainMenuData,
  getMetaData,
  getTrainingProgramBySlug,
  getTrainingProgramsPageData,
  getAllTrainingPrograms,
  getAllTrainingProgramSlugs,
  getBookingSettings,
  getSellableProducts,
  getSellableProductsByIds,
  getSellableProductBySlug,
  getAllSellableProductSlugs,
};
