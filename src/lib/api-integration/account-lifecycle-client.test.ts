import assert from "node:assert/strict";
import test from "node:test";
import { createAccountLifecycleClient, LifecycleDeliveryError, type AccountLifecycleCommand } from "./account-lifecycle-client";
import { withWriterOperationContext } from "@/lib/writer-admission/context";
import type { GatewayRequest } from "./gateway-transport";

const command: AccountLifecycleCommand = { version: 1, commandId: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222", accountVersion: 2, action: "export", issuedAt: "2026-11-05T12:00:00.000Z" };
const now = Date.parse(command.issuedAt);
const receipt = { commandId: command.commandId, accountVersion: command.accountVersion, status: "accepted" };
const exported = { commandId: command.commandId, userId: command.userId, accountVersion: command.accountVersion, expiresAt: new Date(now + 86_400_000).toISOString(), data: { account: { status: "active", accountVersion: 2 }, commands: [], inbox: [], projections: [] } };

test("service lifecycle delivery binds exact command, header, selected receiver and original receipt", async () => {
  for (const receiver of ["course", "community"] as const) {
    let minted = 0;
    const client = createAccountLifecycleClient({ receiver, mintServiceToken: () => { minted++; return "dedicated.lifecycle.jwt"; }, run: async (kind, work) => { assert.equal(kind, "recovery"); return work(); },
      getTransport: () => async (request: GatewayRequest) => {
        assert.equal(request.service, receiver); assert.equal(request.path, "/v1/internal/accounts/commands");
        assert.equal(request.applicationToken, "dedicated.lifecycle.jwt"); assert.equal(request.idempotencyKey, command.commandId); assert.deepEqual(JSON.parse(request.body!), command);
        return Response.json(receipt);
      } });
    assert.deepEqual(await client.deliverCommand(command), receipt); assert.equal(minted, 1);
    await assert.rejects(client.deliverCommand({ ...command, email: "must-not-forward@example.com" } as never));
    assert.equal(minted, 1);
  }
});

test("lifecycle conflicts preserve only allowlisted machine classifications and safe metadata", async () => {
  for (const [code, retryable] of [["account_version_conflict", true], ["idempotency_conflict", false], ["account_deleted", false], ["private-provider-token", false]] as const) {
    const client = createAccountLifecycleClient({ receiver: "community", mintServiceToken: () => "service.jwt", run: async (_kind, work) => work(),
      getTransport: () => async () => Response.json({ error: { code, message: "private-customer-profile" }, requestId: command.commandId }, { status: 409, headers: { "x-request-id": "unsafe-private-value", "retry-after": "private-provider-token" } }) });
    await assert.rejects(client.deliverCommand(command), error => {
      assert.ok(error instanceof LifecycleDeliveryError); assert.equal(error.retryable, retryable);
      assert.equal(error.message.includes("private"), false); assert.equal(error.requestId.includes("unsafe"), false); assert.equal(error.retryAfter, undefined);
      assert.equal(error.receiverCode, code === "private-provider-token" ? "rejected" : code); return true;
    });
  }
});

test("wrong receipt is uncertain even when an adapter converts the failure into a safe response", async () => {
  const client = createAccountLifecycleClient({ receiver: "community", mintServiceToken: () => "service.jwt", run: async (_kind, work) => withWriterOperationContext(work),
    getTransport: () => async () => Response.json({ ...receipt, accountVersion: 3 }) });
  await assert.rejects(client.deliverCommand(command), /WRITER_OPERATION_REQUIRES_REVIEW/u);
});

test("private exports are closed, bound to command and owner/version, and denied at expiry", async () => {
  for (const [response, expected] of [
    [exported, "success"], [{ ...exported, userId: command.commandId }, "service_unavailable"],
    [{ ...exported, commandId: command.userId }, "service_unavailable"], [{ ...exported, accountVersion: 3 }, "service_unavailable"],
    [{ ...exported, expiresAt: command.issuedAt }, "not_found"], [{ ...exported, expiresAt: new Date(now + 86_400_001).toISOString() }, "service_unavailable"],
    [{ ...exported, privateBearer: "must-not-leak" }, "service_unavailable"],
  ] as const) {
    const client = createAccountLifecycleClient({ receiver: "community", now: () => now, mintServiceToken: () => "service.jwt", getTransport: () => async request => {
      assert.equal(request.service, "community"); assert.equal(request.method, "GET"); assert.equal(request.path, `/v1/internal/accounts/exports/${command.commandId}`); return Response.json(response);
    } });
    if (expected === "success") assert.deepEqual(await client.getExport(command), exported);
    else await assert.rejects(client.getExport(command), { code: expected });
  }
});

test("Course exports use their committed receiver schema and cannot be substituted with Community data", async () => {
  const courseExport = { ...exported, data: { account: { status: "active", accountVersion: 2, email: null }, commands: [], progress: [], attempts: [], grants: [] } };
  for (const value of [courseExport, exported, { ...courseExport, data: { ...courseExport.data, providerToken: "must-not-forward" } }]) {
    const client = createAccountLifecycleClient({ receiver: "course", now: () => now, mintServiceToken: () => "course.service.jwt", getTransport: () => async request => {
      assert.equal(request.service, "course"); return Response.json(value);
    } });
    if (value === courseExport) assert.deepEqual(await client.getExport(command), courseExport);
    else await assert.rejects(client.getExport(command), { code: "service_unavailable" });
  }
});
