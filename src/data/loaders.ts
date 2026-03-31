import { client } from "@/sanity/lib/client";
import { groq } from "next-sanity";
import type {
  THomePage,
  TContactPage,
  TGalleryPage,
  TTrainingPage,
  TTrainingProgram,
  TGlobalSettings,
  TMainMenu,
  TMetaData,
} from "@/types";

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
      image{ asset, hotspot, crop, alt },
      link[]{ _key, href, label, isExternal },
      title,
      features[]{ _key, heading, subHeading, icon }
    }
  }`;
  return client.fetch<THomePage | null>(query, {}, { next: { tags: ['homePage'] } });
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
  return client.fetch<TContactPage | null>(query, {}, { next: { tags: ['contactPage'] } });
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
      image{ asset, hotspot, crop, alt },
      link[]{ _key, href, label, isExternal },
      images[]{ asset, hotspot, crop, alt }
    }
  }`;
  return client.fetch<TGalleryPage | null>(query, {}, { next: { tags: ['galleryPage'] } });
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
      features[]{ _key, heading, subHeading, location, tier, features, link{ href, label, isExternal }, icon, mostPopular }
    }
  }`;
  return client.fetch<TTrainingPage | null>(query, {}, { next: { tags: ['trainingPage'] } });
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
  return client.fetch<TGlobalSettings | null>(query, {}, { next: { tags: ['global'] } });
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
  return client.fetch<TMainMenu | null>(query, {}, { next: { tags: ['menu'] } });
}

async function getMetaData(): Promise<TMetaData | null> {
  const query = groq`*[_type == "globalSettings"][0]{
    title,
    description,
    "ogImageUrl": ogImage.asset->url
  }`;
  return client.fetch<TMetaData | null>(query, {}, { next: { tags: ['global'] } });
}

async function getTrainingProgramBySlug(slug: string): Promise<TTrainingProgram | null> {
  const query = groq`*[_type == "trainingProgram" && slug.current == $slug][0]{
    _id,
    title,
    description,
    "slug": slug.current,
    blocks[]{
      _type,
      _key,
      heading,
      subHeading,
      description,
      onHomepage,
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
  return client.fetch<TTrainingProgram | null>(query, { slug }, { next: { tags: ['trainingProgram'] } });
}

async function getAllTrainingPrograms(): Promise<TTrainingProgram[]> {
  const query = groq`*[_type == "trainingProgram"]{
    _id,
    title,
    description,
    "slug": slug.current,
    blocks[]{
      _type,
      _key,
      heading,
      subHeading,
      description,
      onHomepage,
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
  return client.fetch<TTrainingProgram[]>(query, {}, { next: { tags: ['trainingProgram'] } });
}

async function getAllTrainingProgramSlugs(): Promise<Array<{ slug: string }>> {
  const query = groq`*[_type == "trainingProgram"]{
    "slug": slug.current
  }`;
  return client.fetch<Array<{ slug: string }>>(query, {}, { next: { tags: ['trainingProgram'] } });
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
  getAllTrainingPrograms,
  getAllTrainingProgramSlugs,
};
