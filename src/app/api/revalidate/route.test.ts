import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import { createRevalidatePostHandler } from "./src/app/api/revalidate/handler.ts";

  function createRequest(body = JSON.stringify({ _type: "homePage" })) {
    return new Request("http://localhost:3000/api/revalidate", {
      method: "POST",
      body,
    });
  }

  function assertEmptyResponseBody(response) {
    return response.text().then((text) => assert.equal(text, ""));
  }

  function runScenario({
    body,
    isValidSignature,
    getWebhookSecret = () => "webhook-secret",
  }) {
    const parseBodyCalls = [];
    const revalidatedTags = [];
    const syncedStockIds = [];
    const handler = createRevalidatePostHandler({
      getWebhookSecret,
      parseBody: async (req, secret, waitForContentLakeEventualConsistency) => {
        parseBodyCalls.push({ req, secret, waitForContentLakeEventualConsistency });
        return { body, isValidSignature };
      },
      revalidateTag: (tag, profile) => {
        revalidatedTags.push({ tag, profile });
      },
      syncProductStock: (id) => {
        syncedStockIds.push(id);
      },
    });

    return { handler, parseBodyCalls, revalidatedTags, syncedStockIds };
  }
`;

test("Sanity revalidate route revalidates mapped tags for a valid signature", () => {
  runRouteScenario(`
    const request = createRequest();
    const { handler, parseBodyCalls, revalidatedTags } = runScenario({
      body: { _type: "homePage" },
      isValidSignature: true,
    });

    const response = await handler(request);

    assert.equal(response.status, 200);
    assert.equal(parseBodyCalls.length, 1);
    assert.equal(parseBodyCalls[0].req, request);
    assert.equal(parseBodyCalls[0].secret, "webhook-secret");
    assert.equal(parseBodyCalls[0].waitForContentLakeEventualConsistency, true);
    assert.deepEqual(revalidatedTags, [{ tag: "homePage", profile: { expire: 0 } }]);
    await assertEmptyResponseBody(response);
  `);
});

test("Sanity revalidate route reconciles product stock on a product publish", () => {
  runRouteScenario(`
    const { handler, revalidatedTags, syncedStockIds } = runScenario({
      body: { _type: "product", _id: "product-123" },
      isValidSignature: true,
    });

    const response = await handler(createRequest());

    assert.equal(response.status, 200);
    assert.deepEqual(revalidatedTags, [{ tag: "product", profile: { expire: 0 } }]);
    assert.deepEqual(syncedStockIds, ["product-123"]);
  `);
});

test("Sanity revalidate route does not sync stock for non-product docs", () => {
  runRouteScenario(`
    const { handler, syncedStockIds } = runScenario({
      body: { _type: "homePage", _id: "home-1" },
      isValidSignature: true,
    });

    await handler(createRequest());

    assert.equal(syncedStockIds.length, 0);
  `);
});

test("Sanity revalidate route revalidates a product without an _id but skips the stock sync", () => {
  runRouteScenario(`
    const { handler, revalidatedTags, syncedStockIds } = runScenario({
      body: { _type: "product" },
      isValidSignature: true,
    });

    const response = await handler(createRequest());

    assert.equal(response.status, 200);
    assert.deepEqual(revalidatedTags, [{ tag: "product", profile: { expire: 0 } }]);
    assert.equal(syncedStockIds.length, 0);
  `);
});

test("Sanity revalidate route rejects invalid signatures before revalidation", () => {
  runRouteScenario(`
    const { handler, parseBodyCalls, revalidatedTags } = runScenario({
      body: { _type: "homePage" },
      isValidSignature: false,
    });

    const response = await handler(createRequest());

    assert.equal(response.status, 401);
    assert.equal(parseBodyCalls.length, 1);
    assert.equal(revalidatedTags.length, 0);
    await assertEmptyResponseBody(response);
  `);
});

test("Sanity revalidate route rejects null signatures before revalidation", () => {
  runRouteScenario(`
    const { handler, parseBodyCalls, revalidatedTags } = runScenario({
      body: { _type: "homePage" },
      isValidSignature: null,
    });

    const response = await handler(createRequest());

    assert.equal(response.status, 401);
    assert.equal(parseBodyCalls.length, 1);
    assert.equal(revalidatedTags.length, 0);
    await assertEmptyResponseBody(response);
  `);
});

test("Sanity revalidate route rejects unavailable webhook secrets before parsing", () => {
  runRouteScenario(`
    const { handler, parseBodyCalls, revalidatedTags } = runScenario({
      body: { _type: "homePage" },
      isValidSignature: true,
      getWebhookSecret: () => {
        throw new Error("SANITY_WEBHOOK_SECRET is missing");
      },
    });

    const response = await handler(createRequest());

    assert.equal(response.status, 401);
    assert.equal(parseBodyCalls.length, 0);
    assert.equal(revalidatedTags.length, 0);
    await assertEmptyResponseBody(response);
  `);
});

test("Sanity revalidate route rejects blank webhook secrets before parsing", () => {
  runRouteScenario(`
    const { handler, parseBodyCalls, revalidatedTags } = runScenario({
      body: { _type: "homePage" },
      isValidSignature: true,
      getWebhookSecret: () => "",
    });

    const response = await handler(createRequest());

    assert.equal(response.status, 401);
    assert.equal(parseBodyCalls.length, 0);
    assert.equal(revalidatedTags.length, 0);
    await assertEmptyResponseBody(response);
  `);
});

test("Sanity revalidate route rejects missing document types before revalidation", () => {
  runRouteScenario(`
    const { handler, parseBodyCalls, revalidatedTags } = runScenario({
      body: {},
      isValidSignature: true,
    });

    const response = await handler(createRequest("{}"));

    assert.equal(response.status, 400);
    assert.equal(parseBodyCalls.length, 1);
    assert.equal(revalidatedTags.length, 0);
    await assertEmptyResponseBody(response);
  `);
});

test("Sanity revalidate route no-ops unknown document types", () => {
  runRouteScenario(`
    const { handler, parseBodyCalls, revalidatedTags } = runScenario({
      body: { _type: "unknownType" },
      isValidSignature: true,
    });

    const response = await handler(createRequest(JSON.stringify({ _type: "unknownType" })));

    assert.equal(response.status, 200);
    assert.equal(parseBodyCalls.length, 1);
    assert.equal(revalidatedTags.length, 0);
    await assertEmptyResponseBody(response);
  `);
});

function runRouteScenario(assertions: string): void {
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
