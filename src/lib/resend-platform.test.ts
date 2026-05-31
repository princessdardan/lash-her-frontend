import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import {
    buildResendMarketingContactSyncPlan,
    getConfiguredTransactionalTemplate,
    syncResendMarketingContact,
    toResendTemplateVariables,
  } from "./src/lib/resend-platform.ts";

  function ok(data) {
    return { data, error: null, headers: null };
  }

  function notFound(message = "not found") {
    return {
      data: null,
      error: { message, name: "not_found", statusCode: 404 },
      headers: null,
    };
  }
`;

test("Resend template variables normalize primitive dashboard values", () => {
  runResendPlatformScenario(`
    const variables = toResendTemplateVariables({
      booleanValue: true,
      dateValue: new Date("2026-05-10T12:00:00.000Z"),
      emptyValue: "",
      objectValue: { source: "contact_popup" },
      skippedNumber: Number.NaN,
      skippedNull: null,
      stringValue: "Lash Her",
    });

    assert.deepEqual(variables, {
      booleanValue: "true",
      dateValue: "2026-05-10T12:00:00.000Z",
      emptyValue: "",
      objectValue: '{"source":"contact_popup"}',
      stringValue: "Lash Her",
    });
  `);
});

test("configured transactional templates include the runtime email profile image HTML", () => {
  runResendPlatformScenario(`
    process.env.RESEND_TEMPLATE_BOOKING_CONFIRMATION_ID = "template-booking";
    process.env.EMAIL_PROFILE_IMAGE_URL = " https://assets.lashher.test/logo<profile>.jpeg?size=72&theme=dark ";

    const template = getConfiguredTransactionalTemplate("booking_confirmation", {
      CUSTOMER_NAME: "Client Name",
    });

    assert.equal(template.id, "template-booking");
    assert.equal(template.variables.CUSTOMER_NAME, "Client Name");
    assert.match(template.variables.EMAIL_PROFILE_IMAGE_HTML, /<img/);
    assert.equal(
      template.variables.EMAIL_PROFILE_IMAGE_HTML.includes('src="https://assets.lashher.test/logo&lt;profile&gt;.jpeg?size=72&amp;theme=dark"'),
      true,
    );
  `);
});

test("Resend marketing contact plan maps sources to configured segments and topics", () => {
  runResendPlatformScenario(`
    process.env.RESEND_SEGMENT_MARKETING_ID = "segment-all";
    process.env.RESEND_SEGMENT_CONTACT_POPUP_ID = "segment-popup";
    process.env.RESEND_TOPIC_MARKETING_ID = "topic-marketing";
    process.env.RESEND_TOPIC_NEWSLETTER_ID = "topic-newsletter";
    process.env.RESEND_EVENT_MARKETING_CONTACT_OPTED_IN = "lashher.contact.opted_in";

    const plan = buildResendMarketingContactSyncPlan({
      consentText: "I agree to receive updates.",
      consentedAt: new Date("2026-05-10T12:00:00.000Z"),
      email: " Subscriber@Example.COM ",
      instagram: "@subscriber",
      name: "Subscriber Name",
      phone: "555-0100",
      source: "contact_popup",
      sourcePath: "/",
    });

    assert.equal(plan.createContact.email, "Subscriber@Example.COM");
    assert.equal(plan.createContact.firstName, "Subscriber");
    assert.equal(plan.createContact.lastName, "Name");
    assert.equal(plan.createContact.unsubscribed, false);
    assert.deepEqual(plan.createContact.segments, [{ id: "segment-all" }, { id: "segment-popup" }]);
    assert.deepEqual(plan.createContact.topics, [
      { id: "topic-marketing", subscription: "opt_in" },
      { id: "topic-newsletter", subscription: "opt_in" },
    ]);
    assert.deepEqual(plan.createContact.properties, {
      consent_text: "I agree to receive updates.",
      consented_at: "2026-05-10T12:00:00.000Z",
      instagram: "@subscriber",
      phone: "555-0100",
      source: "contact_popup",
      source_path: "/",
    });
    assert.equal(plan.event.event, "lashher.contact.opted_in");
  `);
});

test("Resend marketing contact sync creates missing contacts and adds missing segments", () => {
  runResendPlatformScenario(`
    process.env.RESEND_API_KEY = "re_test";
    process.env.RESEND_SEGMENT_MARKETING_ID = "segment-all";
    process.env.RESEND_SEGMENT_TRAINING_CONTACT_ID = "segment-training";

    const calls = [];
    const dependencies = {
      addContactSegment: async (input) => {
        calls.push({ type: "add-segment", input });
        return ok({ id: input.segmentId });
      },
      createContact: async (input) => {
        calls.push({ type: "create", input });
        return ok({ id: "contact-1" });
      },
      listContactSegments: async (input) => {
        calls.push({ type: "list-segments", input });
        return ok({ data: [{ id: "segment-all" }] });
      },
      sendEvent: async (input) => {
        calls.push({ type: "event", input });
        return ok({ event: input.event, object: "event" });
      },
      updateContact: async (input) => {
        calls.push({ type: "update", input });
        return notFound();
      },
      updateContactTopics: async (input) => {
        calls.push({ type: "topics", input });
        return ok({ id: "contact-1" });
      },
    };

    await syncResendMarketingContact({
      consentedAt: new Date("2026-05-10T12:00:00.000Z"),
      email: "student@example.com",
      name: "Student Name",
      source: "training_contact",
    }, dependencies);

    assert.deepEqual(calls.map((call) => call.type), ["update", "create", "list-segments", "add-segment", "event"]);
    assert.deepEqual(calls[3].input, { email: "student@example.com", segmentId: "segment-training" });
  `);
});

function runResendPlatformScenario(assertions: string): void {
  const scenario = `${helperScript}\nvoid (async () => {\n${assertions}\n})()`;
  const env = { ...process.env };

  env.NEXT_PUBLIC_SANITY_DATASET = "test";
  env.NEXT_PUBLIC_SANITY_PROJECT_ID = "test-project";
  delete env.EMAIL_PROFILE_IMAGE_URL;
  delete env.RESEND_API_KEY;
  delete env.RESEND_EVENT_MARKETING_CONTACT_OPTED_IN;
  delete env.RESEND_TEMPLATE_BOOKING_CONFIRMATION_ID;
  delete env.RESEND_SEGMENT_CONTACT_POPUP_ID;
  delete env.RESEND_SEGMENT_MARKETING_ID;
  delete env.RESEND_SEGMENT_TRAINING_CONTACT_ID;
  delete env.RESEND_TOPIC_MARKETING_ID;
  delete env.RESEND_TOPIC_NEWSLETTER_ID;

  execFileSync(
    "./node_modules/.bin/tsx",
    ["--conditions=react-server", "--eval", scenario],
    {
      cwd: process.cwd(),
      env,
      stdio: "pipe",
    },
  );
}
