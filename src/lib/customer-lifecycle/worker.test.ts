import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import { customerUsers } from "@/lib/customer-auth/schema";
import type { getPrivateDb } from "@/lib/private-db/client";
import { withWriterOperationContext } from "@/lib/writer-admission/context";
import { runAccountWriter } from "./context";
import { AccountLifecycleError, type AccountCommand } from "./policy";
import { customerAccountDeliveries as deliveries, customerAccountExports as exports } from "./schema";
import { createAccountLifecycleStore, type ClaimedAccountDelivery } from "./store";
import { processAccountLifecycle, type LifecycleClient } from "./worker";

type Database = ReturnType<typeof getPrivateDb>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
const instant = new Date("2026-11-05T12:00:00.000Z");
const originalAdmissionMode = process.env.FRONTEND_WRITER_ADMISSION_MODE;
before(() => { process.env.FRONTEND_WRITER_ADMISSION_MODE = "off"; });
after(() => {
  if (originalAdmissionMode === undefined) delete process.env.FRONTEND_WRITER_ADMISSION_MODE;
  else process.env.FRONTEND_WRITER_ADMISSION_MODE = originalAdmissionMode;
});

function command(action: AccountCommand["action"]): AccountCommand {
  return { version: 1, commandId: randomUUID(), userId: randomUUID(), accountVersion: 1, action, issuedAt: instant.toISOString() };
}

/** This seam models a COMMIT accepted by PostgreSQL with its acknowledgement
 * lost in transit. Real store mutation guards and the real worker handle the
 * error; no test double marks admission uncertainty on their behalf. */
function committedMutationWithLostReceipt(input: AccountCommand, mutation: "ack" | "export") {
  let acknowledged = false, exportReady = false, throwAfterCommit = true;
  let mutationAttempts = 0, committedWrites = 0, transactions = 0, lostReceipts = 0;
  let exportData: unknown = null, exportExpiry: Date | null = null, exportReadyAt: Date | null = null;
  const leaseId = randomUUID();
  const claim: ClaimedAccountDelivery = { command: input, receiver: "course", leaseId, attempts: 1 };
  const deliveryRow = () => ({ commandId: input.commandId, receiver: "course", status: acknowledged ? "acknowledged" : "delivering", attempts: 1,
    leaseId: acknowledged ? null : leaseId, leaseUntil: acknowledged ? null : new Date(instant.getTime() + 90_000), acknowledgedAt: acknowledged ? instant : null,
    nextRunAt: instant, lastError: null });
  const exportRow = () => ({ commandId: input.commandId, userId: input.userId, status: exportReady ? "ready" : "pending",
    frontendData: exportReady ? null : { profile: "synthetic" }, data: exportReady ? exportData : null,
    readyAt: exportReadyAt, expiresAt: exportExpiry });
  function query(mode: "select" | "update", initialTable?: unknown) {
    let table = initialTable;
    let values: Record<string, unknown> = {};
    const resolve = (): unknown[] => {
      if (mode === "select") {
        if (table === customerUsers) return [{ id: input.userId, status: "active", accountVersion: 1 }];
        if (table === deliveries) return [deliveryRow()];
        if (table === exports) return [exportRow()];
      }
      if (mode === "update" && table === deliveries && mutation === "ack") {
        mutationAttempts++;
        if (acknowledged) return [];
        acknowledged = true; committedWrites++; return [deliveryRow()];
      }
      if (mode === "update" && table === exports && mutation === "export") {
        mutationAttempts++;
        if (exportReady) return [];
        exportReady = true; exportData = values.data;
        exportExpiry = values.expiresAt instanceof Date ? values.expiresAt : null;
        exportReadyAt = values.readyAt instanceof Date ? values.readyAt : null;
        committedWrites++; return [exportRow()];
      }
      throw new Error("UNEXPECTED_LIFECYCLE_FAULT_QUERY");
    };
    const builder = {
      from(value: unknown) { table = value; return builder; },
      where() { return builder; }, for() { return builder; }, limit() { return builder; }, orderBy() { return builder; },
      set(value: Record<string, unknown>) { values = value; return builder; }, returning() { return builder; },
      then(fulfilled?: (rows: unknown[]) => unknown, rejected?: (error: unknown) => unknown) { return Promise.resolve().then(resolve).then(fulfilled, rejected); },
    };
    return builder;
  }
  const transaction = { select: () => query("select"), update: (table: unknown) => query("update", table) } as unknown as Transaction;
  const database = {
    async transaction<T>(task: (tx: Transaction) => Promise<T>): Promise<T> {
      transactions++;
      const value = await task(transaction);
      if (throwAfterCommit && committedWrites > 0) { throwAfterCommit = false; lostReceipts++; throw new Error("SYNTHETIC_SQL_COMMIT_RECEIPT_LOST"); }
      return value;
    },
  } as unknown as Database;
  return { store: createAccountLifecycleStore(() => database, () => instant), claim,
    state: () => ({ acknowledged, exportReady, mutationAttempts, committedWrites, transactions, lostReceipts }) };
}
function client(): LifecycleClient {
  return {
    async deliverCommand(input) { return { commandId: input.commandId, accountVersion: input.accountVersion, status: "accepted" }; },
    async getExport(input) { return { commandId: input.commandId, userId: input.userId, accountVersion: input.accountVersion, expiresAt: new Date(instant.getTime() + 86_400_000).toISOString(), data: { fixture: "receiver-owned" } }; },
  };
}

test("lost local acknowledgment receipt remains uncertain when retry finds the already-acknowledged delivery", async () => {
  const input = command("suspend"), fixture = committedMutationWithLostReceipt(input, "ack");
  let claimed = false;
  const store = { ...fixture.store, expireExports: async () => 0,
    claimDelivery: async () => { if (claimed) return null; claimed = true; return fixture.claim; },
    pendingExports: async () => [],
  };
  await assert.rejects(withWriterOperationContext(async () => {
    await assert.rejects(runAccountWriter("recovery", () => processAccountLifecycle({ store, client })), /SYNTHETIC_SQL_COMMIT_RECEIPT_LOST/u);
    assert.equal(await runAccountWriter("recovery", () => fixture.store.settleDelivery(fixture.claim, "retry")), "already-acknowledged");
  }), /WRITER_OPERATION_REQUIRES_REVIEW/u);
  assert.equal(fixture.state().lostReceipts, 1);
  assert.equal(fixture.state().acknowledged, true);
  assert.equal(fixture.state().committedWrites, 1);
  assert.ok(fixture.state().mutationAttempts >= 2, "retry must inspect the committed disposition without overwriting it");
  assert.ok(fixture.state().transactions >= 2);
});

test("lost local export completion receipt escapes recovery and leaves admission uncertain", async () => {
  const input = command("export"), fixture = committedMutationWithLostReceipt(input, "export");
  const store = { ...fixture.store, expireExports: async () => 0, claimDelivery: async () => null,
    pendingExports: async () => [{ command: input, frontendData: { scope: "synthetic UUID-owned data" } }],
  };
  await assert.rejects(withWriterOperationContext(async () => {
    await assert.rejects(runAccountWriter("recovery", () => processAccountLifecycle({ store, client })), /SYNTHETIC_SQL_COMMIT_RECEIPT_LOST/u);
  }), /WRITER_OPERATION_REQUIRES_REVIEW/u);
  assert.equal(fixture.state().lostReceipts, 1);
  assert.equal(fixture.state().exportReady, true);
  assert.equal(fixture.state().committedWrites, 1);
});

test("expected lifecycle denial can be handled without making the enclosing admitted operation uncertain", async () => {
  const value = await withWriterOperationContext(async () => {
    await assert.rejects(runAccountWriter("new-work", async () => { throw new AccountLifecycleError(429, "export_rate_limited"); }), error => error instanceof AccountLifecycleError && error.status === 429);
    return "settled-denial";
  });
  assert.equal(value, "settled-denial");
});
