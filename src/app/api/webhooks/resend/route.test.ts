import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import { createResendWebhookPostHandler } from "./src/app/api/webhooks/resend/route.ts";

  const webhookUrl = "http://localhost:3000/api/webhooks/resend";

  function createRequest(body, headers = {}) {
    return new Request(webhookUrl, {
      body,
      headers,
      method: "POST",
    });
  }

  function createSignedRequest(body) {
    return createRequest(body, {
      "svix-id": "msg_123",
      "svix-signature": "v1,signature",
      "svix-timestamp": "1780000000",
    });
  }

  function createHandler({
    getWebhookSecret = () => "whsec_test",
    recordResendUnsubscribe = async () => ({ eventId: "unsubscribe-1" }),
    verifyEvent,
  }) {
    const warnings = [];
    const errors = [];
    const verifiedEvents = [];
    const unsubscribeCalls = [];
    const handler = createResendWebhookPostHandler({
      getWebhookSecret,
      logError: (...args) => errors.push(args),
      logWarn: (...args) => warnings.push(args),
      recordResendUnsubscribe: async (input) => {
        unsubscribeCalls.push(input);
        return recordResendUnsubscribe(input);
      },
      verifyEvent: (input) => {
        verifiedEvents.push(input);
        return verifyEvent(input);
      },
    });

    return { errors, handler, unsubscribeCalls, verifiedEvents, warnings };
  }

  function createContactUpdatedEvent(overrides = {}) {
    return {
      created_at: "2026-05-12T12:00:00.000Z",
      data: {
        audience_id: "audience-1",
        created_at: "2026-05-10T12:00:00.000Z",
        email: "subscriber@example.com",
        first_name: "Subscriber",
        id: "contact-123",
        last_name: "Name",
        segment_ids: ["segment-marketing", "segment-newsletter"],
        unsubscribed: true,
        updated_at: "2026-05-12T12:00:00.000Z",
        ...(overrides.data ?? {}),
      },
      type: "contact.updated",
      ...overrides,
    };
  }
`;

test("Resend webhook route hides itself when the webhook secret is not configured", () => {
  runResendWebhookScenario(`
    const { handler, verifiedEvents, unsubscribeCalls } = createHandler({
      getWebhookSecret: () => undefined,
      verifyEvent: () => createContactUpdatedEvent(),
    });

    const response = await handler(createSignedRequest("{}"));

    assert.equal(response.status, 404);
    assert.equal(verifiedEvents.length, 0);
    assert.equal(unsubscribeCalls.length, 0);
  `);
});

test("Resend webhook route rejects missing Svix signature headers before verification", () => {
  runResendWebhookScenario(`
    const { handler, verifiedEvents, unsubscribeCalls, warnings } = createHandler({
      verifyEvent: () => createContactUpdatedEvent(),
    });

    const response = await handler(createRequest("{}"));

    assert.equal(response.status, 401);
    assert.equal(verifiedEvents.length, 0);
    assert.equal(unsubscribeCalls.length, 0);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0][0], "[resend-webhook] Missing signature headers");
  `);
});

test("Resend webhook route rejects invalid signatures before unsubscribe persistence", () => {
  runResendWebhookScenario(`
    const { handler, verifiedEvents, unsubscribeCalls, warnings } = createHandler({
      verifyEvent: () => {
        throw new Error("invalid signature");
      },
    });

    const response = await handler(createSignedRequest("{}"));

    assert.equal(response.status, 401);
    assert.equal(verifiedEvents.length, 1);
    assert.equal(verifiedEvents[0].webhookSecret, "whsec_test");
    assert.equal(unsubscribeCalls.length, 0);
    assert.equal(warnings[0][0], "[resend-webhook] Invalid signature");
  `);
});

test("Resend webhook route records contact.updated unsubscribe events", () => {
  runResendWebhookScenario(`
    const { handler, unsubscribeCalls, verifiedEvents } = createHandler({
      verifyEvent: () => createContactUpdatedEvent(),
    });

    const response = await handler(createSignedRequest('{"type":"contact.updated"}'));

    assert.equal(response.status, 200);
    assert.equal(verifiedEvents.length, 1);
    assert.equal(verifiedEvents[0].payload, '{"type":"contact.updated"}');
    assert.equal(unsubscribeCalls.length, 1);
    assert.deepEqual(unsubscribeCalls[0], {
      email: "subscriber@example.com",
      metadata: {
        resendSegmentIds: ["segment-marketing", "segment-newsletter"],
      },
      occurredAt: new Date("2026-05-12T12:00:00.000Z"),
      resendContactId: "contact-123",
    });
  `);
});

test("Resend webhook route ignores contact updates that are still subscribed", () => {
  runResendWebhookScenario(`
    const { handler, unsubscribeCalls } = createHandler({
      verifyEvent: () => createContactUpdatedEvent({ data: { unsubscribed: false } }),
    });

    const response = await handler(createSignedRequest("{}"));

    assert.equal(response.status, 200);
    assert.equal(unsubscribeCalls.length, 0);
  `);
});

test("Resend webhook route asks Resend to retry when unsubscribe persistence fails", () => {
  runResendWebhookScenario(`
    const { errors, handler, unsubscribeCalls } = createHandler({
      recordResendUnsubscribe: async () => {
        throw new Error("database unavailable");
      },
      verifyEvent: () => createContactUpdatedEvent(),
    });

    const response = await handler(createSignedRequest("{}"));

    assert.equal(response.status, 503);
    assert.equal(unsubscribeCalls.length, 1);
    assert.equal(errors.length, 1);
    assert.equal(errors[0][0], "[resend-webhook] Unsubscribe persistence failed");
  `);
});

function runResendWebhookScenario(assertions: string): void {
  const scenario = `${helperScript}\nvoid (async () => {\n${assertions}\n})()`;
  const env = { ...process.env };

  env.NEXT_PUBLIC_SANITY_DATASET = "test";
  env.NEXT_PUBLIC_SANITY_PROJECT_ID = "test-project";

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
