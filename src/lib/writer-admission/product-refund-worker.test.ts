import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { GET as routeGet } from "@/app/api/cron/chitchats-shipping/route";
import {
  createShippingWorkerCronHandler,
  defaultDependencies,
} from "@/app/api/cron/chitchats-shipping/handler";
import {
  drainQueuedProductOrderRefunds,
  type ProductRefundDrainDependencies,
} from "@/lib/shipping/customer-refunds";
import { createSquareProductRefunder } from "@/lib/payments/square/product-refund";
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

type Refund = Awaited<
  ReturnType<ProductRefundDrainDependencies["processRefund"]>
>;
const request = (token = "owned-cron") =>
  new Request("https://owned.invalid/api/cron/chitchats-shipping", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
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
function business(
  f: ReturnType<typeof admission>,
  options: {
    off?: boolean;
    empty?: boolean;
    disabled?: boolean;
    queryError?: boolean;
    status?: Refund["status"];
    processError?: boolean;
    undefinedError?: boolean;
    alertError?: boolean;
    shipping?: boolean;
    wait?: (stage: string) => Promise<void>;
  } = {},
) {
  const calls: string[] = [];
  const step = async (stage: string) => {
    if (!options.off) {
      assert.ok(f.calls.some((c) => c.sql.includes("begin_operation")));
      assert.deepEqual(f.state.outcomes, []);
    }
    calls.push(stage);
    await options.wait?.(stage);
  };
  const dependencies: ProductRefundDrainDependencies = {
    listCandidates: async (_now, limit) => {
      await step("list");
      assert.equal(limit, 25);
      if (options.queryError) throw new Error("owned-private-detail");
      return options.empty ? [] : ["one", "two"];
    },
    processRefund: async (id) => {
      await step(`process:${id}`);
      if (id === "one" && options.processError)
        throw options.undefinedError
          ? undefined
          : new Error("owned-private-detail");
      return {
        id,
        status: id === "one" ? (options.status ?? "succeeded") : "succeeded",
      } as Refund;
    },
    alert: async () => {
      await step("alert");
      if (options.alertError) throw new Error("owned-private-detail");
      return 1;
    },
  };
  const downstream = async (name: string) => {
    if (!options.off) assert.deepEqual(f.state.outcomes, ["completed"]);
    calls.push(name);
  };
  const get = createShippingWorkerCronHandler(
    {
      ...defaultDependencies,
      isSquareCommerceCheckoutEnabled: () => {
        if (!options.off)
          assert.ok(f.calls.some((c) => c.sql.includes("begin_operation")));
        calls.push("flag");
        return !options.disabled;
      },
      drainQueuedProductOrderRefunds: () =>
        drainQueuedProductOrderRefunds(undefined, dependencies),
      isChitChatsShippingEnabled: () => options.shipping === true,
      abandonExpiredQuotes: async () => {
        await downstream("abandon");
        return 0;
      },
      listShipmentsDueForPolling: async () => {
        await downstream("poll");
        return [];
      },
      runShippingOperationWorker: async () => {
        await downstream("shipping");
        return {
          claimed: 0,
          succeeded: 0,
          retried: 0,
          deadLettered: 0,
          fenced: 0,
        };
      },
      redactExpiredShipmentPii: async () => {
        await downstream("redact");
        return 0;
      },
    },
    (task) =>
      (options.off ? f.off : f.run)("recovery", task, {
        uncertainResult: (result) =>
          result.needsReview > 0 ||
          result.refunds.some((refund) => refund.status !== "succeeded"),
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

test("refund cron authenticates both accepted secrets before admission or configuration", async () => {
  const f = admission(),
    b = business(f);
  assert.equal((await b.get(request(""))).status, 401);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(b.calls, []);
  delete process.env.CRON_SECRET;
  try {
    assert.equal((await b.get(request())).status, 401);
    process.env.CHITCHATS_WORKER_CRON_SECRET = " owned-alternate ";
    assert.equal((await b.get(request("owned-alternate"))).status, 200);
  } finally {
    process.env.CRON_SECRET = "owned-cron";
    delete process.env.CHITCHATS_WORKER_CRON_SECRET;
  }
});
test("closed refund recovery refuses before enabled checks, candidate query and downstream shipping", async () => {
  for (const disabled of [false, true]) {
    const f = admission(),
      b = business(f, { disabled, shipping: true });
    f.state.recovery = false;
    await unavailable(await b.get(request()));
    assert.deepEqual(b.calls, []);
  }
});
test("refunds run independently of new work and await the complete batch", async () => {
  const f = admission(),
    b = business(f);
  const response = await b.get(request());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    enabled: false,
    queued: 0,
    refunds: { processed: 2, succeeded: 2, needsReview: 0 },
  });
  assert.deepEqual(b.calls, ["flag", "list", "process:one", "process:two"]);
  assert.deepEqual(f.state.outcomes, ["completed"]);
  assert.equal(
    f.calls.find((c) => c.sql.includes("begin_operation"))?.values?.[1],
    "recovery",
  );
});
test("disabled Square and empty batches complete without business processing", async () => {
  for (const options of [{ disabled: true }, { empty: true }]) {
    const f = admission(),
      b = business(f, options);
    assert.equal((await b.get(request())).status, 200);
    assert.deepEqual(f.state.outcomes, ["completed"]);
    assert.equal(
      b.calls.some((c) => c.startsWith("process:")),
      false,
    );
  }
});
test("refund entry survives policy closure through selection, processing, alert and later rows", async () => {
  for (const stage of ["list", "process:one", "alert", "process:two"]) {
    const f = admission(),
      held = latch(),
      b = business(f, {
        status: stage === "alert" ? "outcome_unknown" : undefined,
        wait: async (current) => {
          if (current === stage) await held.wait();
        },
      });
    const pending = b.get(request());
    await held.entered;
    try {
      assert.deepEqual(f.state.outcomes, []);
      f.state.recovery = false;
      await unavailable(await b.get(request()));
      assert.equal(b.calls.filter((c) => c === "list").length, 1);
    } finally {
      held.release();
    }
    const response = await pending;
    if (stage === "alert") await unavailable(response);
    else assert.equal(response.status, 200);
    assert.equal(b.calls.includes("process:two"), true);
  }
});
test("nonsettled refund states retain uncertainty and finish later rows", async () => {
  for (const status of [
    "manual_review",
    "outcome_unknown",
    "processing",
    "queued",
    "failed",
  ] as const) {
    const f = admission(),
      b = business(f, { status });
    await unavailable(await b.get(request()));
    assert.deepEqual(f.state.outcomes, ["uncertain"]);
    assert.equal(b.calls.includes("process:two"), true);
  }
});
test("caught errors and rejected alerts retain uncertainty without skipping later refunds", async () => {
  for (const options of [
    { processError: true },
    { processError: true, undefinedError: true },
    { status: "outcome_unknown" as const, alertError: true },
  ]) {
    const f = admission(),
      b = business(f, options);
    await unavailable(await b.get(request()));
    assert.equal(b.calls.includes("process:two"), true);
    assert.deepEqual(f.state.outcomes, ["uncertain"]);
  }
});
test("query errors settle uncertain and use a sanitized enforced response", async () => {
  const f = admission(),
    b = business(f, { queryError: true });
  await unavailable(await b.get(request()));
  assert.deepEqual(f.state.outcomes, ["uncertain"]);
});
test("off mode preserves existing refund summaries, unknown-state behavior and incident failures", async () => {
  for (const status of [
    "succeeded",
    "manual_review",
    "outcome_unknown",
    "processing",
  ] as const) {
    const f = admission(),
      b = business(f, { off: true, status });
    const response = await b.get(request());
    assert.equal(
      response.status,
      ["manual_review", "outcome_unknown"].includes(status) ? 503 : 200,
    );
    assert.equal(response.headers.get("retry-after"), null);
    assert.deepEqual(f.calls, []);
  }
  const response = await business(admission(), {
    off: true,
    queryError: true,
  }).get(request());
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), null);
  assert.deepEqual(Object.keys(await response.json()), ["error", "incident"]);
});
test("downstream shipping remains a separate unqualified execution after refund settlement", async () => {
  const f = admission(),
    b = business(f, { shipping: true });
  assert.equal((await b.get(request())).status, 200);
  assert.deepEqual(b.calls.slice(-4), [
    "abandon",
    "poll",
    "shipping",
    "redact",
  ]);
  assert.deepEqual(f.state.outcomes, ["completed"]);
});
test("lost ledger socket or completion acknowledgement never replays a refund", async () => {
  for (const fault of ["socket", "settlement"]) {
    const f = admission();
    f.state.loseSettlement = fault === "settlement";
    const b = business(f, {
      wait: async (stage) => {
        if (fault === "socket" && stage === "process:one")
          f.client.emit("error", new Error("owned-private-detail"));
      },
    });
    await unavailable(await b.get(request()));
    assert.equal(b.calls.filter((c) => c === "process:one").length, 1);
    assert.equal(b.calls.filter((c) => c === "process:two").length, 1);
  }
});
test("missing provider payment identity keeps the legacy fallback but cannot prove settlement", async () => {
  const refunder = createSquareProductRefunder({
    refundPayment: async () => ({
      refund: {
        id: "owned-refund",
        status: "COMPLETED",
        amount_money: { amount: 1000, currency: "CAD" },
      },
    }),
  });
  const input = {
    paymentId: "owned-payment",
    amountCents: 1000,
    currency: "CAD",
    idempotencyKey: "owned-key",
  };
  const legacy = await refunder.refundPayment(input);
  assert.equal(legacy.ok, true);
  const f = admission();
  await assert.rejects(f.run("recovery", () => refunder.refundPayment(input)));
  assert.deepEqual(f.state.outcomes, ["uncertain"]);
});
test("actual shipping route refuses invalid admission configuration before business access", async () => {
  const mode = process.env.FRONTEND_WRITER_ADMISSION_MODE;
  try {
    process.env.FRONTEND_WRITER_ADMISSION_MODE = "invalid-owned-fixture";
    await unavailable(await routeGet(request()));
  } finally {
    if (mode === undefined) delete process.env.FRONTEND_WRITER_ADMISSION_MODE;
    else process.env.FRONTEND_WRITER_ADMISSION_MODE = mode;
  }
});
