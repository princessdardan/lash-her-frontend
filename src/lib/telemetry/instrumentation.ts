import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

const SDK_SYMBOL = Symbol.for("lash-her.telemetry.sdk");

let sdkInstance: NodeSDK | undefined;

function getGlobalSdk(): NodeSDK | undefined {
  return (globalThis as Record<symbol, unknown>)[SDK_SYMBOL] as
    | NodeSDK
    | undefined;
}

function setGlobalSdk(sdk: NodeSDK | undefined): void {
  if (sdk === undefined) {
    delete (globalThis as Record<symbol, unknown>)[SDK_SYMBOL];
  } else {
    (globalThis as Record<symbol, unknown>)[SDK_SYMBOL] = sdk;
  }
}

/**
 * Start the OpenTelemetry Node SDK for trace export.
 *
 * Idempotent: safe to call multiple times; subsequent calls are no-ops.
 * Survives HMR via globalThis sentinel.
 * Gated: only starts when OTEL_EXPORTER_OTLP_ENDPOINT is present.
 * Service name falls back to "lash-her-frontend".
 *
 * No request-body or payment-payload capture is configured manually;
 * auto-instrumentations cover HTTP/DB/framework spans without attaching
 * bodies by default.
 */
export function startNodeTelemetry(): NodeSDK | undefined {
  // Prefer global sentinel so idempotency survives Next.js HMR.
  const globalSdk = getGlobalSdk();
  if (globalSdk) {
    sdkInstance = globalSdk;
    return sdkInstance;
  }

  if (sdkInstance) {
    return sdkInstance;
  }

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) {
    return undefined;
  }

  const serviceName = process.env.OTEL_SERVICE_NAME ?? "lash-her-frontend";

  const traceExporter = new OTLPTraceExporter({
    url: endpoint,
  });

  const sdk = new NodeSDK({
    traceExporter,
    instrumentations: [
      getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-http": {
          ignoreIncomingRequestHook: (request) =>
            isSensitiveCustomerBearerRequest(request),
        },
        "@opentelemetry/instrumentation-undici": {
          ignoreRequestHook: (request) =>
            isSignedChitChatsLabelRequest(request),
        },
      }),
    ],
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
    }),
  });

  sdk.start();
  sdkInstance = sdk;
  setGlobalSdk(sdk);

  return sdk;
}

const SENSITIVE_CUSTOMER_BEARER_PATHS = new Set([
  "/orders/address-change",
  "/orders/payment-offer",
  "/orders/payment-offer/exchange",
  "/orders/shipping-decision",
]);

export function isSensitiveCustomerBearerRequest(request: {
  url?: string;
}): boolean {
  try {
    const url = new URL(request.url ?? "", "https://internal.invalid");
    return (
      SENSITIVE_CUSTOMER_BEARER_PATHS.has(url.pathname) &&
      url.searchParams.has("token")
    );
  } catch {
    return false;
  }
}

export function isSignedChitChatsLabelRequest(request: {
  origin?: string;
  path?: string;
}): boolean {
  try {
    const url = new URL(request.path ?? "", request.origin);
    return (
      url.protocol === "https:" &&
      (url.hostname === "chitchats.com" ||
        url.hostname.endsWith(".chitchats.com")) &&
      url.pathname.startsWith("/labels/shipments/")
    );
  } catch {
    return false;
  }
}

/**
 * Return the active SDK instance, if any.
 * Primarily useful in tests.
 */
export function getTelemetrySdk(): NodeSDK | undefined {
  return getGlobalSdk() ?? sdkInstance;
}

/**
 * Shut down the active SDK instance.
 * Primarily useful in tests to reset global state.
 */
export async function shutdownTelemetry(): Promise<void> {
  const sdk = sdkInstance ?? getGlobalSdk();
  if (sdk) {
    await sdk.shutdown();
  }
  sdkInstance = undefined;
  setGlobalSdk(undefined);
}

/**
 * Reset telemetry SDK state for tests without shutting down.
 * Clears both the module-local reference and the global sentinel.
 */
export function resetTelemetrySDKForTests(): void {
  sdkInstance = undefined;
  setGlobalSdk(undefined);
}

/**
 * Reset only the module-local SDK reference.
 * Used to simulate HMR where the module is re-evaluated
 * but globalThis persists.
 * @internal For testing only.
 */
export function __resetModuleLocalSdkForTests(): void {
  sdkInstance = undefined;
}
