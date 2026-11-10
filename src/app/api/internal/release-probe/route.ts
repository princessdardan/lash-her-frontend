import { createPhase2DayTwoWorkloadHandler, createReleaseProbeHandler, PHASE2_DAY_TWO_CANONICAL_WORKLOAD_MODE, PHASE2_DAY_TWO_WORKLOAD_MODE,
  readPhase2DayTwoWorkloadConfiguration, readReleaseProbeConfiguration } from "./handler";
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

const phase2 = (origin: string) => runPhase2GatewaySmoke(createGatewayTransport({ origin }));
const dayTwoWorkload = createPhase2DayTwoWorkloadHandler({ configuration: mode => readPhase2DayTwoWorkloadConfiguration(process.env, mode), phase2 });
const releaseProbe = createReleaseProbeHandler({
  configuration: () => readReleaseProbeConfiguration(process.env),
  run: (origin) => runGatewaySmoke(createGatewayTransport({ origin })),
  phase2,
  admission: runFrontendBootstrapProbe,
  resend: runFrontendResendBindingProbe,
  square: runFrontendSquareBindingProbe,
  google: runFrontendGoogleBindingProbe,
});

export function GET(request: Request) {
  const mode = request.headers.get("x-lash-release-mode");
  return mode === PHASE2_DAY_TWO_WORKLOAD_MODE || mode === PHASE2_DAY_TWO_CANONICAL_WORKLOAD_MODE ? dayTwoWorkload(request) : releaseProbe(request);
}

// Framework-generated HEAD would otherwise execute the upstream GET probe.
export function HEAD() {
  return new Response(null, { status: 405, headers: { allow: "GET", "cache-control": "no-store" } });
}
