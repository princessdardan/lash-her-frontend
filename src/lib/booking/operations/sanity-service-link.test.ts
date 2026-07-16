import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { TService } from "@/types";

import { assertExactPublishedSanityServiceLink } from "./sanity-service-link";

test("exact Sanity service link requires the published slug and stored document ID to match", async () => {
  const lookups: string[] = [];
  const link = await assertExactPublishedSanityServiceLink(
    {
      publicSlug: " classic-fill ",
      sanityDocumentId: " sanity-service-1 ",
    },
    {
      getPublishedBookableServiceBySlug: async (slug) => {
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
    getPublishedBookableServiceBySlug: async (slug: string) =>
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
    /not published and bookable/,
  );
  await assert.rejects(
    assertExactPublishedSanityServiceLink(
      { publicSlug: "classic-fill", sanityDocumentId: undefined },
      dependency,
    ),
    /Select a published bookable Sanity service/,
  );
});

test("admin service setup uses published choices and validates before the audited activation transaction", () => {
  const operationsSource = readFileSync(
    new URL("../../admin/operations-write.ts", import.meta.url),
    "utf8",
  );
  const pageSource = readFileSync(
    new URL(
      "../../../app/admin/(protected)/offerings/page.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  const activationSource = operationsSource.slice(
    operationsSource.indexOf("export async function setServiceOfferingStatus"),
    operationsSource.indexOf("export async function createOfferingAddOn"),
  );

  assert.match(
    pageSource,
    /loaders\.getBookableServices\(\{ mode: "published", stega: false \}\)/,
  );
  assert.match(pageSource, /name="sanityServiceLink"/);
  assert.ok(
    activationSource.indexOf("loadAndValidateOfferingSanityServiceLink") <
      activationSource.indexOf("runAuditedAdminMutation"),
  );
  assert.match(
    operationsSource,
    /await assertExactPublishedSanityServiceLink\(\{\s*publicSlug,\s*sanityDocumentId,\s*\}\);/,
  );
});

function createService(): TService {
  return {
    _id: "sanity-service-1",
    currency: "CAD",
    depositAmount: 50,
    description: "Classic fill",
    durationMinutes: 60,
    fullPrice: 150,
    isAvailable: true,
    showDetailPage: true,
    slug: "classic-fill",
    title: "Classic Fill",
  };
}
