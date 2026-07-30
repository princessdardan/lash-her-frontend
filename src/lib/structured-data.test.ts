import assert from "node:assert/strict";
import test from "node:test";

import type { TServiceEditorial } from "@/types";

process.env.NEXT_PUBLIC_SANITY_DATASET ??= "production";
process.env.NEXT_PUBLIC_SANITY_PROJECT_ID ??= "3auncj84";

const service: TServiceEditorial = {
  _id: "service-1",
  description: "Editorial service description",
  shortDescription: "Editorial summary",
  slug: "classic-fill",
  title: "Classic Fill",
};

test("service detail structured data contains editorial facts without a Sanity offer", async () => {
  const { buildServiceJsonLd } = await import("./structured-data");
  const data = buildServiceJsonLd(service);

  assert.equal(data["@type"], "Service");
  assert.equal(data.description, "Editorial summary");
  assert.ok(!("offers" in data));
  assert.doesNotMatch(
    JSON.stringify(data),
    /fullPrice|priceCurrency|InStock|OutOfStock/,
  );
});

test("service collection structured data links to editorial detail pages without offers", async () => {
  const { buildServiceCollectionJsonLd } = await import("./structured-data");
  const data = buildServiceCollectionJsonLd([service]);

  assert.ok(data);
  assert.match(
    JSON.stringify(data),
    /https:\/\/lashher\.com\/services\/classic-fill/,
  );
  assert.doesNotMatch(
    JSON.stringify(data),
    /\/booking|offers|fullPrice|priceCurrency/,
  );
});
