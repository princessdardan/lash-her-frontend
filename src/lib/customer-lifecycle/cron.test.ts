import assert from "node:assert/strict";
import test from "node:test";
import { VERCEL_PROJECT_BINDINGS } from "@/lib/env/application-environment.mjs";
import { currentWriterOperationIdentity, withWriterOperationContext, type WriterOperationIdentity } from "@/lib/writer-admission/context";
import { createAccountLifecycleCron, createScopedExportCleanupRunner } from "./cron";
import { AccountLifecycleError } from "./policy";

const identity = (operationId: string): WriterOperationIdentity => ({ operationId, kind: "recovery", epoch: "7",
  producerSha256: "a".repeat(64), sourceCommit: "b".repeat(40), targetSha256: "c".repeat(64) });
const stagingProductionEnvironment = () => ({ VERCEL: "1", APP_ENV: "staging", VERCEL_ENV: "production", VERCEL_TARGET_ENV: "production",
  APP_VERCEL_TEAM_ID: VERCEL_PROJECT_BINDINGS.teamId, VERCEL_PROJECT_ID: VERCEL_PROJECT_BINDINGS.stagingProjectId! });

test("lifecycle recovery is independently disabled and authenticated before any database or receiver work", async () => {
  let calls = 0;
  const run = async () => { calls++; return { acknowledged: 1, retrying: 0, blocked: 0, exportsReady: 0, expired: 0 }; };
  const request = (authorization: string) => new Request("https://staging.example.com/api/cron/account-lifecycle",
    { headers: { authorization, "x-request-id": "11111111-1111-4111-8111-111111111111" } });
  const disabled = createAccountLifecycleCron({ enabled: () => false, secret: () => "owned", run });
  const disabledResponse = await disabled(request("Bearer owned"));
  assert.equal(disabledResponse.status, 404); assert.equal(disabledResponse.headers.get("x-request-id"), null);
  const missing = createAccountLifecycleCron({ enabled: () => true, secret: () => undefined, run });
  const missingResponse = await missing(request("Bearer owned"));
  assert.equal(missingResponse.status, 404); assert.equal(missingResponse.headers.get("x-request-id"), null);
  const handler = createAccountLifecycleCron({ enabled: () => true, secret: () => "owned", run });
  for (const value of ["", "owned", "Basic owned", "Bearer wrong"]) {
    const response = await handler(request(value)); assert.equal(response.status, 401); assert.equal(response.headers.get("x-request-id"), null);
  }
  assert.equal(calls, 0);
  const response = await handler(request("Bearer owned"));
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-request-id"), null); assert.equal(calls, 1);
});
test("unavailable receivers, rejected commands and unexpected errors return sanitized retryable responses", async () => {
  for (const outcome of ["retry", "blocked", "error"]) {
    const handler = createAccountLifecycleCron({ enabled: () => true, secret: () => "owned", run: async () => {
      if (outcome === "error") throw new Error("private-receiver-credentials");
      return { acknowledged: 0, retrying: outcome === "retry" ? 1 : 0, blocked: outcome === "blocked" ? 1 : 0, exportsReady: 0, expired: 0 };
    } });
    const response = await handler(new Request("https://staging.example.com/api/cron/account-lifecycle", { headers: { authorization: "Bearer owned" } }));
    assert.equal(response.status, 503); assert.equal(response.headers.get("retry-after"), "30");
    assert.equal(response.headers.get("x-request-id"), null);
    assert.equal((await response.text()).includes("private-receiver-credentials"), false);
  }
});

test("concurrent admitted requests return only their own AsyncLocalStorage operation UUID", async () => {
  const operationIds = ["22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
  let started = 0, release!: () => void;
  const bothStarted = new Promise<void>(resolve => { release = resolve; });
  const handler = createAccountLifecycleCron({ enabled: () => true, secret: () => "owned", run: async onAdmitted => {
    const selected = identity(operationIds[started++]);
    return withWriterOperationContext(async () => {
      const active = currentWriterOperationIdentity(); assert.equal(active?.operationId, selected.operationId);
      onAdmitted?.(active!.operationId);
      if (started === operationIds.length) release();
      await bothStarted;
      assert.equal(currentWriterOperationIdentity()?.operationId, selected.operationId);
      return { acknowledged: 1, retrying: 0, blocked: 0, exportsReady: 0, expired: 0 };
    }, selected);
  } });
  const makeRequest = (forged: string) => new Request("https://staging.example.com/api/cron/account-lifecycle",
    { headers: { authorization: "Bearer owned", "x-request-id": forged } });
  const responses = await Promise.all([handler(makeRequest("44444444-4444-4444-8444-444444444444")),
    handler(makeRequest("55555555-5555-4555-8555-555555555555"))]);
  assert.deepEqual(responses.map(response => response.status), [200, 200]);
  assert.deepEqual(responses.map(response => response.headers.get("x-request-id")), operationIds);
  assert.equal(currentWriterOperationIdentity(), undefined);
});

test("admitted retryable responses retain the actual operation UUID while no-context values are omitted", async () => {
  const operationIds = ["66666666-6666-4666-8666-666666666666", "77777777-7777-4777-8777-777777777777"];
  for (const [index, outcome] of ["retrying", "error"].entries()) {
    const selected = identity(operationIds[index]);
    const handler = createAccountLifecycleCron({ enabled: () => true, secret: () => "owned", run: async onAdmitted =>
      withWriterOperationContext(async () => {
        onAdmitted?.(currentWriterOperationIdentity()!.operationId);
        if (outcome === "error") throw new Error("private-provider-result");
        return { acknowledged: 0, retrying: 1, blocked: 0, exportsReady: 0, expired: 0 };
      }, selected) });
    const response = await handler(new Request("https://staging.example.com/api/cron/account-lifecycle",
      { headers: { authorization: "Bearer owned", "x-request-id": "88888888-8888-4888-8888-888888888888" } }));
    assert.equal(response.status, 503); assert.equal(response.headers.get("x-request-id"), selected.operationId);
    assert.equal((await response.text()).includes("private-provider-result"), false);
  }
  const withoutContext = createAccountLifecycleCron({ enabled: () => true, secret: () => "owned", run: async onAdmitted => {
    onAdmitted?.("99999999-9999-4999-8999-999999999999");
    return { acknowledged: 1, retrying: 0, blocked: 0, exportsReady: 0, expired: 0 };
  } });
  const response = await withoutContext(new Request("https://staging.example.com/api/cron/account-lifecycle",
    { headers: { authorization: "Bearer owned", "x-request-id": "99999999-9999-4999-8999-999999999999" } }));
  assert.equal(response.status, 200); assert.equal(response.headers.get("x-request-id"), null);
});

test("scoped export cleanup accepts only the canonical selector and staging policy before admission", async () => {
  const commandId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  let scopedCalls = 0, ordinaryCalls = 0;
  const handler = createAccountLifecycleCron({ enabled: () => true, secret: () => "owned", environment: stagingProductionEnvironment,
    run: async () => { ordinaryCalls++; return { acknowledged: 0, retrying: 0, blocked: 0, exportsReady: 0, expired: 0 }; },
    runScoped: async () => { scopedCalls++; throw new Error("must not run"); },
  });
  const paths = [
    `?commandId=${commandId}&operation=expire-export`,
    `?operation=expire-export&commandId=${commandId}&extra=true`,
    `?operation=expire-export&operation=expire-export&commandId=${commandId}`,
    `?operation=expire-export&commandId=${commandId.toUpperCase()}`,
    `?operation=other&commandId=${commandId}`,
    `?operation=expire-export&commandId=not-a-command`,
    `?%6fperation=expire-export&commandId=${commandId}`,
  ];
  for (const search of paths) {
    const response = await handler(new Request(`https://staging.example.com/api/cron/account-lifecycle${search}`, { headers: { authorization: "Bearer owned" } }));
    assert.equal(response.status, 404); assert.deepEqual(await response.json(), { error: "unavailable" });
    assert.equal(response.headers.get("x-request-id"), null);
  }
  const environments = [
    {},
    { ...stagingProductionEnvironment(), APP_ENV: "production", VERCEL_PROJECT_ID: VERCEL_PROJECT_BINDINGS.productionProjectId },
    { ...stagingProductionEnvironment(), VERCEL_ENV: "preview", VERCEL_TARGET_ENV: "preview" },
    { ...stagingProductionEnvironment(), VERCEL: undefined },
  ];
  for (const environment of environments) {
    const unavailable = createAccountLifecycleCron({ enabled: () => true, secret: () => "owned", environment: () => environment,
      runScoped: async () => { scopedCalls++; throw new Error("must not run"); } });
    const response = await unavailable(new Request(`https://staging.example.com/api/cron/account-lifecycle?operation=expire-export&commandId=${commandId}`,
      { headers: { authorization: "Bearer owned" } }));
    assert.equal(response.status, 404); assert.equal(response.headers.get("x-request-id"), null);
  }
  const invalidPolicy = createAccountLifecycleCron({ enabled: () => true, secret: () => "owned", environment: () => { throw new Error("private binding"); },
    runScoped: async () => { scopedCalls++; throw new Error("must not run"); } });
  const invalidResponse = await invalidPolicy(new Request(`https://staging.example.com/api/cron/account-lifecycle?operation=expire-export&commandId=${commandId}`,
    { headers: { authorization: "Bearer owned" } }));
  assert.equal(invalidResponse.status, 404); assert.equal((await invalidResponse.text()).includes("private binding"), false);
  const head = await handler(new Request(`https://staging.example.com/api/cron/account-lifecycle?operation=expire-export&commandId=${commandId}`,
    { method: "HEAD", headers: { authorization: "Bearer owned" } }));
  assert.equal(head.status, 404); assert.equal(head.headers.get("x-request-id"), null);
  assert.equal(scopedCalls, 0); assert.equal(ordinaryCalls, 0);
});

test("production scoped cleanup refuses missing or non-recovery ledger identity before trace and store", async () => {
  const commandId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  let traces = 0, stores = 0, admissions = 0;
  const runner = createScopedExportCleanupRunner({ trace: () => { traces++; }, expireExport: async selected => {
    stores++; return { operation: "expire-export", commandId: selected, outcome: "scrubbed", status: "expired", dataCleared: true, frontendCleared: true };
  } });
  await assert.rejects(() => runner(commandId, () => { admissions++; }), /SCOPED_EXPORT_CLEANUP_REQUIRES_RECOVERY_ADMISSION/u);
  await assert.rejects(() => withWriterOperationContext(() => runner(commandId, () => { admissions++; }), { ...identity("11111111-1111-4111-8111-111111111111"), kind: "new-work" }),
    /SCOPED_EXPORT_CLEANUP_REQUIRES_RECOVERY_ADMISSION/u);
  assert.deepEqual({ traces, stores, admissions }, { traces: 0, stores: 0, admissions: 0 });
  const admittedIdentity = identity("22222222-2222-4222-8222-222222222222");
  const result = await withWriterOperationContext(() => runner(commandId, operationId => {
    admissions++; assert.equal(operationId, admittedIdentity.operationId);
  }), admittedIdentity);
  assert.equal(result.commandId, commandId);
  assert.deepEqual({ traces, stores, admissions }, { traces: 1, stores: 1, admissions: 1 });
});

test("scoped export cleanup binds the exact command, cleanup outcome and admitted request identity without ordinary lifecycle work", async () => {
  const commandId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const operationId = "22222222-2222-4222-8222-222222222222";
  let ordinaryCalls = 0, selectedCommand: string | undefined;
  const handler = createAccountLifecycleCron({ enabled: () => true, secret: () => "owned", environment: stagingProductionEnvironment,
    run: async () => { ordinaryCalls++; return { acknowledged: 0, retrying: 0, blocked: 0, exportsReady: 0, expired: 0 }; },
    runScoped: async (selected, onAdmitted) => withWriterOperationContext(async () => {
      selectedCommand = selected; onAdmitted?.(currentWriterOperationIdentity()!.operationId);
      return { operation: "expire-export" as const, commandId: selected, outcome: "scrubbed" as const,
        status: "expired" as const, dataCleared: true as const, frontendCleared: true as const };
    }, identity(operationId)),
  });
  const response = await handler(new Request(`https://staging.example.com/api/cron/account-lifecycle?operation=expire-export&commandId=${commandId}`,
    { headers: { authorization: "Bearer owned", "x-request-id": "33333333-3333-4333-8333-333333333333" } }));
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-request-id"), operationId); assert.equal(selectedCommand, commandId); assert.equal(ordinaryCalls, 0);
  assert.deepEqual(await response.json(), { operation: "expire-export", commandId, outcome: "scrubbed", status: "expired",
    dataCleared: true, frontendCleared: true, requestId: operationId });
});

test("scoped export cleanup returns settled domain refusals and sanitizes uncertain failures", async () => {
  const commandId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const operationIds = ["44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"];
  for (const [index, failure] of [new AccountLifecycleError(409, "export_not_expired"), new Error("private export bytes")].entries()) {
    const handler = createAccountLifecycleCron({ enabled: () => true, secret: () => "owned", environment: stagingProductionEnvironment,
      runScoped: async (_selected, onAdmitted) => withWriterOperationContext(async () => {
        onAdmitted?.(currentWriterOperationIdentity()!.operationId); throw failure;
      }, identity(operationIds[index])),
    });
    const response = await handler(new Request(`https://staging.example.com/api/cron/account-lifecycle?operation=expire-export&commandId=${commandId}`,
      { headers: { authorization: "Bearer owned" } }));
    assert.equal(response.status, index === 0 ? 409 : 503); assert.equal(response.headers.get("x-request-id"), operationIds[index]);
    assert.deepEqual(await response.json(), index === 0 ? { error: "export_not_expired" } : { error: "temporarily_unavailable" });
  }
});
