import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const source = readFileSync("src/app/(site)/training-programs/[slug]/confirmation/page.tsx", "utf8");

test("training confirmation disables static caching and indexing for order-bearing links", () => {
  assert.match(source, /unstable_noStore as noStore/);
  assert.match(source, /export const dynamic = "force-dynamic";/);
  assert.match(source, /export const revalidate = 0;/);
  assert.match(source, /robots: \{ index: false, follow: false \}/);
  assert.match(source, /noStore\(\);/);
});

test("training confirmation schedule button uses token-only schedule route", () => {
  assert.match(source, /buildTrainingScheduleUrl/);
  assert.match(source, /schedulingToken/);
  assert.doesNotMatch(source, /href=\{`\/booking\?type=training-call&order=/);
  assert.equal(source.includes("Use the same email address from checkout"), false);
});
