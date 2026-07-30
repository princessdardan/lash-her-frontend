import "server-only";

import type { TServiceEditorial } from "@/types";

export interface ExactSanityServiceLink {
  publicSlug: string;
  sanityDocumentId: string;
}

export interface SanityServiceLinkDependencies {
  getPublishedServiceBySlug: (
    slug: string,
  ) => Promise<TServiceEditorial | null>;
}

const defaultDependencies: SanityServiceLinkDependencies = {
  getPublishedServiceBySlug: async (slug) => {
    const { loaders } = await import("@/data/loaders");

    return loaders.getServiceBySlug(slug, {
      mode: "published",
      stega: false,
    });
  },
};

/**
 * Verifies both sides of the operational-to-Sanity service link. Resolving by
 * slug alone is insufficient because a stale document ID could otherwise
 * reopen the legacy booking path during a dual-mode migration.
 */
export async function assertExactPublishedSanityServiceLink(
  input: {
    publicSlug: string | null | undefined;
    sanityDocumentId: string | null | undefined;
  },
  dependencies: SanityServiceLinkDependencies = defaultDependencies,
): Promise<ExactSanityServiceLink> {
  const publicSlug = input.publicSlug?.trim();
  const sanityDocumentId = input.sanityDocumentId?.trim();

  if (!publicSlug || !sanityDocumentId) {
    throw new Error("Select a published Sanity service");
  }

  const publishedService =
    await dependencies.getPublishedServiceBySlug(publicSlug);

  if (publishedService === null) {
    throw new Error("The linked Sanity service slug is not published");
  }

  if (publishedService._id !== sanityDocumentId) {
    throw new Error(
      "The linked Sanity service document ID does not match its published slug",
    );
  }

  return { publicSlug, sanityDocumentId };
}
