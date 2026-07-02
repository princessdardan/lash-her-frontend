import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  __resetModuleLocalSdkForTests,
  getTelemetrySdk,
  resetTelemetrySDKForTests,
  shutdownTelemetry,
  startNodeTelemetry,
} from "./instrumentation";

// Shared cleanup helper for same-process tests
test.afterEach(async () => {
  await shutdownTelemetry();
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  delete process.env.OTEL_SERVICE_NAME;
});

test("startNodeTelemetry returns undefined when OTEL_EXPORTER_OTLP_ENDPOINT is absent", () => {
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  const result = startNodeTelemetry();

  assert.equal(result, undefined);
  assert.equal(getTelemetrySdk(), undefined);
});

test("startNodeTelemetry starts SDK when endpoint is present", () => {
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318/v1/traces";

  const result = startNodeTelemetry();

  assert.notEqual(result, undefined);
  assert.equal(getTelemetrySdk(), result);
});

test("startNodeTelemetry is idempotent", () => {
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318/v1/traces";

  const first = startNodeTelemetry();
  const second = startNodeTelemetry();
  const third = startNodeTelemetry();

  assert.notEqual(first, undefined);
  assert.equal(second, first);
  assert.equal(third, first);
});

test("startNodeTelemetry reuses global sentinel after module-local reset (HMR survival)", () => {
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318/v1/traces";

  const first = startNodeTelemetry();
  assert.notEqual(first, undefined);

  // Simulate HMR: module re-evaluated, local state lost,
  // but globalThis sentinel persists.
  __resetModuleLocalSdkForTests();
  assert.equal(getTelemetrySdk(), first);

  const second = startNodeTelemetry();
  assert.equal(
    second,
    first,
    "should reuse existing SDK, not create a new one",
  );
});

test("shutdownTelemetry resets sdkInstance and global sentinel", async () => {
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318/v1/traces";

  startNodeTelemetry();
  assert.notEqual(getTelemetrySdk(), undefined);

  await shutdownTelemetry();
  assert.equal(getTelemetrySdk(), undefined);
});

test("shutdownTelemetry is safe when sdkInstance is absent", async () => {
  assert.equal(getTelemetrySdk(), undefined);

  await shutdownTelemetry();

  assert.equal(getTelemetrySdk(), undefined);
});

test("resetTelemetrySDKForTests clears state without shutting down", () => {
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318/v1/traces";

  startNodeTelemetry();
  assert.notEqual(getTelemetrySdk(), undefined);

  resetTelemetrySDKForTests();
  assert.equal(getTelemetrySdk(), undefined);
});

// Child-process tests for env-dependent config behaviour

const serviceNameFallbackScript = String.raw`
  import assert from "node:assert/strict";
  import { startNodeTelemetry, getTelemetrySdk, shutdownTelemetry } from "./src/lib/telemetry/instrumentation.ts";

  (async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318/v1/traces";
    delete process.env.OTEL_SERVICE_NAME;

    startNodeTelemetry();

    const sdk = getTelemetrySdk();
    assert.notEqual(sdk, undefined, "SDK should start with endpoint configured");

    await shutdownTelemetry();
  })();
`;

const customServiceNameScript = String.raw`
  import assert from "node:assert/strict";
  import { startNodeTelemetry, getTelemetrySdk, shutdownTelemetry } from "./src/lib/telemetry/instrumentation.ts";

  (async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318/v1/traces";
    process.env.OTEL_SERVICE_NAME = "lash-her-staging";

    startNodeTelemetry();

    const sdk = getTelemetrySdk();
    assert.notEqual(sdk, undefined, "SDK should start with endpoint configured");

    await shutdownTelemetry();
  })();
`;

const noEndpointNoStartScript = String.raw`
  import assert from "node:assert/strict";
  import { startNodeTelemetry, getTelemetrySdk } from "./src/lib/telemetry/instrumentation.ts";

  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  const result = startNodeTelemetry();

  assert.equal(result, undefined);
  assert.equal(getTelemetrySdk(), undefined);
`;

const hmrSurvivalScript = String.raw`
  import assert from "node:assert/strict";
  import { startNodeTelemetry, getTelemetrySdk, shutdownTelemetry, __resetModuleLocalSdkForTests } from "./src/lib/telemetry/instrumentation.ts";

  (async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318/v1/traces";

    const first = startNodeTelemetry();
    assert.notEqual(first, undefined, "SDK should start");

    // Simulate HMR: clear module-local state via the test helper,
    // leaving globalThis sentinel intact.
    __resetModuleLocalSdkForTests();

    const second = startNodeTelemetry();
    assert.equal(second, first, "HMR: should reuse global sentinel, not create new SDK");

    await shutdownTelemetry();
  })();
`;

test("SDK starts in child process when endpoint is configured", () => {
  const env = { ...process.env };
  env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318/v1/traces";

  const result = runTsx(serviceNameFallbackScript, env);

  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
});

test("SDK accepts custom OTEL_SERVICE_NAME in child process", () => {
  const env = { ...process.env };
  env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318/v1/traces";
  env.OTEL_SERVICE_NAME = "lash-her-staging";

  const result = runTsx(customServiceNameScript, env);

  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
});

test("SDK does not start in child process when endpoint is absent", () => {
  const env = { ...process.env };
  delete env.OTEL_EXPORTER_OTLP_ENDPOINT;

  const result = runTsx(noEndpointNoStartScript, env);

  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
});

test("HMR survival in child process: global sentinel prevents duplicate SDK", () => {
  const env = { ...process.env };
  env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318/v1/traces";

  const result = runTsx(hmrSurvivalScript, env);

  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
});

function runTsx(
  script: string,
  env: NodeJS.ProcessEnv,
): {
  status: number | null;
  stdout: string;
  stderr: string;
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
  };
}
