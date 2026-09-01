import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import {
    ContactPopupWelcomeEmailError,
    processContactPopupSubmission,
  } from "./src/lib/contact-popup/contact-popup-submission.ts";

  const offer = {
    promotionId: "promotion.sitewide.welcome",
    promotionRevision: "promotion-revision-1",
    promotionCode: "WELCOME20",
    discountType: "percentage",
    discountAmount: 20,
    appliesTo: "all",
    offerLabel: "20% off your first order",
    offerTerms: "One use per customer.",
    ctaLabel: "Shop now",
    ctaUrl: "https://lashher.com/products",
    resolvedAt: "2026-08-31T12:00:00.000Z",
  };

  function createDependencies(overrides = {}) {
    const calls = [];
    const dependencies = {
      resolveOffer: async () => ({ status: "available", offer }),
      recordSubmission: async (input) => {
        calls.push({ type: "record", input });
        return {
          submissionId: "00000000-0000-4000-8000-000000000001",
          offerEmailEnqueued: true,
          offerEmailJobId: "00000000-0000-4000-8000-000000000002",
        };
      },
      processOfferEmailJob: async (input) => {
        calls.push({ type: "process", input });
        return { claimed: 1, enqueued: 0, failed: 0, sent: 1, suppressed: 0 };
      },
      sendAdminEmail: async (formType, data) => {
        calls.push({ type: "admin", formType, data });
      },
      sendGenericWelcomeEmail: async (formType, data) => {
        calls.push({ type: "generic", formType, data });
      },
      logError: (...args) => calls.push({ type: "error", args }),
      logWarn: (...args) => calls.push({ type: "warn", args }),
      ...overrides,
    };
    return { calls, dependencies };
  }

  const data = {
    variant: "fullContact",
    name: " Subscriber ",
    email: "subscriber@example.com",
    instagram: "@subscriber",
    sourcePath: "/",
    consentText: "I agree.",
  };
`;

test("available signup offer is saved with its snapshot and attempted immediately from the durable outbox", () => {
  runScenario(`
    const { calls, dependencies } = createDependencies();
    const result = await processContactPopupSubmission(data, dependencies);

    assert.deepEqual(result, {
      status: "offer_email_enqueued",
      submissionId: "00000000-0000-4000-8000-000000000001",
      offerEmailJobId: "00000000-0000-4000-8000-000000000002",
      immediateDelivery: "sent",
    });
    const record = calls.find((call) => call.type === "record");
    assert.deepEqual(record.input.signupOffer, offer);
    assert.equal(record.input.variant, "fullContact");
    assert.deepEqual(
      calls.find((call) => call.type === "process").input,
      { jobId: "00000000-0000-4000-8000-000000000002" },
    );
    assert.equal(calls.some((call) => call.type === "generic"), false);
  `);
});

test("disabled signup offer saves without an offer and sends the generic welcome", () => {
  runScenario(`
    const { calls, dependencies } = createDependencies({
      resolveOffer: async () => ({ status: "disabled" }),
      recordSubmission: async (input) => {
        calls.push({ type: "record", input });
        return { submissionId: "submission-disabled" };
      },
    });
    const result = await processContactPopupSubmission(data, dependencies);

    assert.deepEqual(result, {
      status: "generic_welcome_sent",
      submissionId: "submission-disabled",
      offerResolution: "disabled",
    });
    assert.equal(calls.find((call) => call.type === "record").input.signupOffer, undefined);
    assert.equal(calls.filter((call) => call.type === "generic").length, 1);
    assert.equal(calls.some((call) => call.type === "process"), false);
  `);
});

test("invalid signup offer falls back to the generic welcome and records the reason", () => {
  runScenario(`
    const { calls, dependencies } = createDependencies({
      resolveOffer: async () => ({
        status: "invalid",
        reason: "promotion_not_sitewide",
      }),
      recordSubmission: async (input) => {
        calls.push({ type: "record", input });
        return { submissionId: "submission-invalid" };
      },
    });
    const result = await processContactPopupSubmission(data, dependencies);

    assert.deepEqual(result, {
      status: "generic_welcome_sent",
      submissionId: "submission-invalid",
      offerResolution: "invalid",
      invalidReason: "promotion_not_sitewide",
    });
    assert.equal(calls.filter((call) => call.type === "generic").length, 1);
    assert.equal(calls.filter((call) => call.type === "warn").length, 1);
  `);
});

test("offer provider failure remains nonblocking because the email is durably queued", () => {
  runScenario(`
    const { calls, dependencies } = createDependencies({
      processOfferEmailJob: async (input) => {
        calls.push({ type: "process", input });
        return { claimed: 1, enqueued: 0, failed: 1, sent: 0, suppressed: 0 };
      },
    });
    const result = await processContactPopupSubmission(data, dependencies);

    assert.equal(result.status, "offer_email_enqueued");
    assert.equal(result.immediateDelivery, "failed");
    assert.equal(calls.filter((call) => call.type === "error").length, 1);
  `);
});

test("an immediate outbox processing exception remains nonblocking", () => {
  runScenario(`
    const { calls, dependencies } = createDependencies({
      processOfferEmailJob: async () => {
        throw new Error("provider unavailable");
      },
    });
    const result = await processContactPopupSubmission(data, dependencies);

    assert.equal(result.status, "offer_email_enqueued");
    assert.equal(result.immediateDelivery, "failed");
    assert.equal(calls.filter((call) => call.type === "error").length, 1);
  `);
});

test("generic welcome failure is reported after the submission is saved", () => {
  runScenario(`
    const { calls, dependencies } = createDependencies({
      resolveOffer: async () => ({ status: "disabled" }),
      recordSubmission: async (input) => {
        calls.push({ type: "record", input });
        return { submissionId: "submission-generic-failure" };
      },
      sendGenericWelcomeEmail: async () => {
        throw new Error("customer delivery failed");
      },
    });

    await assert.rejects(
      () => processContactPopupSubmission(data, dependencies),
      ContactPopupWelcomeEmailError,
    );
    assert.equal(calls.filter((call) => call.type === "record").length, 1);
  `);
});

test("admin notification failure never fails the customer submission flow", () => {
  runScenario(`
    const { calls, dependencies } = createDependencies({
      resolveOffer: async () => ({ status: "disabled" }),
      recordSubmission: async (input) => {
        calls.push({ type: "record", input });
        return { submissionId: "submission-admin-failure" };
      },
      sendAdminEmail: async () => {
        throw new Error("admin delivery failed");
      },
    });
    const result = await processContactPopupSubmission(data, dependencies);

    assert.equal(result.status, "generic_welcome_sent");
    assert.equal(calls.filter((call) => call.type === "generic").length, 1);
    assert.equal(calls.filter((call) => call.type === "error").length, 1);
  `);
});

test("duplicate offer enqueue sends the existing generic welcome without retrying the offer", () => {
  runScenario(`
    const { calls, dependencies } = createDependencies({
      recordSubmission: async (input) => {
        calls.push({ type: "record", input });
        return {
          submissionId: "submission-duplicate",
          offerEmailEnqueued: false,
        };
      },
    });
    const result = await processContactPopupSubmission(data, dependencies);

    assert.deepEqual(result, {
      status: "offer_email_duplicate",
      submissionId: "submission-duplicate",
    });
    assert.equal(calls.filter((call) => call.type === "generic").length, 1);
    assert.equal(calls.some((call) => call.type === "process"), false);
  `);
});

test("duplicate offer generic welcome failure preserves saved-but-email-failed semantics", () => {
  runScenario(`
    const { calls, dependencies } = createDependencies({
      recordSubmission: async (input) => {
        calls.push({ type: "record", input });
        return {
          submissionId: "submission-duplicate-failure",
          offerEmailEnqueued: false,
        };
      },
      sendGenericWelcomeEmail: async () => {
        throw new Error("repeat welcome delivery failed");
      },
    });

    await assert.rejects(
      () => processContactPopupSubmission(data, dependencies),
      ContactPopupWelcomeEmailError,
    );
    assert.equal(calls.filter((call) => call.type === "record").length, 1);
    assert.equal(calls.some((call) => call.type === "process"), false);
  `);
});

function runScenario(assertions: string): void {
  const scenario = `${helperScript}\nvoid (async () => {\n${assertions}\n})()`;
  const env = { ...process.env };

  env.NEXT_PUBLIC_SANITY_DATASET = "test";
  env.NEXT_PUBLIC_SANITY_PROJECT_ID = "test-project";

  execFileSync(
    process.execPath,
    [
      "--conditions=react-server",
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      scenario,
    ],
    {
      cwd: process.cwd(),
      env,
      stdio: "pipe",
    },
  );
}
