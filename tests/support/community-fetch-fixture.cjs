/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");

assert.equal(process.env.NODE_ENV, "development");
assert.equal(process.env.COMMUNITY_E2E, "1");
const database = new URL(process.env.DATABASE_URL);
assert.equal(database.hostname, "127.0.0.1");
assert.equal(database.pathname, "/lash_community_frontend_test");
assert.equal(process.env.API_GATEWAY_STAGING_ORIGIN, "https://127.0.0.1:4113");

const originalFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (
    url.hostname.endsWith(".api.sanity.io") ||
    url.hostname.endsWith(".apicdn.sanity.io")
  ) {
    return Response.json({ result: null });
  }
  if (
    process.env.COMMUNITY_E2E_INVALID_RESPONSE === "1" &&
    url.origin === process.env.API_GATEWAY_STAGING_ORIGIN &&
    /^\/community\/v1\/spaces\/[a-f0-9-]+\/posts$/u.test(url.pathname) &&
    url.searchParams.get("search") === "p5-06-invalid-response"
  ) {
    return Response.json({
      posts: [{ body: "Must not render upstream payload" }],
    });
  }
  assert.equal(
    url.hostname,
    "127.0.0.1",
    `Unexpected external request to ${url.hostname}`,
  );
  return originalFetch(input, init);
};
