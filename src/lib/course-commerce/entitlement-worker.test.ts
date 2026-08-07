import assert from "node:assert/strict";
import test from "node:test";

import { hashEntitlementPayload } from "./entitlement-commands";
import {
  EntitlementDeliveryError,
  calculateEntitlementRetryDelayMs,
  classifyEntitlementDeliveryFailure,
  createEntitlementWorker,
  type ClaimedEntitlementJob,
  type EntitlementOutboxRepository,
  type SanitizedEntitlementError,
} from "./entitlement-worker";

function createJob(
  overrides: Partial<ClaimedEntitlementJob> = {},
): ClaimedEntitlementJob {
  const payload = {
    userId: "user-1",
    courseId: "course-1",
    orderId: "order-1",
    idempotencyKey: "course-entitlement:grant:v1:item-1:user-1",
    grantReason: "purchase" as const,
    grantedAt: "2026-08-07T10:00:00.000Z",
    expiresAt: null,
  };
  return {
    attemptCount: 1,
    commandType: "grant",
    courseOrderItemId: "item-1",
    id: "job-1",
    idempotencyKey: "course-entitlement:grant:v1:item-1:user-1",
    leaseOwner: "worker-1",
    maxAttempts: 5,
    payload,
    payloadHash: hashEntitlementPayload(payload),
    sequence: 1,
    ...overrides,
  };
}

function createRepository(jobs: ClaimedEntitlementJob[]) {
  const calls: Array<{ kind: string; input: unknown }> = [];
  const repository: EntitlementOutboxRepository = {
    async claimDue(input) {
      calls.push({ kind: "claim", input });
      return jobs;
    },
    async markCompleted(input) {
      calls.push({ kind: "completed", input });
      return input.leaseOwner === "worker-1";
    },
    async markFailed(input) {
      calls.push({ kind: "failed", input });
      return input.leaseOwner === "worker-1";
    },
    async markRetry(input) {
      calls.push({ kind: "retry", input });
      return input.leaseOwner === "worker-1";
    },
    async releaseClaims(input) {
      calls.push({ kind: "release", input });
      return input.jobIds.length;
    },
  };
  return { calls, repository };
}

test("worker replays the exact stored command and completes its lease", async () => {
  const job = createJob();
  const { calls, repository } = createRepository([job]);
  const delivered: unknown[] = [];
  const worker = createEntitlementWorker({
    client: {
      async grant(command) {
        delivered.push(command);
        return {
          grantId: "grant-1",
          userId: command.userId,
          courseId: command.courseId,
          status: "active",
          createdAt: command.grantedAt,
        };
      },
      async revoke() {
        throw new Error("Unexpected revoke");
      },
    },
    getNow: () => new Date("2026-08-07T10:00:00.000Z"),
    getWorkerId: () => "worker-1",
    log: () => undefined,
    repository,
  });

  const summary = await worker.run();

  assert.equal(delivered[0], job.payload);
  assert.equal(summary.completed, 1);
  assert.equal(calls.some((call) => call.kind === "completed"), true);
});

test("network, rate-limit, and server failures retry; contract failures do not", () => {
  assert.equal(classifyEntitlementDeliveryFailure(new Error("ECONNRESET")).kind, "retry");
  assert.equal(
    classifyEntitlementDeliveryFailure(
      new EntitlementDeliveryError("limited", { status: 429 }),
    ).kind,
    "retry",
  );
  assert.equal(
    classifyEntitlementDeliveryFailure(
      new EntitlementDeliveryError("server", { status: 503 }),
    ).kind,
    "retry",
  );
  for (const status of [400, 404, 409, 422]) {
    assert.equal(
      classifyEntitlementDeliveryFailure(
        new EntitlementDeliveryError("terminal", { status }),
      ).kind,
      "permanent",
    );
  }
});

test("retry delay is exponential, capped, and honors Retry-After", () => {
  assert.equal(calculateEntitlementRetryDelayMs(1), 5_000);
  assert.equal(calculateEntitlementRetryDelayMs(3), 20_000);
  assert.equal(calculateEntitlementRetryDelayMs(1, 45_000), 45_000);
  assert.equal(calculateEntitlementRetryDelayMs(99), 15 * 60_000);
});

test("authentication failure fails closed and releases unprocessed leases", async () => {
  const { calls, repository } = createRepository([
    createJob(),
    createJob({ id: "job-2", courseOrderItemId: "item-2" }),
  ]);
  const worker = createEntitlementWorker({
    client: {
      async grant() {
        throw new EntitlementDeliveryError("bad Bearer secret-token", {
          code: "UNAUTHORIZED",
          status: 401,
        });
      },
      async revoke() {
        throw new Error("Unexpected revoke");
      },
    },
    getNow: () => new Date("2026-08-07T10:00:00.000Z"),
    getWorkerId: () => "worker-1",
    log: () => undefined,
    repository,
  });

  const summary = await worker.run();
  const failure = calls.find((call) => call.kind === "failed")?.input as {
    error: SanitizedEntitlementError;
  };

  assert.equal(summary.failed, 1);
  assert.equal(summary.released, 1);
  assert.equal(failure.error.message.includes("secret-token"), false);
  assert.equal(calls.some((call) => call.kind === "release"), true);
});

test("stale lease completion does not count as completed", async () => {
  const job = createJob({ leaseOwner: "expired-worker" });
  const { repository } = createRepository([job]);
  const worker = createEntitlementWorker({
    client: {
      async grant(command) {
        return {
          grantId: "grant-1",
          userId: command.userId,
          courseId: command.courseId,
          status: "active",
          createdAt: command.grantedAt,
        };
      },
      async revoke() {
        throw new Error("Unexpected revoke");
      },
    },
    getNow: () => new Date("2026-08-07T10:00:00.000Z"),
    getWorkerId: () => "worker-1",
    log: () => undefined,
    repository,
  });

  const summary = await worker.run();

  assert.equal(summary.completed, 0);
  assert.equal(summary.stale, 1);
});

test("causal claim contract excludes a revoke while its grant is incomplete", async () => {
  const rows = [
    { id: "grant", itemId: "item-1", sequence: 1, status: "pending" },
    { id: "revoke", itemId: "item-1", sequence: 2, status: "pending" },
  ];
  const due = rows.filter(
    (row) =>
      row.status === "pending" &&
      !rows.some(
        (predecessor) =>
          predecessor.itemId === row.itemId &&
          predecessor.sequence < row.sequence &&
          predecessor.status !== "completed",
      ),
  );

  assert.deepEqual(due.map((row) => row.id), ["grant"]);
});
