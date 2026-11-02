import { requirePermission } from "@/lib/admin/auth";
import { runGatewaySmoke } from "@/lib/api-integration/gateway-smoke";
import { createAdminGatewaySmokeHandler } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = createAdminGatewaySmokeHandler({
  enabled: () => process.env.API_GATEWAY_SMOKE_ENABLED === "true",
  authorize: () => requirePermission("settings:manage"),
  run: () => runGatewaySmoke(),
});
