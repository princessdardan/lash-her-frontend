import assert from "node:assert/strict";
import test from "node:test";

import { executeAuditedMutation } from "./audited-mutation";

interface FakeTransaction {
  rows: string[];
}

function createTransactionalState() {
  let committedRows: string[] = [];

  return {
    get rows() {
      return committedRows;
    },
    transaction: async <T>(
      operation: (tx: FakeTransaction) => Promise<T>,
    ): Promise<T> => {
      const tx = { rows: [...committedRows] };
      const result = await operation(tx);
      committedRows = tx.rows;
      return result;
    },
  };
}

test("an audit failure rolls back the accompanying admin mutation", async () => {
  const state = createTransactionalState();

  await assert.rejects(
    executeAuditedMutation<string, FakeTransaction>(state.transaction, {
      mutate: async (tx) => {
        tx.rows.push("domain-write");
        return "target-id";
      },
      writeAudit: async () => {
        throw new Error("audit insert failed");
      },
    }),
    /audit insert failed/,
  );

  assert.deepEqual(state.rows, []);
});

test("a successful mutation and audit commit together", async () => {
  const state = createTransactionalState();

  await executeAuditedMutation<string, FakeTransaction>(state.transaction, {
    mutate: async (tx) => {
      tx.rows.push("domain-write");
      return "target-id";
    },
    writeAudit: async (tx, targetId) => {
      tx.rows.push(`audit:${targetId}`);
    },
  });

  assert.deepEqual(state.rows, ["domain-write", "audit:target-id"]);
});
