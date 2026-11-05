import "server-only";

import { parseBoundary } from "./boundary-validation";
import type { components } from "./generated/boundaries";
import { getGatewayTransport, type GatewayRequest } from "./gateway-transport";
import { validateCandidateRequest, validateCandidateResponse, type CandidateSuccess } from "./candidate-validation";
import { IntegrationServiceError, parseGatewayFailure, upstreamIntegrationError } from "./service-errors";
import { markWriterOperationUncertain } from "@/lib/writer-admission/context";
import { runWriterAdmission, type WriterAdmissionRunner } from "@/lib/writer-admission/runtime";

export type AccountLifecycleCommand = components["schemas"]["AccountLifecycleCommand"];
export type AccountLifecycleReceipt = components["schemas"]["AccountLifecycleReceipt"];
export type LifecycleReceiver = "course" | "community";
export type LifecycleReceiverCode = "account_version_conflict" | "idempotency_conflict" | "account_deleted" | "unavailable" | "rejected";

export class LifecycleDeliveryError extends IntegrationServiceError {
  constructor(status: number, readonly receiverCode: LifecycleReceiverCode, requestId?: string | null, retryAfter?: string) {
    const retryable = status >= 500 || status === 429 || receiverCode === "account_version_conflict";
    super(retryable ? "service_unavailable" : status === 409 ? "conflict" : "forbidden", status >= 500 ? 503 : status, requestId, retryAfter);
    this.name = "LifecycleDeliveryError";
  }
  get retryable(): boolean { return this.status >= 500 || this.status === 429 || this.receiverCode === "account_version_conflict"; }
}

/** Service-only delivery. The caller supplies its dedicated lifecycle issuer,
 * never a browser bearer or learner/admin token. No browser handler exposes it. */
type ReceiverExport<R extends LifecycleReceiver> = CandidateSuccess<R, "/v1/internal/accounts/exports/{commandId}", "get">;

export function createAccountLifecycleClient<R extends LifecycleReceiver>(dependencies: {
  receiver: R;
  mintServiceToken: () => string | Promise<string>;
  getTransport?: () => (request: GatewayRequest) => Promise<Response>;
  run?: WriterAdmissionRunner;
  now?: () => number;
}) {
  const getTransport = dependencies.getTransport ?? getGatewayTransport;
  const run = dependencies.run ?? runWriterAdmission;
  const receiver = dependencies.receiver;
  if (receiver !== "course" && receiver !== "community") throw new IntegrationServiceError("invalid_request", 400);
  return {
    async deliverCommand(input: AccountLifecycleCommand): Promise<AccountLifecycleReceipt> {
      const command = parseBoundary("AccountLifecycleCommand", input);
      const outcome = await run("recovery", async () => {
        let started = false;
        try {
          const token = await dependencies.mintServiceToken(), transport = getTransport();
          started = true;
          const response = await transport({ service: receiver, method: "POST", path: "/v1/internal/accounts/commands", applicationToken: token,
            idempotencyKey: command.commandId, body: JSON.stringify(command) });
          if (response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") throw new Error("INVALID_INTEGRATION_RESPONSE");
          const value: unknown = await response.json();
          const gatewayFailure = parseGatewayFailure(response, value);
          if (gatewayFailure) {
            if (gatewayFailure.uncertain) markWriterOperationUncertain();
            return { failure: new LifecycleDeliveryError(gatewayFailure.failure.status, "unavailable", gatewayFailure.failure.requestId, gatewayFailure.failure.retryAfter) };
          }
          validateCandidateResponse(receiver, "/v1/internal/accounts/commands", "post", response.status, value);
          if (response.status === 200) {
            const receipt = parseBoundary("AccountLifecycleReceipt", value);
            if (receipt.commandId !== command.commandId || receipt.accountVersion !== command.accountVersion) throw new Error("RECEIPT_MISMATCH");
            return { receipt };
          }
          if (![400, 401, 403, 409, 413, 415, 429, 500].includes(response.status)) throw new Error("UNDOCUMENTED_RESPONSE");
          const rawCode = value && typeof value === "object" && "error" in value && value.error && typeof value.error === "object" && "code" in value.error && typeof value.error.code === "string" ? value.error.code.toLowerCase() : "";
          const code: LifecycleReceiverCode = rawCode === "account_version_conflict" || rawCode === "idempotency_conflict" || rawCode === "account_deleted" ? rawCode : response.status >= 500 || response.status === 429 ? "unavailable" : "rejected";
          if (response.status >= 500) markWriterOperationUncertain();
          return { failure: new LifecycleDeliveryError(response.status, code, response.headers.get("x-request-id"), response.headers.get("retry-after") ?? undefined) };
        } catch {
          if (started) markWriterOperationUncertain();
          return { failure: new LifecycleDeliveryError(503, "unavailable") };
        }
      });
      if ("failure" in outcome) throw outcome.failure;
      return outcome.receipt;
    },
    async getExport(input: AccountLifecycleCommand): Promise<ReceiverExport<R>> {
      const command = parseBoundary("AccountLifecycleCommand", input);
      if (command.action !== "export") throw new IntegrationServiceError("invalid_request", 400);
      const { commandId } = command;
      validateCandidateRequest(receiver, "/v1/internal/accounts/exports/{commandId}", "get", { params: { commandId } });
      try {
        const response = await getTransport()({ service: receiver, method: "GET", path: `/v1/internal/accounts/exports/${commandId}`, applicationToken: await dependencies.mintServiceToken() });
        if (response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") throw new Error("INVALID_INTEGRATION_RESPONSE");
        const value: unknown = await response.json();
        const gatewayFailure = parseGatewayFailure(response, value);
        if (gatewayFailure) throw gatewayFailure.failure;
        validateCandidateResponse(receiver, "/v1/internal/accounts/exports/{commandId}", "get", response.status, value);
        if (response.status === 401) throw new IntegrationServiceError("service_unavailable", 503, response.headers.get("x-request-id"));
        if (response.status !== 200) throw upstreamIntegrationError(response.status, "", response.headers.get("x-request-id"), response.headers.get("retry-after"));
        const result = value as ReceiverExport<"course"> | ReceiverExport<"community">;
        if (result.commandId !== commandId || result.userId !== command.userId || result.accountVersion !== command.accountVersion) throw new Error("EXPORT_MISMATCH");
        const expires = Date.parse(result.expiresAt), now = (dependencies.now ?? Date.now)();
        if (expires <= now) throw new IntegrationServiceError("not_found", 404);
        if (expires > now + 86_400_000) throw new Error("EXPORT_EXPIRY_MISMATCH");
        return result as ReceiverExport<R>;
      } catch (error) { if (error instanceof IntegrationServiceError) throw error; throw new IntegrationServiceError("service_unavailable", 503); }
    },
  };
}
