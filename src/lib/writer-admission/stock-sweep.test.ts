import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { GET as routeGet } from "@/app/api/cron/product-stock-reservations/route";
import { createAbandonedProductStockCronHandler } from "@/lib/commerce/product-stock-abandoned-sweep-cron";
import {
  releaseAbandonedProductStockReservations,
  verifySquareCommercePayment,
  type AbandonedStockSweepDependencies,
} from "@/lib/commerce/product-stock-abandoned-sweep";
import { releaseProductStockForOrderInTransaction } from "@/lib/commerce/product-stock-store";
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
  new Request("https://owned.invalid/api/cron/product-stock-reservations", {
    headers: authorized ? { authorization: "Bearer owned-cron-fixture" } : {},
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
    providerError?: boolean;
    undefinedFailure?: boolean;
    releaseError?: boolean;
    queryError?: boolean;
    skip?: boolean;
    wait?: (stage: string) => Promise<void>;
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
  const dependencies: AbandonedStockSweepDependencies = {
    listCandidates: async (cutoff, limit) => {
      await step("list");
      assert.equal(cutoff.toISOString(), "2032-01-01T11:00:00.000Z");
      assert.equal(limit, 200);
      if (options.queryError) throw new Error("owned-private-detail");
      return options.empty
        ? []
        : ["one", "two"].map((orderId) => ({ orderId, createdAt: now }));
    },
    release: async (orderId, selectedNow) => {
      await step(`release:${orderId}`);
      assert.equal(selectedNow, now);
      if (options.releaseError && orderId === "one")
        throw options.undefinedFailure
          ? undefined
          : new Error("owned-private-detail");
      return "released";
    },
  };
  const get = createAbandonedProductStockCronHandler(
    () =>
      releaseAbandonedProductStockReservations(
        {
          now,
          verifyProviderPayment: async ({ orderReference, createdAt }) => {
            await step(`provider:${orderReference}`);
            assert.equal(createdAt, now);
            if (options.providerError && orderReference === "one")
              throw options.undefinedFailure
                ? undefined
                : new Error("owned-private-detail");
            return options.skip ? "captured" : "absent";
          },
        },
        dependencies,
      ),
    (task) =>
      (options.off ? f.off : f.run)("recovery", task, {
        uncertainResult: (result) => result.failed > 0,
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
  process.env.CRON_SECRET = "owned-cron-fixture";
});

test("stock sweep authenticates before recovery admission and candidate selection", async () => {
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
test("closed stock recovery refuses before query, verification or stock release", async () => {
  const f = admission(),
    b = business(f);
  f.state.recovery = false;
  await unavailable(await b.get(request()));
  assert.deepEqual(b.calls, []);
  assert.deepEqual(f.state.outcomes, []);
});
test("stock recovery operates independently of new work and awaits every order", async () => {
  const f = admission(),
    b = business(f);
  const response = await b.get(request());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    scanned: 2,
    released: 2,
    skipped: 0,
    failed: 0,
  });
  assert.deepEqual(b.calls, [
    "list",
    "provider:one",
    "release:one",
    "provider:two",
    "release:two",
  ]);
  assert.deepEqual(f.state.outcomes, ["completed"]);
  assert.equal(
    f.calls.find((c) => c.sql.includes("begin_operation"))?.values?.[1],
    "recovery",
  );
});
test("stock admission remains active during query, provider and release after policy closure", async () => {
  for (const stage of ["list", "provider:one", "release:one", "release:two"]) {
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
      assert.deepEqual(f.state.outcomes, []);
      f.state.recovery = false;
      await unavailable(await b.get(request()));
      assert.equal(b.calls.filter((c) => c === "list").length, 1);
    } finally {
      held.release();
    }
    assert.equal((await pending).status, 200);
    assert.deepEqual(f.state.outcomes, ["completed"]);
    assert.equal(b.calls.includes("release:two"), true);
  }
});
test("caught provider failures cannot complete success-shaped stock cleanup", async () => {
  for (const undefinedFailure of [false, true]) {
    const f = admission(),
      b = business(f, { providerError: true, undefinedFailure });
    await unavailable(await b.get(request()));
    assert.deepEqual(f.state.outcomes, ["uncertain"]);
    assert.equal(b.calls.includes("release:one"), true);
    assert.equal(b.calls.includes("release:two"), true);
  }
});
test("caught stock release failures retain uncertainty and finish later orders", async () => {
  for (const undefinedFailure of [false, true]) {
    const f = admission(),
      b = business(f, { releaseError: true, undefinedFailure });
    await unavailable(await b.get(request()));
    assert.deepEqual(f.state.outcomes, ["uncertain"]);
    assert.equal(b.calls.includes("release:two"), true);
  }
});
test("stock query errors are sanitized under enforcement and retain off-mode exceptions", async () => {
  const f = admission(),
    b = business(f, { queryError: true });
  await unavailable(await b.get(request()));
  assert.deepEqual(f.state.outcomes, ["uncertain"]);
  await assert.rejects(
    business(admission(), { off: true, queryError: true }).get(request()),
    /owned-private-detail/,
  );
});
test("empty stock batches and authoritative provider skips can complete", async () => {
  for (const options of [{ empty: true }, { skip: true }]) {
    const f = admission(),
      b = business(f, options);
    assert.equal((await b.get(request())).status, 200);
    assert.deepEqual(f.state.outcomes, ["completed"]);
    assert.equal(
      b.calls.some((c) => c.startsWith("release:")),
      false,
    );
  }
});
test("stock off mode preserves 200 summaries and provider-error fallback", async () => {
  for (const options of [{ providerError: true }, { releaseError: true }]) {
    const f = admission(),
      b = business(f, { ...options, off: true });
    const response = await b.get(request());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("retry-after"), null);
    assert.deepEqual(await response.json(), {
      scanned: 2,
      released: options.releaseError ? 1 : 2,
      skipped: 0,
      failed: options.releaseError ? 1 : 0,
    });
    assert.deepEqual(f.calls, []);
  }
});
test("bounded Square scans preserve legacy verdict but retain enforced uncertainty", async () => {
  const client = {
    listPayments: async () => ({ payments: [], cursor: "more" }),
  };
  const input = { orderReference: "owned-order", createdAt: now };
  assert.equal(await verifySquareCommercePayment(client, input), "absent");
  const f = admission();
  await assert.rejects(
    f.run("recovery", () => verifySquareCommercePayment(client, input)),
  );
  assert.deepEqual(f.state.outcomes, ["uncertain"]);
});
test("missing movement or stock release receipts cannot settle as completed", async () => {
  for (const missing of ["movement", "stock"]) {
    let selections = 0;
    const tx = {
      select: () => ({
        from: () => ({
          where: () => {
            selections++;
            return Object.assign(
              Promise.resolve([{ productStockId: "owned-stock", quantity: 2 }]),
              { limit: async () => [] },
            );
          },
        }),
      }),
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({
            returning: async () =>
              missing === "movement" ? [] : [{ id: "owned-movement" }],
          }),
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () =>
              missing === "stock" ? [] : [{ id: "owned-stock" }],
          }),
        }),
      }),
    };
    const f = admission();
    await assert.rejects(
      f.run("recovery", () =>
        releaseProductStockForOrderInTransaction(
          tx as unknown as Parameters<
            typeof releaseProductStockForOrderInTransaction
          >[0],
          "owned-order",
        ),
      ),
    );
    assert.equal(selections, 2);
    assert.deepEqual(f.state.outcomes, ["uncertain"]);
  }
});
test("lost stock socket or settlement acknowledgement never replays cleanup", async () => {
  for (const fault of ["socket", "settlement"]) {
    const f = admission();
    f.state.loseSettlement = fault === "settlement";
    const b = business(f, {
      wait: async (stage) => {
        if (fault === "socket" && stage === "release:one")
          f.client.emit("error", new Error("owned-private-detail"));
      },
    });
    await unavailable(await b.get(request()));
    assert.equal(b.calls.filter((c) => c === "release:one").length, 1);
    assert.equal(b.calls.filter((c) => c === "release:two").length, 1);
  }
});
test("production stock route refuses invalid enforcement before configured business access", async () => {
  const mode = process.env.FRONTEND_WRITER_ADMISSION_MODE;
  try {
    process.env.FRONTEND_WRITER_ADMISSION_MODE = "invalid-owned-fixture";
    await unavailable(await routeGet(request()));
  } finally {
    if (mode === undefined) delete process.env.FRONTEND_WRITER_ADMISSION_MODE;
    else process.env.FRONTEND_WRITER_ADMISSION_MODE = mode;
  }
});

test("malformed Square listing rows cannot be silently omitted from admitted verification", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ payments: [{ id: "malformed-owned-payment" }] }),
  );
  const client = createSquarePaymentsClient({
    environment: "sandbox",
    accessToken: "owned-unused",
    locationId: "owned",
  });
  const input = { orderReference: "owned-order", createdAt: now };
  assert.equal(await verifySquareCommercePayment(client, input), "absent");
  const f = admission();
  await assert.rejects(
    f.run("recovery", () => verifySquareCommercePayment(client, input)),
  );
  assert.deepEqual(f.state.outcomes, ["uncertain"]);
});
test("unknown Square payment states preserve legacy absence but cannot clear uncertainty", async () => {
  const client = {
    listPayments: async () => ({
      payments: [
        {
          id: "owned-payment",
          reference_id: "owned-order",
          status: "UNKNOWN",
          amount_money: { amount: 1000, currency: "CAD" },
        },
      ],
    }),
  };
  const input = { orderReference: "owned-order", createdAt: now };
  assert.equal(await verifySquareCommercePayment(client, input), "absent");
  const f = admission();
  await assert.rejects(
    f.run("recovery", () => verifySquareCommercePayment(client, input)),
  );
  assert.deepEqual(f.state.outcomes, ["uncertain"]);
});
