import assert from "node:assert/strict";
import test from "node:test";
import { sendShippingPolicyAlert } from "./policy-alerts";

test("refund policy alerts await every outbox enqueue before propagating a sibling failure", async () => {
  const previous = process.env.CHECKOUT_SECRET_ENCRYPTION_KEY;
  process.env.CHECKOUT_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString("base64");
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const failure = new Error("owned-enqueue-failure");
  let inserts = 0, finished = false, settled = false;
  // Exercise the real alert fan-out and encrypted outbox enqueue, with only
  // the transaction's terminal queries replaced by controlled fixture results.
  const executor = {
    select: () => ({ from: () => ({ where: async () => [
      { email: "one@example.invalid" }, { email: "two@example.invalid" },
    ] }) }),
    insert: () => ({ values: () => ({ onConflictDoNothing: () => ({ returning: async () => {
      if (++inserts === 1) throw failure;
      entered(); await held; finished = true; return [{ id: "owned-outbox" }];
    } }) }) }),
  } as unknown as NonNullable<Parameters<typeof sendShippingPolicyAlert>[0]["executor"]>;
  try {
    const result = sendShippingPolicyAlert({ duties: ["finance_owner"], subject: "Owned", message: "Owned",
      idempotencyKey: "owned-refund", executor });
    const observed = result.then(() => { settled = true; }, error => { settled = true; return error; });
    await started;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(settled, false); assert.equal(finished, false); assert.equal(inserts, 2);
    release(); assert.equal(await observed, failure); assert.equal(finished, true);
  } finally {
    release();
    if (previous === undefined) delete process.env.CHECKOUT_SECRET_ENCRYPTION_KEY;
    else process.env.CHECKOUT_SECRET_ENCRYPTION_KEY = previous;
  }
});
