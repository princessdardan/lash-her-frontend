import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { GET as routeGet } from "@/app/api/admin/payment-reconciliation/route";
import {
  createPaymentReconciliationGetHandler,
  defaultDependencies,
} from "@/app/api/admin/payment-reconciliation/handler";
import {
  createTrainingSplitCancellationOperation,
  reconcileTrainingSplits,
  type TrainingSplitReconciliationSummary,
} from "@/lib/commerce/square-training-split-live";
import {
  runSquareCommerceCaptureReconciliation,
  type SquareCaptureReconciliationDependencies,
} from "@/lib/commerce/square-commerce-capture-reconciliation";
import {
  chargeTrainingSplit,
  type TrainingSplitResult,
  type TrainingSplitState,
} from "@/lib/commerce/square-training-split";
import { notifyPaidTrainingOrder } from "@/lib/commerce/training-paid-notification";
import { createSquarePaymentsClient } from "@/lib/payments/square/payments-client";
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
type WorkerDependencies = NonNullable<
  Awaited<
    ReturnType<NonNullable<Parameters<typeof reconcileTrainingSplits>[2]>>
  >
>;

function business(
  f: ReturnType<typeof admission>,
  options: {
    off?: boolean;
    disabled?: boolean;
    empty?: boolean;
    fail?: string;
    stage?: TrainingSplitState["stage"];
    missingEnrollment?: boolean;
    wait?: (stage: string) => Promise<void>;
    charge?: WorkerDependencies["charge"];
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
    if (options.fail === stage) throw undefined;
  };
  const deps: WorkerDependencies = {
    findPending: async (input) => {
      await step("list");
      assert.equal(input.limit, 20);
      assert.equal(
        input.updatedBefore.toISOString(),
        "2032-01-01T11:59:00.000Z",
      );
      return options.empty
        ? []
        : [{ orderId: "order-0" }, { orderId: "order-1" }];
    },
    charge:
      options.charge ??
      (async (input) => {
        assert.deepEqual(Object.keys(input), ["orderReference"]);
        const id = input.orderReference;
        await step(`charge:${id}`);
        const state: TrainingSplitState = {
          stage: options.stage ?? "completing",
          cardAmountCents: 195500,
          afterpayAmountCents: 200000,
          squareOrderId: `square-${id}`,
          cardPaymentId: `${id}/card`,
          afterpayPaymentId: `${id}/afterpay`,
        };
        const statuses = new Map([
          [state.cardPaymentId!, "APPROVED"],
          [state.afterpayPaymentId!, "APPROVED"],
        ]);
        return chargeTrainingSplit(
          { ...input, amountCents: 395500 },
          {
            load: async () => state,
            save: async (value) => {
              await step(`save:${id}:${value.stage}`);
            },
            createOrder: async () => {
              throw new Error("unexpected new Square order");
            },
            authorize: async () => {
              throw new Error("unexpected authorization");
            },
            getPayment: async (paymentId) => {
              await step(`lookup:${paymentId}`);
              const card = paymentId.endsWith("/card");
              return {
                id: paymentId,
                status: statuses.get(paymentId)!,
                order_id: state.squareOrderId,
                reference_id: id,
                source_type: card ? "CARD" : "BUY_NOW_PAY_LATER",
                amount_money: {
                  amount: card
                    ? state.cardAmountCents
                    : state.afterpayAmountCents,
                  currency: "CAD",
                },
              };
            },
            payOrder: async (orderId, ids, key) => {
              await step(`pay:${id}`);
              assert.equal(orderId, state.squareOrderId);
              assert.deepEqual(ids, [
                state.cardPaymentId,
                state.afterpayPaymentId,
              ]);
              assert.equal(key, `training-split/${id}/pay`);
            },
            complete: async (paymentId) => {
              await step(`complete:${paymentId}`);
              statuses.set(paymentId, "COMPLETED");
            },
            cancel: async (paymentId) => {
              await step(`cancel:${paymentId}`);
            },
            cancelByKey: async () => {
              throw new Error("unexpected cancellation key");
            },
            finalize: async () => {
              await step(`finalize:${id}`);
            },
            notify: async () => {
              await step(`notify:${id}`);
              if (options.missingEnrollment)
                await notifyPaidTrainingOrder(id, undefined, {
                  getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId:
                    async () => null,
                  getOrIssueTrainingSchedulingTokenForPaidOrder: async () => {
                    throw new Error("unexpected token");
                  },
                  sendTrainingPaymentNotificationEmailsIfNeeded: async () => {
                    throw new Error("unexpected send");
                  },
                });
            },
            logError() {},
          },
        );
      }),
    logError() {},
  };
  let summary: TrainingSplitReconciliationSummary | undefined;
  const run = (task: () => Promise<TrainingSplitReconciliationSummary>) =>
    (options.off ? f.off : f.run)(
      "recovery",
      async () => {
        summary = await task();
        return summary;
      },
      { uncertainResult: (value) => value.failed > 0 },
    );
  const capture: SquareCaptureReconciliationDependencies = {
    findUncaptured: async () => {
      calls.push("capture-list");
      return [];
    },
    getPaymentStatus: async () => {
      throw new Error("unexpected capture");
    },
    completePayment: async () => {},
    markCaptured: async () => {},
    markUncollected: async () => {},
    logError() {},
    logWarn() {},
  };
  const get = createPaymentReconciliationGetHandler(
    {
      getCronSecrets: () => ["owned-cron-fixture"],
      getNow: () => now,
      logError() {},
      logWarn() {},
      runMonitor: async () => {
        calls.push("monitor");
        return { findings: [], ok: true, checkedAt: now.toISOString() };
      },
      retryBookingOutcomeEmails: async () => {
        calls.push("email");
        return { attempted: 0, failed: 0, processed: 0 };
      },
      runCommerceCaptureReconciliation: (
        input,
        captureRunner,
        _loader,
        splitRunner,
      ) =>
        runSquareCommerceCaptureReconciliation(
          input,
          captureRunner,
          async () => ({
            capture,
            reconcileTrainingSplits: (time, runner) =>
              reconcileTrainingSplits(time, runner, async () =>
                options.disabled ? null : deps,
              ),
          }),
          splitRunner,
        ),
    },
    (task) => task(),
    (task) => task(),
    run,
  );
  return { calls, get, summary: () => summary };
}

test("split cron authenticates before effects and finishes its separate recovery entry before capture", async () => {
  const f = admission(),
    b = business(f);
  assert.equal((await b.get(request(false))).status, 401);
  assert.equal(b.calls.length, 0);
  assert.equal(f.calls.length, 0);
  assert.equal((await b.get(request())).status, 200);
  assert.deepEqual(b.calls.slice(0, 3), ["monitor", "email", "list"]);
  assert.equal(b.calls.at(-1), "capture-list");
  assert.deepEqual(b.summary(), {
    checked: 2,
    recovered: 2,
    canceled: 0,
    failed: 0,
  });
  assert.deepEqual(f.state.outcomes, ["completed"]);
  assert.equal(
    f.calls.find((c) => c.sql.includes("begin_operation"))?.values?.[1],
    "recovery",
  );
});

test("closed split recovery refuses before listing and returns sanitized retryable no-store 503", async () => {
  const f = admission(),
    b = business(f);
  f.state.recovery = false;
  const response = await b.get(request());
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("retry-after"), "30");
  assert.equal((await response.text()).includes("owned"), false);
  assert.deepEqual(b.calls, ["monitor", "email"]);
});

test("split recovery holds admission through query, provider effects, receipts, notifications and later orders", async () => {
  for (const stage of [
    "list",
    "lookup:order-0/card",
    "pay:order-0",
    "save:order-0:completing",
    "complete:order-0/card",
    "finalize:order-0",
    "notify:order-0",
    "cancel:order-0/card",
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
      stage: stage.startsWith("cancel:") ? "canceling" : "capturing",
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
    assert.equal((await pending).status, 200, stage);
    assert.ok(b.calls.includes("charge:order-1"), stage);
    assert.deepEqual(f.state.outcomes, ["completed"], stage);
  }
});

test("split caught and undefined failures retain uncertainty while later orders finish", async () => {
  for (const fail of [
    "list",
    "charge:order-0",
    "lookup:order-0/card",
    "complete:order-0/card",
    "finalize:order-0",
    "notify:order-0",
  ]) {
    const f = admission(),
      b = business(f, { fail });
    assert.equal((await b.get(request())).status, 503, fail);
    assert.deepEqual(f.state.outcomes, ["uncertain"], fail);
    if (fail !== "list") assert.ok(b.calls.includes("notify:order-1"), fail);
    assert.equal(b.calls.includes("capture-list"), false);
  }
});

test("split unknown/lock/capture/cancellation outcomes fail closed; confirmed cancellation can settle", async () => {
  for (const reason of [
    "split_payment_in_progress",
    "split_capture_pending",
    "split_cancellation_pending",
    "split_amount_mismatch",
    "unknown-result",
    "split_payment_canceled",
  ]) {
    const f = admission(),
      b = business(f, {
        charge: async (): Promise<TrainingSplitResult> => ({
          ok: false,
          reason,
          retryWithNewReservation: reason === "split_payment_canceled",
        }),
      });
    const canceled = reason === "split_payment_canceled";
    assert.equal((await b.get(request())).status, canceled ? 200 : 503, reason);
    assert.deepEqual(
      f.state.outcomes,
      [canceled ? "completed" : "uncertain"],
      reason,
    );
  }
});

test("split notification ambiguity remains uncertain behind a success-shaped charge result", async () => {
  const f = admission(),
    b = business(f, { missingEnrollment: true });
  assert.equal((await b.get(request())).status, 503);
  assert.deepEqual(b.summary(), {
    checked: 2,
    recovered: 2,
    canceled: 0,
    failed: 0,
  });
  assert.deepEqual(f.state.outcomes, ["uncertain"]);
});

test("split failed provider observations and cancellations await their sibling before settlement", async () => {
  for (const effect of ["lookup", "cancel"]) {
    const f = admission();
    let entered!: () => void, release!: () => void;
    const atSibling = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const b = business(f, {
      fail: `${effect}:order-0/card`,
      stage: effect === "cancel" ? "canceling" : "completing",
      wait: async (stage) => {
        if (stage === `${effect}:order-0/afterpay`) {
          entered();
          await gate;
        }
      },
    });
    const pending = b.get(request());
    await atSibling;
    f.state.recovery = false;
    try {
      assert.deepEqual(f.state.outcomes, []);
    } finally {
      release();
    }
    assert.equal((await pending).status, 503);
    assert.ok(b.calls.includes("charge:order-1"));
    assert.deepEqual(f.state.outcomes, ["uncertain"]);
  }
});

test("disabled, empty and admission-off split batches preserve their existing behavior", async () => {
  for (const options of [
    { disabled: true },
    { empty: true },
    { off: true, fail: "charge:order-0" },
  ]) {
    const f = admission(),
      b = business(f, options);
    assert.equal((await b.get(request())).status, 200);
    assert.deepEqual(
      f.state.outcomes,
      options.disabled || options.off ? [] : ["completed"],
    );
    assert.ok(b.calls.includes("capture-list"));
  }
});

test("split socket loss and lost settlement never replay financial effects", async () => {
  for (const mode of ["socket", "settlement"]) {
    const f = admission();
    f.state.loseSettlement = mode === "settlement";
    const b = business(f, {
      wait: async (stage) => {
        if (stage === "complete:order-0/card" && mode === "socket")
          f.client.emit("error", new Error("owned-private-detail"));
      },
    });
    assert.equal((await b.get(request())).status, 503);
    assert.equal(
      b.calls.filter((s) => s === "complete:order-0/card").length,
      1,
    );
    assert.ok(b.calls.includes("notify:order-1"));
  }
});

test("actual cancellation HTTP adapter requires requested identity and confirmed terminal status", async () => {
  const previous = globalThis.fetch;
  try {
    for (const mode of [
      "lookup-id",
      "cancel-id",
      "cancel-status",
      "terminal",
      "valid",
    ]) {
      const paths: string[] = [];
      globalThis.fetch = async (input) => {
        const path = String(input);
        paths.push(path);
        const cancel = path.endsWith("/cancel");
        return Response.json({
          payment: {
            id:
              mode === "lookup-id" || (cancel && mode === "cancel-id")
                ? "other"
                : "owned-payment",
            status:
              mode === "terminal" || (cancel && mode !== "cancel-status")
                ? "CANCELED"
                : "APPROVED",
            amount_money: { amount: 195500, currency: "CAD" },
          },
        });
      };
      const cancel = createTrainingSplitCancellationOperation(
        createSquarePaymentsClient({
          environment: "sandbox",
          accessToken: "owned-fixture",
        }),
      );
      if (["valid", "terminal"].includes(mode)) await cancel("owned-payment");
      else await assert.rejects(cancel("owned-payment"));
      assert.equal(
        paths.length,
        ["lookup-id", "terminal"].includes(mode) ? 1 : 2,
      );
    }
  } finally {
    globalThis.fetch = previous;
  }
});

test("production route passes independent split admission without covering monitor or capture", async () => {
  const previous = { ...defaultDependencies },
    mode = process.env.FRONTEND_WRITER_ADMISSION_MODE;
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
    retryBookingOutcomeEmails: undefined,
    runCommerceCaptureReconciliation: async (
      _input: unknown,
      _capture: unknown,
      _loader: unknown,
      runner: Parameters<typeof runSquareCommerceCaptureReconciliation>[3],
    ) => {
      assert.ok(runner);
      await runner(async () => {
        calls.push("split");
        return { checked: 0, recovered: 0, canceled: 0, failed: 0 };
      });
      throw new Error("unexpected capture");
    },
  });
  process.env.FRONTEND_WRITER_ADMISSION_MODE = "off";
  try {
    assert.equal((await routeGet(request())).status, 503);
    assert.deepEqual(calls, ["monitor"]);
  } finally {
    Object.assign(defaultDependencies, previous);
    if (mode === undefined) delete process.env.FRONTEND_WRITER_ADMISSION_MODE;
    else process.env.FRONTEND_WRITER_ADMISSION_MODE = mode;
  }
});
