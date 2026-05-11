import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import { getHelcimCardTransaction } from "./src/lib/commerce/helcim-client.ts";

  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ input, init });
    return Response.json({ id: 25764674, status: "APPROVED" });
  };

  void (async () => {
  try {
    const response = await getHelcimCardTransaction("25764674");
    const call = calls[0];

    assert.deepEqual(response, { id: 25764674, status: "APPROVED" });
    assert.ok(call);
    assert.equal(String(call.input), "https://api.helcim.com/v2/card-transactions/25764674");
    assert.equal(call.init?.method, "GET");
    assert.equal(call.init?.cache, "no-store");

    const headers = new Headers(call.init?.headers);
    assert.equal(headers.get("api-token"), "test-helcim-token");
    assert.equal(headers.get("accept"), "application/json");
    assert.equal(headers.has("content-type"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
  })();
`;

test("getHelcimCardTransaction calls the official card transaction endpoint with api-token", () => {
  const env = { ...process.env };

  env.NEXT_PUBLIC_SANITY_DATASET = "test";
  env.NEXT_PUBLIC_SANITY_PROJECT_ID = "test-project";
  env.HELCIM_API_TOKEN = "test-helcim-token";

  execFileSync(
    "./node_modules/.bin/tsx",
    ["--conditions=react-server", "--eval", helperScript],
    {
      cwd: process.cwd(),
      env,
      stdio: "pipe",
    },
  );
});
