import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { TServiceEditorial } from "@/types";

import { assertExactPublishedSanityServiceLink } from "./sanity-service-link";

test("exact Sanity service link requires the published slug and stored document ID to match", async () => {
  const lookups: string[] = [];
  const link = await assertExactPublishedSanityServiceLink(
    {
      publicSlug: " classic-fill ",
      sanityDocumentId: " sanity-service-1 ",
    },
    {
      getPublishedServiceBySlug: async (slug) => {
        lookups.push(slug);
        return createService();
      },
    },
  );

  assert.deepEqual(lookups, ["classic-fill"]);
  assert.deepEqual(link, {
    publicSlug: "classic-fill",
    sanityDocumentId: "sanity-service-1",
  });
});

test("exact Sanity service link rejects stale IDs, unpublished slugs, and incomplete pairs", async () => {
  const dependency = {
    getPublishedServiceBySlug: async (slug: string) =>
      slug === "classic-fill" ? createService() : null,
  };

  await assert.rejects(
    assertExactPublishedSanityServiceLink(
      {
        publicSlug: "classic-fill",
        sanityDocumentId: "stale-sanity-id",
      },
      dependency,
    ),
    /does not match its published slug/,
  );
  await assert.rejects(
    assertExactPublishedSanityServiceLink(
      {
        publicSlug: "unpublished-service",
        sanityDocumentId: "sanity-service-1",
      },
      dependency,
    ),
    /not published/,
  );
  await assert.rejects(
    assertExactPublishedSanityServiceLink(
      { publicSlug: "classic-fill", sanityDocumentId: undefined },
      dependency,
    ),
    /Select a published Sanity service/,
  );
});

test("optional editorial links are validated without blocking standalone operational services", () => {
  const operationsSource = readFileSync(
    new URL("../../admin/operations-write.ts", import.meta.url),
    "utf8",
  );
  const linkSource = readFileSync(
    new URL("./sanity-service-link.ts", import.meta.url),
    "utf8",
  );
  const activationSource = operationsSource.slice(
    operationsSource.indexOf("export async function setServiceOfferingStatus"),
    operationsSource.indexOf("export async function createOfferingAddOn"),
  );

  assert.match(linkSource, /loaders\.getServiceBySlug\(slug,/);
  assert.doesNotMatch(linkSource, /loaders\.getBookableServiceBySlug/);
  assert.doesNotMatch(
    activationSource,
    /assertExactPublishedSanityServiceLink|loadAndValidateOfferingSanityServiceLink/,
  );
  assert.match(
    operationsSource,
    /if \(sanityDocumentId\) \{\s*await assertExactPublishedSanityServiceLink\(\{\s*publicSlug,\s*sanityDocumentId,\s*\}\);\s*\}/,
  );
  assert.doesNotMatch(
    operationsSource,
    /if \(publicSlug \|\| sanityDocumentId\)/,
  );
});

function createService(): TServiceEditorial {
  return {
    _id: "sanity-service-1",
    description: "Classic fill",
    slug: "classic-fill",
    title: "Classic Fill",
  };
}
