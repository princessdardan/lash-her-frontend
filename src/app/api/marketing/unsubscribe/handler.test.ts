import assert from "node:assert/strict";
import test from "node:test";

import {
  createMarketingUnsubscribeGetHandler,
  createMarketingUnsubscribePostHandler,
} from "./handler";

const EMAIL = "client@example.com";
const ISSUED_AT = new Date("2026-08-31T18:30:00.000Z");

function request(method: "GET" | "POST", token?: string): Request {
  const url = new URL("/api/marketing/unsubscribe", "https://www.lashher.ca");
  if (token !== undefined) url.searchParams.set("token", token);
  return new Request(url, { method });
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    buildUrlFromToken: (token: string) =>
      `https://www.lashher.ca/api/marketing/unsubscribe?token=${token}`,
    logError: () => undefined,
    recordInternalUnsubscribe: async () => ({ eventId: "event-1" }),
    verifyToken: () => ({
      email: EMAIL,
      issuedAt: ISSUED_AT,
      tokenVersion: "v1" as const,
    }),
    ...overrides,
  };
}

test("GET validates without mutating and renders an exact escaped action", async () => {
  let mutationCount = 0;
  const action =
    'https://www.lashher.ca/api/marketing/unsubscribe?token=a&next="><script>';
  const handler = createMarketingUnsubscribeGetHandler(
    dependencies({
      buildUrlFromToken: () => action,
      recordInternalUnsubscribe: async () => {
        mutationCount += 1;
        return { eventId: "event-1" };
      },
    }),
  );

  const response = await handler(request("GET", "valid-token"));
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.equal(mutationCount, 0);
  assert.ok(
    html.includes(
      'action="https://www.lashher.ca/api/marketing/unsubscribe?token=a&amp;next=&quot;&gt;&lt;script&gt;"',
    ),
  );
  assert.equal(html.includes(action), false);
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.match(
    response.headers.get("content-security-policy") ?? "",
    /form-action 'self'/,
  );
  assert.match(
    response.headers.get("content-security-policy") ?? "",
    /frame-ancestors 'none'/,
  );
});

test("GET returns generic invalid-token HTML without leaking an email", async () => {
  let builtUrl = false;
  const handler = createMarketingUnsubscribeGetHandler(
    dependencies({
      buildUrlFromToken: () => {
        builtUrl = true;
        return "https://example.invalid";
      },
      verifyToken: () => null,
    }),
  );

  const response = await handler(request("GET", "invalid-token"));
  const html = await response.text();

  assert.equal(response.status, 400);
  assert.equal(builtUrl, false);
  assert.match(html, /This unsubscribe link is invalid\./);
  assert.equal(html.includes(EMAIL), false);
});

test("POST persists a stable internal unsubscribe and returns an empty 200", async () => {
  const calls: unknown[] = [];
  const handler = createMarketingUnsubscribePostHandler(
    dependencies({
      recordInternalUnsubscribe: async (input: unknown) => {
        calls.push(input);
        return { eventId: "event-1" };
      },
      verifyToken: () => ({
        email: EMAIL,
        issuedAt: ISSUED_AT,
        tokenVersion: "v2" as const,
      }),
    }),
  );

  const response = await handler(request("POST", "valid-token"));

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "");
  assert.deepEqual(calls, [
    {
      email: EMAIL,
      metadata: {
        mechanism: "signed_unsubscribe_url",
        source: "contact_popup_customer_email",
        tokenVersion: "v2",
      },
      reason: "contact_popup_email_unsubscribe",
    },
  ]);
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
});

test("POST rejects a missing or invalid token without persistence", async () => {
  let mutationCount = 0;
  const handler = createMarketingUnsubscribePostHandler(
    dependencies({
      recordInternalUnsubscribe: async () => {
        mutationCount += 1;
        return { eventId: "event-1" };
      },
      verifyToken: () => null,
    }),
  );

  assert.equal((await handler(request("POST"))).status, 400);
  assert.equal((await handler(request("POST", "invalid-token"))).status, 400);
  assert.equal(mutationCount, 0);
});

test("POST returns an empty 503 and logs no sensitive values on persistence failure", async () => {
  const messages: string[] = [];
  const handler = createMarketingUnsubscribePostHandler(
    dependencies({
      logError: (message: string) => messages.push(message),
      recordInternalUnsubscribe: async () => {
        throw new Error(`failed for ${EMAIL} with valid-token`);
      },
    }),
  );

  const response = await handler(request("POST", "valid-token"));

  assert.equal(response.status, 503);
  assert.equal(await response.text(), "");
  assert.deepEqual(messages, [
    "[marketing-unsubscribe] Unsubscribe persistence failed",
  ]);
  assert.equal(messages.join(" ").includes(EMAIL), false);
  assert.equal(messages.join(" ").includes("valid-token"), false);
});

test("POST replay remains successful and delegates idempotency to persistence", async () => {
  let mutationCount = 0;
  const handler = createMarketingUnsubscribePostHandler(
    dependencies({
      recordInternalUnsubscribe: async () => ({
        eventId: `event-${++mutationCount}`,
      }),
    }),
  );

  assert.equal((await handler(request("POST", "same-token"))).status, 200);
  assert.equal((await handler(request("POST", "same-token"))).status, 200);
  assert.equal(mutationCount, 2);
});
