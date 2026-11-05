import "server-only";

import { randomUUID } from "node:crypto";

export type IntegrationErrorCode = "invalid_request" | "sign_in_required" | "forbidden" | "not_found" | "access_required" | "access_revoked" | "conflict" | "rate_limited" | "feature_disabled" | "service_unavailable";
const messages: Record<IntegrationErrorCode, string> = {
  invalid_request: "The request is invalid.", sign_in_required: "Sign in to continue.", forbidden: "This operation is not permitted.",
  not_found: "This resource is unavailable.", access_required: "Course access is required.", access_revoked: "Course access has been revoked.",
  conflict: "This operation conflicts with the current state. Refresh and try again.", rate_limited: "Please wait before trying again.",
  feature_disabled: "This feature is unavailable.", service_unavailable: "The service is temporarily unavailable.",
};
export function safeIntegrationRequestId(value?: string | null): string {
  return value && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value) ? value : randomUUID();
}
export class IntegrationServiceError extends Error {
  readonly requestId: string;
  readonly retryAfter?: string;
  constructor(readonly code: IntegrationErrorCode, readonly status: number, requestId?: string | null, retryAfter?: string) {
    super(messages[code]); this.name = "IntegrationServiceError"; this.requestId = safeIntegrationRequestId(requestId);
    this.retryAfter = retryAfter && /^[0-9]{1,5}$/u.test(retryAfter) ? retryAfter : status === 503 ? "30" : undefined;
  }
}
export function upstreamIntegrationError(status: number, upstreamCode: string, requestId: string | null, retryAfter: string | null): IntegrationServiceError {
  const code: IntegrationErrorCode = upstreamCode === "ENTITLEMENT_REVOKED" ? "access_revoked" : upstreamCode === "ACTIVE_ENROLLMENT_REQUIRED" ? "access_required" :
    status === 400 || status === 413 || status === 415 ? "invalid_request" : status === 401 ? "sign_in_required" : status === 403 ? "forbidden" :
      status === 404 ? "not_found" : status === 409 ? "conflict" : status === 429 ? "rate_limited" : "service_unavailable";
  return new IntegrationServiceError(code, status >= 500 ? 503 : status, requestId, retryAfter && /^[0-9]{1,5}$/u.test(retryAfter) ? retryAfter : undefined);
}

/** Only the gateway's closed, fixed-message envelope is distinct from a pinned
 * receiver response. Its request UUID must match the protected response header. */
export function parseGatewayFailure(response: Response, value: unknown): { failure: IntegrationServiceError; uncertain: boolean } | null {
  if (!value || typeof value !== "object" || Object.keys(value).sort().join(",") !== "error,requestId" ||
    !("requestId" in value) || value.requestId !== response.headers.get("x-request-id") || typeof value.requestId !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value.requestId) || !("error" in value) || !value.error || typeof value.error !== "object" ||
    Object.keys(value.error).sort().join(",") !== "code,message" || !("code" in value.error) || typeof value.error.code !== "string" || !("message" in value.error)) return null;
  const statuses: Record<string, number[]> = { unavailable: [503], ambiguous_headers: [400], invalid_host: [421], route_not_allowed: [404],
    upstream_unavailable: [502, 503], rate_limit_exceeded: [429], invalid_workload: [401], application_authorization_required: [401],
    release_maintenance: [503], body_too_large: [413], body_not_allowed: [400], upstream_redirect_refused: [502] };
  const code = value.error.code;
  if (!Object.hasOwn(statuses, code) || !statuses[code].includes(response.status) || value.error.message !== code.replaceAll("_", " ")) return null;
  return { failure: code === "rate_limit_exceeded" ? upstreamIntegrationError(429, "", value.requestId, response.headers.get("retry-after")) :
    new IntegrationServiceError(code === "body_too_large" ? "invalid_request" : "service_unavailable", code === "body_too_large" ? 413 : 503, value.requestId, response.headers.get("retry-after") ?? undefined),
    uncertain: response.status === 502 };
}
export function integrationErrorResponse(error: unknown): Response {
  const failure = error instanceof IntegrationServiceError ? error : new IntegrationServiceError("service_unavailable", 503);
  return Response.json({ error: { code: failure.code, message: failure.message }, requestId: failure.requestId }, {
    status: failure.status, headers: { "cache-control": "private, no-store", "x-request-id": failure.requestId, ...(failure.retryAfter ? { "retry-after": failure.retryAfter } : {}) },
  });
}
