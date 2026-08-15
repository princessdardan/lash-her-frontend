import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  __resetModuleLocalSdkForTests,
  getTelemetrySdk,
  isSensitiveCustomerBearerRequest,
  isSignedChitChatsLabelRequest,
  resetTelemetrySDKForTests,
  shutdownTelemetry,
  startNodeTelemetry,
} from "./instrumentation";

test("customer bearer links are excluded only when sensitive routes carry tokens", () => {
  for (const path of [
    "/orders/address-change",
    "/orders/payment-offer",
    "/orders/payment-offer/exchange",
    "/orders/shipping-decision",
  ]) {
    assert.equal(
      isSensitiveCustomerBearerRequest({
        url: `${path}?token=do-not-export`,
      }),
      true,
    );
    assert.equal(isSensitiveCustomerBearerRequest({ url: path }), false);
  }
  assert.equal(
    isSensitiveCustomerBearerRequest({
      url: "/products?token=ordinary-filter",
    }),
    false,
  );
});

test("signed Chit Chats labels are excluded from Undici spans", () => {
  assert.equal(
    isSignedChitChatsLabelRequest({
      origin: "https://staging.chitchats.com",
      path: "/labels/shipments/abc.pdf?auth_token=do-not-export",
    }),
    true,
  );
  assert.equal(
    isSignedChitChatsLabelRequest({
      origin: "https://example.com",
      path: "/labels/shipments/abc.pdf?auth_token=secret",
    }),
    false,
  );
});

const signedLabelInstrumentationScript = String.raw`
  import assert from "node:assert/strict";
  import { channel } from "node:diagnostics_channel";
  import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
  import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
  import { isSignedChitChatsLabelRequest } from "./src/lib/telemetry/instrumentation.ts";

  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const instrumentation = new UndiciInstrumentation({
    ignoreRequestHook: isSignedChitChatsLabelRequest,
  });
  instrumentation.setTracerProvider(provider);

  const secret = "instrumentation-secret-must-not-be-exported";
  const publishCompletedRequest = (path) => {
    const request = {
      origin: "https://staging.chitchats.com",
      method: "GET",
      path,
      headers: [],
      addHeader(name, value) { this.headers.push(name, value); },
      throwOnError: false,
      completed: false,
      aborted: false,
      idempotent: true,
      contentLength: null,
      contentType: null,
      body: null,
    };
    channel("undici:request:create").publish({ request });
    channel("undici:client:sendHeaders").publish({
      request,
      socket: { remoteAddress: "127.0.0.1", remotePort: 443 },
    });
    channel("undici:request:headers").publish({
      request,
      response: { headers: [], statusCode: 200, statusText: "OK" },
    });
    channel("undici:request:trailers").publish({ request, trailers: [] });
  };

  try {
    publishCompletedRequest(
      "/labels/shipments/shipment-1.pdf?auth_token=" + secret,
    );
    publishCompletedRequest("/api/v1/health");
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 1, "the ordinary request proves Undici instrumentation emitted spans");
    const serialized = JSON.stringify(
      spans.map((span) => ({
        attributes: span.attributes,
        events: span.events,
        links: span.links,
        name: span.name,
        status: span.status,
      })),
    );
    assert.doesNotMatch(serialized, /auth_token/i);
    assert.doesNotMatch(serialized, /instrumentation-secret-must-not-be-exported/);
    assert.equal(serialized.includes("labels/shipments/shipment-1"), false);
  } finally {
    instrumentation.disable();
    await provider.shutdown();
  }
`;

test("Undici instrumentation exports no span or signed URL for Chit Chats label requests", () => {
  const result = runTsx(signedLabelInstrumentationScript, process.env);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
});

const inboundBearerInstrumentationScript = String.raw`
  import assert from "node:assert/strict";
  import { createRequire } from "node:module";
  import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
  import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
  import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
  import { isSensitiveCustomerBearerRequest } from "./src/lib/telemetry/instrumentation.ts";

  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();
  const instrumentation = new HttpInstrumentation({
    ignoreIncomingRequestHook: isSensitiveCustomerBearerRequest,
    ignoreOutgoingRequestHook: () => true,
  });
  instrumentation.setTracerProvider(provider);
  instrumentation.enable();
  // HTTP instrumentation patches the module when it is loaded. Keep this
  // CommonJS load after enable() so the ordinary request is a valid positive
  // control for the sensitive-route suppression assertion below.
  const require = createRequire(import.meta.url);
  const http = require("node:http");
  const server = http.createServer((_request, response) => {
    response.writeHead(204);
    response.end();
  });

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const requestPath = (path) => new Promise((resolve, reject) => {
      const request = http.get(
        { host: "127.0.0.1", port: address.port, path },
        (response) => {
          response.resume();
          response.once("end", resolve);
        },
      );
      request.once("error", reject);
    });
    const secret = "inbound-customer-bearer-must-not-be-exported";
    await requestPath("/orders/payment-offer/exchange?token=" + secret);
    await requestPath("/health");
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 1, "ordinary inbound traffic proves HTTP server spans were exported");
    const serialized = JSON.stringify(
      spans.map((span) => ({
        attributes: span.attributes,
        events: span.events,
        name: span.name,
      })),
    );
    assert.doesNotMatch(serialized, /token/i);
    assert.doesNotMatch(serialized, /inbound-customer-bearer-must-not-be-exported/);
  } finally {
    instrumentation.disable();
    await new Promise((resolve) => server.close(resolve));
    await provider.shutdown();
  }
`;

test("HTTP instrumentation exports no server span for inbound customer bearer links", (context) => {
  const result = runTsx(inboundBearerInstrumentationScript, process.env);
  if (/listen EPERM/.test(result.stderr)) {
    context.skip(
      "Local sandbox forbids the loopback server used by this instrumentation test",
    );
    return;
  }
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
});

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
    process.execPath,
    [
      "--conditions=react-server",
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      script,
    ],
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
