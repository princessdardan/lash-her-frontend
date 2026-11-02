import "server-only";

import { getGatewayTransport, GatewayTransportError } from "@/lib/api-integration/gateway-transport";
import { parseCourseResponse } from "@/lib/api-integration/response-validation";

export async function runGatewaySmoke(transport = getGatewayTransport()) {
  const started = performance.now();
  const response = await transport({ method: "GET", path: "/v1/courses" });
  if (response.status !== 200) throw new GatewayTransportError("unavailable");
  parseCourseResponse("/v1/courses", "get", 200, await response.json());
  return { ok: true, service: "course", durationMs: Math.round(performance.now() - started) } as const;
}
