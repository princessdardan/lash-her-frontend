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
  assert.doesNotMatch(pageSource, /providerSlug|searchParams|View Provider/);
  assert.match(pageSource, /href="\/services"/);
  assert.match(pageSource, /href=\{FRESHA_BOOKING_URL\}/);
  assert.match(pageSource, /Book on Fresha/);
});
