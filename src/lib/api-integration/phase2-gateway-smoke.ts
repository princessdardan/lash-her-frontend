import "server-only";

import { getGatewayTransport, GatewayTransportError } from "./gateway-transport";
import { validateCandidateResponse } from "./candidate-validation";

/** Current P2 catalog probe. Historical P1 validation remains in gateway-smoke. */
export async function runPhase2GatewaySmoke(transport = getGatewayTransport()) {
  const started = performance.now();
  const response = await transport({ method: "GET", path: "/v1/courses" });
  if (response.status !== 200 || response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new GatewayTransportError("unavailable");
  }
  validateCandidateResponse("course", "/v1/courses", "get", 200, await response.json());
  return { ok: true, service: "course", durationMs: Math.round(performance.now() - started) } as const;
}
