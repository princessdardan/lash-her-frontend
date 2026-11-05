import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  createHighLevelWorker,
  createCrmCronHandler,
  type HighLevelWorkerDependencies,
} from "@/lib/highlevel/worker";
import { finishJob, type CrmJob } from "@/lib/highlevel/store";
import { HighLevelError } from "@/lib/highlevel/contract";
import {
  createMarketingContactSyncWorker,
  type MarketingContactSyncWorkerDependencies,
  type MarketingContactSyncJob,
} from "@/lib/marketing-contact/marketing-contact-sync-worker";
import { syncResendMarketingContact } from "@/lib/resend-platform";
import { VERCEL_PROJECT_BINDINGS } from "@/lib/env/application-environment.mjs";
import { resolveWriterAdmissionConfiguration } from "./config";
import { createWriterAdmissionRunner } from "./runtime";

function admission() {
  const url =
    "postgresql://protocol_runtime:owned-password@db.owned.invalid/owned?sslmode=verify-full";
  const configuration = resolveWriterAdmissionConfiguration({
    FRONTEND_WRITER_ADMISSION_MODE: "enforce",
    APP_ENV: "staging",
    VERCEL: "1",
    VERCEL_ENV: "production",
    VERCEL_TARGET_ENV: "production",
    VERCEL_PROJECT_ID: VERCEL_PROJECT_BINDINGS.stagingProjectId,
    APP_VERCEL_TEAM_ID: VERCEL_PROJECT_BINDINGS.teamId,
    VERCEL_GIT_COMMIT_SHA: "c".repeat(40),
    FRONTEND_WRITER_PRODUCER_SHA256: "b".repeat(64),
    FRONTEND_WRITER_ADMISSION_TARGET_JSON: JSON.stringify({
      environment: "staging",
      host: "db.owned.invalid",
      port: 5432,
      database: "owned",
      user: "protocol_runtime",
      serverMajor: 18,
      targetSha256: "a".repeat(64),
    }),
    DATABASE_URL: url,
    FRONTEND_WRITER_ADMISSION_DATABASE_URL: url,
  });
  const state = {
    recovery: true,
    newWork: false,
    outcomes: [] as unknown[],
    loseSettlement: false,
  };
  const calls: string[] = [];
  const client = Object.assign(new EventEmitter(), {
    connection: { stream: { encrypted: true, authorized: true } },
    async connect() {},
    async end() {},
    async query(query: string, values?: unknown[]) {
      calls.push(query);
      if (query.startsWith("SELECT current_user"))
        return {
          rows: [
            { username: "protocol_runtime", database: "owned", major: 18 },
          ],
        };
      if (query.includes("current_policy"))
        return {
          rows: [
            { epoch: "7", new_work: state.newWork, recovery: state.recovery },
          ],
        };
      if (query.includes("finish_operation")) {
        state.outcomes.push(values?.[1]);
        if (state.loseSettlement) throw new Error("owned-private-detail");
      }
      return { rows: [] };
    },
  });
  return {
    state,
    calls,
    client,
    run: createWriterAdmissionRunner({
      getConfiguration: () => configuration,
      createClient: () => client,
    }),
    off: createWriterAdmissionRunner({ getConfiguration: () => null }),
  };
}

const now = new Date("2032-01-01T12:00:00.000Z");
const crmJob: CrmJob = {
  id: "a".repeat(8) + "-1111-4111-8111-" + "a".repeat(12),
  entity_type: "submission",
  entity_id: "owned-source",
  event_type: "submission_changed",
  historical: false,
  attempts: 1,
  occurred_at: now,
  locked_by: "owned-worker",
};
function highlevel(overrides: Partial<HighLevelWorkerDependencies> = {}) {
  const calls: string[] = [];
  let claimed = false;
  const dependencies: HighLevelWorkerDependencies = {
    syncEnabled: () => true,
    marketingEnabled: () => true,
    hasLocation: () => true,
    listActiveContacts: async () => {
      calls.push("contacts");
      return [];
    },
    stopJourneys: async () => {
      calls.push("stop");
    },
    claimJobs: async () => {
      calls.push("claim");
      if (claimed) return [];
      claimed = true;
      return [crmJob];
    },
    syncJob: async () => {
      calls.push("provider");
      return "succeeded";
    },
    finishJob: async () => {
      calls.push("receipt");
    },
    now: () => now.getTime(),
    ...overrides,
  };
  return { calls, dependencies };
}

const marketingJob: MarketingContactSyncJob = {
  id: "owned-marketing-job",
  attempts: 1,
  lockedBy: "owned-worker",
  maxAttempts: 8,
  status: "processing",
  payload: {
    email: "owned@example.invalid",
    consentedAt: now.toISOString(),
    source: "contact_popup",
  },
};
function marketing(
  overrides: Partial<MarketingContactSyncWorkerDependencies["repository"]> = {},
) {
  const calls: string[] = [];
  const dependencies: MarketingContactSyncWorkerDependencies = {
    getApiKey: () => "owned-unused",
    getNow: () => now,
    logWarn() {},
    logError() {},
    repository: {
      claimDueJobs: async () => {
        calls.push("claim");
        return [marketingJob];
      },
      isContactSubscribed: async () => true,
      markJobSucceeded: async () => {
        calls.push("receipt");
        return 1;
      },
      markJobRetryableFailed: async () => {
        calls.push("retry");
        return 1;
      },
      markJobDeadLetter: async () => 1,
      markJobSkippedUnconfigured: async () => 1,
      ...overrides,
    },
    syncContact: async () => {
      calls.push("provider");
    },
    unsubscribeContact: async () => {
      calls.push("unsubscribe");
    },
  };
  return { calls, dependencies };
}

test("recovery fence prevents CRM pause queries, claims, and marketing effects", async () => {
  const f = admission();
  f.state.recovery = false;
  const crm = highlevel({ marketingEnabled: () => false }),
    m = marketing();
  await assert.rejects(createHighLevelWorker(crm.dependencies, f.run)());
  await assert.rejects(
    createMarketingContactSyncWorker(m.dependencies, f.run).run(),
  );
  assert.deepEqual(crm.calls, []);
  assert.deepEqual(m.calls, []);
  assert.deepEqual(f.state.outcomes, []);
});

test("new-work closure retains CRM/marketing recovery and settled receipts", async () => {
  const f = admission(),
    crm = highlevel(),
    m = marketing();
  assert.equal(
    (await createHighLevelWorker(crm.dependencies, f.run)()).succeeded,
    1,
  );
  assert.equal(
    (await createMarketingContactSyncWorker(m.dependencies, f.run).run())
      .succeeded,
    1,
  );
  assert.deepEqual(crm.calls, ["claim", "provider", "receipt", "claim"]);
  assert.deepEqual(m.calls, ["claim", "provider", "receipt"]);
  assert.deepEqual(f.state.outcomes, ["completed", "completed"]);
});

test("caught CRM effects remain uncertain after a durable retry receipt", async () => {
  const f = admission(),
    crm = highlevel({
      syncJob: async () => {
        throw new HighLevelError("provider_reply_lost", true);
      },
    });
  await assert.rejects(createHighLevelWorker(crm.dependencies, f.run)());
  assert.deepEqual(f.state.outcomes, ["uncertain"]);
  assert.equal(crm.calls.includes("receipt"), true);
});

test("missing CRM lock-qualified receipt is retained for reconciliation", async () => {
  const f = admission();
  await assert.rejects(
    f.run("recovery", () =>
      finishJob(crmJob, "succeeded", null, 60, {
        execute: async () => ({ rows: [] }),
      } as unknown as Parameters<typeof finishJob>[4]),
    ),
  );
  assert.deepEqual(f.state.outcomes, ["uncertain"]);
});

test("marketing claim, missing receipt, and provider failure never report a completed operation", async () => {
  for (const fault of ["claim", "receipt", "provider"]) {
    const f = admission(),
      m = marketing(
        fault === "claim"
          ? {
              claimDueJobs: async () => {
                throw new Error("owned-private-detail");
              },
            }
          : fault === "receipt"
            ? { markJobSucceeded: async () => 0 }
            : {},
      );
    if (fault === "provider")
      m.dependencies.syncContact = async () => {
        throw new Error("owned-private-detail");
      };
    await assert.rejects(
      createMarketingContactSyncWorker(m.dependencies, f.run).run(),
    );
    assert.deepEqual(f.state.outcomes, ["uncertain"]);
    if (fault === "provider") assert.equal(m.calls.includes("retry"), true);
  }
});

test("off mode preserves caught marketing summaries and CRM retries", async () => {
  const f = admission(),
    m = marketing({ markJobSucceeded: async () => 0 });
  assert.equal(
    (await createMarketingContactSyncWorker(m.dependencies, f.off).run())
      .succeeded,
    0,
  );
  const crm = highlevel({
    syncJob: async () => {
      throw new Error("owned-private-detail");
    },
  });
  assert.equal(
    (await createHighLevelWorker(crm.dependencies, f.off)()).retry,
    1,
  );
  assert.deepEqual(f.calls, []);
});

test("marketing remains admitted through subscription compensation and final receipt", async () => {
  const f = admission();
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const m = marketing({ isContactSubscribed: async () => false });
  m.dependencies.unsubscribeContact = async () => {
    m.calls.push("unsubscribe");
    entered();
    await held;
  };
  const running = createMarketingContactSyncWorker(m.dependencies, f.run).run();
  await waiting;
  assert.deepEqual(f.state.outcomes, []);
  assert.equal(m.calls.includes("receipt"), false);
  release();
  await running;
  assert.deepEqual(f.state.outcomes, ["completed"]);
  assert.equal(m.calls.at(-1), "receipt");
});

test("lost worker socket or settlement cannot replay provider calls", async () => {
  for (const fault of ["socket", "settlement"]) {
    const f = admission(),
      m = marketing();
    f.state.loseSettlement = fault === "settlement";
    m.dependencies.syncContact = async () => {
      m.calls.push("provider");
      if (fault === "socket")
        f.client.emit("error", new Error("owned-private-detail"));
    };
    await assert.rejects(
      createMarketingContactSyncWorker(m.dependencies, f.run).run(),
    );
    assert.equal(m.calls.filter((c) => c === "provider").length, 1);
  }
});

test("CRM authentication runs before admission and sanitizes refusal", async () => {
  const old = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "owned-cron";
  try {
    const f = admission(),
      crm = highlevel();
    f.state.recovery = false;
    const get = createCrmCronHandler(
      createHighLevelWorker(crm.dependencies, f.run),
    );
    assert.equal((await get(new Request("https://owned.invalid"))).status, 401);
    assert.deepEqual(f.calls, []);
    const response = await get(
      new Request("https://owned.invalid", {
        headers: { authorization: "Bearer owned-cron" },
      }),
    );
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "crm_worker_failed" });
    assert.deepEqual(crm.calls, []);
  } finally {
    if (old === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = old;
  }
});

test("best-effort Resend event failures and absent provider receipts retain uncertainty", async () => {
  const old = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = "owned-unused";
  try {
    for (const fault of ["event-error", "event-throw", "contact-receipt"]) {
      const f = admission();
      await assert.rejects(
        f.run("recovery", () =>
          syncResendMarketingContact(
            {
              email: "owned@example.invalid",
              source: "contact_popup",
              consentedAt: now,
            },
            {
              updateContact: async () =>
                ({
                  data:
                    fault === "contact-receipt"
                      ? null
                      : { id: "owned-contact" },
                  error: null,
                }) as never,
              createContact: async () =>
                ({ data: { id: "owned-contact" }, error: null }) as never,
              addContactSegment: async () =>
                ({ data: { id: "owned-segment" }, error: null }) as never,
              listContactSegments: async () =>
                ({ data: { data: [] }, error: null }) as never,
              updateContactTopics: async () =>
                ({ data: { id: "owned-topic" }, error: null }) as never,
              sendEvent: async () => {
                if (fault === "event-throw")
                  throw new Error("owned-private-detail");
                return fault === "event-error"
                  ? ({
                      data: null,
                      error: {
                        name: "application_error",
                        message: "owned-private-detail",
                      },
                    } as never)
                  : {
                data: { event: "owned-event", object: "event" },
                error: null,
                headers: null,
                    };
              },
            },
          ),
        ),
      );
      assert.deepEqual(f.state.outcomes, ["uncertain"]);
    }
  } finally {
    if (old === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = old;
  }
});
