import { createReleaseProbeHandler, readReleaseProbeConfiguration } from "./handler";
import { runGatewaySmoke } from "@/lib/api-integration/gateway-smoke";
import { runPhase2GatewaySmoke } from "@/lib/api-integration/phase2-gateway-smoke";
import { createGatewayTransport } from "@/lib/api-integration/gateway-transport";
import { runFrontendBootstrapProbe } from "@/lib/writer-admission/bootstrap-probe";
import { runFrontendSquareBindingProbe } from "@/lib/writer-admission/square-binding-probe";
import { runFrontendResendBindingProbe } from "@/lib/writer-admission/resend-binding-probe";
import { runFrontendGoogleBindingProbe } from "@/lib/writer-admission/google-binding-probe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

export const GET = createReleaseProbeHandler({
  configuration: () => readReleaseProbeConfiguration(process.env),
  run: (origin) => runGatewaySmoke(createGatewayTransport({ origin })),
  phase2: (origin) => runPhase2GatewaySmoke(createGatewayTransport({ origin })),
  admission: runFrontendBootstrapProbe,
  resend: runFrontendResendBindingProbe,
  square: runFrontendSquareBindingProbe,
  google: runFrontendGoogleBindingProbe,
});

// Framework-generated HEAD would otherwise execute the upstream GET probe.
export function HEAD() {
  return new Response(null, { status: 405, headers: { allow: "GET", "cache-control": "no-store" } });
}
