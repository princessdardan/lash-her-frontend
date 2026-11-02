import { createSchedulerProbeHandler, readSchedulerProbeConfiguration } from "./handler";
import { runGatewaySmoke } from "@/lib/api-integration/gateway-smoke";
import { createGatewayTransport } from "@/lib/api-integration/gateway-transport";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

export const GET = createSchedulerProbeHandler({
  configuration: () => readSchedulerProbeConfiguration(process.env),
  run: (origin) => runGatewaySmoke(createGatewayTransport({ origin })),
  record: (evidence) => console.info(JSON.stringify(evidence)),
});

export function HEAD() {
  return new Response(null, { status: 405, headers: { allow: "GET", "cache-control": "no-store" } });
}
