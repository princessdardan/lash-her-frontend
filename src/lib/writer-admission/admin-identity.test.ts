import assert from "node:assert/strict";
import test from "node:test";
import {
  withAdminUserWriterAdmission,
  runAdminIdentityWriter,
} from "@/lib/admin/user-writer-admission";
import { withAdminAuthRouteAdmission } from "@/lib/admin/auth-route-admission";
import type { AdminUserRepository } from "@/lib/admin/admin-user-store";
import { WriterAdmissionError } from "./config";
import { withWriterAdmission } from "./route";
import { interactiveAdmissionFixture } from "./interactive-fixture";
import type { WriterAdmissionRunner } from "./runtime";

function identityRepository(effects: string[]): AdminUserRepository {
  const user = {
    id: "owned",
    displayName: "Owned",
    email: "owned@example.invalid",
    emailNormalized: "owned@example.invalid",
    providerUserId: "owned-provider",
    role: "admin" as const,
    status: "active" as const,
  };
  return {
    bindIdentity: async () => {
      effects.push("bind");
      return user;
    },
    createBootstrapOwner: async () => {
      effects.push("bootstrap");
      return user;
    },
    recordSignIn: async () => {
      effects.push("refresh");
      return user;
    },
    findByEmailNormalized: async () => user,
    findByProviderUserId: async () => user,
    listBookingProviderResourceIds: async () => [],
    listBookingResourceIds: async () => [],
  };
}
const identity = {
  adminUserId: "owned",
  displayName: "Owned",
  email: "owned@example.invalid",
  providerUserId: "owned-provider",
  emailVerified: true,
};

test("admin identity bootstrap/binding require new work, while known-user heartbeat may recover", async () => {
  const kinds: string[] = [],
    effects: string[] = [];
  const run: WriterAdmissionRunner = async (kind, task) => {
    kinds.push(kind);
    if (kind === "new-work") throw new WriterAdmissionError("unavailable");
    return task();
  };
  const store = withAdminUserWriterAdmission(identityRepository(effects), run);
  await assert.rejects(store.bindIdentity(identity), WriterAdmissionError);
  await assert.rejects(
    store.createBootstrapOwner(identity),
    WriterAdmissionError,
  );
  await store.recordSignIn(identity);
  assert.deepEqual(kinds, ["new-work", "new-work", "recovery"]);
  assert.deepEqual(effects, ["refresh"]);
});

test("an inner writer failure caught by authentication policy still leaves parent admission uncertain", async () => {
  const parent = interactiveAdmissionFixture(),
    child = interactiveAdmissionFixture();
  const response = await withWriterAdmission(
    "recovery",
    async () => {
      try {
        await runAdminIdentityWriter(
          "recovery",
          async () => {
            throw new Error("owned-private-marker");
          },
          child.run,
        );
      } catch {
        /* existing auth policy preserves a denial/fallback */
      }
      return Response.json({ ok: true });
    },
    parent.run,
  )();
  assert.equal(response.status, 503);
  assert.equal(child.state.uncertain, true);
  assert.equal(parent.state.uncertain, true);
});

test("admin authentication routes classify provider initiation separately from callback/session/sign-out recovery", async () => {
  const kinds: string[] = [];
  const run: WriterAdmissionRunner = async (kind, task) => {
    kinds.push(kind);
    if (kind === "new-work") throw new WriterAdmissionError("unavailable");
    return task();
  };
  let calls = 0;
  const handler = withAdminAuthRouteAdmission(async (request: Request) => {
    calls++;
    await request.text();
    return Response.json({ ok: true });
  }, run);
  const signin = new Request("https://owned.invalid/api/auth/signin/google", {
    method: "POST",
    body: "untouched",
  });
  assert.equal((await handler(signin)).status, 503);
  assert.equal(signin.bodyUsed, false);
  for (const action of ["callback/google", "session", "signout"])
    assert.equal(
      (await handler(new Request(`https://owned.invalid/api/auth/${action}`)))
        .status,
      200,
    );
  assert.deepEqual(kinds, ["new-work", "recovery", "recovery", "recovery"]);
  assert.equal(calls, 3);
});

test("admin sign-out awaits the installed Auth.js raw-response shape before returning its fixed redirect", async () => {
  const { completeAdminSignOut } = await import("@/lib/admin/sign-out");
  for (const developer of [false, true]) {
    const events: string[] = [];
    const result = await completeAdminSignOut({
      hasDeveloperSession: async () => developer,
      clearDeveloperSession: async () => {
        events.push("clear");
      },
      signOut: async () => {
        events.push("authjs");
        return { redirect: "/admin/sign-in", cookies: [], status: 302 };
      },
    });
    assert.equal(result, "/admin/sign-in");
    assert.equal(typeof result, "string");
    assert.deepEqual(events, developer ? ["clear"] : ["clear", "authjs"]);
  }
});

test("manual write mode refuses before inventory and side effects; read-only dry runs preserve their behavior", async () => {
  const { runManualWriterAdmission } = await import("./manual");
  const f = interactiveAdmissionFixture();
  f.state.open = false;
  let tasks = 0;
  const task = async () => {
    tasks++;
    return "owned-result";
  };
  await assert.rejects(
    runManualWriterAdmission(true, "new-work", task, f.run),
    WriterAdmissionError,
  );
  assert.equal(tasks, 0);
  assert.equal(
    await runManualWriterAdmission(false, "new-work", task, f.run),
    "owned-result",
  );
  assert.equal(tasks, 1);
  assert.deepEqual(f.events, []);
});

test("exported nonshipping admin/manual primitives refuse closed configuration before request context or provider effects", async () => {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "./scripts/register-server-only-test.mjs",
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      String.raw`
    import assert from "node:assert/strict";
    let providers = 0;
    globalThis.fetch = async () => { providers++; throw new Error("OWNED_UNEXPECTED_PROVIDER"); };
    const operations = await import("./src/lib/admin/operations-write.ts");
    const employee = await import("./src/lib/admin/employee-calendar.ts");
    const promotions = await import("./src/lib/admin/service-promotions.ts");
    const square = await import("./src/lib/admin/square-team-attribution.ts");
    const audits = await import("./src/lib/admin/audit-log.ts");
    const proofs = await import("./src/lib/admin/step-up-proof.ts");
    const retries = await import("./src/lib/transactional-email-retry.ts");
    const noShow = await import("./src/app/api/admin/appointments/[id]/no-show/handler.ts");
    const calls = [
      () => operations.createCalendarConnection(),
      () => operations.saveAdminGoogleCalendarCredential({}),
      () => employee.createEmployeeCalendarConnection("owned"),
      () => employee.saveEmployeeGoogleCalendarCredential({}),
      () => promotions.createServicePromotion({}),
      () => square.refreshSquareTeamMappings(),
      () => audits.recordAdminAudit({}),
      () => proofs.issueAdminStepUpProof({}),
      () => proofs.consumeAdminStepUpProof({}),
      () => retries.retryTransactionalEmail({ flow: "booking", orderId: "owned", origin: "https://owned.invalid" }),
      () => noShow.defaultChargeNoShowCommand({}),
    ];
    for (const call of calls) await assert.rejects(call(), error => error.name === "WriterAdmissionError" && error.code === "configuration");
    assert.equal(providers, 0);
  `,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        FRONTEND_WRITER_ADMISSION_MODE: "enforce",
        FRONTEND_WRITER_ADMISSION_TARGET_JSON: "{}",
        NEXT_PUBLIC_SANITY_DATASET: "owned",
        NEXT_PUBLIC_SANITY_PROJECT_ID: "owned",
        VERCEL_ENV: "production",
        VERCEL_TARGET_ENV: "production",
        APP_ENV: "staging",
      },
    },
  );
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

test("legacy booking write-mode maintenance commands refuse before their Sanity inventory fetch", async () => {
  const { spawnSync } = await import("node:child_process");
  for (const script of [
    "bootstrap-booking-operations",
    "import-booking-operational-cutover",
  ]) {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "./scripts/register-server-only-test.mjs",
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        `
      globalThis.fetch = async () => { throw new Error("OWNED_UNEXPECTED_PROVIDER"); };
      process.argv.push("--execute");
      await import("./scripts/${script}.ts");
    `,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          FRONTEND_WRITER_ADMISSION_MODE: "enforce",
          FRONTEND_WRITER_ADMISSION_TARGET_JSON: "{}",
          NEXT_PUBLIC_SANITY_DATASET: "owned",
          NEXT_PUBLIC_SANITY_PROJECT_ID: "owned",
          VERCEL_ENV: "production",
          VERCEL_TARGET_ENV: "production",
          APP_ENV: "staging",
        },
      },
    );
    assert.equal(result.status, 1, script);
    assert.match(result.stderr, /Writer admission configuration/);
    assert.doesNotMatch(result.stderr, /OWNED_UNEXPECTED_PROVIDER/);
  }
});
