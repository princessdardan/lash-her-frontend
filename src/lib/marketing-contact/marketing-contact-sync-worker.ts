import "server-only";

import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";

import { getPrivateDb } from "@/lib/private-db/client";
import {
  marketingContactSyncJobs,
  type MarketingContactSyncJobPayload,
  type MarketingContactSyncJobStatus,
} from "@/lib/private-db/schema";
import {
  syncResendMarketingContact,
  type ResendContactSyncStep,
  type ResendMarketingContactInput,
} from "@/lib/resend-platform";

export interface MarketingContactSyncJob {
  id: string;
  attempts: number;
  lockedBy: string;
  maxAttempts: number;
  payload: MarketingContactSyncJobPayload;
  status: MarketingContactSyncJobStatus;
}

export interface MarketingContactSyncWorkerRepository {
  claimDueJobs(input: {
    batchSize: number;
    lockTtlSeconds: number;
    now: Date;
    workerId: string;
  }): Promise<MarketingContactSyncJob[]>;
  markJobDeadLetter(input: {
    error: string;
    errorContext: Record<string, unknown>;
    jobId: string;
    lockedBy: string;
    now: Date;
  }): Promise<number>;
  markJobRetryableFailed(input: {
    error: string;
    errorContext: Record<string, unknown>;
    jobId: string;
    lockedBy: string;
    nextRunAt: Date;
    now: Date;
  }): Promise<number>;
  markJobSkippedUnconfigured(input: {
    jobId: string;
    lockedBy: string;
    now: Date;
    reason: string;
  }): Promise<number>;
  markJobSucceeded(input: {
    jobId: string;
    lockedBy: string;
    now: Date;
  }): Promise<number>;
}

export interface MarketingContactSyncWorkerDependencies {
  getApiKey: () => string | undefined;
  getNow: () => Date;
  logError: typeof console.error;
  logWarn: typeof console.warn;
  repository: MarketingContactSyncWorkerRepository;
  syncContact: (input: ResendMarketingContactInput) => Promise<void>;
}

export interface MarketingContactSyncRunSummary {
  deadLettered: number;
  failedToClaim: number;
  processed: number;
  retryableFailed: number;
  runAt: string;
  skippedUnconfigured: number;
  succeeded: number;
}

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_LOCK_TTL_SECONDS = 5 * 60;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 60 * 60_000;

export function createMarketingContactSyncWorker(
  dependencies: MarketingContactSyncWorkerDependencies,
): {
  run(input?: {
    batchSize?: number;
    lockTtlSeconds?: number;
  }): Promise<MarketingContactSyncRunSummary>;
} {
  return {
    async run(input): Promise<MarketingContactSyncRunSummary> {
      const now = dependencies.getNow();
      const batchSize = input?.batchSize ?? DEFAULT_BATCH_SIZE;
      const lockTtlSeconds = input?.lockTtlSeconds ?? DEFAULT_LOCK_TTL_SECONDS;
      const apiKey = dependencies.getApiKey();

      if (!apiKey) {
        dependencies.logWarn(
          "[marketing-contact-sync] RESEND_API_KEY is not configured; skipping run without claiming jobs",
        );

        return buildSummary({ now, processed: 0 });
      }

      let jobs: MarketingContactSyncJob[];

      try {
        jobs = await dependencies.repository.claimDueJobs({
          batchSize,
          lockTtlSeconds,
          now,
          workerId: getWorkerId(),
        });
      } catch (error) {
        dependencies.logError("[marketing-contact-sync] Failed to claim jobs", {
          error: error instanceof Error ? error.message : "Unknown error",
        });

        return buildSummary({ now, processed: 0, failedToClaim: batchSize });
      }

      const summary = buildSummary({ now, processed: jobs.length });

      for (const job of jobs) {
        try {
          await dependencies.syncContact(
            toResendMarketingContactInput(job.payload),
          );
          const updated = await dependencies.repository.markJobSucceeded({
            jobId: job.id,
            lockedBy: job.lockedBy,
            now: dependencies.getNow(),
          });

          if (updated > 0) {
            summary.succeeded += 1;
          } else {
            dependencies.logWarn(
              "[marketing-contact-sync] Stale lock or status mismatch; mark succeeded ignored",
              { jobId: job.id },
            );
          }
        } catch (error) {
          const errorMessage =
            error instanceof Error
              ? error.message
              : "Unknown Resend sync error";
          const errorContext = buildErrorContext(error);

          dependencies.logError(
            "[marketing-contact-sync] Resend contact sync failed",
            {
              error: errorMessage,
              jobId: job.id,
              source: job.payload.source,
            },
          );

          if (job.attempts >= job.maxAttempts) {
            const updated = await safeMarkJobDeadLetter(dependencies, {
              error: errorMessage,
              errorContext,
              job,
            });

            if (updated > 0) {
              summary.deadLettered += 1;
            } else {
              dependencies.logWarn(
                "[marketing-contact-sync] Stale lock or status mismatch; mark dead_letter ignored",
                { jobId: job.id },
              );
            }
          } else {
            const updated = await safeMarkJobRetryableFailed(dependencies, {
              error: errorMessage,
              errorContext,
              job,
            });

            if (updated > 0) {
              summary.retryableFailed += 1;
            } else {
              dependencies.logWarn(
                "[marketing-contact-sync] Stale lock or status mismatch; mark retryable_failed ignored",
                { jobId: job.id },
              );
            }
          }
        }
      }

      return summary;
    },
  };
}

async function safeMarkJobDeadLetter(
  dependencies: MarketingContactSyncWorkerDependencies,
  input: {
    error: string;
    errorContext: Record<string, unknown>;
    job: MarketingContactSyncJob;
  },
): Promise<number> {
  try {
    return await dependencies.repository.markJobDeadLetter({
      error: input.error,
      errorContext: input.errorContext,
      jobId: input.job.id,
      lockedBy: input.job.lockedBy,
      now: dependencies.getNow(),
    });
  } catch (deadLetterError) {
    dependencies.logError(
      "[marketing-contact-sync] Failed to mark job dead_letter",
      {
        error:
          deadLetterError instanceof Error
            ? deadLetterError.message
            : "Unknown error",
        jobId: input.job.id,
      },
    );

    return 0;
  }
}

async function safeMarkJobRetryableFailed(
  dependencies: MarketingContactSyncWorkerDependencies,
  input: {
    error: string;
    errorContext: Record<string, unknown>;
    job: MarketingContactSyncJob;
  },
): Promise<number> {
  try {
    return await dependencies.repository.markJobRetryableFailed({
      error: input.error,
      errorContext: input.errorContext,
      jobId: input.job.id,
      lockedBy: input.job.lockedBy,
      nextRunAt: calculateNextRunAt(input.job.attempts, dependencies.getNow()),
      now: dependencies.getNow(),
    });
  } catch (retryError) {
    dependencies.logError(
      "[marketing-contact-sync] Failed to mark job retryable_failed",
      {
        error:
          retryError instanceof Error ? retryError.message : "Unknown error",
        jobId: input.job.id,
      },
    );

    return 0;
  }
}

export async function runMarketingContactSyncWorker(input?: {
  batchSize?: number;
  lockTtlSeconds?: number;
  now?: Date;
}): Promise<MarketingContactSyncRunSummary> {
  const worker = createMarketingContactSyncWorker({
    getApiKey: () => {
      const value = process.env.RESEND_API_KEY?.trim();

      return value ? value : undefined;
    },
    getNow: () => input?.now ?? new Date(),
    logError: console.error,
    logWarn: console.warn,
    repository: createDrizzleMarketingContactSyncWorkerRepository(),
    syncContact: syncResendMarketingContact,
  });

  return worker.run(input);
}

export function createDrizzleMarketingContactSyncWorkerRepository(
  db: ReturnType<typeof getPrivateDb> = getPrivateDb(),
): MarketingContactSyncWorkerRepository {
  return {
    async claimDueJobs({ batchSize, lockTtlSeconds, now, workerId }) {
      return db.transaction(async (tx) => {
        const lockUntil = new Date(now.getTime() + lockTtlSeconds * 1000);

        const candidateIds = await tx
          .select({ id: marketingContactSyncJobs.id })
          .from(marketingContactSyncJobs)
          .where(
            or(
              and(
                inArray(marketingContactSyncJobs.status, [
                  "queued",
                  "retryable_failed",
                ]),
                lte(marketingContactSyncJobs.nextRunAt, now),
              ),
              and(
                eq(marketingContactSyncJobs.status, "processing"),
                lte(marketingContactSyncJobs.lockedUntil, now),
              ),
            ),
          )
          .orderBy(
            asc(marketingContactSyncJobs.nextRunAt),
            asc(marketingContactSyncJobs.createdAt),
          )
          .limit(batchSize)
          .for("update", { skipLocked: true });

        if (candidateIds.length === 0) {
          return [];
        }

        const claimed = await tx
          .update(marketingContactSyncJobs)
          .set({
            attempts: sql`${marketingContactSyncJobs.attempts} + 1`,
            lockedBy: workerId,
            lockedUntil: lockUntil,
            lastAttemptedAt: now,
            status: "processing",
            updatedAt: now,
          })
          .where(
            inArray(
              marketingContactSyncJobs.id,
              candidateIds.map((row) => row.id),
            ),
          )
          .returning({
            id: marketingContactSyncJobs.id,
            attempts: marketingContactSyncJobs.attempts,
            lockedBy: marketingContactSyncJobs.lockedBy,
            maxAttempts: marketingContactSyncJobs.maxAttempts,
            payload: marketingContactSyncJobs.payload,
            status: marketingContactSyncJobs.status,
          });

        return claimed as MarketingContactSyncJob[];
      });
    },

    async markJobSucceeded({ jobId, lockedBy, now }) {
      const result = await db
        .update(marketingContactSyncJobs)
        .set({
          lockedBy: null,
          lockedUntil: null,
          status: "succeeded",
          succeededAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(marketingContactSyncJobs.id, jobId),
            eq(marketingContactSyncJobs.status, "processing"),
            eq(marketingContactSyncJobs.lockedBy, lockedBy),
          ),
        )
        .returning({ id: marketingContactSyncJobs.id });

      return result.length;
    },

    async markJobRetryableFailed({
      jobId,
      lockedBy,
      now,
      nextRunAt,
      error,
      errorContext,
    }) {
      const result = await db
        .update(marketingContactSyncJobs)
        .set({
          lockedBy: null,
          lockedUntil: null,
          status: "retryable_failed",
          nextRunAt,
          lastAttemptedAt: now,
          lastError: error,
          lastErrorContext: errorContext,
          updatedAt: now,
        })
        .where(
          and(
            eq(marketingContactSyncJobs.id, jobId),
            eq(marketingContactSyncJobs.status, "processing"),
            eq(marketingContactSyncJobs.lockedBy, lockedBy),
          ),
        )
        .returning({ id: marketingContactSyncJobs.id });

      return result.length;
    },

    async markJobDeadLetter({ jobId, lockedBy, now, error, errorContext }) {
      const result = await db
        .update(marketingContactSyncJobs)
        .set({
          lockedBy: null,
          lockedUntil: null,
          status: "dead_letter",
          deadLetteredAt: now,
          lastAttemptedAt: now,
          lastError: error,
          lastErrorContext: errorContext,
          updatedAt: now,
        })
        .where(
          and(
            eq(marketingContactSyncJobs.id, jobId),
            eq(marketingContactSyncJobs.status, "processing"),
            eq(marketingContactSyncJobs.lockedBy, lockedBy),
          ),
        )
        .returning({ id: marketingContactSyncJobs.id });

      return result.length;
    },

    async markJobSkippedUnconfigured({ jobId, lockedBy, now, reason }) {
      const result = await db
        .update(marketingContactSyncJobs)
        .set({
          lockedBy: null,
          lockedUntil: null,
          status: "skipped_unconfigured",
          skippedAt: now,
          lastAttemptedAt: now,
          lastError: reason,
          updatedAt: now,
        })
        .where(
          and(
            eq(marketingContactSyncJobs.id, jobId),
            eq(marketingContactSyncJobs.status, "processing"),
            eq(marketingContactSyncJobs.lockedBy, lockedBy),
          ),
        )
        .returning({ id: marketingContactSyncJobs.id });

      return result.length;
    },
  };
}

function toResendMarketingContactInput(
  payload: MarketingContactSyncJobPayload,
): ResendMarketingContactInput {
  const consentedAt = new Date(payload.consentedAt);

  if (Number.isNaN(consentedAt.getTime())) {
    throw new Error(
      `Invalid consentedAt in marketing contact sync payload: ${payload.consentedAt}`,
    );
  }

  const input: ResendMarketingContactInput = {
    consentedAt,
    email: payload.email,
    source: payload.source as ResendMarketingContactInput["source"],
  };

  if (payload.consentText !== undefined) {
    input.consentText = payload.consentText;
  }

  if (payload.contactId !== undefined) {
    input.contactId = payload.contactId;
  }

  if (payload.consentEventId !== undefined) {
    input.consentEventId = payload.consentEventId;
  }

  if (payload.instagram !== undefined) {
    input.instagram = payload.instagram;
  }

  if (payload.name !== undefined) {
    input.name = payload.name;
  }

  if (payload.phone !== undefined) {
    input.phone = payload.phone;
  }

  if (payload.sourcePath !== undefined) {
    input.sourcePath = payload.sourcePath;
  }

  if (payload.submissionId !== undefined) {
    input.submissionId = payload.submissionId;
  }

  return input;
}

function buildErrorContext(error: unknown): Record<string, unknown> {
  const context: Record<string, unknown> = {};

  if (error instanceof Error) {
    context.errorName = error.name;
    context.errorMessage = error.message;

    if (
      "step" in error &&
      typeof error.step === "string" &&
      isResendContactSyncStep(error.step)
    ) {
      context.step = error.step;
    }

    if (
      "context" in error &&
      typeof error.context === "object" &&
      error.context !== null
    ) {
      context.stepContext = error.context;
    }
  }

  return context;
}

function isResendContactSyncStep(
  value: string,
): value is ResendContactSyncStep {
  return [
    "update_contact",
    "create_contact",
    "list_segments",
    "add_segment",
    "update_topics",
    "send_event",
  ].includes(value);
}

function calculateNextRunAt(attempts: number, now: Date): Date {
  const delayMs = Math.min(BACKOFF_BASE_MS * 2 ** attempts, BACKOFF_MAX_MS);

  return new Date(now.getTime() + delayMs);
}

function getWorkerId(): string {
  return `worker-${process.pid}-${Date.now()}`;
}

function buildSummary(input: {
  failedToClaim?: number;
  now: Date;
  processed: number;
}): MarketingContactSyncRunSummary {
  return {
    deadLettered: 0,
    failedToClaim: input.failedToClaim ?? 0,
    processed: input.processed,
    retryableFailed: 0,
    runAt: input.now.toISOString(),
    skippedUnconfigured: 0,
    succeeded: 0,
  };
}
