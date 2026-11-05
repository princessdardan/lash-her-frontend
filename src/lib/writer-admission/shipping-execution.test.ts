import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import {
  createShippingWorkerCronHandler,
  defaultDependencies,
} from "@/app/api/cron/chitchats-shipping/handler";
import { VERCEL_PROJECT_BINDINGS } from "@/lib/env/application-environment.mjs";
import { resolveWriterAdmissionConfiguration } from "./config";
import { createWriterAdmissionRunner } from "./runtime";
import { markWriterOperationUncertain } from "./context";
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
    newWork: false,
    recovery: true,
    loseSettlement: false,
    outcomes: [] as unknown[],
  };
  const calls: { sql: string; values?: unknown[] }[] = [];
  const client = Object.assign(new EventEmitter(), {
    connection: { stream: { encrypted: true, authorized: true } },
    async connect() {},
    async end() {},
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      if (sql.startsWith("SELECT current_user"))
        return {
          rows: [
            { username: "protocol_runtime", database: "owned", major: 18 },
          ],
        };
      if (sql.includes("current_policy"))
        return {
          rows: [
            { epoch: "7", new_work: state.newWork, recovery: state.recovery },
          ],
        };
      if (sql.includes("finish_operation")) {
        state.outcomes.push(values?.[1]);
        if (state.loseSettlement) throw new Error("owned-private-detail");
      }
      return { rows: [] };
    },
  });
  const run = createWriterAdmissionRunner({
    getConfiguration: () => configuration,
    createClient: () => client,
  });
  const off = createWriterAdmissionRunner({ getConfiguration: () => null });
  return { state, calls, client, run, off };
}

const request = (token = "owned-cron") =>
  new Request("https://owned.invalid/api/cron/chitchats-shipping", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
const clean = {
  claimed: 1,
  succeeded: 1,
  retried: 0,
  deadLettered: 0,
  fenced: 0,
};
function business(
  f: ReturnType<typeof admission>,
  options: {
    off?: boolean;
    disabled?: boolean;
    closeAfterPreparation?: boolean;
    uncertain?: boolean;
    result?: typeof clean;
    fail?: string;
    wait?: (stage: string) => Promise<void>;
  } = {},
) {
  const calls: string[] = [];
  const run = options.off ? f.off : f.run;
  const get = createShippingWorkerCronHandler(
    {
      ...defaultDependencies,
      isSquareCommerceCheckoutEnabled: () => false,
      isChitChatsShippingEnabled: () => {
        calls.push("flag");
        return !options.disabled;
      },
      abandonExpiredQuotes: async () => {
        calls.push("abandon");
        return 0;
      },
      listShipmentsDueForPolling: async () => {
        calls.push("poll");
        return [];
      },
      runShippingOperationWorker: async () => {
        if (!options.off)
          assert.deepEqual(f.state.outcomes, ["completed", "completed"]);
        for (const stage of [
          "configuration",
          "claim",
          "provider",
          "persistence",
          "alerts",
        ]) {
          calls.push(stage);
          await options.wait?.(stage);
          if (options.fail === stage) throw new Error("owned-private-detail");
        }
        if (options.uncertain) markWriterOperationUncertain();
        return options.result ?? clean;
      },
      redactExpiredShipmentPii: async () => {
        if (!options.off)
          assert.deepEqual(f.state.outcomes, [
            "completed",
            "completed",
            "completed",
          ]);
        calls.push("redact");
        if (options.fail === "redact") throw new Error("owned-private-detail");
        return 0;
      },
    },
    (task) => run("recovery", task),
    async (task) => {
      const result = await run("recovery", task);
      if (options.closeAfterPreparation) f.state.recovery = false;
      return result;
    },
    (task) =>
      run("recovery", task, {
        uncertainResult: (r) =>
          r.retried > 0 || r.deadLettered > 0 || r.fenced > 0,
      }),
  );
  return { get, calls };
}
async function unavailable(response: Response) {
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("retry-after"), "30");
  assert.equal((await response.text()).includes("owned-private-detail"), false);
}
test.before(() => {
  process.env.CRON_SECRET = "owned-cron";
  delete process.env.CHITCHATS_WORKER_CRON_SECRET;
});
test("execution authentication precedes all three entries", async () => {
  const f = admission(),
    b = business(f);
  assert.equal((await b.get(request(""))).status, 401);
  assert.equal((await b.get(request("wrong"))).status, 401);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(b.calls, []);
});
test("execution stays independent of new-work admission and settles before redaction", async () => {
  const f = admission(),
    b = business(f);
  assert.equal(f.state.newWork, false);
  const response = await b.get(request());
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).operations, clean);
  assert.deepEqual(f.state.outcomes, ["completed", "completed", "completed"]);
  assert.equal(
    f.calls.filter((c) => c.sql.includes("begin_operation")).length,
    3,
  );
  assert.equal(b.calls.at(-1), "redact");
});
test("closure after preparation refuses configuration and claims without replaying earlier batches", async () => {
  const f = admission(),
    b = business(f, { closeAfterPreparation: true });
  await unavailable(await b.get(request()));
  assert.deepEqual(f.state.outcomes, ["completed", "completed"]);
  assert.deepEqual(b.calls, ["flag", "abandon", "poll"]);
});
test("disabled shipping skips the execution entry and empty execution completes normally", async () => {
  for (const disabled of [false, true]) {
    const f = admission(),
      b = business(f, {
        disabled,
        result: { ...clean, claimed: 0, succeeded: 0 },
      });
    assert.equal((await b.get(request())).status, 200);
    assert.equal(f.state.outcomes.length, disabled ? 2 : 3);
    assert.equal(b.calls.includes("claim"), !disabled);
  }
});
test("closure during configuration, claims, provider, persistence or alerts retains admitted work", async () => {
  for (const stage of [
    "configuration",
    "claim",
    "provider",
    "persistence",
    "alerts",
  ]) {
    const f = admission();
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((r) => {
        entered = r;
      }),
      held = new Promise<void>((r) => {
        release = r;
      });
    const b = business(f, {
      wait: async (current) => {
        if (current === stage) {
          entered();
          await held;
        }
      },
    });
    const pending = b.get(request());
    await ready;
    try {
      f.state.recovery = false;
      await unavailable(await b.get(request()));
      assert.deepEqual(f.state.outcomes, ["completed", "completed"]);
    } finally {
      release();
    }
    assert.equal((await pending).status, 200);
    for (const effect of ["claim", "provider", "persistence", "alerts"])
      assert.equal(b.calls.filter((c) => c === effect).length, 1);
    assert.deepEqual(f.state.outcomes, ["completed", "completed", "completed"]);
  }
});
test("query, provider, receipt and alert errors retain uncertainty before redaction", async () => {
  for (const fail of [
    "configuration",
    "claim",
    "provider",
    "persistence",
    "alerts",
  ]) {
    const f = admission(),
      b = business(f, { fail });
    await unavailable(await b.get(request()));
    assert.deepEqual(f.state.outcomes, ["completed", "completed", "uncertain"]);
    assert.equal(b.calls.includes("redact"), false);
  }
});
test("retried, dead-lettered and fenced summaries cannot complete enforced execution", async () => {
  for (const key of ["retried", "deadLettered", "fenced"] as const) {
    const f = admission(),
      b = business(f, { result: { ...clean, succeeded: 0, [key]: 1 } });
    await unavailable(await b.get(request()));
    assert.equal(b.calls.includes("redact"), false);
    assert.deepEqual(f.state.outcomes, ["completed", "completed", "uncertain"]);
  }
});
test("caught missing-receipt markers survive a successful-looking worker summary", async () => {
  const f = admission(),
    b = business(f, { uncertain: true });
  await unavailable(await b.get(request()));
  assert.equal(b.calls.includes("alerts"), true);
  assert.equal(b.calls.includes("redact"), false);
});
test("socket and execution settlement loss never replay provider work or run redaction", async () => {
  for (const fault of ["socket", "settlement"]) {
    const f = admission(),
      b = business(f, {
        wait: async (stage) => {
          if (stage === "provider") {
            if (fault === "socket")
              f.client.emit("error", new Error("owned-private-detail"));
            else f.state.loseSettlement = true;
          }
        },
      });
    await unavailable(await b.get(request()));
    assert.equal(b.calls.filter((c) => c === "provider").length, 1);
    assert.equal(b.calls.includes("redact"), false);
  }
});
test("off mode preserves legacy counters, receipt-marker behavior and redaction", async () => {
  for (const failed of [false, true]) {
    const f = admission(),
      result = failed ? { ...clean, succeeded: 0, retried: 1 } : clean;
    const b = business(f, { off: true, uncertain: true, result });
    const response = await b.get(request());
    assert.equal(response.status, failed ? 503 : 200);
    assert.equal(response.headers.get("retry-after"), null);
    assert.deepEqual((await response.json()).operations, result);
    assert.deepEqual(f.calls, []);
    assert.equal(b.calls.includes("redact"), true);
  }
});
test("redaction failure occurs after execution settles and remains outside this boundary", async () => {
  const f = admission(),
    b = business(f, { fail: "redact" });
  const response = await b.get(request());
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), null);
  assert.deepEqual(f.state.outcomes, ["completed", "completed", "completed"]);
});
