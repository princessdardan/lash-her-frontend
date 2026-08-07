import "server-only";

import { randomUUID } from "node:crypto";

import {
  readCourseApiConfig,
  requireEnabledCourseApiConfig,
} from "@/lib/course-api/config";
import { createInternalEntitlementClient } from "@/lib/course-api/internal-entitlement-client";
import { log } from "@/lib/logging/logger";

import { createDrizzleEntitlementOutboxRepository } from "./drizzle-outbox-repository";
import {
  createEntitlementWorker,
  type EntitlementWorkerRunSummary,
} from "./entitlement-worker";

const RECOVERY_BATCH_SIZE = 5;
const MINIMUM_LEASE_DURATION_MS = 60_000;
const LEASE_COMPLETION_BUFFER_MS = 15_000;

export interface CourseEntitlementBatchOptions {
  batchSize?: number;
}

export async function runCourseEntitlementBatch(
  options: CourseEntitlementBatchOptions = {},
): Promise<EntitlementWorkerRunSummary> {
  const config = requireEnabledCourseApiConfig(readCourseApiConfig());
  const batchSize = options.batchSize ?? RECOVERY_BATCH_SIZE;
  const leaseDurationMs = Math.max(
    MINIMUM_LEASE_DURATION_MS,
    config.timeoutMs * batchSize + LEASE_COMPLETION_BUFFER_MS,
  );
  const client = createInternalEntitlementClient(config);
  const worker = createEntitlementWorker({
    client,
    getNow: () => new Date(),
    getWorkerId: () => `course-entitlement:${randomUUID()}`,
    log,
    repository: createDrizzleEntitlementOutboxRepository(),
  });

  return worker.run({ batchSize, leaseDurationMs });
}

export async function dispatchCourseEntitlementsBestEffort(): Promise<EntitlementWorkerRunSummary | null> {
  try {
    // Payment responses should never wait for a global serial recovery batch.
    // One idempotent attempt provides low-latency best effort; cron recovers
    // anything remaining from the durable outbox.
    return await runCourseEntitlementBatch({ batchSize: 1 });
  } catch (error) {
    log("warn", "Course entitlement immediate dispatch deferred", {
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
    return null;
  }
}
