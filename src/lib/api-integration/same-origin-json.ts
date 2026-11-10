import "server-only";

import { IntegrationServiceError } from "./service-errors";
import { hasConfiguredRequestOrigin } from "./request-origin";

/** Browser mutations require a protected origin and a header that cross-origin
 * forms cannot send. Never infer trust from an arbitrary Host/Forwarded header. */
export async function readSameOriginJson(request: Request, configuredOrigin: string | undefined, maximumBytes = 1_048_576): Promise<unknown> {
  let expected: URL;
  try { expected = new URL(configuredOrigin ?? ""); } catch { throw new IntegrationServiceError("forbidden", 403); }
  if (!hasConfiguredRequestOrigin(request, configuredOrigin) || request.headers.get("origin") !== expected.origin ||
      request.headers.get("x-lash-csrf") !== "1" || request.headers.get("sec-fetch-site") && request.headers.get("sec-fetch-site") !== "same-origin") throw new IntegrationServiceError("forbidden", 403);
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") throw new IntegrationServiceError("invalid_request", 415);
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && (!/^[0-9]+$/u.test(declaredLength) || Number(declaredLength) > maximumBytes)) throw new IntegrationServiceError("invalid_request", 413);
  const reader = request.body?.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    if (reader) while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximumBytes) { await reader.cancel(); throw new IntegrationServiceError("invalid_request", 413); }
      chunks.push(chunk.value);
    }
  } finally { reader?.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new IntegrationServiceError("invalid_request", 400); }
}
