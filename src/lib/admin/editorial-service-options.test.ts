import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveOptionalEditorialServiceOptions } from "./editorial-service-options";

describe("optional editorial service options", () => {
  it("returns published editorial services when Sanity is available", async () => {
    const result = await resolveOptionalEditorialServiceOptions(async () => [
      { _id: "service-1", slug: "classic-set" },
    ]);

    assert.deepEqual(result, {
      isAvailable: true,
      services: [{ _id: "service-1", slug: "classic-set" }],
    });
  });

  it("does not fail the operational admin page when Sanity is unavailable", async () => {
    const result = await resolveOptionalEditorialServiceOptions(async () => {
      throw new Error("Sanity unavailable");
    });

    assert.deepEqual(result, {
      isAvailable: false,
      services: [],
    });
  });
});
