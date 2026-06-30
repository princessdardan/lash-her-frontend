import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const disabledRouteScript = String.raw`
  import assert from "node:assert/strict";

  import { GET } from "./src/app/api/booking/square/config/route.ts";

  (async () => {
    const response = await GET(new Request("http://localhost:3000/api/booking/square/config"));

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: "Square card-on-file booking is not enabled",
    });
  })().catch((error) => {
    console.error(error);
    process.exit(1);
  });
`;

const enabledSandboxRouteScript = String.raw`
  import assert from "node:assert/strict";

  import { GET } from "./src/app/api/booking/square/config/route.ts";

  (async () => {
    const response = await GET(new Request("http://localhost:3000/api/booking/square/config"));

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body, {
      applicationId: "sandbox-sq0idb-test",
      environment: "sandbox",
      locationId: "LOC123",
      scriptUrl: "https://sandbox.web.squarecdn.com/v1/square.js",
    });
    const bodyText = JSON.stringify(body);
    assert.ok(!bodyText.includes("secret-access-token"));
    assert.ok(!bodyText.includes("secret-webhook-key"));
  })().catch((error) => {
    console.error(error);
    process.exit(1);
  });
`;

const enabledProductionRouteScript = String.raw`
  import assert from "node:assert/strict";

  import { GET } from "./src/app/api/booking/square/config/route.ts";

  (async () => {
    const response = await GET(new Request("http://localhost:3000/api/booking/square/config"));

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body, {
      applicationId: "sq0idp-test",
      environment: "production",
      locationId: "LOC456",
      scriptUrl: "https://web.squarecdn.com/v1/square.js",
    });
  })().catch((error) => {
    console.error(error);
    process.exit(1);
  });
`;

const factoryScript = String.raw`
  import assert from "node:assert/strict";

  import { createSquareConfigGetHandler } from "./src/app/api/booking/square/config/route.ts";

  (async () => {
    const handler = createSquareConfigGetHandler({
      getConfig: () => ({
        applicationId: "sandbox-sq0idb-factory",
        environment: "sandbox",
        locationId: "LOC-FACTORY",
      }),
    });

    const response = await handler(new Request("http://localhost:3000/api/booking/square/config"));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      applicationId: "sandbox-sq0idb-factory",
      environment: "sandbox",
      locationId: "LOC-FACTORY",
      scriptUrl: "https://sandbox.web.squarecdn.com/v1/square.js",
    });
  })().catch((error) => {
    console.error(error);
    process.exit(1);
  });
`;

const factoryDisabledScript = String.raw`
  import assert from "node:assert/strict";

  import { createSquareConfigGetHandler } from "./src/app/api/booking/square/config/route.ts";

  (async () => {
    const handler = createSquareConfigGetHandler({
      getConfig: () => null,
    });

    const response = await handler(new Request("http://localhost:3000/api/booking/square/config"));

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: "Square card-on-file booking is not enabled",
    });
  })().catch((error) => {
    console.error(error);
    process.exit(1);
  });
`;

test("square config route returns 404 when card-on-file is disabled", () => {
  const env = { ...process.env };

  delete env.SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED;
  delete env.SQUARE_ENVIRONMENT;
  delete env.SQUARE_APPLICATION_ID;
  delete env.SQUARE_LOCATION_ID;
  delete env.SQUARE_ACCESS_TOKEN;
  delete env.SQUARE_WEBHOOK_SIGNATURE_KEY;

  const result = runTsx(disabledRouteScript, env);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("square config route returns public sandbox config when enabled", () => {
  const env = { ...process.env };

  env.SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED = "true";
  env.SERVICE_BOOKING_SQUARE_ENABLED = "true";
  env.SQUARE_ENVIRONMENT = "sandbox";
  env.SQUARE_APPLICATION_ID = "sandbox-sq0idb-test";
  env.SQUARE_LOCATION_ID = "LOC123";
  env.SQUARE_ACCESS_TOKEN = "secret-access-token";
  env.SQUARE_WEBHOOK_SIGNATURE_KEY = "secret-webhook-key";
  env.SQUARE_SERVICE_BOOKING_RETURN_URL =
    "https://lashher.example/api/booking/square/return";
  env.SQUARE_SERVICE_BOOKING_WEBHOOK_URL =
    "https://lashher.example/api/webhooks/square";
  env.DATABASE_URL = "postgres://neon-pooled-url";

  const result = runTsx(enabledSandboxRouteScript, env);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("square config route returns production script url in production", () => {
  const env = { ...process.env };

  env.SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED = "true";
  env.SERVICE_BOOKING_SQUARE_ENABLED = "true";
  env.SQUARE_ENVIRONMENT = "production";
  env.SQUARE_APPLICATION_ID = "sq0idp-test";
  env.SQUARE_LOCATION_ID = "LOC456";
  env.SQUARE_ACCESS_TOKEN = "secret-access-token";
  env.SQUARE_WEBHOOK_SIGNATURE_KEY = "secret-webhook-key";
  env.SQUARE_SERVICE_BOOKING_RETURN_URL =
    "https://lashher.example/api/booking/square/return";
  env.SQUARE_SERVICE_BOOKING_WEBHOOK_URL =
    "https://lashher.example/api/webhooks/square";
  env.DATABASE_URL = "postgres://neon-pooled-url";

  const result = runTsx(enabledProductionRouteScript, env);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("square config handler factory builds JSON from injected config", () => {
  const env = { ...process.env };

  const result = runTsx(factoryScript, env);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("square config handler factory returns 404 for null injected config", () => {
  const env = { ...process.env };

  const result = runTsx(factoryDisabledScript, env);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

function runTsx(
  script: string,
  env: NodeJS.ProcessEnv,
): {
  status: number | null;
  stdout: string;
  stderr: string;
  combinedOutput: string;
} {
  const result = spawnSync(
    "./node_modules/.bin/tsx",
    ["--conditions=react-server", "--eval", script],
    {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
      stdio: "pipe",
    },
  );

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    combinedOutput: `${result.stdout}${result.stderr}`,
  };
}
