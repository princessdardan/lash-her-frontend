import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
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

function latch() {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    entered,
    release,
    wait: async () => {
      enter();
      await held;
    },
  };
}

const now = new Date("2032-01-01T12:00:00.000Z");
const request = (token = "owned-cron") =>
  new Request("https://owned.invalid/api/cron/chitchats-shipping", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
function business(
  f: ReturnType<typeof admission>,
  options: {
    disabled?: boolean;
    empty?: boolean;
    off?: boolean;
    fail?: string;
    uncertain?: boolean;
    closeAfterRefund?: boolean;
    wait?: (stage: string) => Promise<void>;
  } = {},
) {
  const calls: string[] = [];
  const step = async (stage: string) => {
    calls.push(stage);
    if (!options.off) {
      assert.ok(f.calls.some((c) => c.sql.includes("begin_operation")));
      assert.deepEqual(f.state.outcomes, []);
    }
    await options.wait?.(stage);
    if (options.fail === stage) throw new Error("owned-private-detail");
  };
  const get = createShippingWorkerCronHandler(
    {
      ...defaultDependencies,
      now: () => now,
      isSquareCommerceCheckoutEnabled: () => false,
      isChitChatsShippingEnabled: () => {
        if (!options.off)
          assert.ok(f.calls.some((c) => c.sql.includes("begin_operation")));
        calls.push("flag");
        return !options.disabled;
      },
      abandonExpiredQuotes: async (selectedNow) => {
        assert.equal(selectedNow, now);
        await step("abandon");
        if (options.uncertain) markWriterOperationUncertain();
        return 2;
      },
      listShipmentsDueForPolling: async (selectedNow, limit) => {
        assert.equal(selectedNow, now);
        assert.equal(limit, 100);
        await step("list");
        return options.empty
          ? []
          : ([
              {
                id: "one",
                status: "label_ready",
                stateVersion: 3,
                providerShipmentId: "owned-one",
              },
              {
                id: "skip",
                status: "accepted",
                stateVersion: 4,
                providerShipmentId: null,
              },
              {
                id: "two",
                status: "in_transit",
                stateVersion: 5,
                providerShipmentId: "owned-two",
              },
            ] as Awaited<
              ReturnType<typeof defaultDependencies.listShipmentsDueForPolling>
            >);
      },
      enqueueShipmentOperation: async (input) => {
        await step(`enqueue:${input.shipmentId}`);
        const interval =
          input.shipmentId === "one" ? 30 * 60_000 : 2 * 60 * 60_000;
        const bucket = Math.floor(now.getTime() / interval);
        const version = input.shipmentId === "one" ? 3 : 5;
        assert.deepEqual(input, {
          shipmentId: input.shipmentId,
          type: "tracking",
          idempotencyKey: `tracking/${input.shipmentId}/${version}/${bucket}`,
          operationPayloadHash: createHash("sha256")
            .update(`${input.shipmentId}:${version}:${bucket}`)
            .digest("hex"),
          payload: { expectedShipmentStateVersion: version },
        });
        return {} as Awaited<
          ReturnType<typeof defaultDependencies.enqueueShipmentOperation>
        >;
      },
      runShippingOperationWorker: async () => {
        if (!options.off) assert.deepEqual(f.state.outcomes, ["completed"]);
        calls.push("worker");
        if (options.fail === "worker") throw new Error("owned-private-detail");
        return {
          claimed: 0,
          succeeded: 0,
          retried: 0,
          deadLettered: 0,
          fenced: 0,
        };
      },
      redactExpiredShipmentPii: async () => {
        if (!options.off) assert.deepEqual(f.state.outcomes, ["completed"]);
        calls.push("redact");
        return 0;
      },
    },
    async (task) => {
      const result = await task();
      if (options.closeAfterRefund) f.state.recovery = false;
      return result;
    },
    (task) => (options.off ? f.off : f.run)("recovery", task),
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
test("preparation authenticates before admission and shipping configuration", async () => {
  const f = admission(),
    b = business(f);
  assert.equal((await b.get(request(""))).status, 401);
  assert.equal((await b.get(request("wrong"))).status, 401);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(b.calls, []);
});
test("closed preparation recovery refuses even when shipping is disabled", async () => {
  for (const disabled of [false, true]) {
    const f = admission(),
      b = business(f, { disabled });
    f.state.recovery = false;
    await unavailable(await b.get(request()));
    assert.deepEqual(b.calls, []);
  }
});
test("closure after refund completion refuses the independent preparation entry", async () => {
  const f = admission(),
    b = business(f, { closeAfterRefund: true });
  await unavailable(await b.get(request()));
  assert.deepEqual(b.calls, []);
});
test("preparation remains independent of new work and binds tracking identities", async () => {
  const f = admission(),
    b = business(f);
  const response = await b.get(request());
  assert.equal(response.status, 200);
  assert.deepEqual(b.calls, [
    "flag",
    "abandon",
    "list",
    "enqueue:one",
    "enqueue:two",
    "worker",
    "redact",
  ]);
  const result = await response.json();
  assert.equal(result.queued, 2);
  assert.equal(result.abandoned, 2);
  assert.equal(
    f.calls.find((c) => c.sql.includes("begin_operation"))?.values?.[1],
    "recovery",
  );
});
test("disabled and empty preparation batches retain normal summaries", async () => {
  for (const disabled of [false, true]) {
    const f = admission(),
      b = business(f, { disabled, empty: true });
    const response = await b.get(request());
    assert.equal(response.status, 200);
    assert.deepEqual(f.state.outcomes, ["completed"]);
    assert.equal(
      b.calls.some((c) => c.startsWith("enqueue:")),
      false,
    );
    if (disabled)
      assert.deepEqual(await response.json(), {
        enabled: false,
        queued: 0,
        refunds: { processed: 0, succeeded: 0, needsReview: 0 },
      });
  }
});
test("preparation stays active through abandonment, selection and every enqueue after closure", async () => {
  for (const stage of ["abandon", "list", "enqueue:one", "enqueue:two"]) {
    const f = admission(),
      held = latch(),
      b = business(f, {
        wait: async (current) => {
          if (current === stage) await held.wait();
        },
      });
    const pending = b.get(request());
    await held.entered;
    try {
      f.state.recovery = false;
      await unavailable(await b.get(request()));
      assert.deepEqual(f.state.outcomes, []);
    } finally {
      held.release();
    }
    assert.equal((await pending).status, 200);
    assert.deepEqual(f.state.outcomes, ["completed"]);
  }
});
test("preparation errors retain uncertainty and prevent worker and redaction", async () => {
  for (const fail of ["abandon", "list", "enqueue:one", "enqueue:two"]) {
    const f = admission(),
      b = business(f, { fail });
    await unavailable(await b.get(request()));
    assert.deepEqual(f.state.outcomes, ["uncertain"]);
    assert.equal(b.calls.includes("worker"), false);
    assert.equal(b.calls.includes("redact"), false);
  }
});
test("missing quote receipts retain uncertainty through later preparation effects", async () => {
  const f = admission(),
    b = business(f, { uncertain: true });
  await unavailable(await b.get(request()));
  assert.equal(b.calls.includes("enqueue:two"), true);
  assert.equal(b.calls.includes("worker"), false);
  assert.deepEqual(f.state.outcomes, ["uncertain"]);
});
test("lost ledger socket or acknowledgement never replays preparation", async () => {
  for (const fault of ["socket", "settlement"]) {
    const f = admission();
    f.state.loseSettlement = fault === "settlement";
    const b = business(f, {
      wait: async (stage) => {
        if (fault === "socket" && stage === "enqueue:one")
          f.client.emit("error", new Error("owned-private-detail"));
      },
    });
    await unavailable(await b.get(request()));
    assert.equal(b.calls.filter((c) => c === "enqueue:one").length, 1);
    assert.equal(b.calls.filter((c) => c === "enqueue:two").length, 1);
    assert.equal(b.calls.includes("worker"), false);
  }
});
test("off mode preserves counters, errors and continued shipping after receipt markers", async () => {
  const f = admission(),
    b = business(f, { off: true, uncertain: true });
  assert.equal((await b.get(request())).status, 200);
  assert.deepEqual(f.calls, []);
  const failed = await business(admission(), {
    off: true,
    fail: "enqueue:one",
  }).get(request());
  assert.equal(failed.status, 503);
  assert.equal(failed.headers.get("retry-after"), null);
  assert.deepEqual(Object.keys(await failed.json()), ["error", "incident"]);
});
test("worker failures happen after preparation settlement and stay outside this boundary", async () => {
  const f = admission(),
    b = business(f, { fail: "worker" });
  const response = await b.get(request());
  assert.equal(response.status, 503);
  assert.deepEqual(Object.keys(await response.json()), ["error", "incident"]);
  assert.deepEqual(f.state.outcomes, ["completed"]);
});
