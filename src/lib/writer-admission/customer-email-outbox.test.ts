import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { GET as routeGet } from "@/app/api/cron/customer-email-outbox/route";
import { createCustomerEmailOutboxCronHandler } from "@/lib/commerce/customer-email-outbox-cron";
import {
  processCustomerEmailOutbox,
  type CustomerEmailOutboxWorkerDependencies as Dependencies,
} from "@/lib/commerce/customer-email-outbox-worker";
import { markShipmentNotificationSent } from "@/lib/shipping/shipment-store";
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

const now = new Date("2032-01-01T12:00:00.000Z");
const request = (authorized = true) =>
  new Request("https://owned.invalid/api/cron/customer-email-outbox", {
    headers: authorized ? { authorization: "Bearer owned-cron-fixture" } : {},
  });
const job = (
  id: string,
  kind:
    | "shipping_customer_update"
    | "product_order_confirmation" = "shipping_customer_update",
) => ({
  id,
  kind,
  recipient: "owned@example.invalid",
  payload: { orderId: "owned-order" },
  providerIdempotencyKey: `owned-key-${id}`,
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
    wait?: (stage: string) => Promise<void>;
    off?: boolean;
    empty?: boolean;
    failDelivery?: boolean;
    enqueueMissing?: boolean;
    suppress?: boolean;
    lostReceipt?: boolean;
    emptyProviderId?: boolean;
    missingProjection?: boolean;
    failFailureReceipt?: boolean;
    failProductError?: boolean;
    undefinedFailure?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const step = async (stage: string) => {
    if (!options.off)
      assert.ok(f.calls.some((c) => c.sql.includes("begin_operation")));
    assert.equal(
      f.calls.some((c) => c.sql.includes("finish_operation")),
      false,
    );
    calls.push(stage);
    await options.wait?.(stage);
  };
  const rows = options.empty
    ? []
    : [
        job(
          "one",
          options.missingProjection || options.failProductError
            ? "product_order_confirmation"
            : "shipping_customer_update",
        ),
        job("two"),
      ];
  const dependencies: Dependencies = {
    listMissing: async () => {
      await step("list");
      return options.empty ? [] : ["owned-order"];
    },
    enqueue: async () => {
      await step("enqueue");
      return options.enqueueMissing
        ? null
        : ({} as NonNullable<Awaited<ReturnType<Dependencies["enqueue"]>>>);
    },
    claim: async (input) => {
      await step("claim");
      assert.equal(input.leaseOwner, "owned-lease");
      return rows;
    },
    claimById: async () => {
      throw new Error("single job is outside the cron");
    },
    deliver: async (email) => {
      await step(`deliver:${email.id}`);
      assert.equal(email.providerIdempotencyKey, `owned-key-${email.id}`);
      if (
        (options.failDelivery || options.failProductError) &&
        email.id === "one"
      )
        throw options.undefinedFailure
          ? undefined
          : new Error("owned-private-detail");
      if (options.suppress && email.id === "one") return { suppressed: true };
      return {
        id: options.emptyProviderId ? "" : `owned-message-${email.id}`,
        ...(options.missingProjection && email.id === "one"
          ? {
              completion: {
                type: "product_confirmation" as const,
                orderId: "owned-order",
              },
            }
          : {}),
      };
    },
    complete: async (input) => {
      await step(`complete:${input.id}`);
      if (input.onCompleted) {
        const tx = {
          update: () => ({
            set: () => ({ where: () => ({ returning: async () => [] }) }),
          }),
        };
        await input.onCompleted(
          tx as unknown as Parameters<NonNullable<typeof input.onCompleted>>[0],
        );
      }
      return !options.lostReceipt;
    },
    suppress: async (input) => {
      await step(`suppress:${input.id}`);
      return !options.lostReceipt;
    },
    recordProductFailure: async () => {
      await step("product-failure");
      throw new Error("owned-private-detail");
    },
    fail: async (input) => {
      await step(`fail:${input.id}`);
      if (options.failFailureReceipt) throw new Error("owned-private-detail");
      return !options.lostReceipt;
    },
  };
  const get = createCustomerEmailOutboxCronHandler(
    () =>
      processCustomerEmailOutbox(
        { now, leaseOwner: "owned-lease" },
        dependencies,
      ),
    (task) =>
      (options.off ? f.off : f.run)("recovery", task, {
        uncertainResult: (result) => result.failed > 0,
      }),
  );
  return { calls, get, dependencies };
}
async function unavailable(response: Response) {
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("retry-after"), "30");
  assert.equal((await response.text()).includes("owned-private-detail"), false);
}

test.before(() => {
  process.env.CRON_SECRET = "owned-cron-fixture";
});

test("outbox cron authenticates before admission and worker effects", async () => {
  const f = admission(),
    b = business(f);
  assert.equal((await b.get(request(false))).status, 401);
  const secret = process.env.CRON_SECRET;
  try {
    delete process.env.CRON_SECRET;
    assert.equal((await b.get(request())).status, 404);
  } finally {
    process.env.CRON_SECRET = secret;
  }
  assert.deepEqual(b.calls, []);
  assert.deepEqual(f.calls, []);
});

test("closed outbox recovery refuses before backfill, claim or provider effects", async () => {
  const f = admission(),
    b = business(f);
  f.state.recovery = false;
  await unavailable(await b.get(request()));
  assert.deepEqual(b.calls, []);
  assert.deepEqual(f.state.outcomes, []);
});

test("outbox recovery stays independent of new work and retains lease and provider keys", async () => {
  const f = admission(),
    b = business(f);
  assert.equal((await b.get(request())).status, 200);
  assert.deepEqual(b.calls, [
    "list",
    "enqueue",
    "claim",
    "deliver:one",
    "complete:one",
    "deliver:two",
    "complete:two",
  ]);
  assert.deepEqual(f.state.outcomes, ["completed"]);
  assert.equal(
    f.calls.find((c) => c.sql.includes("begin_operation"))?.values?.[1],
    "recovery",
  );
});

test("outbox recovery retains admission throughout backfill, claims, sends and receipt cleanup after closure", async () => {
  for (const stage of [
    "list",
    "enqueue",
    "claim",
    "deliver:one",
    "complete:one",
    "suppress:one",
    "product-failure",
    "fail:one",
  ]) {
    const f = admission(),
      held = latch();
    const b = business(f, {
      suppress: stage === "suppress:one",
      failProductError: ["product-failure", "fail:one"].includes(stage),
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
    assert.equal(
      response.status,
      ["product-failure", "fail:one"].includes(stage) ? 503 : 200,
      stage,
    );
    assert.equal(b.calls.includes("complete:two"), true);
    assert.equal(f.state.outcomes.length, 1);
  }
});

test("caught and undefined delivery failures retain uncertainty while later jobs finish", async () => {
  for (const undefinedFailure of [false, true]) {
    const f = admission(),
      b = business(f, { failDelivery: true, undefinedFailure });
    await unavailable(await b.get(request()));
    assert.deepEqual(f.state.outcomes, ["uncertain"]);
    assert.equal(b.calls.includes("fail:one"), true);
    assert.equal(b.calls.includes("complete:two"), true);
  }
});

test("outbox lost claims, suppression and delivery receipts cannot settle success-shaped work", async () => {
  for (const options of [
    { enqueueMissing: true },
    { emptyProviderId: true },
    { lostReceipt: true },
    { lostReceipt: true, suppress: true },
    { missingProjection: true },
  ]) {
    const f = admission(),
      b = business(f, options);
    await unavailable(await b.get(request()));
    assert.deepEqual(f.state.outcomes, ["uncertain"]);
  }
});

test("outbox swallowed product error recording and failed failure receipts remain unresolved", async () => {
  const f = admission(),
    b = business(f, { failProductError: true, failFailureReceipt: true });
  await unavailable(await b.get(request()));
  assert.deepEqual(f.state.outcomes, ["uncertain"]);
  assert.equal(b.calls.includes("product-failure"), true);
  assert.equal(b.calls.includes("fail:one"), true);
  assert.equal(b.calls.includes("deliver:two"), false);
});

test("outbox empty batches complete and admission off preserves partial-failure responses", async () => {
  const f = admission(),
    b = business(f, { empty: true });
  assert.equal((await b.get(request())).status, 200);
  assert.deepEqual(f.state.outcomes, ["completed"]);
  const off = admission(),
    partial = business(off, { off: true, failDelivery: true });
  const response = await partial.get(request());
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), null);
  assert.deepEqual(await response.json(), {
    claimed: 2,
    enqueued: 1,
    failed: 1,
    sent: 1,
    suppressed: 0,
  });
  assert.deepEqual(off.calls, []);
  const ambiguous = business(admission(), {
    off: true,
    enqueueMissing: true,
    emptyProviderId: true,
    missingProjection: true,
  });
  assert.equal((await ambiguous.get(request())).status, 200);
});

test("outbox socket and settlement acknowledgement loss never replay delivery", async () => {
  for (const loss of ["socket", "settlement"]) {
    const f = admission();
    f.state.loseSettlement = loss === "settlement";
    const b = business(f, {
      wait: async (stage) => {
        if (loss === "socket" && stage === "deliver:one")
          f.client.emit("error", new Error("owned-private-detail"));
      },
    });
    await unavailable(await b.get(request()));
    assert.equal(b.calls.filter((c) => c === "deliver:one").length, 1);
    assert.equal(b.calls.filter((c) => c === "complete:two").length, 1);
    assert.deepEqual(f.state.outcomes, [
      loss === "socket" ? "uncertain" : "completed",
    ]);
  }
});

test("missing shipment projection marks the surrounding operation uncertain", async () => {
  const f = admission();
  const executor = {
    update: () => ({
      set: () => ({ where: () => ({ returning: async () => [] }) }),
    }),
  };
  await assert.rejects(
    f.run("recovery", () =>
      markShipmentNotificationSent(
        "owned-shipment",
        "accepted",
        now,
        executor as unknown as Parameters<
          typeof markShipmentNotificationSent
        >[3],
      ),
    ),
  );
  assert.deepEqual(f.state.outcomes, ["uncertain"]);
});

test("production outbox route refuses enforcement before any configured business database", async () => {
  const mode = process.env.FRONTEND_WRITER_ADMISSION_MODE;
  try {
    process.env.FRONTEND_WRITER_ADMISSION_MODE = "invalid-owned-fixture";
    await unavailable(await routeGet(request()));
  } finally {
    if (mode === undefined) delete process.env.FRONTEND_WRITER_ADMISSION_MODE;
    else process.env.FRONTEND_WRITER_ADMISSION_MODE = mode;
  }
});
