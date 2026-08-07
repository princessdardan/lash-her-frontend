import {
  hashEntitlementPayload,
  type EntitlementCommand,
  type GrantEntitlementCommand,
  type RevokeEntitlementCommand,
} from "./entitlement-commands";

export interface EntitlementDeliveryClient {
  grant(
    command: GrantEntitlementCommand,
    context?: { correlationId?: string },
  ): Promise<{
    grantId: string;
    userId: string;
    courseId: string;
    status: "active" | "revoked" | "expired";
    createdAt: string;
    idempotentReplay?: true;
  }>;
  revoke(
    command: RevokeEntitlementCommand,
    context?: { correlationId?: string },
  ): Promise<{
    grantId: string;
    userId: string;
    courseId: string;
    status: "active" | "revoked" | "expired";
    revokedAt: string;
    idempotentReplay?: true;
  }>;
}

export interface ClaimedEntitlementJob {
  attemptCount: number;
  commandType: "grant" | "revoke";
  courseOrderItemId: string;
  id: string;
  idempotencyKey: string;
  leaseOwner: string;
  maxAttempts: number;
  payload: EntitlementCommand;
  payloadHash: string;
  sequence: number;
}

export interface EntitlementOutboxRepository {
  claimDue(input: {
    batchSize: number;
    leaseDurationMs: number;
    now: Date;
    workerId: string;
  }): Promise<ClaimedEntitlementJob[]>;
  markCompleted(input: {
    jobId: string;
    leaseOwner: string;
    now: Date;
    returnedGrantId: string;
  }): Promise<boolean>;
  markFailed(input: {
    error: SanitizedEntitlementError;
    jobId: string;
    leaseOwner: string;
    now: Date;
  }): Promise<boolean>;
  markRetry(input: {
    error: SanitizedEntitlementError;
    jobId: string;
    leaseOwner: string;
    nextAttemptAt: Date;
    now: Date;
  }): Promise<boolean>;
  releaseClaims(input: {
    jobIds: string[];
    leaseOwner: string;
    now: Date;
  }): Promise<number>;
}

export interface EntitlementWorkerLog {
  (
    level: "info" | "warn" | "error",
    message: string,
    meta?: Record<string, unknown>,
  ): void;
}

export interface EntitlementWorkerDependencies {
  client: EntitlementDeliveryClient;
  getNow: () => Date;
  getWorkerId: () => string;
  log: EntitlementWorkerLog;
  repository: EntitlementOutboxRepository;
}

export interface EntitlementWorkerRunSummary {
  claimed: number;
  completed: number;
  failed: number;
  released: number;
  retried: number;
  stale: number;
}

export interface SanitizedEntitlementError {
  code: string;
  context: Readonly<{
    category: "auth" | "network" | "permanent" | "rate_limit" | "server";
    retryAfterMs?: number;
    status?: number;
  }>;
  message: string;
}

export class EntitlementDeliveryError extends Error {
  constructor(
    message: string,
    readonly options: {
      code?: string;
      retryAfterMs?: number;
      status?: number;
    } = {},
  ) {
    super(message);
    this.name = "EntitlementDeliveryError";
  }
}

type FailureClassification =
  | { kind: "auth" | "permanent"; error: SanitizedEntitlementError }
  | {
      kind: "retry";
      error: SanitizedEntitlementError;
      retryAfterMs?: number;
    };

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_LEASE_DURATION_MS = 60_000;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 15 * 60_000;
const MAX_ERROR_MESSAGE_LENGTH = 500;
const MAX_ERROR_CODE_LENGTH = 64;

export function createEntitlementWorker(
  dependencies: EntitlementWorkerDependencies,
): {
  run(input?: {
    batchSize?: number;
    leaseDurationMs?: number;
  }): Promise<EntitlementWorkerRunSummary>;
} {
  return {
    async run(input = {}) {
      const workerId = dependencies.getWorkerId();
      const jobs = await dependencies.repository.claimDue({
        batchSize: input.batchSize ?? DEFAULT_BATCH_SIZE,
        leaseDurationMs:
          input.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS,
        now: dependencies.getNow(),
        workerId,
      });
      const summary: EntitlementWorkerRunSummary = {
        claimed: jobs.length,
        completed: 0,
        failed: 0,
        released: 0,
        retried: 0,
        stale: 0,
      };

      for (let index = 0; index < jobs.length; index += 1) {
        const job = jobs[index];

        try {
          assertStoredCommandIntegrity(job);
          const result =
            job.commandType === "grant"
              ? await dependencies.client.grant(
                  job.payload as GrantEntitlementCommand,
                  { correlationId: job.id },
                )
              : await dependencies.client.revoke(
                  job.payload as RevokeEntitlementCommand,
                  { correlationId: job.id },
                );
          const updated = await dependencies.repository.markCompleted({
            jobId: job.id,
            leaseOwner: job.leaseOwner,
            now: dependencies.getNow(),
            returnedGrantId: result.grantId,
          });

          if (updated) {
            summary.completed += 1;
          } else {
            summary.stale += 1;
          }
        } catch (cause) {
          const classification = classifyEntitlementDeliveryFailure(cause);

          if (
            classification.kind === "retry" &&
            job.attemptCount < job.maxAttempts
          ) {
            const delayMs = calculateEntitlementRetryDelayMs(
              job.attemptCount,
              classification.retryAfterMs,
            );
            const updated = await dependencies.repository.markRetry({
              error: classification.error,
              jobId: job.id,
              leaseOwner: job.leaseOwner,
              nextAttemptAt: new Date(dependencies.getNow().getTime() + delayMs),
              now: dependencies.getNow(),
            });
            if (updated) {
              summary.retried += 1;
            } else {
              summary.stale += 1;
            }
            continue;
          }

          const updated = await dependencies.repository.markFailed({
            error: classification.error,
            jobId: job.id,
            leaseOwner: job.leaseOwner,
            now: dependencies.getNow(),
          });
          if (updated) {
            summary.failed += 1;
          } else {
            summary.stale += 1;
          }

          if (classification.kind === "auth") {
            const remainingJobIds = jobs.slice(index + 1).map((item) => item.id);
            if (remainingJobIds.length > 0) {
              summary.released += await dependencies.repository.releaseClaims({
                jobIds: remainingJobIds,
                leaseOwner: workerId,
                now: dependencies.getNow(),
              });
            }

            dependencies.log(
              "error",
              "Course entitlement delivery paused after authentication failure",
              { failed: summary.failed, released: summary.released },
            );
            break;
          }
        }
      }

      dependencies.log("info", "Course entitlement worker completed", {
        ...summary,
      });

      return summary;
    },
  };
}

export function classifyEntitlementDeliveryFailure(
  cause: unknown,
): FailureClassification {
  const status = readFiniteNumber(cause, "status");
  const retryAfterMs =
    readFiniteNumber(cause, "retryAfterMs") ??
    toMilliseconds(readFiniteNumber(cause, "retryAfter"));
  const category =
    status === 401 || status === 403
      ? "auth"
      : status === 429
        ? "rate_limit"
        : status !== undefined && status >= 500
          ? "server"
          : status !== undefined
            ? "permanent"
            : "network";
  const error = sanitizeEntitlementError(cause, {
    category,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(status !== undefined ? { status } : {}),
  });

  if (status === 401 || status === 403) {
    return { kind: "auth", error };
  }

  if (
    status === 400 ||
    status === 404 ||
    status === 409 ||
    status === 422 ||
    (status !== undefined && status >= 400 && status < 500 && status !== 429)
  ) {
    return { kind: "permanent", error };
  }

  return {
    kind: "retry",
    error,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

export function calculateEntitlementRetryDelayMs(
  attemptCount: number,
  retryAfterMs?: number,
): number {
  const exponential = Math.min(
    BACKOFF_MAX_MS,
    BACKOFF_BASE_MS * 2 ** Math.max(0, attemptCount - 1),
  );

  if (retryAfterMs === undefined || retryAfterMs < 0) {
    return exponential;
  }

  return Math.min(BACKOFF_MAX_MS, Math.max(exponential, retryAfterMs));
}

function sanitizeEntitlementError(
  cause: unknown,
  context: SanitizedEntitlementError["context"],
): SanitizedEntitlementError {
  const rawCode =
    readString(cause, "code") ??
    readString(cause, "upstreamCode") ??
    context.category.toUpperCase();

  return {
    code: sanitizeErrorCode(rawCode),
    context: Object.freeze(context),
    message: boundAndSanitize(
      context.status === undefined
        ? "Course entitlement delivery failed before a successful response"
        : `Course entitlement request failed with status ${context.status}`,
      MAX_ERROR_MESSAGE_LENGTH,
    ),
  };
}

function assertStoredCommandIntegrity(job: ClaimedEntitlementJob): void {
  const payloadCommandType =
    "grantReason" in job.payload
      ? "grant"
      : "revokeReason" in job.payload
        ? "revoke"
        : null;

  if (
    payloadCommandType !== job.commandType ||
    job.payload.idempotencyKey !== job.idempotencyKey ||
    hashEntitlementPayload(job.payload) !== job.payloadHash
  ) {
    throw new EntitlementDeliveryError("Stored command integrity check failed", {
      code: "STORED_COMMAND_INTEGRITY",
      status: 422,
    });
  }
}

function boundAndSanitize(value: string, maxLength: number): string {
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function sanitizeErrorCode(value: string): string {
  const bounded = boundAndSanitize(value, MAX_ERROR_CODE_LENGTH);
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(bounded)
    ? bounded
    : "DELIVERY_ERROR";
}

function readFiniteNumber(value: unknown, property: string): number | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const direct = (value as Record<string, unknown>)[property];
  if (typeof direct === "number" && Number.isFinite(direct)) {
    return direct;
  }

  const options = (value as Record<string, unknown>).options;
  if (typeof options === "object" && options !== null) {
    const nested = (options as Record<string, unknown>)[property];
    return typeof nested === "number" && Number.isFinite(nested)
      ? nested
      : undefined;
  }

  return undefined;
}

function readString(value: unknown, property: string): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const direct = (value as Record<string, unknown>)[property];
  if (typeof direct === "string") {
    return direct;
  }

  const options = (value as Record<string, unknown>).options;
  if (typeof options === "object" && options !== null) {
    const nested = (options as Record<string, unknown>)[property];
    return typeof nested === "string" ? nested : undefined;
  }

  return undefined;
}

function toMilliseconds(seconds: number | undefined): number | undefined {
  return seconds === undefined ? undefined : seconds * 1_000;
}
