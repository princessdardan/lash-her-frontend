/**
 * Next.js instrumentation hook (runs once at server startup).
 *
 * Dynamically imports the Node telemetry helper only when:
 * 1. Running in the Node.js runtime (not Edge)
 * 2. OTEL_EXPORTER_OTLP_ENDPOINT is configured
 *
 * This keeps heavy NodeSDK packages out of Edge/client bundles.
 */
export async function register(): Promise<void> {
  // Next's Edge compiler removes the positive runtime branch before resolving
  // NodeSDK dependencies. An early return still lets Webpack traverse them.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return;
    const { startNodeTelemetry } =
      await import("@/lib/telemetry/instrumentation");
    startNodeTelemetry();
  }
}
