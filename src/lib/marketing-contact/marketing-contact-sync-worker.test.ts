import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import {
    createMarketingContactSyncWorker,
  } from "./src/lib/marketing-contact/marketing-contact-sync-worker.ts";
  import { ResendContactSyncError } from "./src/lib/resend-platform.ts";

  function createFakeRepository(initialJobs = []) {
    const jobs = new Map();
    for (const job of initialJobs) {
      jobs.set(job.id, { ...job });
    }

    const operations = [];

    function canUpdate(job, lockedBy) {
      return (
        job !== undefined &&
        job.status === "processing" &&
        job.lockedBy === lockedBy
      );
    }

    const repository = {
      async claimDueJobs({ batchSize, workerId }) {
        operations.push("claim");
        const due = Array.from(jobs.values())
          .filter((job) =>
            job.status === "queued" || job.status === "retryable_failed"
          )
          .slice(0, batchSize);

        for (const job of due) {
          job.status = "processing";
          job.lockedBy = workerId;
          operations.push("lock:" + job.id);
        }

        return due.map((job) => ({
          id: job.id,
          attempts: job.attempts,
          lockedBy: job.lockedBy,
          maxAttempts: job.maxAttempts,
          payload: job.payload,
          status: job.status,
        }));
      },

      async markJobSucceeded({ jobId, lockedBy }) {
        operations.push("succeeded:" + jobId);
        const job = jobs.get(jobId);
        if (canUpdate(job, lockedBy)) {
          job.status = "succeeded";
          return 1;
        }
        return 0;
      },

      async markJobRetryableFailed({ jobId, lockedBy }) {
        operations.push("retryable_failed:" + jobId);
        const job = jobs.get(jobId);
        if (canUpdate(job, lockedBy)) {
          job.status = "retryable_failed";
          job.attempts += 1;
          return 1;
        }
        return 0;
      },

      async markJobDeadLetter({ jobId, lockedBy }) {
        operations.push("dead_letter:" + jobId);
        const job = jobs.get(jobId);
        if (canUpdate(job, lockedBy)) {
          job.status = "dead_letter";
          return 1;
        }
        return 0;
      },

      async markJobSkippedUnconfigured({ jobId, lockedBy }) {
        operations.push("skipped:" + jobId);
        const job = jobs.get(jobId);
        if (canUpdate(job, lockedBy)) {
          job.status = "skipped_unconfigured";
          return 1;
        }
        return 0;
      },
    };

    return { repository, jobs, operations };
  }

  function createWorker(overrides = {}, initialJobs = []) {
    const { repository, jobs, operations } = createFakeRepository(initialJobs);
    const syncCalls = [];
    const warnings = [];
    const errors = [];

    const worker = createMarketingContactSyncWorker({
      getApiKey: () => "re_test",
      getNow: () => new Date("2026-05-10T12:00:00.000Z"),
      logError: (message, context) => errors.push({ context, message }),
      logWarn: (message, context) => warnings.push({ context, message }),
      repository,
      syncContact: async (input) => {
        syncCalls.push(input);
      },
      ...overrides,
    });

    return { errors, jobs, operations, run: worker.run, syncCalls, warnings };
  }

  function createSampleJob(overrides = {}) {
    return {
      id: "job-1",
      attempts: 0,
      maxAttempts: 5,
      payload: {
        consentedAt: "2026-05-10T12:00:00.000Z",
        email: "subscriber@example.com",
        source: "general_inquiry",
      },
      status: "queued",
      ...overrides,
    };
  }
`;

test("worker syncs due jobs and marks them succeeded", () => {
  runWorkerScenario(`
    const { run, syncCalls, operations, jobs } = createWorker({}, [createSampleJob()]);

    const summary = await run();

    assert.equal(summary.processed, 1);
    assert.equal(summary.succeeded, 1);
    assert.equal(summary.retryableFailed, 0);
    assert.equal(summary.deadLettered, 0);
    assert.equal(summary.skippedUnconfigured, 0);
    assert.equal(syncCalls.length, 1);
    assert.equal(syncCalls[0].email, "subscriber@example.com");
    assert.equal(jobs.get("job-1").status, "succeeded");
    assert.ok(operations.includes("succeeded:job-1"));
  `);
});

test("worker marks jobs retryable_failed on sync error", () => {
  runWorkerScenario(`
    const { run, operations, jobs } = createWorker({
      syncContact: async () => {
        throw new ResendContactSyncError("update_contact", "Resend contact update failed", {
          email: "subscriber@example.com",
        });
      },
    }, [createSampleJob()]);

    const summary = await run();

    assert.equal(summary.processed, 1);
    assert.equal(summary.succeeded, 0);
    assert.equal(summary.retryableFailed, 1);
    assert.equal(summary.deadLettered, 0);
    assert.equal(jobs.get("job-1").status, "retryable_failed");
    assert.ok(operations.includes("retryable_failed:job-1"));
  `);
});

test("worker dead-letters jobs after max attempts", () => {
  runWorkerScenario(`
    const { run, operations, jobs } = createWorker({
      syncContact: async () => {
        throw new Error("Persistent Resend failure");
      },
    }, [createSampleJob({ attempts: 5, maxAttempts: 5 })]);

    const summary = await run();

    assert.equal(summary.processed, 1);
    assert.equal(summary.succeeded, 0);
    assert.equal(summary.retryableFailed, 0);
    assert.equal(summary.deadLettered, 1);
    assert.equal(jobs.get("job-1").status, "dead_letter");
    assert.ok(operations.includes("dead_letter:job-1"));
  `);
});

test("worker does not claim or consume jobs when API key is missing", () => {
  runWorkerScenario(`
    const { run, syncCalls, operations, jobs, warnings } = createWorker({
      getApiKey: () => undefined,
    }, [createSampleJob()]);

    const summary = await run();

    assert.equal(summary.processed, 0);
    assert.equal(summary.succeeded, 0);
    assert.equal(summary.skippedUnconfigured, 0);
    assert.equal(summary.failedToClaim, 0);
    assert.equal(syncCalls.length, 0);
    assert.equal(operations.length, 0);
    assert.equal(jobs.get("job-1").status, "queued");
    assert.ok(warnings.some((w) => w.message.includes("RESEND_API_KEY is not configured")));
  `);
});

test("worker ignores stale lock when another worker has claimed the job", () => {
  runWorkerScenario(`
    let syncCalled = false;
    const { run, operations, jobs, warnings } = createWorker({
      syncContact: async () => {
        syncCalled = true;
        // Simulate the lock expiring and another worker claiming the job
        // before the original worker can mark it succeeded.
        jobs.get("job-1").lockedBy = "stale-worker";
      },
    }, [createSampleJob()]);

    const summary = await run();

    assert.equal(summary.processed, 1);
    assert.equal(summary.succeeded, 0);
    assert.equal(summary.retryableFailed, 0);
    assert.equal(summary.deadLettered, 0);
    assert.equal(syncCalled, true);
    assert.equal(jobs.get("job-1").status, "processing");
    assert.equal(jobs.get("job-1").lockedBy, "stale-worker");
    assert.ok(operations.includes("succeeded:job-1"));
    assert.ok(warnings.some((w) => w.message.includes("Stale lock or status mismatch")));
  `);
});

test("worker ignores stale lock when marking retryable_failed", () => {
  runWorkerScenario(`
    const { run, operations, jobs, warnings } = createWorker({
      syncContact: async () => {
        jobs.get("job-1").lockedBy = "stale-worker";
        throw new Error("Resend transient failure");
      },
    }, [createSampleJob()]);

    const summary = await run();

    assert.equal(summary.processed, 1);
    assert.equal(summary.succeeded, 0);
    assert.equal(summary.retryableFailed, 0);
    assert.equal(summary.deadLettered, 0);
    assert.equal(jobs.get("job-1").status, "processing");
    assert.equal(jobs.get("job-1").lockedBy, "stale-worker");
    assert.ok(operations.includes("retryable_failed:job-1"));
    assert.ok(warnings.some((w) => w.message.includes("Stale lock or status mismatch")));
  `);
});

test("worker includes contact, submission, and event IDs in sync payload", () => {
  runWorkerScenario(`
    const { run, syncCalls } = createWorker({}, [createSampleJob({
      payload: {
        consentedAt: "2026-05-10T12:00:00.000Z",
        contactId: "contact-1",
        consentEventId: "event-1",
        email: "subscriber@example.com",
        source: "general_inquiry",
        submissionId: "submission-1",
      },
    })]);

    await run();

    assert.deepEqual(syncCalls[0], {
      consentedAt: new Date("2026-05-10T12:00:00.000Z"),
      email: "subscriber@example.com",
      source: "general_inquiry",
      contactId: "contact-1",
      consentEventId: "event-1",
      submissionId: "submission-1",
    });
  `);
});

test("worker claims no more than the configured batch size", () => {
  runWorkerScenario(`
    const { run, syncCalls } = createWorker({}, [
      createSampleJob({ id: "job-1" }),
      createSampleJob({ id: "job-2" }),
      createSampleJob({ id: "job-3" }),
    ]);

    const summary = await run({ batchSize: 2 });

    assert.equal(summary.processed, 2);
    assert.equal(syncCalls.length, 2);
  `);
});

function runWorkerScenario(assertions: string): void {
  const scenario = `${helperScript}\nvoid (async () => {\n${assertions}\n})()`;
  const env = { ...process.env };

  env.NEXT_PUBLIC_SANITY_DATASET = "test";
  env.NEXT_PUBLIC_SANITY_PROJECT_ID = "test-project";
  delete env.RESEND_API_KEY;

  execFileSync(
    "./node_modules/.bin/tsx",
    ["--conditions=react-server", "--eval", scenario],
    {
      cwd: process.cwd(),
      env,
      stdio: "pipe",
    },
  );
}
