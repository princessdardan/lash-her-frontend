import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { GET as routeGet } from "@/app/api/admin/payment-reconciliation/route";
import {
  createPaymentReconciliationGetHandler,
  defaultDependencies,
} from "@/app/api/admin/payment-reconciliation/handler";
import {
  retryOperationalBookingOutcomeEmails,
  sendBookingConfirmationEmailForHold,
} from "@/lib/booking/email";
import { sendProviderBookingEmailForHold } from "@/lib/booking/provider-booking-email";
import {
  claimBookingConfirmationEmailByHoldId,
  type BookingHoldRecord,
} from "@/lib/booking/holds";
import { claimProviderBookingEmail } from "@/lib/private-db/booking-provider-email-repository";
import { VERCEL_PROJECT_BINDINGS } from "@/lib/env/application-environment.mjs";
import { resolveWriterAdmissionConfiguration } from "./config";
import { markWriterOperationUncertain } from "./context";
import {
  createWriterAdmissionRunner,
  type WriterAdmissionRunner,
} from "./runtime";

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
function handler(
  run: WriterAdmissionRunner,
  retry: Dependencies["retryBookingOutcomeEmails"],
  overrides: Partial<Dependencies> = {},
) {
  return createPaymentReconciliationGetHandler(
    {
      getCronSecrets: () => ["owned-cron-fixture"],
      getNow: () => now,
      logError() {},
      logWarn() {},
      runMonitor: async () => ({
        findings: [],
        ok: true,
        checkedAt: now.toISOString(),
      }),
      retryBookingOutcomeEmails: retry,
      ...overrides,
    },
    (task) =>
      run("recovery", task, {
        uncertainResult: (summary) => summary.failed > 0,
      }),
  );
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
function hold(id: string): BookingHoldRecord {
  return {
    id,
    publicReference: "owned-reference",
    bookingModelVersion: 2,
    bookingType: "in-person-appointment",
    state: "booked",
    customer: {
      name: "Owned customer",
      email: "client@owned.invalid",
      phone: "5555555555",
    },
    createdAt: now,
    updatedAt: now,
    expiresAt: now,
    googleEventId: "owned-event",
    offeringId: "owned-offering",
    offeringSnapshot: {},
    payment: null,
    selectedStart: now,
    selectedEnd: new Date(now.getTime() + 3600000),
    timezone: "America/Toronto",
    paymentProvider: "square",
    paymentSessionReference: "owned-session",
  };
}
function business(
  f: ReturnType<typeof admission>,
  options: {
    off?: boolean;
    ids?: string[];
    fail?: string;
    failHold?: string;
    customerError?: boolean;
    providerError?: boolean;
    correction?: boolean;
    wait?: (stage: string) => Promise<void>;
    uncertainClaim?: boolean;
    undefinedFailure?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const step = async (stage: string, id = "owned-hold") => {
    if (!options.off)
      assert.ok(f.calls.some((call) => call.sql.includes("begin_operation")));
    assert.equal(
      f.calls.some((call) => call.sql.includes("finish_operation")),
      false,
    );
    calls.push(`${stage}:${id}`);
    await options.wait?.(stage);
    if (
      options.fail === stage &&
      (!options.failHold || options.failHold === id)
    )
      throw new Error("owned-private-detail");
  };
  const retry: NonNullable<Dependencies["retryBookingOutcomeEmails"]> = (
    input,
  ) =>
    retryOperationalBookingOutcomeEmails(input, {
      listHoldIds: async () => {
        await step("list");
        return options.ids ?? ["owned-hold"];
      },
      logError() {},
      sendForHold: async (id) => {
        let claims = 0;
        await sendBookingConfirmationEmailForHold(id, {
          claimBookingConfirmationEmailByHoldId: async () => {
            await step("customer-claim", id);
            if (options.uncertainClaim) {
              markWriterOperationUncertain();
              return null;
            }
            claims++;
            return {
              ...hold(id),
              bookingConfirmationStatus:
                options.correction && claims === 1
                  ? "manual_followup"
                  : "booked",
            };
          },
          sendBookingConfirmationEmail: async () => {
            await step("customer-send", id);
            if (options.customerError) throw new Error("owned-private-detail");
          },
          markBookingConfirmationEmailSent: async () => {
            await step("customer-sent", id);
            return { correctionRequired: !!options.correction && claims === 1 };
          },
          recordBookingConfirmationEmailFailure: async () => {
            await step("customer-failure", id);
            if (options.undefinedFailure) throw undefined;
          },
          logError() {},
          sendProviderBookingEmailForHold: async () =>
            sendProviderBookingEmailForHold(id, {
              claimProviderBookingEmail: async () => {
                await step("provider-claim", id);
                return {
                  bookingType: "in-person-appointment",
                  capturedAmountCents: 10000,
                  currency: "CAD",
                  customer: hold(id).customer,
                  end: hold(id).selectedEnd,
                  holdId: id,
                  offeringSnapshot: {},
                  orderId: "owned-order",
                  paymentProvider: "square",
                  paymentPurpose: "appointment_full",
                  providerName: "Owned provider",
                  recipientEmails: ["provider@owned.invalid"],
                  start: now,
                  timezone: "America/Toronto",
                  tipAmountCents: 0,
                };
              },
              sendProviderBookingEmail: async () => {
                await step("provider-send", id);
                if (options.providerError)
                  throw new Error("owned-private-detail");
              },
              markProviderBookingEmailSent: async () => {
                await step("provider-sent", id);
              },
              recordProviderBookingEmailFailure: async () => {
                await step("provider-failure", id);
                if (options.undefinedFailure) throw undefined;
              },
              logError() {},
            }),
        });
      },
    });
  return { retry, calls };
}

test("booking outcome recovery admits before listing, claims, sends and receipts with new work closed", async () => {
  const f = admission(),
    b = business(f);
  assert.equal((await handler(f.run, b.retry)(request())).status, 200);
  assert.deepEqual(b.calls, [
    "list:owned-hold",
    "customer-claim:owned-hold",
    "customer-send:owned-hold",
    "customer-sent:owned-hold",
    "provider-claim:owned-hold",
    "provider-send:owned-hold",
    "provider-sent:owned-hold",
  ]);
  assert.deepEqual(f.state.outcomes, ["completed"]);
  assert.equal(
    f.calls.find((call) => call.sql.includes("begin_operation"))?.values?.[1],
    "recovery",
  );
  assert.equal(JSON.stringify(f.calls).includes("owned-hold"), false);
});

test("booking outcome authentication refuses before admission or any reconciliation effects", async () => {
  for (const secrets of [[], ["owned-cron-fixture"]]) {
    const f = admission(),
      b = business(f);
    let effects = 0;
    const response = await handler(f.run, b.retry, {
      getCronSecrets: () => secrets,
      runMonitor: async () => {
        effects++;
        throw new Error();
      },
    })(request(false));
    assert.equal(response.status, secrets.length ? 401 : 404);
    assert.equal(effects, 0);
    assert.deepEqual(b.calls, []);
    assert.deepEqual(f.calls, []);
  }
});

test("closed booking outcome recovery refuses its list and effects but does not claim the other worker boundaries", async () => {
  const f = admission(),
    b = business(f);
  f.state.recovery = false;
  const outside: string[] = [];
  const response = await handler(f.run, b.retry, {
    runMonitor: async () => {
      outside.push("monitor");
      return { findings: [], ok: true, checkedAt: now.toISOString() };
    },
    runCommerceCaptureReconciliation: async () => {
      outside.push("commerce");
      return null;
    },
  })(request());
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "30");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(b.calls, []);
  assert.deepEqual(outside, ["monitor", "commerce"]);
});

test("booking outcome recovery keeps every batch stage active after closure and refuses a second batch", async () => {
  for (const stage of [
    "list",
    "customer-claim",
    "customer-send",
    "customer-sent",
    "provider-claim",
    "provider-send",
    "provider-sent",
    "customer-failure",
    "provider-failure",
  ]) {
    const f = admission(),
      gate = latch(),
      b = business(f, {
        ids: ["owned-hold", "owned-later-hold"],
        customerError: stage === "customer-failure",
        providerError: stage === "provider-failure",
        wait: (name) => (name === stage ? gate.wait() : Promise.resolve()),
      });
    const get = handler(f.run, b.retry),
      pending = get(request());
    await gate.entered;
    f.state.recovery = false;
    try {
      assert.deepEqual(f.state.outcomes, [], stage);
      assert.equal((await get(request())).status, 503);
    } finally {
      gate.release();
    }
    assert.equal(
      (await pending).status,
      stage.endsWith("failure") ? 503 : 200,
      stage,
    );
    assert.ok(b.calls.includes("provider-claim:owned-later-hold"), stage);
    assert.deepEqual(
      f.state.outcomes,
      [stage.endsWith("failure") ? "uncertain" : "completed"],
      stage,
    );
  }
});

test("booking outcome caught failures retain uncertainty and finish later holds before returning", async () => {
  for (const fail of [
    "list",
    "customer-claim",
    "customer-send",
    "customer-sent",
    "provider-claim",
    "provider-send",
    "provider-sent",
    "customer-failure",
    "provider-failure",
  ]) {
    const f = admission(),
      b = business(f, {
        fail,
        failHold: "owned-hold",
        ids: ["owned-hold", "owned-later-hold"],
        customerError: fail === "customer-failure",
        providerError: fail === "provider-failure",
      });
    const response = await handler(f.run, b.retry)(request());
    assert.equal(response.status, 503, fail);
    assert.deepEqual(f.state.outcomes, ["uncertain"], fail);
    if (fail !== "list")
      assert.ok(b.calls.includes("provider-claim:owned-later-hold"), fail);
    assert.equal(
      (await response.text()).includes("owned-private-detail"),
      false,
    );
  }
});

test("booking outcome customer failure waits for the provider notification before settling uncertain", async () => {
  const f = admission(),
    gate = latch(),
    b = business(f, {
      customerError: true,
      wait: (stage) =>
        stage === "provider-send" ? gate.wait() : Promise.resolve(),
    });
  const pending = handler(f.run, b.retry)(request());
  await gate.entered;
  try {
    assert.deepEqual(f.state.outcomes, []);
    assert.ok(b.calls.includes("customer-failure:owned-hold"));
  } finally {
    gate.release();
  }
  assert.equal((await pending).status, 503);
  assert.deepEqual(f.state.outcomes, ["uncertain"]);
  assert.ok(b.calls.includes("provider-sent:owned-hold"));
});

test("booking outcome correction loops remain inside the batch until the final sent acknowledgement", async () => {
  const f = admission(),
    b = business(f, { correction: true });
  assert.equal((await handler(f.run, b.retry)(request())).status, 200);
  assert.equal(
    b.calls.filter((call) => call.startsWith("customer-sent")).length,
    2,
  );
  assert.deepEqual(f.state.outcomes, ["completed"]);
});

test("booking outcome ambiguous claims cannot complete a success-shaped batch", async () => {
  const f = admission(),
    b = business(f, { uncertainClaim: true });
  assert.equal((await handler(f.run, b.retry)(request())).status, 503);
  assert.deepEqual(f.state.outcomes, ["uncertain"]);
  assert.ok(b.calls.includes("provider-sent:owned-hold"));
});

test("booking outcome undefined cleanup rejections retain uncertainty and await the other notification", async () => {
  for (const source of ["customer", "provider"]) {
    const f = admission(),
      b = business(f, {
        customerError: source === "customer",
        providerError: source === "provider",
        undefinedFailure: true,
      });
    assert.equal((await handler(f.run, b.retry)(request())).status, 503);
    assert.deepEqual(f.state.outcomes, ["uncertain"]);
    assert.ok(
      b.calls.includes(
        source === "customer"
          ? "provider-sent:owned-hold"
          : "provider-failure:owned-hold",
      ),
    );
  }
});

test("booking outcome partial summaries and lost socket or settlement acknowledgements cannot succeed or replay", async () => {
  for (const mode of ["partial", "socket", "settlement"]) {
    const f = admission();
    let effects = 0;
    f.state.loseSettlement = mode === "settlement";
    const response = await handler(f.run, async () => {
      effects++;
      if (mode === "socket")
        f.client.emit("error", new Error("owned-private-detail"));
      return {
        attempted: 1,
        failed: mode === "partial" ? 1 : 0,
        processed: mode === "partial" ? 0 : 1,
      };
    })(request());
    assert.equal(response.status, 503);
    assert.equal(effects, 1);
  }
});

test("booking outcome admission-off preserves partial-failure success and monitor failure behavior", async () => {
  const f = admission(),
    b = business(f, { off: true, customerError: true });
  assert.equal((await handler(f.off, b.retry)(request())).status, 200);
  assert.deepEqual(f.calls, []);
  assert.equal(
    (
      await handler(f.off, b.retry, {
        runMonitor: async () => {
          throw new Error();
        },
      })(request())
    ).status,
    503,
  );
});

test("empty booking outcome batches settle and monitor failures do not skip recovery", async () => {
  const f = admission(),
    b = business(f, { ids: [] });
  assert.equal(
    (
      await handler(f.run, b.retry, {
        runMonitor: async () => {
          throw new Error();
        },
      })(request())
    ).status,
    503,
  );
  assert.deepEqual(b.calls, ["list:owned-hold"]);
  assert.deepEqual(f.state.outcomes, ["completed"]);
});

// Actual claim repositories with controlled query results: a sent receipt is
// distinct from a missing projection or busy claim. No live DB is used here.
function claimDb(rows: unknown[][]) {
  const builder = {
    where: () => builder,
    limit: () => builder,
    for: () => Promise.resolve(rows.shift() ?? []),
    then: (resolve: (value: unknown[]) => unknown) =>
      Promise.resolve(rows.shift() ?? []).then(resolve),
  };
  const tx = {
    select: () => ({ from: () => builder }),
    update: () => ({
      set: () => ({ where: () => ({ returning: async () => [] }) }),
    }),
  };
  return {
    transaction: async (task: (value: typeof tx) => Promise<unknown>) =>
      task(tx),
  };
}

test("booking outcome actual customer claims distinguish durable sent proof from missing and busy projections", async () => {
  for (const mode of ["sent", "missing", "busy", "manual"]) {
    const f = admission();
    const db = claimDb([
      [
        {
          id: "owned-hold",
          bookingModelVersion: 2,
          reconciliationMetadata: { bookingConfirmationEmailOutcome: "booked" },
        },
      ],
      mode === "missing"
        ? []
        : [
            {
              status: mode === "manual" ? "rebooking_pending" : "confirmed",
              calendarSyncStatus: "synced",
              sentAt: mode === "sent" ? now : null,
            },
          ],
    ]);
    const get = handler(f.run, (input) =>
      retryOperationalBookingOutcomeEmails(input, {
        listHoldIds: async () => ["owned-hold"],
        logError() {},
        sendForHold: async () => {
          await claimBookingConfirmationEmailByHoldId(
            { holdId: "owned-hold" },
            db as unknown as Parameters<
              typeof claimBookingConfirmationEmailByHoldId
            >[1],
          );
        },
      }),
    );
    assert.equal(
      (await get(request())).status,
      mode === "sent" ? 200 : 503,
      mode,
    );
    assert.deepEqual(
      f.state.outcomes,
      [mode === "sent" ? "completed" : "uncertain"],
      mode,
    );
  }
});

test("booking outcome actual provider claims distinguish sent receipts from busy or missing bookings", async () => {
  for (const mode of ["sent", "missing", "busy"]) {
    const f = admission();
    const db = claimDb([
      [
        {
          id: "owned-hold",
          bookingModelVersion: 2,
          providerBookingEmailSentAt: mode === "sent" ? now : null,
          providerBookingEmailClaimedUntil: new Date(now.getTime() + 60000),
        },
      ],
      mode === "missing" ? [] : [{ id: "owned-appointment" }],
    ]);
    const get = handler(f.run, (input) =>
      retryOperationalBookingOutcomeEmails(input, {
        listHoldIds: async () => ["owned-hold"],
        logError() {},
        sendForHold: async () => {
          await claimProviderBookingEmail(
            { lookup: { holdId: "owned-hold" }, now },
            db as unknown as Parameters<typeof claimProviderBookingEmail>[1],
          );
        },
      }),
    );
    assert.equal(
      (await get(request())).status,
      mode === "sent" ? 200 : 503,
      mode,
    );
  }
});

test("production reconciliation route separately admits booking outcome recovery before its list", async () => {
  const previous = { ...defaultDependencies },
    previousMode = process.env.FRONTEND_WRITER_ADMISSION_MODE;
  let retryCalls = 0,
    monitors = 0,
    commerce = 0;
  Object.assign(defaultDependencies, {
    getCronSecrets: () => ["owned-cron-fixture"],
    getNow: () => now,
    logError() {},
    logWarn() {},
    runMonitor: async () => {
      monitors++;
      process.env.FRONTEND_WRITER_ADMISSION_MODE = "invalid-owned-fixture";
      return { findings: [], ok: true, checkedAt: now.toISOString() };
    },
    retryBookingOutcomeEmails: async () => {
      retryCalls++;
      return { attempted: 0, failed: 0, processed: 0 };
    },
    runCommerceCaptureReconciliation: async () => {
      commerce++;
      return null;
    },
  });
  process.env.FRONTEND_WRITER_ADMISSION_MODE = "off";
  try {
    assert.equal((await routeGet(request())).status, 503);
    assert.equal(retryCalls, 0);
    assert.equal(monitors, 1);
    assert.equal(commerce, 1);
  } finally {
    Object.assign(defaultDependencies, previous);
    if (previousMode === undefined)
      delete process.env.FRONTEND_WRITER_ADMISSION_MODE;
    else process.env.FRONTEND_WRITER_ADMISSION_MODE = previousMode;
  }
});
