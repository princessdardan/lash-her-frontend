import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import { createRevalidatePostHandler } from "./src/app/api/revalidate/route.ts";

  function createRequest(body = JSON.stringify({ _type: "homePage" })) {
    return new Request("http://localhost:3000/api/revalidate", {
      method: "POST",
      body,
    });
  }

  function runScenario({ body, isValidSignature }) {
    const parseBodyCalls = [];
    const revalidatedTags = [];
    const handler = createRevalidatePostHandler({
      getWebhookSecret: () => "webhook-secret",
      parseBody: async (req, secret) => {
        parseBodyCalls.push({ req, secret });
        return { body, isValidSignature };
      },
      revalidateTag: (tag, profile) => {
        revalidatedTags.push({ tag, profile });
      },
    });

    return { handler, parseBodyCalls, revalidatedTags };
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
    assert.deepEqual(revalidatedTags, [{ tag: "homePage", profile: { expire: 0 } }]);
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
