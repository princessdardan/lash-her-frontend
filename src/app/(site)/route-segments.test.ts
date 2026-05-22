import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";

test("reserved booking and schedule route segments have explicit route files", () => {
  assert.equal(existsSync("src/app/(site)/booking/page.tsx"), true);
  assert.equal(existsSync("src/app/(site)/booking/confirmation/page.tsx"), true);
  assert.equal(existsSync("src/app/(site)/services/booking/confirmation/page.tsx"), true);
  assert.equal(existsSync("src/app/(site)/services/[slug]/booking/confirmation/page.tsx"), true);
  assert.equal(existsSync("src/app/(site)/training-programs/[slug]/schedule/page.tsx"), true);
});
