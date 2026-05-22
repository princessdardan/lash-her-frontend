import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const source = readFileSync("src/app/(site)/training-programs/[slug]/confirmation/page.tsx", "utf8");

test("training confirmation schedule button uses token-only schedule route", () => {
  assert.match(source, /buildTrainingScheduleUrl/);
  assert.match(source, /schedulingToken/);
  assert.doesNotMatch(source, /href=\{`\/booking\?type=training-call&order=/);
  assert.equal(source.includes("Use the same email address from checkout"), false);
});
