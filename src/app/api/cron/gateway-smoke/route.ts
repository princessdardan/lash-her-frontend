import { createScheduledGatewaySmokeHandler } from "@/app/api/admin/gateway-smoke/handler";
import { runGatewaySmoke } from "@/lib/api-integration/gateway-smoke";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Not registered in vercel.json. Native scheduling stays held until the R04
// handoff, strict cancellation and release controls are independently qualified.
export const GET = createScheduledGatewaySmokeHandler({
  enabled: () => process.env.API_GATEWAY_SMOKE_ENABLED === "true",
  getSecret: () => process.env.CRON_SECRET,
  run: () => runGatewaySmoke(),
});
