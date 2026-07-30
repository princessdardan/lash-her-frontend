import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pageSource = readFileSync(
  new URL("./[slug]/page.tsx", import.meta.url),
  "utf8",
);

test("service detail page renders editorial content without Sanity commerce state", () => {
  assert.doesNotMatch(
    pageSource,
    /formatCad|fullPrice|isAvailable|showDetailPage/,
  );
  assert.doesNotMatch(pageSource, /\/booking/);
  assert.match(pageSource, /searchParams:/);
  assert.match(
    pageSource,
    /new URLSearchParams\(\{ provider: providerSlug \}\)/,
  );
  assert.match(pageSource, /href=\{servicesHref\}/);
  assert.match(pageSource, /View Provider Services &amp; Pricing/);
});
