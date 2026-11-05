import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { GET as routeGet } from "@/app/api/admin/payment-reconciliation/route";
import {
  createPaymentReconciliationGetHandler,
  defaultDependencies,
} from "@/app/api/admin/payment-reconciliation/handler";
import {
  createDrizzleServiceReconciliationRepository,
  createServiceReconciliationMonitor,
  type ServiceReconciliationMonitorDependencies,
  type ServiceReconciliationRepository,
} from "@/lib/booking/payments/service-reconciliation-monitor";
import { VERCEL_PROJECT_BINDINGS } from "@/lib/env/application-environment.mjs";
import { markWriterOperationUncertain } from "./context";
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
          rows: [{ epoch: "7", new_work: false, recovery: state.recovery }],
        };
      if (sql.includes("finish_operation")) {
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
const request = (authorized = true) =>
  new Request("https://owned.invalid/api/admin/payment-reconciliation", {
    headers: authorized ? { authorization: "Bearer owned-cron-fixture" } : {},
  });
const queryNames = [
  "findAuthorizedOperationalPayments",
  "findCapturedPaymentsWithoutOperationalAppointment",
  "findAmountCurrencyCustomerMismatches",
  "findBookedAppointmentsWithoutNoShowChargeRecord",
  "findBookedAppointmentsWithoutPolicyAcceptance",
  "findBookedAppointmentsWithoutSavedPaymentMethod",
  "findConfirmedBookingsWithoutNoShowInvoice",
  "findFailedNoShowCharges",
  "findNoShowChargeFailedNotAlerted",
  "findNoShowChargesPendingTooLong",
  "findOperationalAppointmentsPendingCalendar",
  "findOperationalAppointmentsWithoutCapturedPayment",
  "findPaidBookingsNotBooked",
  "findSquareInvoicePaymentEventsNotReconciled",
  "findSquarePaymentsPendingTooLong",
] as const;
const attempt = (index = 0) => ({
  amountCents: 1000,
  currency: "CAD",
  holdId: `hold-${index}`,
  idempotencyKey: `key-${index}`,
  paymentAttemptId: `attempt-${index}`,
  referenceId: `reference-${index}`,
  squareCustomerId: "customer",
  squareOrderId: `order-${index}`,
  squarePaymentId: `payment-${index}`,
});

function business(
  f: ReturnType<typeof admission>,
  options: {
    off?: boolean;
    empty?: boolean;
    status?: string;
    fail?: string;
    sticky?: boolean;
    wait?: (stage: string) => Promise<void>;
    repository?: Partial<ServiceReconciliationRepository>;
    provider?:
      | ServiceReconciliationMonitorDependencies["providerPayments"]
      | null;
  } = {},
) {
  const calls: string[] = [];
  const step = async (stage: string) => {
    calls.push(stage);
    if (!options.off) {
      assert.ok(
        f.calls.some((c) => c.sql.includes("begin_operation")),
        stage,
      );
      assert.deepEqual(f.state.outcomes, [], stage);
    }
    await options.wait?.(stage);
    if (stage === options.fail) throw undefined;
  };
  const repository = Object.fromEntries(
    queryNames.map((name) => [
      name,
      async () => {
        await step(name);
        return name === "findAuthorizedOperationalPayments" && !options.empty
          ? [attempt(), attempt(1)]
          : [];
      },
    ]),
  ) as unknown as ServiceReconciliationRepository;
  Object.assign(repository, {
    recordProviderCompletedOperationalPayment: async (input: {
      holdId: string;
    }) => {
      await step(`record:${input.holdId}`);
      if (options.sticky) markWriterOperationUncertain();
    },
    markOperationalPaymentFailed: async () => step("failed"),
    markOperationalPaymentRefundRequired: async () => step("refund"),
    markOperationalPaymentTerminated: async (input: {
      status: "cancelled" | "failed";
    }) => {
      await step("terminate");
      return input.status;
    },
    ...options.repository,
  });
  const monitor = createServiceReconciliationMonitor({
    repository,
    alerts: {
      alert: async () => {
        await step("alert");
      },
    },
    providerPayments:
      options.provider === null
        ? undefined
        : (options.provider ?? {
            getPayment: async (paymentId) => {
              await step(`lookup:${paymentId}`);
              const value = attempt(paymentId.endsWith("1") ? 1 : 0);
              return {
                payment: {
                  id: paymentId,
                  status: options.status ?? "COMPLETED",
                  reference_id: value.referenceId,
                  customer_id: value.squareCustomerId,
                  order_id: value.squareOrderId,
                  amount_money: {
                    amount: options.status === "APPROVED" ? 999 : 1000,
                    currency: "CAD",
                  },
                },
              };
            },
            cancelPayment: async (id) => {
              await step("cancel");
              return {
                payment: {
                  id,
                  status: "CANCELED",
                  amount_money: { amount: 1000, currency: "CAD" },
                },
              };
            },
          }),
  });
  const get = createPaymentReconciliationGetHandler(
    {
      getCronSecrets: () => ["owned-cron-fixture"],
      getNow: () => now,
      logError() {},
      logWarn() {},
      runMonitor: (input) => monitor.run(input),
      retryBookingOutcomeEmails: async () => {
        calls.push("email");
        if (
          !options.off &&
          f.calls.some((c) => c.sql.includes("begin_operation"))
        )
          assert.notDeepEqual(f.state.outcomes, []);
        return { attempted: 0, processed: 0, failed: 0 };
      },
      runCommerceCaptureReconciliation: async () => {
        calls.push("commerce");
        return null;
      },
    },
    undefined,
    undefined,
    undefined,
    (task) =>
      (options.off ? f.off : f.run)("recovery", task, {
        uncertainResult: (summary) => !summary.ok,
      }),
  );
  return { get, calls, repository, monitor };
}

test("service monitor authenticates before independent admission and settles before sibling batches", async () => {
  const f = admission(),
    b = business(f);
  assert.equal((await b.get(request(false))).status, 401);
  assert.equal(b.calls.length, 0);
  assert.equal(f.calls.length, 0);
  assert.equal((await b.get(request())).status, 200);
  assert.deepEqual(f.state.outcomes, ["completed"]);
  assert.deepEqual(b.calls.slice(-2), ["email", "commerce"]);
  assert.equal(
    f.calls.find((c) => c.sql.includes("begin_operation"))?.values?.[1],
    "recovery",
  );
});

test("service admission refusal precedes queries and still permits independent later batches", async () => {
  const f = admission(),
    b = business(f);
  f.state.recovery = false;
  const response = await b.get(request());
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("retry-after"), "30");
  assert.equal((await response.text()).includes("owned"), false);
  assert.deepEqual(b.calls, ["email", "commerce"]);
});

test("service recovery retains admission through queries, lookup, projection, cancellation and local remediation", async () => {
  for (const stage of [
    "findAuthorizedOperationalPayments",
    "lookup:payment-0",
    "record:hold-0",
    "alert",
    "cancel",
    "terminate",
    "failed",
    "refund",
  ]) {
    const f = admission();
    let entered!: () => void, release!: () => void;
    const atStage = new Promise<void>((r) => {
      entered = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const b = business(f, {
      status: ["alert", "cancel", "terminate", "failed", "refund"].includes(
        stage,
      )
        ? "APPROVED"
        : "COMPLETED",
      fail: stage === "refund" ? "cancel" : undefined,
      wait: async (current) => {
        if (current === stage) {
          entered();
          await gate;
        }
      },
    });
    const pending = b.get(request());
    await atStage;
    f.state.recovery = false;
    assert.deepEqual(f.state.outcomes, []);
    release();
    const response = await pending;
    assert.equal(
      response.status,
      ["alert", "cancel", "terminate", "failed", "refund"].includes(stage)
        ? 503
        : 200,
      stage,
    );
    assert.ok(b.calls.includes("lookup:payment-1"), stage);
  }
});

test("service failed concurrent checks wait for every sibling before uncertain settlement", async () => {
  const f = admission();
  let entered!: () => void, release!: () => void;
  const atSibling = new Promise<void>((r) => {
    entered = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const b = business(f, {
    fail: "findAuthorizedOperationalPayments",
    wait: async (stage) => {
      if (stage === "findSquarePaymentsPendingTooLong") {
        entered();
        await gate;
      }
    },
  });
  const pending = b.get(request());
  await atSibling;
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(f.state.outcomes, []);
  assert.equal(b.calls.includes("email"), false);
  release();
  assert.equal((await pending).status, 503);
  assert.deepEqual(f.state.outcomes, ["uncertain"]);
  assert.equal(
    b.calls.some((c) => c.startsWith("lookup:")),
    false,
  );
});

test("actual mismatch repository awaits all four query siblings after one rejects", async () => {
  let started = 0,
    release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const db = {
    select() {
      const index = started++;
      const query = new Proxy(
        {},
        {
          get(_target, property) {
            if (property === "then")
              return (
                resolve: (rows: unknown[]) => void,
                reject: (error: unknown) => void,
              ) => {
                const operation =
                  index === 0 ? Promise.reject(undefined) : gate.then(() => []);
                return operation.then(resolve, reject);
              };
            return () => query;
          },
        },
      );
      return query;
    },
  } as unknown as Parameters<
    typeof createDrizzleServiceReconciliationRepository
  >[0];
  const repository = createDrizzleServiceReconciliationRepository(db);
  let settled = false;
  const pending = repository
    .findAmountCurrencyCustomerMismatches(now)
    .finally(() => {
      settled = true;
    });
  const rejected = assert.rejects(pending);
  await new Promise((r) => setImmediate(r));
  assert.equal(started, 4);
  assert.equal(settled, false);
  release();
  await rejected;
});

test("caught service lookup and persistence failures retain uncertainty while later attempts finish", async () => {
  for (const fail of [
    "lookup:payment-0",
    "record:hold-0",
    "terminate",
    "failed",
    "cancel",
    "refund",
  ]) {
    const f = admission(),
      b = business(f, {
        fail,
        status: ["terminate", "failed"].includes(fail)
          ? "CANCELED"
          : ["cancel", "refund"].includes(fail)
            ? "APPROVED"
            : "COMPLETED",
        repository:
          fail === "refund"
            ? {
                markOperationalPaymentRefundRequired: async () => {
                  throw undefined;
                },
              }
            : undefined,
        provider:
          fail === "refund"
            ? {
                getPayment: async (id) => ({
                  payment: {
                    id,
                    status: "COMPLETED",
                    amount_money: { amount: 999, currency: "CAD" },
                  },
                }),
              }
            : undefined,
      });
    assert.equal((await b.get(request())).status, 503, fail);
    assert.deepEqual(f.state.outcomes, ["uncertain"], fail);
    if (fail !== "refund")
      assert.ok(b.calls.includes("lookup:payment-1"), fail);
    assert.deepEqual(b.calls.slice(-2), ["email", "commerce"]);
  }
});

test("success-shaped projection cannot clear operation-local uncertainty", async () => {
  const f = admission(),
    b = business(f, { sticky: true });
  assert.equal((await b.get(request())).status, 503);
  assert.deepEqual(f.state.outcomes, ["uncertain"]);
  assert.ok(b.calls.includes("record:hold-1"));
});

test("selected attempts without usable request intent cannot settle as completed", async () => {
  for (const providerMetadata of [
    null,
    {},
    { squareRequestIntent: null },
    { squareRequestIntent: { squareCustomerId: "" } },
  ]) {
    for (const off of [false, true]) {
      const f = admission();
      const valid = attempt(1);
      const rows = [
        { ...attempt(), providerMetadata },
        {
          ...valid,
          providerMetadata: {
            squareRequestIntent: { squareCustomerId: valid.squareCustomerId },
          },
        },
      ];
      const db = {
        select: () => ({
          from: () => ({
            innerJoin: () => ({ where: async () => rows }),
          }),
        }),
      } as unknown as Parameters<
        typeof createDrizzleServiceReconciliationRepository
      >[0];
      const repository = createDrizzleServiceReconciliationRepository(db);
      const b = business(f, {
        off,
        repository: {
          findAuthorizedOperationalPayments:
            repository.findAuthorizedOperationalPayments,
        },
      });
      const response = await b.get(request());
      assert.equal(response.status, off ? 200 : 503);
      assert.deepEqual(f.state.outcomes, off ? [] : ["uncertain"]);
      if (off) {
        assert.equal((await response.json()).ok, true);
      } else {
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.equal(response.headers.get("retry-after"), "30");
      }
      assert.equal(b.calls.includes("lookup:payment-0"), false);
      assert.ok(b.calls.includes("record:hold-1"));
      assert.deepEqual(b.calls.slice(-2), ["email", "commerce"]);
    }
  }
});

test("service findings remain uncertain including warnings, missing provider, and unknown or terminal states", async () => {
  for (const status of [
    "APPROVED",
    "CANCELED",
    "FAILED",
    "DECLINED",
    "PENDING",
    "UNKNOWN",
  ]) {
    const f = admission(),
      b = business(f, { status });
    assert.equal((await b.get(request())).status, 503, status);
    assert.deepEqual(f.state.outcomes, ["uncertain"], status);
  }
  const f = admission(),
    b = business(f, {
      empty: true,
      repository: {
        findConfirmedBookingsWithoutNoShowInvoice: async () => [
          { holdId: "owned-hold" },
        ],
      },
    });
  assert.equal((await b.get(request())).status, 503);
  assert.deepEqual(f.state.outcomes, ["uncertain"]);
  const missing = admission(),
    unavailable = business(missing, { provider: null });
  assert.equal((await unavailable.get(request())).status, 503);
  assert.deepEqual(missing.state.outcomes, ["uncertain"]);
});

test("unrelated provider payment IDs never trigger cancellation, refund or terminal writes", async () => {
  for (const status of [
    "APPROVED",
    "COMPLETED",
    "CANCELED",
    "FAILED",
    "DECLINED",
  ]) {
    const f = admission(),
      b = business(f, {
        provider: {
          getPayment: async () => ({
            payment: {
              id: "other",
              status,
              amount_money: { amount: 1000, currency: "CAD" },
            },
          }),
          cancelPayment: async () => {
            throw new Error("unexpected cancellation");
          },
        },
      });
    assert.equal((await b.get(request())).status, 503, status);
    assert.equal(
      b.calls.some(
        (c) =>
          ["cancel", "refund", "terminate", "failed"].includes(c) ||
          c.startsWith("record:"),
      ),
      false,
      status,
    );
    assert.deepEqual(f.state.outcomes, ["uncertain"], status);
  }
});

test("completed payment with wrong immutable Square order cannot finalize", async () => {
  const f = admission(),
    b = business(f, {
      provider: {
        getPayment: async (id) => ({
          payment: {
            id,
            status: "COMPLETED",
            reference_id: attempt(id.endsWith("1") ? 1 : 0).referenceId,
            customer_id: "customer",
            order_id: "other-order",
            amount_money: { amount: 1000, currency: "CAD" },
          },
        }),
      },
    });
  assert.equal((await b.get(request())).status, 503);
  assert.equal(
    b.calls.some((c) => c.startsWith("record:")),
    false,
  );
  assert.ok(b.calls.includes("refund"));
});

test("empty and admission-off service runs preserve existing behavior", async () => {
  const f = admission(),
    b = business(f, { empty: true });
  assert.equal((await b.get(request())).status, 200);
  assert.deepEqual(f.state.outcomes, ["completed"]);
  const off = admission(),
    direct = business(off, { off: true, status: "UNKNOWN" });
  assert.equal((await direct.get(request())).status, 200);
  assert.deepEqual(off.state.outcomes, []);
});

test("service socket and settlement loss never replay provider or projection effects", async () => {
  for (const mode of ["socket", "settlement"]) {
    const f = admission();
    f.state.loseSettlement = mode === "settlement";
    const b = business(f, {
      wait: async (stage) => {
        if (mode === "socket" && stage === "record:hold-0")
          f.client.emit("error", new Error("owned-private-detail"));
      },
    });
    assert.equal((await b.get(request())).status, 503);
    assert.equal(b.calls.filter((c) => c === "record:hold-0").length, 1);
    assert.ok(b.calls.includes("record:hold-1"));
  }
});

test("production route refuses service admission before the actual monitor starts", async () => {
  const previous = { ...defaultDependencies },
    mode = process.env.FRONTEND_WRITER_ADMISSION_MODE;
  let called = false;
  Object.assign(defaultDependencies, {
    getCronSecrets: () => ["owned-cron-fixture"],
    getNow: () => now,
    logError() {},
    logWarn() {},
    runMonitor: async () => {
      called = true;
      return { ok: true, findings: [], checkedAt: now.toISOString() };
    },
    retryBookingOutcomeEmails: undefined,
    runCommerceCaptureReconciliation: undefined,
  });
  process.env.FRONTEND_WRITER_ADMISSION_MODE = "invalid-owned-fixture";
  try {
    assert.equal((await routeGet(request())).status, 503);
    assert.equal(called, false);
  } finally {
    Object.assign(defaultDependencies, previous);
    if (mode === undefined) delete process.env.FRONTEND_WRITER_ADMISSION_MODE;
    else process.env.FRONTEND_WRITER_ADMISSION_MODE = mode;
  }
});
