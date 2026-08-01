import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readSource = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

test("legacy booking settings are not registered in the active Sanity Studio", () => {
  const schemaIndex = readSource("./schemas/index.ts");
  const sanityConfig = readSource("./sanity.config.ts");
  const structure = readSource("./structure/index.ts");
  const presentation = readSource("./presentation/resolve.ts");

  for (const source of [schemaIndex, sanityConfig, structure, presentation]) {
    assert.doesNotMatch(source, /bookingSettings|Booking Settings/);
  }
});

test("the legacy loader remains available for V1 booking compatibility", () => {
  const loaders = readSource("../data/loaders.ts");

  assert.match(loaders, /async function getBookingSettings/);
  assert.match(loaders, /_type == "bookingSettings"/);
});
