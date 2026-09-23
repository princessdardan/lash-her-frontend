import assert from "node:assert/strict";
import test from "node:test";
import {
  chargeTrainingSplit,
  type TrainingSplitDependencies,
  type TrainingSplitState,
} from "./square-training-split";
import type { SquarePayment } from "@/lib/payments/square/payments-client";
import type { TrainingSplitPayment } from "@/lib/payments/square/training-split-policy";

const payment: TrainingSplitPayment = {
  method: "afterpay_card",
  expectedAmountCents: 395500,
  afterpayAmountCents: 200000,
  afterpay: {
    method: "afterpay",
    sourceId: "ap-nonce",
    expectedAmountCents: 200000,
  },
  card: { sourceId: "card-nonce" },
};
function scenario() {
  let state: TrainingSplitState = {
    stage: "reserved",
    cardAmountCents: 195500,
    afterpayAmountCents: 200000,
  };
  const calls: string[] = [];
  const payments = new Map<string, SquarePayment>();
  const deps: TrainingSplitDependencies = {
    load: async () => ({ ...state }),
    save: async (value) => {
      state = { ...value };
    },
    createOrder: async () => {
      calls.push("order");
      return "sq-order";
    },
    authorize: async (request) => {
      const leg = request.idempotency_key.endsWith("/card")
        ? "card"
        : "afterpay";
      calls.push(`authorize:${leg}`);
      assert.equal(request.autocomplete, false);
      assert.equal(request.order_id, "sq-order");
      const p = {
        id: leg,
        status: "APPROVED",
        order_id: request.order_id,
        reference_id: request.reference_id,
        amount_money: request.amount_money,
        source_type: leg === "card" ? "CARD" : "BUY_NOW_PAY_LATER",
      };
      payments.set(leg, p);
      return p;
    },
    getPayment: async (id) => ({ ...payments.get(id)! }),
    payOrder: async (_id, ids) => {
      calls.push("capture");
      assert.deepEqual(ids, ["card", "afterpay"]);
      for (const p of payments.values()) p.status = "COMPLETED";
    },
    complete: async (id) => {
      calls.push(`complete:${id}`);
      payments.get(id)!.status = "COMPLETED";
    },
    cancel: async (id) => {
      calls.push(`cancel:${id}`);
      const p = payments.get(id)!;
      if (p.status === "COMPLETED") throw new Error("Already captured");
      p.status = "CANCELED";
    },
    cancelByKey: async (key) => {
      calls.push(`cancel-key:${key.split("/").at(-1)}`);
    },
    finalize: async (value) => {
      calls.push("finalize");
      assert.ok([...payments.values()].every((p) => p.status === "COMPLETED"));
      state = { ...value };
    },
    notify: async () => {
      calls.push("notify");
    },
    logError: (reason) => {
      calls.push(`log:${reason}`);
    },
  };
  return {
    deps,
    calls,
    payments,
    state: () => state,
    setState: (value: TrainingSplitState) => {
      state = value;
    },
    run: (source: TrainingSplitPayment | undefined = payment) =>
      chargeTrainingSplit(
        { orderReference: "lh-test", amountCents: 395500, payment: source },
        deps,
      ),
    recover: () =>
      chargeTrainingSplit(
        { orderReference: "lh-test", amountCents: 395500 },
        deps,
      ),
  };
}

test("two portions authorize card first and finalize only after both capture; replay never charges again", async () => {
  const s = scenario();
  assert.equal((await s.run()).ok, true);
  assert.deepEqual(s.calls, [
    "order",
    "authorize:card",
    "authorize:afterpay",
    "capture",
    "finalize",
    "notify",
  ]);
  assert.equal(s.payments.get("card")?.amount_money.amount, 195500);
  assert.equal(s.payments.get("afterpay")?.amount_money.amount, 200000);
  assert.equal(s.state().stage, "paid");
  assert.equal((await s.recover()).ok, true);
  assert.equal(s.calls.filter((c) => c === "capture").length, 1);
});

test("card decline cancels uncertain outcomes without attempting Afterpay", async () => {
  const s = scenario();
  s.deps.authorize = async () => {
    throw new Error("Declined");
  };
  assert.deepEqual(await s.run(), {
    ok: false,
    reason: "split_payment_canceled",
    retryWithNewReservation: true,
  });
  assert.ok(s.calls.includes("cancel-key:card"));
  assert.ok(s.calls.includes("cancel-key:afterpay"));
  assert.ok(!s.calls.includes("finalize"));
});

test("Afterpay rejection voids card; a failed void blocks new reservations", async () => {
  const s = scenario();
  const authorize = s.deps.authorize;
  s.deps.authorize = async (request) => {
    if (request.idempotency_key.endsWith("/afterpay"))
      throw new Error("Declined");
    return authorize(request);
  };
  s.deps.cancel = async () => {
    throw new Error("Timeout");
  };
  assert.equal((await s.run()).ok, false);
  assert.equal(s.state().stage, "canceling");
  const retry = await s.recover();
  assert.equal(retry.ok, false);
  if (!retry.ok) assert.equal(retry.retryWithNewReservation, false);
  assert.ok(!s.calls.includes("capture"));
});

test("lost PayOrder response recovers completed portions with no new authorization", async () => {
  const s = scenario();
  const pay = s.deps.payOrder;
  s.deps.payOrder = async (...args) => {
    await pay(...args);
    throw new Error("Connection lost");
  };
  const first = await s.run();
  assert.equal(first.ok, false);
  assert.equal(s.state().stage, "capturing");
  assert.ok(!s.calls.includes("finalize"));
  assert.equal((await s.recover()).ok, true);
  assert.equal(s.calls.filter((c) => c.startsWith("authorize:")).length, 2);
});

test("crash before PayOrder retries the exact capture with existing payment IDs", async () => {
  const s = scenario();
  const pay = s.deps.payOrder;
  s.deps.payOrder = async () => {
    throw new Error("Offline");
  };
  await s.run();
  s.deps.payOrder = pay;
  assert.equal((await s.recover()).ok, true);
  assert.equal(s.calls.filter((c) => c.startsWith("authorize:")).length, 2);
});

test("interrupted authorization with unknown ID cancels by key and never uses new tokens", async () => {
  const s = scenario();
  s.setState({
    ...s.state(),
    squareOrderId: "sq-order",
    stage: "authorizing_card",
  });
  const result = await s.recover();
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.retryWithNewReservation, true);
  assert.ok(!s.calls.some((c) => c.startsWith("authorize:")));
});

test("a partial capture never confirms enrollment or permits a new charge", async () => {
  const s = scenario();
  s.deps.payOrder = async () => {
    s.payments.get("card")!.status = "COMPLETED";
    s.payments.get("afterpay")!.status = "FAILED";
  };
  await s.run();
  const result = await s.recover();
  assert.deepEqual(result, {
    ok: false,
    reason: "split_payment_requires_review",
    retryWithNewReservation: false,
  });
  assert.ok(!s.calls.includes("finalize"));
});

test("provider amount/source mismatches cancel authorizations before capture", async () => {
  for (const mismatch of ["amount", "source", "order", "reference"]) {
    const s = scenario();
    const authorize = s.deps.authorize;
    s.deps.authorize = async (request) => {
      const p = await authorize(request);
      if (mismatch === "amount")
        p.amount_money = { amount: 1, currency: "CAD" };
      if (mismatch === "source") p.source_type = "CASH";
      if (mismatch === "order") p.order_id = "another-order";
      if (mismatch === "reference") p.reference_id = "another-reference";
      return p;
    };
    assert.equal((await s.run()).ok, false);
    assert.ok(!s.calls.includes("capture"));
  }
});

test("stale, excessive, and changed split amounts never call Square", async () => {
  for (const p of [
    { ...payment, afterpayAmountCents: 200001 },
    { ...payment, expectedAmountCents: 395499 },
    { ...payment, afterpayAmountCents: 150000 },
  ]) {
    const s = scenario();
    assert.equal((await s.run(p)).ok, false);
    assert.deepEqual(s.calls, []);
  }
});

test("failure writing paid state can be recovered without capturing again", async () => {
  const s = scenario();
  const finalize = s.deps.finalize;
  s.deps.finalize = async () => {
    throw new Error("DB unavailable");
  };
  assert.equal((await s.run()).ok, false);
  s.deps.finalize = finalize;
  assert.equal((await s.recover()).ok, true);
  assert.equal(s.calls.filter((c) => c === "capture").length, 1);
});

test("completed Square order with approved payment records completes the same IDs before enrollment", async () => {
  const s = scenario();
  s.deps.payOrder = async () => {
    s.calls.push("capture");
  };
  assert.equal((await s.run()).ok, true);
  assert.deepEqual(s.calls.slice(-4), [
    "complete:card",
    "complete:afterpay",
    "finalize",
    "notify",
  ]);
});

test("interrupted explicit completion resumes the remaining authorization without new charges", async () => {
  const s = scenario();
  s.deps.payOrder = async () => {
    s.calls.push("capture");
  };
  const complete = s.deps.complete;
  s.deps.complete = async (id) => {
    if (id === "afterpay") throw new Error("Offline");
    await complete(id);
  };
  assert.equal((await s.run()).ok, false);
  assert.equal(s.state().stage, "completing");
  assert.ok(!s.calls.includes("finalize"));
  s.deps.complete = complete;
  assert.equal((await s.recover()).ok, true);
  assert.equal(s.calls.filter((c) => c === "complete:card").length, 1);
  assert.equal(s.calls.filter((c) => c === "capture").length, 1);
});
