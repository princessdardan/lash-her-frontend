/**
 * Strapi → Sanity migration script
 *
 * Fetches all content from the Strapi Cloud REST API, transforms it to Sanity
 * document shapes (including image uploads and rich text conversion), and
 * writes all documents as published to the production Sanity dataset.
 *
 * Usage:
 *   cd frontend && npm run migrate
 *
 * Required env vars (in .env.local):
 *   NEXT_PUBLIC_SANITY_PROJECT_ID
 *   NEXT_PUBLIC_SANITY_DATASET
 *   SANITY_WRITE_TOKEN
 *   STRAPI_BASE_URL
 *   STRAPI_API_TOKEN
 */

import { createClient, type SanityClient } from "@sanity/client";
import { nanoid } from "nanoid";
import { Readable } from "node:stream";
import * as dotenv from "dotenv";
import qs from "qs";

dotenv.config({ path: ".env.local" });

// ---------------------------------------------------------------------------
// Environment validation
// ---------------------------------------------------------------------------

const REQUIRED_ENV = [
  "NEXT_PUBLIC_SANITY_PROJECT_ID",
  "NEXT_PUBLIC_SANITY_DATASET",
  "SANITY_WRITE_TOKEN",
  "STRAPI_BASE_URL",
  "STRAPI_API_TOKEN",
] as const;

const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`[migrate] ERROR: Missing required env vars: ${missing.join(", ")}`);
  process.exit(1);
}

const SANITY_PROJECT_ID = process.env.NEXT_PUBLIC_SANITY_PROJECT_ID!;
const SANITY_DATASET = process.env.NEXT_PUBLIC_SANITY_DATASET!;
const SANITY_WRITE_TOKEN = process.env.SANITY_WRITE_TOKEN!;
const STRAPI_BASE_URL = process.env.STRAPI_BASE_URL!;
const STRAPI_API_TOKEN = process.env.STRAPI_API_TOKEN!;

// ---------------------------------------------------------------------------
// Sanity client
// ---------------------------------------------------------------------------

const client: SanityClient = createClient({
  projectId: SANITY_PROJECT_ID,
  dataset: SANITY_DATASET,
  apiVersion: "2026-03-24",
  token: SANITY_WRITE_TOKEN,
  useCdn: false,
});

// ---------------------------------------------------------------------------
// Strapi populate queries (Strapi v5 requires explicit populate — no deep plugin)
// ---------------------------------------------------------------------------

const POPULATE_HOME_PAGE = qs.stringify({
  populate: {
    blocks: {
      on: {
        "layout.hero-section": {
          populate: { image: { fields: ["url", "alternativeText"] }, link: { populate: true } },
        },
        "layout.features-section": {
          populate: { features: { populate: true } },
        },
      },
    },
  },
});

const POPULATE_CONTACT_PAGE = qs.stringify({
  populate: {
    blocks: {
      on: {
        "layout.schedule": { populate: { hours: { populate: true } } },
        "layout.contact-info": { populate: { contact: { populate: true } } },
        "layout.general-inquiry-labels": { populate: true },
      },
    },
  },
});

const POPULATE_GALLERY_PAGE = qs.stringify({
  populate: {
    blocks: {
      on: {
        "layout.hero-section": {
          populate: { image: { fields: ["url", "alternativeText"] }, link: { populate: true } },
        },
        "layout.photo-gallery": { populate: { image: { populate: true } } },
      },
    },
  },
});

const POPULATE_TRAINING_PAGE = qs.stringify({
  populate: {
    blocks: {
      on: {
        "layout.cta-features-section": {
          populate: { features: { populate: { link: { populate: true } } } },
        },
        "layout.image-with-text": {
          populate: { image: { fields: ["url", "alternativeText"] } },
        },
      },
    },
  },
});

const POPULATE_TRAINING_PROGRAMS_PAGE = "populate=*";

const POPULATE_GLOBAL = qs.stringify({
  populate: [
    "header.logoText",
    "header.ctaButton",
    "footer.logoText",
    "footer.socialLink",
  ],
});

const POPULATE_MAIN_MENU =
  "populate[MainMenuItems][on][menu.dropdown][populate][sections][populate][links]=true&populate[MainMenuItems][on][menu.menu-link][populate]=true";

const POPULATE_TRAINING_PROGRAMS = qs.stringify({
  populate: {
    blocks: {
      on: {
        "layout.hero-section": {
          populate: { image: { fields: ["url", "alternativeText"] }, link: { populate: true } },
        },
        "layout.info-section": { populate: true },
        "layout.contact-form": { populate: true },
      },
    },
  },
});

// ---------------------------------------------------------------------------
// Strapi types
// ---------------------------------------------------------------------------

interface StrapiTextChild {
  type: "text";
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  code?: boolean;
}

interface StrapiLinkChild {
  type: "link";
  url: string;
  children?: StrapiTextChild[];
}

type StrapiInlineChild = StrapiTextChild | StrapiLinkChild;

interface StrapiBlockNode {
  type:
    | "paragraph"
    | "heading"
    | "list"
    | "list-item"
    | "link"
    | "quote"
    | "code"
    | "image";
  level?: number;
  format?: "ordered" | "unordered";
  url?: string;
  text?: string;
  children?: Array<StrapiInlineChild | StrapiBlockNode>;
  image?: { url: string; alternativeText?: string };
}

// ---------------------------------------------------------------------------
// Strapi fetch utilities
// ---------------------------------------------------------------------------

async function fetchStrapi<T>(path: string): Promise<T> {
  const url = `${STRAPI_BASE_URL}${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${STRAPI_API_TOKEN}` },
  });
  if (!res.ok) {
    throw new Error(`[migrate] ERROR fetching ${path}: ${res.status}`);
  }
  const json = await res.json();
  // Strapi 5 flat format: data at top level or wrapped in .data
  return (json.data ?? json) as T;
}

async function fetchStrapiPaginated<T>(path: string, populateQs?: string): Promise<T[]> {
  const allItems: T[] = [];
  let page = 1;
  const pageSize = 100;

  while (true) {
    const separator = path.includes("?") ? "&" : "?";
    const populatePart = populateQs ? `&${populateQs}` : "";
    const url = `${path}${separator}pagination[pageSize]=${pageSize}&pagination[page]=${page}${populatePart}`;
    const res = await fetch(`${STRAPI_BASE_URL}${url}`, {
      headers: { Authorization: `Bearer ${STRAPI_API_TOKEN}` },
    });
    if (!res.ok) {
      throw new Error(`[migrate] ERROR fetching ${path} page ${page}: ${res.status}`);
    }
    const json = await res.json();
    const items = (json.data ?? []) as T[];
    allItems.push(...items);

    const pagination = json.meta?.pagination;
    if (!pagination || page >= pagination.pageCount) {
      break;
    }
    page++;
  }

  return allItems;
}

// ---------------------------------------------------------------------------
// Image upload system
// ---------------------------------------------------------------------------

const imageCache = new Map<string, string>();

async function uploadImage(
  url: string,
  strapiId: string | number
): Promise<string> {
  if (imageCache.has(url)) {
    return imageCache.get(url)!;
  }

  const filename = url.split("/").pop() ?? "image";
  console.log(`[migrate] Uploading image: ${filename}`);

  try {
    const res = await fetch(url);
    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status}`);
    }

    const asset = await client.assets.upload(
      "image",
      Readable.fromWeb(res.body as ReadableStream<Uint8Array>),
      {
        filename,
        source: {
          name: "strapi",
          id: String(strapiId),
          url,
        },
      }
    );

    imageCache.set(url, asset._id);
    return asset._id;
  } catch (error) {
    console.error(
      `[migrate] ERROR uploading image ${filename}: ${(error as Error).message} -- skipping`
    );
    return "";
  }
}

async function uploadVideo(
  url: string,
  strapiId: string | number
): Promise<string> {
  const filename = url.split("/").pop() ?? "video";
  console.log(`[migrate] Uploading video: ${filename}`);

  try {
    const res = await fetch(url);
    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status}`);
    }

    const asset = await client.assets.upload(
      "file",
      Readable.fromWeb(res.body as ReadableStream<Uint8Array>),
      {
        filename,
        source: {
          name: "strapi",
          id: String(strapiId),
          url,
        },
      }
    );

    return asset._id;
  } catch (error) {
    console.error(
      `[migrate] ERROR uploading video ${filename}: ${(error as Error).message} -- skipping`
    );
    return "";
  }
}

function imageRef(assetId: string): object {
  return {
    _type: "image",
    asset: { _type: "reference", _ref: assetId },
  };
}

function fileRef(assetId: string): object {
  return {
    _type: "file",
    asset: { _type: "reference", _ref: assetId },
  };
}

// ---------------------------------------------------------------------------
// Recursive image URL collector
// ---------------------------------------------------------------------------

function collectImageUrls(obj: unknown, urls: Set<string>): void {
  if (!obj || typeof obj !== "object") return;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      collectImageUrls(item, urls);
    }
    return;
  }

  const record = obj as Record<string, unknown>;

  // Strapi media objects have a `url` field — collect if it looks like an upload
  if (typeof record.url === "string" && record.url.includes("/uploads/")) {
    urls.add(record.url);
  }

  for (const value of Object.values(record)) {
    collectImageUrls(value, urls);
  }
}

async function collectAndUploadAllImages(): Promise<void> {
  console.log("[migrate] Phase 1: Collecting all images...");

  const urls = new Set<string>();

  const endpoints = [
    `/api/home-page?${POPULATE_HOME_PAGE}`,
    `/api/contact?${POPULATE_CONTACT_PAGE}`,
    `/api/gallery?${POPULATE_GALLERY_PAGE}`,
    `/api/training?${POPULATE_TRAINING_PAGE}`,
    `/api/training-programs-page?${POPULATE_TRAINING_PROGRAMS_PAGE}`,
    `/api/global?${POPULATE_GLOBAL}`,
    `/api/main-menu?${POPULATE_MAIN_MENU}`,
  ];

  // Fetch paginated collections too
  const paginatedEndpoints = [
    `/api/training-programs?${POPULATE_TRAINING_PROGRAMS}&pagination[pageSize]=100&pagination[page]=1`,
    "/api/contact-forms?pagination[pageSize]=100&pagination[page]=1",
    "/api/general-inquiries?pagination[pageSize]=100&pagination[page]=1",
  ];

  for (const endpoint of endpoints) {
    try {
      const data = await fetchStrapi<unknown>(endpoint);
      collectImageUrls(data, urls);
    } catch (err) {
      console.warn(`[migrate] WARN: Could not prefetch ${endpoint}: ${(err as Error).message}`);
    }
  }

  for (const endpoint of paginatedEndpoints) {
    try {
      const res = await fetch(`${STRAPI_BASE_URL}${endpoint}`, {
        headers: { Authorization: `Bearer ${STRAPI_API_TOKEN}` },
      });
      if (res.ok) {
        const json = await res.json();
        collectImageUrls(json, urls);
      }
    } catch (err) {
      console.warn(`[migrate] WARN: Could not prefetch ${endpoint}: ${(err as Error).message}`);
    }
  }

  console.log(`[migrate] Found ${urls.size} unique images to upload`);

  for (const url of urls) {
    // Use the URL itself as the strapiId for deduplication
    await uploadImage(url, url);
  }

  console.log(`[migrate] Phase 1 complete. ${imageCache.size} images uploaded.`);
}

// ---------------------------------------------------------------------------
// Rich text: Strapi Blocks → Sanity Portable Text
// ---------------------------------------------------------------------------

function flattenSpans(
  children: Array<StrapiInlineChild | StrapiBlockNode>,
  markDefs: object[]
): object[] {
  const spans: object[] = [];

  for (const child of children) {
    if (child.type === "text") {
      const textChild = child as StrapiTextChild;
      const marks: string[] = [];
      if (textChild.bold) marks.push("strong");
      if (textChild.italic) marks.push("em");
      spans.push({
        _type: "span",
        _key: nanoid(12),
        text: textChild.text,
        marks,
      });
    } else if (child.type === "link") {
      const linkChild = child as StrapiLinkChild;
      const linkKey = nanoid(12);
      markDefs.push({
        _type: "link",
        _key: linkKey,
        href: linkChild.url,
      });
      // Flatten the text children of the link
      const linkChildren = linkChild.children ?? [];
      for (const textChild of linkChildren) {
        if (textChild.type === "text") {
          const marks: string[] = [linkKey];
          if ((textChild as StrapiTextChild).bold) marks.push("strong");
          if ((textChild as StrapiTextChild).italic) marks.push("em");
          spans.push({
            _type: "span",
            _key: nanoid(12),
            text: (textChild as StrapiTextChild).text,
            marks,
          });
        }
      }
    }
  }

  return spans;
}

function convertBlocksToPortableText(nodes: StrapiBlockNode[] | null | undefined): object[] {
  if (!nodes || nodes.length === 0) return [];

  const ptBlocks: object[] = [];

  for (const node of nodes) {
    const markDefs: object[] = [];

    if (node.type === "paragraph" || node.type === "quote") {
      const spans = flattenSpans(
        (node.children ?? []) as Array<StrapiInlineChild | StrapiBlockNode>,
        markDefs
      );
      ptBlocks.push({
        _type: "block",
        _key: nanoid(12),
        style: "normal",
        children: spans,
        markDefs,
      });
    } else if (node.type === "heading") {
      const style = node.level === 2 ? "h2" : "h3";
      const spans = flattenSpans(
        (node.children ?? []) as Array<StrapiInlineChild | StrapiBlockNode>,
        markDefs
      );
      ptBlocks.push({
        _type: "block",
        _key: nanoid(12),
        style,
        children: spans,
        markDefs,
      });
    } else if (node.type === "list") {
      const listItem = node.format === "ordered" ? "number" : "bullet";
      for (const child of node.children ?? []) {
        const itemMarkDefs: object[] = [];
        const childNode = child as StrapiBlockNode;
        const spans = flattenSpans(
          (childNode.children ?? []) as Array<StrapiInlineChild | StrapiBlockNode>,
          itemMarkDefs
        );
        ptBlocks.push({
          _type: "block",
          _key: nanoid(12),
          style: "normal",
          listItem,
          level: 1,
          children: spans,
          markDefs: itemMarkDefs,
        });
      }
    } else if (node.type === "code") {
      // Render code blocks as normal paragraphs (no code style in schema)
      const text =
        typeof (node as Record<string, unknown>).code === "string"
          ? (node as Record<string, unknown>).code
          : (node.children
              ?.filter((c) => c.type === "text")
              .map((c) => (c as StrapiTextChild).text)
              .join("") ?? "");
      ptBlocks.push({
        _type: "block",
        _key: nanoid(12),
        style: "normal",
        children: [{ _type: "span", _key: nanoid(12), text, marks: [] }],
        markDefs: [],
      });
    }
    // image nodes inside rich text are skipped (not supported in schema)
  }

  return ptBlocks;
}

// ---------------------------------------------------------------------------
// Block transformer: Strapi layout component → Sanity block object
// ---------------------------------------------------------------------------

function kebabToCamel(str: string): string {
  return str.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
}

// Strapi component → Sanity _type overrides for name mismatches
const COMPONENT_TYPE_OVERRIDES: Record<string, string> = {
  "layout.contact-form": "contactFormLabels",
  "layout.general-inquiry": "generalInquiryLabels",
};

function strapiComponentToSanityType(component: string): string {
  if (COMPONENT_TYPE_OVERRIDES[component]) {
    return COMPONENT_TYPE_OVERRIDES[component];
  }
  // e.g. "layout.hero-section" → "heroSection"
  const withoutPrefix = component.replace(/^[^.]+\./, "");
  return kebabToCamel(withoutPrefix);
}

async function transformBlock(block: Record<string, unknown>): Promise<object | null> {
  const component = block.__component as string | undefined;
  if (!component) {
    console.warn("[migrate] WARN: Block missing __component:", JSON.stringify(block).slice(0, 100));
    return null;
  }

  const _type = strapiComponentToSanityType(component);
  const _key = nanoid(12);

  try {
    switch (_type) {
      case "heroSection": {
        const img = block.image as Record<string, unknown> | null;
        let imageSanity: object | undefined;
        if (img?.url) {
          const assetId = await uploadImage(img.url as string, img.id as string | number ?? "");
          if (assetId) {
            imageSanity = {
              ...(imageRef(assetId) as Record<string, unknown>),
              alt: img.alternativeText ?? "",
            };
          }
        }
        const links = (block.link as Record<string, unknown>[] | null) ?? [];
        return {
          _type,
          _key,
          heading: block.heading ?? "",
          subHeading: block.subHeading ?? block.sub_heading ?? "",
          description: block.description ?? "",
          onHomepage: block.onHomepage ?? block.on_homepage ?? false,
          image: imageSanity,
          link: links.map((l) => ({
            _type: "link",
            _key: nanoid(12),
            href: l.href ?? l.url ?? "",
            label: l.label ?? "",
            isExternal: l.isExternal ?? l.is_external ?? false,
          })),
        };
      }

      case "featuresSection": {
        const featureItems = (block.features as Record<string, unknown>[] | null) ?? [];
        return {
          _type,
          _key,
          title: block.title ?? "",
          heading: block.heading ?? "",
          subHeading: block.subHeading ?? block.sub_heading ?? "",
          description: block.description ?? "",
          features: featureItems.map((f) => ({
            _type: "feature",
            _key: nanoid(12),
            heading: f.heading ?? "",
            subHeading: f.subHeading ?? f.sub_heading ?? f.description ?? "",
            icon: f.icon ?? "",
          })),
        };
      }

      case "ctaFeaturesSection": {
        const ctaFeatureItems = (block.features as Record<string, unknown>[] | null) ?? [];
        const transformedFeatures = await Promise.all(
          ctaFeatureItems.map(async (f) => ({
            _type: "ctaFeature",
            _key: nanoid(12),
            heading: f.heading ?? "",
            subHeading: f.subHeading ?? f.sub_heading ?? "",
            location: f.location ?? "",
            tier: f.tier ?? "",
            mostPopular: f.mostPopular ?? f.most_popular ?? false,
            icon: f.icon ?? "",
            link: f.link
              ? {
                  _type: "link",
                  href: (f.link as Record<string, unknown>).href ?? (f.link as Record<string, unknown>).url ?? "",
                  label: (f.link as Record<string, unknown>).label ?? "",
                  isExternal: (f.link as Record<string, unknown>).isExternal ?? false,
                }
              : undefined,
            features: convertBlocksToPortableText(
              f.features as StrapiBlockNode[] | null
            ),
          }))
        );
        return {
          _type,
          _key,
          heading: block.heading ?? "",
          subHeading: block.subHeading ?? block.sub_heading ?? "",
          description: block.description ?? "",
          features: transformedFeatures,
        };
      }

      case "imageWithText": {
        const img2 = block.image as Record<string, unknown> | null;
        let image2Sanity: object | undefined;
        if (img2?.url) {
          const assetId = await uploadImage(img2.url as string, img2.id as string | number ?? "");
          if (assetId) {
            image2Sanity = {
              ...(imageRef(assetId) as Record<string, unknown>),
              alt: img2.alternativeText ?? "",
            };
          }
        }
        return {
          _type,
          _key,
          heading: block.heading ?? "",
          subHeading: block.subHeading ?? block.sub_heading ?? "",
          description: block.description ?? "",
          orientation: block.orientation ?? "HORIZONTAL_IMAGE_LEFT",
          image: image2Sanity,
          perks: convertBlocksToPortableText(
            block.perks as StrapiBlockNode[] | null
          ),
        };
      }

      case "infoSection": {
        return {
          _type,
          _key,
          heading: block.heading ?? "",
          subHeading: block.subHeading ?? block.sub_heading ?? "",
          info: convertBlocksToPortableText(
            block.info as StrapiBlockNode[] | null
          ),
        };
      }

      case "photoGallery": {
        const galleryImages = (block.image as Record<string, unknown>[] | null) ??
          (block.images as Record<string, unknown>[] | null) ?? [];
        const uploadedImages = await Promise.all(
          galleryImages.map(async (img) => {
            if (!img.url) return null;
            const assetId = await uploadImage(img.url as string, img.id as string | number ?? "");
            if (!assetId) return null;
            return {
              ...(imageRef(assetId) as Record<string, unknown>),
              _key: nanoid(12),
              alt: img.alternativeText ?? "",
            };
          })
        );
        return {
          _type,
          _key,
          heading: block.heading ?? "",
          subHeading: block.subHeading ?? block.sub_heading ?? "",
          description: block.description ?? "",
          images: uploadedImages.filter(Boolean),
        };
      }

      case "schedule": {
        const hoursItems = (block.hours as Record<string, unknown>[] | null) ?? [];
        return {
          _type,
          _key,
          heading: block.heading ?? "",
          subHeading: block.subHeading ?? block.sub_heading ?? "",
          hours: hoursItems.map((h) => ({
            _type: "hours",
            _key: nanoid(12),
            days: h.days ?? "",
            times: h.times ?? "",
          })),
        };
      }

      case "contactInfo": {
        const contactItems = (block.contact as Record<string, unknown>[] | null) ?? [];
        return {
          _type,
          _key,
          heading: block.heading ?? "",
          subHeading: block.subHeading ?? block.sub_heading ?? "",
          contact: contactItems.map((c) => ({
            _type: "contact",
            _key: nanoid(12),
            phone: c.phone ?? "",
            email: c.email ?? "",
            location: c.location ?? "",
          })),
        };
      }

      case "contactFormLabels": {
        return {
          _type,
          _key,
          heading: block.heading ?? "",
          subHeading: block.subHeading ?? block.sub_heading ?? "",
          name: block.name ?? "",
          email: block.email ?? "",
          phone: block.phone ?? "",
          instagram: block.instagram ?? "",
          location: block.location ?? "",
          interest: block.interest ?? "",
          experience: block.experience ?? "",
          clients: block.clients ?? "",
          info: block.info ?? "",
        };
      }

      case "generalInquiryLabels": {
        return {
          _type,
          _key,
          heading: block.heading ?? "",
          subHeading: block.subHeading ?? block.sub_heading ?? "",
          name: block.name ?? "",
          email: block.email ?? "",
          phone: block.phone ?? "",
          instagram: block.instagram ?? "",
          message: block.message ?? "",
        };
      }

      case "ctaSectionImage": {
        const img3 = block.image as Record<string, unknown> | null;
        let image3Sanity: object | undefined;
        if (img3?.url) {
          const assetId = await uploadImage(img3.url as string, img3.id as string | number ?? "");
          if (assetId) {
            image3Sanity = {
              ...(imageRef(assetId) as Record<string, unknown>),
              alt: img3.alternativeText ?? "",
            };
          }
        }
        const ctaLinks3 = (block.link as Record<string, unknown>[] | null) ?? [];
        return {
          _type,
          _key,
          heading: block.heading ?? "",
          description: block.description ?? "",
          image: image3Sanity,
          link: ctaLinks3.map((l) => ({
            _type: "link",
            _key: nanoid(12),
            href: l.href ?? l.url ?? "",
            label: l.label ?? "",
            isExternal: l.isExternal ?? false,
          })),
        };
      }

      case "ctaSectionVideo": {
        const videoData = block.video as Record<string, unknown> | null;
        let videoSanity: object | undefined;
        if (videoData?.url) {
          const assetId = await uploadVideo(videoData.url as string, videoData.id as string | number ?? "");
          if (assetId) {
            videoSanity = fileRef(assetId);
          }
        }
        const ctaLinks4 = (block.link as Record<string, unknown>[] | null) ?? [];
        return {
          _type,
          _key,
          title: block.title ?? "",
          description: block.description ?? "",
          video: videoSanity,
          link: ctaLinks4.map((l) => ({
            _type: "link",
            _key: nanoid(12),
            href: l.href ?? l.url ?? "",
            label: l.label ?? "",
            isExternal: l.isExternal ?? false,
          })),
        };
      }

      default:
        console.warn(`[migrate] WARN: Unrecognized block type: ${_type} (from ${component})`);
        return null;
    }
  } catch (err) {
    console.error(`[migrate] ERROR transforming block ${_type}: ${(err as Error).message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Summary tracking
// ---------------------------------------------------------------------------

const migrationCounts: Record<string, { strapi: number; sanity: number }> = {};

// ---------------------------------------------------------------------------
// Singleton migrators
// ---------------------------------------------------------------------------

async function migrateHomePage(): Promise<void> {
  console.log("[migrate] Migrating homePage...");
  try {
    const data = await fetchStrapi<Record<string, unknown>>(
      `/api/home-page?${POPULATE_HOME_PAGE}`
    );
    const blocks = (data.blocks as Record<string, unknown>[] | null) ?? [];
    const transformedBlocks = (
      await Promise.all(blocks.map((b) => transformBlock(b)))
    ).filter(Boolean);

    await client.createOrReplace({
      _id: "homePage",
      _type: "homePage",
      title: data.title ?? "",
      description: data.description ?? "",
      blocks: transformedBlocks,
    });

    migrationCounts["homePage"] = { strapi: 1, sanity: 1 };
    console.log("[migrate] homePage: OK");
  } catch (err) {
    console.error(`[migrate] ERROR writing homePage: ${(err as Error).message}`);
    migrationCounts["homePage"] = { strapi: 1, sanity: 0 };
  }
}

async function migrateContactPage(): Promise<void> {
  console.log("[migrate] Migrating contactPage...");
  try {
    const data = await fetchStrapi<Record<string, unknown>>(
      `/api/contact?${POPULATE_CONTACT_PAGE}`
    );
    const blocks = (data.blocks as Record<string, unknown>[] | null) ?? [];
    const transformedBlocks = (
      await Promise.all(blocks.map((b) => transformBlock(b)))
    ).filter(Boolean);

    await client.createOrReplace({
      _id: "contactPage",
      _type: "contactPage",
      title: data.title ?? "",
      subTitle: data.subTitle ?? data.sub_title ?? "",
      description: data.description ?? "",
      blocks: transformedBlocks,
    });

    migrationCounts["contactPage"] = { strapi: 1, sanity: 1 };
    console.log("[migrate] contactPage: OK");
  } catch (err) {
    console.error(`[migrate] ERROR writing contactPage: ${(err as Error).message}`);
    migrationCounts["contactPage"] = { strapi: 1, sanity: 0 };
  }
}

async function migrateGalleryPage(): Promise<void> {
  console.log("[migrate] Migrating galleryPage...");
  try {
    const data = await fetchStrapi<Record<string, unknown>>(
      `/api/gallery?${POPULATE_GALLERY_PAGE}`
    );
    const blocks = (data.blocks as Record<string, unknown>[] | null) ?? [];
    const transformedBlocks = (
      await Promise.all(blocks.map((b) => transformBlock(b)))
    ).filter(Boolean);

    await client.createOrReplace({
      _id: "galleryPage",
      _type: "galleryPage",
      title: data.title ?? "",
      description: data.description ?? "",
      blocks: transformedBlocks,
    });

    migrationCounts["galleryPage"] = { strapi: 1, sanity: 1 };
    console.log("[migrate] galleryPage: OK");
  } catch (err) {
    console.error(`[migrate] ERROR writing galleryPage: ${(err as Error).message}`);
    migrationCounts["galleryPage"] = { strapi: 1, sanity: 0 };
  }
}

async function migrateTrainingPage(): Promise<void> {
  console.log("[migrate] Migrating trainingPage...");
  try {
    const data = await fetchStrapi<Record<string, unknown>>(
      `/api/training?${POPULATE_TRAINING_PAGE}`
    );
    const blocks = (data.blocks as Record<string, unknown>[] | null) ?? [];
    const transformedBlocks = (
      await Promise.all(blocks.map((b) => transformBlock(b)))
    ).filter(Boolean);

    await client.createOrReplace({
      _id: "trainingPage",
      _type: "trainingPage",
      title: data.title ?? "",
      description: data.description ?? "",
      blocks: transformedBlocks,
    });

    migrationCounts["trainingPage"] = { strapi: 1, sanity: 1 };
    console.log("[migrate] trainingPage: OK");
  } catch (err) {
    console.error(`[migrate] ERROR writing trainingPage: ${(err as Error).message}`);
    migrationCounts["trainingPage"] = { strapi: 1, sanity: 0 };
  }
}

async function migrateTrainingProgramsPage(): Promise<void> {
  console.log("[migrate] Migrating trainingProgramsPage...");
  try {
    const data = await fetchStrapi<Record<string, unknown>>(
      `/api/training-programs-page?${POPULATE_TRAINING_PROGRAMS_PAGE}`
    );

    // Fetch all training programs to get their documentIds for references
    const programs = await fetchStrapiPaginated<Record<string, unknown>>(
      "/api/training-programs",
      "fields[0]=documentId&fields[1]=title&fields[2]=slug"
    );

    const trainingProgramRefs = programs.map((p) => ({
      _type: "reference" as const,
      _ref: `trainingProgram-${p.documentId}`,
      _key: nanoid(12),
    }));

    await client.createOrReplace({
      _id: "trainingProgramsPage",
      _type: "trainingProgramsPage",
      title: data.title ?? "",
      description: data.description ?? "",
      trainingPrograms: trainingProgramRefs,
    });

    migrationCounts["trainingProgramsPage"] = { strapi: 1, sanity: 1 };
    console.log("[migrate] trainingProgramsPage: OK");
  } catch (err) {
    console.error(`[migrate] ERROR writing trainingProgramsPage: ${(err as Error).message}`);
    migrationCounts["trainingProgramsPage"] = { strapi: 1, sanity: 0 };
  }
}

async function migrateGlobalSettings(): Promise<void> {
  console.log("[migrate] Migrating globalSettings...");
  try {
    const data = await fetchStrapi<Record<string, unknown>>(
      `/api/global?${POPULATE_GLOBAL}`
    );

    const headerData = (data.header as Record<string, unknown> | null) ?? {};
    const footerData = (data.footer as Record<string, unknown> | null) ?? {};

    // Transform header
    const logoTextHeader = headerData.logoText as Record<string, unknown> | null;
    const ctaButtonLinks = (headerData.ctaButton as Record<string, unknown>[] | null) ?? [];

    const header = {
      _type: "header",
      logoText: logoTextHeader
        ? {
            _type: "link",
            href: logoTextHeader.href ?? logoTextHeader.url ?? "",
            label: logoTextHeader.label ?? "",
            isExternal: logoTextHeader.isExternal ?? false,
          }
        : undefined,
      ctaButton: ctaButtonLinks.map((l) => ({
        _type: "link",
        _key: nanoid(12),
        href: l.href ?? l.url ?? "",
        label: l.label ?? "",
        isExternal: l.isExternal ?? false,
      })),
    };

    // Transform footer
    const logoTextFooter = footerData.logoText as Record<string, unknown> | null;
    const socialLinks = (footerData.socialLink as Record<string, unknown>[] | null) ?? [];

    const footer = {
      _type: "footer",
      logoText: logoTextFooter
        ? {
            _type: "link",
            href: logoTextFooter.href ?? logoTextFooter.url ?? "",
            label: logoTextFooter.label ?? "",
            isExternal: logoTextFooter.isExternal ?? false,
          }
        : undefined,
      text: footerData.text ?? "",
      socialLink: socialLinks.map((l) => ({
        _type: "link",
        _key: nanoid(12),
        href: l.href ?? l.url ?? "",
        label: l.label ?? "",
        isExternal: l.isExternal ?? false,
      })),
    };

    await client.createOrReplace({
      _id: "globalSettings",
      _type: "globalSettings",
      title: data.title ?? "",
      description: data.description ?? "",
      header,
      footer,
    });

    migrationCounts["globalSettings"] = { strapi: 1, sanity: 1 };
    console.log("[migrate] globalSettings: OK");
  } catch (err) {
    console.error(`[migrate] ERROR writing globalSettings: ${(err as Error).message}`);
    migrationCounts["globalSettings"] = { strapi: 1, sanity: 0 };
  }
}

async function migrateMainMenu(): Promise<void> {
  console.log("[migrate] Migrating mainMenu...");
  try {
    const data = await fetchStrapi<Record<string, unknown>>(
      "/api/main-menu?populate[MainMenuItems][on][menu.dropdown][populate][sections][populate][links]=true&populate[MainMenuItems][on][menu.menu-link][populate]=true"
    );

    const rawItems =
      (data.MainMenuItems as Record<string, unknown>[] | null) ??
      (data.items as Record<string, unknown>[] | null) ?? [];

    const items = rawItems.map((item) => {
      const itemComponent = item.__component as string | undefined;

      if (itemComponent === "menu.menu-link" || itemComponent === "menu.direct-link") {
        return {
          _type: "menuDirectLink",
          _key: nanoid(12),
          title: item.title ?? item.label ?? "",
          url: item.url ?? item.href ?? "",
        };
      } else if (itemComponent === "menu.dropdown") {
        const sectionItems =
          (item.sections as Record<string, unknown>[] | null) ?? [];
        return {
          _type: "menuDropdown",
          _key: nanoid(12),
          title: item.title ?? item.label ?? "",
          sections: sectionItems.map((section) => {
            const linkItems =
              (section.links as Record<string, unknown>[] | null) ?? [];
            return {
              _type: "menuDropdownSection",
              _key: nanoid(12),
              heading: section.heading ?? section.title ?? "",
              links: linkItems.map((l) => ({
                _type: "menuLink",
                _key: nanoid(12),
                name: l.name ?? l.label ?? "",
                url: l.url ?? l.href ?? "",
                description: l.description ?? "",
              })),
            };
          }),
        };
      }

      // Fallback: treat as direct link
      console.warn(`[migrate] WARN: Unknown menu item component: ${itemComponent}`);
      return {
        _type: "menuDirectLink",
        _key: nanoid(12),
        title: item.title ?? item.label ?? "",
        url: item.url ?? item.href ?? "",
      };
    });

    await client.createOrReplace({
      _id: "mainMenu",
      _type: "mainMenu",
      items,
    });

    migrationCounts["mainMenu"] = { strapi: 1, sanity: 1 };
    console.log("[migrate] mainMenu: OK");
  } catch (err) {
    console.error(`[migrate] ERROR writing mainMenu: ${(err as Error).message}`);
    migrationCounts["mainMenu"] = { strapi: 1, sanity: 0 };
  }
}

// ---------------------------------------------------------------------------
// Collection migrators
// ---------------------------------------------------------------------------

async function migrateTrainingPrograms(): Promise<void> {
  console.log("[migrate] Migrating trainingPrograms...");
  try {
    const programs = await fetchStrapiPaginated<Record<string, unknown>>(
      "/api/training-programs",
      POPULATE_TRAINING_PROGRAMS
    );

    if (programs.length === 0) {
      console.log("[migrate] trainingProgram: 0 records (none in Strapi)");
      migrationCounts["trainingProgram"] = { strapi: 0, sanity: 0 };
      return;
    }

    const transaction = client.transaction();

    for (const program of programs) {
      const blocks =
        (program.blocks as Record<string, unknown>[] | null) ?? [];
      const transformedBlocks = (
        await Promise.all(blocks.map((b) => transformBlock(b)))
      ).filter(Boolean);

      const doc = {
        _id: `trainingProgram-${program.documentId}`,
        _type: "trainingProgram",
        title: program.title ?? "",
        description: program.description ?? "",
        slug: {
          _type: "slug",
          current: program.slug ?? "",
        },
        blocks: transformedBlocks,
      };

      transaction.createOrReplace(doc);
    }

    await transaction.commit({ visibility: "deferred" });
    migrationCounts["trainingProgram"] = {
      strapi: programs.length,
      sanity: programs.length,
    };
    console.log(`[migrate] trainingProgram: ${programs.length} records migrated`);
  } catch (err) {
    console.error(`[migrate] ERROR writing trainingProgram: ${(err as Error).message}`);
    migrationCounts["trainingProgram"] = { strapi: -1, sanity: 0 };
  }
}

async function migrateContactForms(): Promise<void> {
  console.log("[migrate] Migrating contactForms...");
  try {
    const forms = await fetchStrapiPaginated<Record<string, unknown>>(
      "/api/contact-forms"
    );

    if (forms.length === 0) {
      console.log("[migrate] contactForm: 0 records");
      migrationCounts["contactForm"] = { strapi: 0, sanity: 0 };
      return;
    }

    const transaction = client.transaction();

    for (const form of forms) {
      const doc = {
        _id: `contactForm-${form.documentId}`,
        _type: "contactForm",
        name: form.name ?? "",
        email: form.email ?? "",
        phone: form.phone ?? "",
        location: form.location ?? "",
        instagram: form.instagram ?? "",
        experience: form.experience ?? "",
        interest: form.interest ?? "",
        clients: typeof form.clients === "number" ? form.clients : undefined,
        info: form.info ?? "",
      };

      transaction.createOrReplace(doc);
    }

    await transaction.commit({ visibility: "deferred" });
    migrationCounts["contactForm"] = {
      strapi: forms.length,
      sanity: forms.length,
    };
    console.log(`[migrate] contactForm: ${forms.length} records migrated`);
  } catch (err) {
    console.error(`[migrate] ERROR writing contactForm: ${(err as Error).message}`);
    migrationCounts["contactForm"] = { strapi: -1, sanity: 0 };
  }
}

async function migrateGeneralInquiries(): Promise<void> {
  console.log("[migrate] Migrating generalInquiries...");
  try {
    const inquiries = await fetchStrapiPaginated<Record<string, unknown>>(
      "/api/general-inquiries"
    );

    if (inquiries.length === 0) {
      console.log("[migrate] generalInquiry: 0 records");
      migrationCounts["generalInquiry"] = { strapi: 0, sanity: 0 };
      return;
    }

    const transaction = client.transaction();

    for (const inquiry of inquiries) {
      const doc = {
        _id: `generalInquiry-${inquiry.documentId}`,
        _type: "generalInquiry",
        name: inquiry.name ?? "",
        email: inquiry.email ?? "",
        phone: inquiry.phone ?? "",
        instagram: inquiry.instagram ?? "",
        message: inquiry.message ?? "",
      };

      transaction.createOrReplace(doc);
    }

    await transaction.commit({ visibility: "deferred" });
    migrationCounts["generalInquiry"] = {
      strapi: inquiries.length,
      sanity: inquiries.length,
    };
    console.log(`[migrate] generalInquiry: ${inquiries.length} records migrated`);
  } catch (err) {
    console.error(`[migrate] ERROR writing generalInquiry: ${(err as Error).message}`);
    migrationCounts["generalInquiry"] = { strapi: -1, sanity: 0 };
  }
}

// ---------------------------------------------------------------------------
// Summary report
// ---------------------------------------------------------------------------

async function printSummaryReport(): Promise<void> {
  console.log("\n[migrate] === Migration Summary ===");

  for (const [docType, counts] of Object.entries(migrationCounts)) {
    // Query Sanity for actual count
    let sanityCount = 0;
    try {
      sanityCount = await client.fetch<number>(
        `count(*[_type == $type])`,
        { type: docType }
      );
    } catch {
      sanityCount = counts.sanity;
    }

    const status =
      counts.strapi < 0
        ? "ERROR"
        : counts.strapi === 0
          ? "EMPTY"
          : sanityCount >= counts.strapi
            ? "OK"
            : "MISMATCH";

    console.log(
      `[migrate] ${docType}: ${counts.strapi} Strapi -> ${sanityCount} Sanity (${status})`
    );
  }

  console.log("[migrate] Migration complete. Verify counts above before cleanup.");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("[migrate] Starting Strapi -> Sanity migration");
  console.log(`[migrate] Target: ${SANITY_PROJECT_ID}/${SANITY_DATASET}`);
  console.log(`[migrate] Source: ${STRAPI_BASE_URL}`);

  // Phase 1: Upload all images first to build imageCache
  await collectAndUploadAllImages();

  // Phase 2: Migrate collection types first (training programs needed for references)
  await migrateTrainingPrograms();
  await migrateContactForms();
  await migrateGeneralInquiries();

  // Phase 3: Migrate singleton pages
  await migrateHomePage();
  await migrateContactPage();
  await migrateGalleryPage();
  await migrateTrainingPage();
  await migrateTrainingProgramsPage(); // depends on training programs existing
  await migrateGlobalSettings();
  await migrateMainMenu();

  // Phase 4: Summary report
  await printSummaryReport();
}

main().catch((err) => {
  console.error("[migrate] Fatal error:", err);
  process.exit(1);
});
