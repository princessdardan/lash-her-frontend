import { createReleaseProbeHandler, readReleaseProbeConfiguration } from "./handler";
import { runGatewaySmoke } from "@/lib/api-integration/gateway-smoke";
import { createGatewayTransport } from "@/lib/api-integration/gateway-transport";
import { runFrontendBootstrapProbe } from "@/lib/writer-admission/bootstrap-probe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

export const GET = createReleaseProbeHandler({
  configuration: () => readReleaseProbeConfiguration(process.env),
  run: (origin) => runGatewaySmoke(createGatewayTransport({ origin })),
  admission: runFrontendBootstrapProbe,
});

// Framework-generated HEAD would otherwise execute the upstream GET probe.
export function HEAD() {
  return new Response(null, { status: 405, headers: { allow: "GET", "cache-control": "no-store" } });
}
