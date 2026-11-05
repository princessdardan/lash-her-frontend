import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { GET as routeGet } from "@/app/api/admin/payment-reconciliation/route";
import {
  createPaymentReconciliationGetHandler,
  defaultDependencies,
} from "@/app/api/admin/payment-reconciliation/handler";
import {
  createSquareCapturePaymentOperations,
  runSquareCommerceCaptureReconciliation,
  type SquareCaptureReconciliationDependencies,
} from "@/lib/commerce/square-commerce-capture-reconciliation";
import {
  markSquareCommerceOrderCaptured,
  markSquareCommerceOrderUncollected,
} from "@/lib/commerce/order-store";
import { createSquarePaymentsClient } from "@/lib/payments/square/payments-client";
import { VERCEL_PROJECT_BINDINGS } from "@/lib/env/application-environment.mjs";
import {
  resolveWriterAdmissionConfiguration,
  WriterAdmissionError,
} from "./config";
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

const now = new Date("2032-01-01T12:00:00.000Z");
const request = (authorized = true) =>
  new Request("https://owned.invalid/api/admin/payment-reconciliation", {
    headers: authorized ? { authorization: "Bearer owned-cron-fixture" } : {},
  });
type Dependencies = Parameters<typeof createPaymentReconciliationGetHandler>[0];

function business(
  f: ReturnType<typeof admission>,
  options: {
    off?: boolean;
    statuses?: string[];
    fail?: string;
    wait?: (stage: string) => Promise<void>;
    disabled?: boolean;
    capture?: Partial<SquareCaptureReconciliationDependencies>;
  } = {},
) {
  const calls: string[] = [];
  const step = async (stage: string, admitted = true) => {
    if (admitted && !options.off) {
      assert.ok(f.calls.some((c) => c.sql.includes("begin_operation")));
      assert.equal(
        f.calls.some((c) => c.sql.includes("finish_operation")),
        false,
      );
    }
    calls.push(stage);
    await options.wait?.(stage);
    if (options.fail === stage) throw undefined;
  };
  const statuses = options.statuses ?? ["APPROVED", "COMPLETED"];
  const capture: SquareCaptureReconciliationDependencies = {
    findUncaptured: async (input) => {
      await step("list");
      assert.equal(input.paidBefore.toISOString(), "2032-01-01T11:55:00.000Z");
      assert.equal(input.limit, 100);
      return statuses.map((_, i) => ({
        orderId: `order-${i}`,
        providerPaymentId: `pay-${i}`,
        purpose: "product",
        providerMetadata: null,
      }));
    },
    getPaymentStatus: async (id) => {
      await step(`lookup:${id}`);
      return statuses[Number(id.slice(4))];
    },
    completePayment: async (id) => {
      await step(`complete:${id}`);
    },
    markCaptured: async (_, id) => {
      await step(`captured:${id}`);
    },
    markUncollected: async (_, id) => {
      await step(`uncollected:${id}`);
    },
    logError() {},
    logWarn() {},
    ...options.capture,
  };
  const live: NonNullable<Dependencies["runCommerceCaptureReconciliation"]> = (
    input,
    runner,
  ) =>
    runSquareCommerceCaptureReconciliation(input, runner, async () =>
      options.disabled
        ? null
        : {
            reconcileTrainingSplits: async () => {
              await step("training-splits", false);
            },
            capture,
          },
    );
  const get = createPaymentReconciliationGetHandler(
    {
      getCronSecrets: () => ["owned-cron-fixture"],
      getNow: () => now,
      logError() {},
      logWarn() {},
      runMonitor: async () => {
        await step("monitor", false);
        return { findings: [], ok: true, checkedAt: now.toISOString() };
      },
      retryBookingOutcomeEmails: async () => {
        await step("email", false);
        return { attempted: 0, failed: 0, processed: 0 };
      },
      runCommerceCaptureReconciliation: live,
    },
    (task) => task(),
    (task) =>
      (options.off ? f.off : f.run)("recovery", task, {
        uncertainResult: (summary) =>
          summary.failed > 0 || summary.uncollected > 0,
      }),
  );
  return { calls, get, live };
}

test("capture recovery authenticates before every effect and admits only the capture batch", async () => {
  const f = admission(),
    b = business(f);
  assert.equal((await b.get(request(false))).status, 401);
  assert.deepEqual(b.calls, []);
  assert.equal(f.calls.length, 0);
  assert.equal((await b.get(request())).status, 200);
  assert.deepEqual(b.calls, [
    "monitor",
    "email",
    "training-splits",
    "list",
    "lookup:pay-0",
    "complete:pay-0",
    "captured:pay-0",
    "lookup:pay-1",
    "captured:pay-1",
  ]);
  assert.deepEqual(f.state.outcomes, ["completed"]);
  assert.equal(
    f.calls.find((c) => c.sql.includes("begin_operation"))?.values?.[1],
    "recovery",
  );
});

test("closed capture recovery refuses before listing while independent sibling work still runs", async () => {
  const f = admission(),
    b = business(f);
  f.state.recovery = false;
  const response = await b.get(request());
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("retry-after"), "30");
  assert.deepEqual(b.calls, ["monitor", "email", "training-splits"]);
  assert.equal((await response.text()).includes("owned"), false);
});

test("capture recovery retains every admitted stage and later orders after closure", async () => {
  for (const stage of [
    "list",
    "lookup:pay-0",
    "complete:pay-0",
    "captured:pay-0",
    "uncollected:pay-0",
  ]) {
    const f = admission();
    let entered!: () => void, release!: () => void;
    const atStage = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const b = business(f, {
      statuses: stage.startsWith("uncollected")
        ? ["CANCELED", "COMPLETED"]
        : undefined,
      wait: async (s) => {
        if (s === stage) {
          entered();
          await gate;
        }
      },
    });
    const pending = b.get(request());
    await atStage;
    f.state.recovery = false;
    try {
      assert.deepEqual(f.state.outcomes, []);
      assert.equal((await b.get(request())).status, 503);
    } finally {
      release();
    }
    assert.equal(
      (await pending).status,
      stage.startsWith("uncollected") ? 503 : 200,
    );
    assert.ok(b.calls.includes("captured:pay-1"));
    assert.deepEqual(f.state.outcomes, [
      stage.startsWith("uncollected") ? "uncertain" : "completed",
    ]);
  }
});

test("capture failures including undefined rejections retain uncertainty and finish later orders", async () => {
  for (const stage of [
    "list",
    "lookup:pay-0",
    "complete:pay-0",
    "captured:pay-0",
    "uncollected:pay-0",
  ]) {
    const f = admission(),
      b = business(f, {
        fail: stage,
        statuses: stage.startsWith("uncollected")
          ? ["FAILED", "COMPLETED"]
          : undefined,
      });
    assert.equal((await b.get(request())).status, 503, stage);
    assert.deepEqual(f.state.outcomes, ["uncertain"], stage);
    if (stage !== "list") assert.ok(b.calls.includes("captured:pay-1"), stage);
  }
});

test("capture unknown and uncollected outcomes require review even after durable handling", async () => {
  for (const status of ["PENDING", "CANCELED", "FAILED"]) {
    const f = admission(),
      b = business(f, { statuses: [status, "COMPLETED"] });
    assert.equal((await b.get(request())).status, 503);
    assert.deepEqual(f.state.outcomes, ["uncertain"]);
    assert.ok(b.calls.includes("captured:pay-1"));
    assert.equal(b.calls.includes("uncollected:pay-0"), status !== "PENDING");
  }
});

test("disabled commerce does not enter admission and empty enabled batches settle", async () => {
  for (const disabled of [true, false]) {
    const f = admission(),
      b = business(f, { disabled, statuses: [] });
    assert.equal((await b.get(request())).status, 200);
    assert.deepEqual(f.state.outcomes, disabled ? [] : ["completed"]);
    assert.equal(b.calls.includes("list"), !disabled);
  }
});

test("capture admission-off preserves monitor-derived status for partial or thrown failures", async () => {
  for (const fail of ["list", "complete:pay-0", undefined]) {
    const f = admission(),
      b = business(f, {
        off: true,
        fail,
        statuses: fail ? undefined : ["FAILED"],
      });
    assert.equal((await b.get(request())).status, 200);
    assert.deepEqual(f.calls, []);
  }
});

test("capture socket loss and settlement acknowledgement loss never replay effects", async () => {
  for (const mode of ["socket", "settlement"]) {
    const f = admission();
    f.state.loseSettlement = mode === "settlement";
    let effects = 0;
    const b = business(f, {
      capture: {
        completePayment: async () => {
          effects++;
          if (mode === "socket")
            f.client.emit("error", new Error("owned-private-detail"));
        },
      },
    });
    assert.equal((await b.get(request())).status, 503);
    assert.equal(effects, 1);
    assert.ok(b.calls.includes("captured:pay-1"));
  }
});

test("monitor or email failures do not skip capture, while a training-split failure precedes capture admission", async () => {
  for (const fail of ["monitor", "email", "training-splits"]) {
    const f = admission(),
      b = business(f, { fail });
    assert.equal(
      (await b.get(request())).status,
      fail === "monitor" ? 503 : 200,
    );
    assert.deepEqual(
      f.state.outcomes,
      fail === "training-splits" ? [] : ["completed"],
    );
    assert.equal(
      b.calls.includes("captured:pay-1"),
      fail !== "training-splits",
    );
  }
});

test("actual capture receipt mutation distinguishes a written row from a missing target", async () => {
  for (const matched of [true, false]) {
    const f = admission();
    const db = {
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => (matched ? [{ id: "owned-order" }] : []),
          }),
        }),
      }),
    };
    const b = business(f, {
      capture: {
        markCaptured: (order, payment) =>
          markSquareCommerceOrderCaptured(
            order,
            payment,
            db as unknown as Parameters<
              typeof markSquareCommerceOrderCaptured
            >[2],
          ),
      },
    });
    assert.equal((await b.get(request())).status, matched ? 200 : 503);
    assert.deepEqual(f.state.outcomes, [matched ? "completed" : "uncertain"]);
  }
});

test("actual uncollected mutation retains uncertainty for a missing paid order", async () => {
  const f = admission();
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({ for: () => ({ limit: async () => [] }) }),
      }),
    }),
  };
  const db = {
    transaction: async (task: (tx: unknown) => Promise<unknown>) => task(tx),
  };
  await assert.rejects(
    f.run("recovery", async () => {
      await markSquareCommerceOrderUncollected(
        "owned-order",
        "owned-payment",
        db as unknown as Parameters<
          typeof markSquareCommerceOrderUncollected
        >[2],
      );
    }),
    WriterAdmissionError,
  );
  assert.deepEqual(f.state.outcomes, ["uncertain"]);
});

test("actual Square HTTP adapter rejects mismatched lookups and unconfirmed completion before local receipts", async () => {
  const previous = globalThis.fetch;
  try {
    for (const mode of [
      "lookup-id",
      "complete-id",
      "complete-status",
      "valid",
    ]) {
      const paths: string[] = [];
      globalThis.fetch = async (input) => {
        const url = String(input);
        paths.push(url);
        const complete = url.endsWith("/complete");
        return Response.json({
          payment: {
            id:
              mode === "lookup-id" || (complete && mode === "complete-id")
                ? "other-payment"
                : "pay-0",
            status:
              complete && mode !== "complete-status" ? "COMPLETED" : "APPROVED",
            amount_money: { amount: 10000, currency: "CAD" },
          },
        });
      };
      const operations = createSquareCapturePaymentOperations(
        createSquarePaymentsClient({
          environment: "sandbox",
          accessToken: "owned-fixture",
        }),
      );
      const f = admission(),
        b = business(f, { statuses: ["APPROVED"], capture: operations });
      assert.equal(
        (await b.get(request())).status,
        mode === "valid" ? 200 : 503,
        mode,
      );
      assert.equal(b.calls.includes("captured:pay-0"), mode === "valid", mode);
      assert.equal(paths.length, mode === "lookup-id" ? 1 : 2);
    }
  } finally {
    globalThis.fetch = previous;
  }
});

test("production route supplies separate capture admission and keeps siblings outside it", async () => {
  const previous = { ...defaultDependencies },
    previousMode = process.env.FRONTEND_WRITER_ADMISSION_MODE;
  const calls: string[] = [];
  Object.assign(defaultDependencies, {
    getCronSecrets: () => ["owned-cron-fixture"],
    getNow: () => now,
    logError() {},
    logWarn() {},
    runMonitor: async () => {
      calls.push("monitor");
      process.env.FRONTEND_WRITER_ADMISSION_MODE = "invalid-owned-fixture";
      return { findings: [], ok: true, checkedAt: now.toISOString() };
    },
    retryBookingOutcomeEmails: async () => {
      calls.push("email");
      return { attempted: 0, failed: 0, processed: 0 };
    },
    runCommerceCaptureReconciliation: async (
      _input: unknown,
      runner: Parameters<typeof runSquareCommerceCaptureReconciliation>[1],
    ) => {
      calls.push("training-splits");
      assert.ok(runner);
      return runner(async () => {
        calls.push("capture");
        return {
          checked: 0,
          completed: 0,
          captured: 0,
          failed: 0,
          uncollected: 0,
        };
      });
    },
  });
  process.env.FRONTEND_WRITER_ADMISSION_MODE = "off";
  try {
    assert.equal((await routeGet(request())).status, 503);
    assert.deepEqual(calls, ["monitor", "training-splits"]);
  } finally {
    Object.assign(defaultDependencies, previous);
    if (previousMode === undefined)
      delete process.env.FRONTEND_WRITER_ADMISSION_MODE;
    else process.env.FRONTEND_WRITER_ADMISSION_MODE = previousMode;
  }
});
