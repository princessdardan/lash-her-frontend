import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

test("new marketing submissions no longer write to Sanity form documents", () => {
  const formActions = readFileSync(join(process.cwd(), "src/app/actions/form.ts"), "utf8");
  const bookingService = readFileSync(join(process.cwd(), "src/lib/booking/booking-service.ts"), "utf8");
  const liveSubmissionCode = `${formActions}\n${bookingService}`;

  assert.equal(liveSubmissionCode.includes("@/sanity/lib/form-client"), false);
  assert.equal(liveSubmissionCode.includes("formClient.create"), false);
  assert.equal(liveSubmissionCode.includes("_type: 'generalInquiry'"), false);
  assert.equal(liveSubmissionCode.includes("_type: 'contactForm'"), false);
  assert.equal(liveSubmissionCode.includes("_type: 'contactPopupSubmission'"), false);
  assert.equal(liveSubmissionCode.includes('_type: "bookingMarketingOptIn"'), false);
});

test("Sanity form token is no longer required for launch validation", () => {
  const validator = readFileSync(join(process.cwd(), "scripts/validate-sanity-env.mjs"), "utf8");
  const validatorTest = readFileSync(join(process.cwd(), "src/lib/env/validate-sanity-env.test.ts"), "utf8");

  assert.equal(validator.includes("SANITY_FORM_TOKEN"), false);
  assert.equal(validatorTest.includes("SANITY_FORM_TOKEN"), false);
});
