import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import test from "node:test";
import {
  RESERVED_LANDING_PAGE_SLUGS,
  validateLandingPageSlug,
} from "./contract";

test("landing slugs allow reusable root paths and reject unsafe or reserved paths", () => {
  for (const slug of [
    "founding-membership",
    "salon-opening",
    "offer-2027",
    "a",
  ])
    assert.equal(validateLandingPageSlug(slug), true);
  for (const slug of [
    "",
    "UPPER",
    "nested/page",
    "-start",
    "end-",
    "two--hyphens",
    "studio",
    "api",
    "homepage",
    "training",
    "a".repeat(97),
    null,
  ])
    assert.equal(typeof validateLandingPageSlug(slug), "string");
});

test("all existing root route directories are reserved from landing pages", () => {
  for (const root of ["src/app", "src/app/(site)"]) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        !/^[([_.]/.test(entry.name) &&
        readdirSync(`${root}/${entry.name}`, { recursive: true }).some((name) =>
          /(?:^|\/)(page|route)\.tsx?$/.test(String(name)),
        )
      ) {
        assert.equal(
          RESERVED_LANDING_PAGE_SLUGS.has(entry.name),
          true,
          entry.name,
        );
      }
    }
  }
});
