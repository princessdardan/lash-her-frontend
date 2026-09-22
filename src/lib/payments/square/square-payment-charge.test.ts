import { execFileSync } from "node:child_process";
import test from "node:test";

// Pure unit coverage for the audited one-time Square sale core
// (authorize -> verify -> record locally -> capture). Exercised entirely
// through the module's injected dependency seams with fakes; no DB or network.
const helperScript = String.raw`
  import assert from "node:assert/strict";

  import { authorizeCaptureSquarePayment } from "./src/lib/payments/square/square-payment-charge.ts";

  const baseInput = {
    orderReference: "lh-charge-1",
    amountCents: 4200,
    currency: "CAD",
    sourceId: "cnon:card-nonce",
    verificationToken: "verify-token",
    idempotencyKey: "charge-key-1",
  };

  // A recording dependency harness. 'authorized' controls the payment the fake
  // Square returns from authorizePayment; every seam appends to 'calls' so tests
  // can assert exact ordering and that voids fire on the compensation paths.
  function harness(overrides) {
    const calls = [];
    const authorized = overrides.authorized;
    const deps = {
      authorizePayment: async (request) => {
        calls.push(["authorize", request.idempotency_key]);
        if (overrides.authorizeThrows) throw new Error("network down");
        return { payment: authorized };
      },
      capturePayment: async (paymentId, versionToken) => {
        calls.push(["capture", paymentId, versionToken ?? null]);
        if (overrides.captureThrows) throw new Error("capture failed");
      },
      voidPayment: async (paymentId) => {
        calls.push(["void", paymentId]);
      },
      voidPaymentByIdempotencyKey: async (key) => {
        calls.push(["voidByKey", key]);
      },
      finalize: async (input) => {
        calls.push(["finalize", input.squarePaymentId, input.amountCents, input.currency]);
        if (overrides.finalizeThrows) throw new Error("ledger write failed");
        return { transition: overrides.finalizeTransition ?? "applied" };
      },
      onCaptured: async (orderReference, paymentId) => {
        calls.push(["onCaptured", orderReference, paymentId]);
        if (overrides.onCapturedThrows) throw new Error("mark-captured failed");
      },
      onSuccess: async (orderReference) => {
        calls.push(["onSuccess", orderReference]);
      },
      logError: (message, meta) => {
        calls.push(["logError", message]);
      },
    };
    return { deps, calls };
  }

  const approvedPayment = {
    id: "sq-payment-1",
    status: "APPROVED",
    source_type: "CARD",
    version_token: "v-token-1",
    amount_money: { amount: 4200, currency: "CAD" },
  };
`;

function runChargeScenario(assertions: string): void {
  const scenario = `${helperScript}\nvoid (async () => {\n${assertions}\n})()`;
  execFileSync(
    "./node_modules/.bin/tsx",
    ["--conditions=react-server", "--eval", scenario],
    { cwd: process.cwd(), stdio: "pipe" },
  );
}

test("authorize -> verify -> finalize -> capture happens in order on the happy path", () => {
  runChargeScenario(`
    const { deps, calls } = harness({ authorized: approvedPayment });
    const result = await authorizeCaptureSquarePayment(baseInput, deps);
    assert.deepEqual(result, { ok: true, squarePaymentId: "sq-payment-1", transition: "applied" });
    // Ledger commit (finalize) MUST precede capture, and capture the held funds.
    const stages = calls.map((entry) => entry[0]);
    assert.deepEqual(stages, ["authorize", "finalize", "capture", "onCaptured", "onSuccess"]);
    // Finalize is fed the verified provider amount/currency, not the raw input.
    assert.deepEqual(calls[1], ["finalize", "sq-payment-1", 4200, "CAD"]);
    // Capture uses the version token from the authorization.
    assert.deepEqual(calls[2], ["capture", "sq-payment-1", "v-token-1"]);
    // No void ever fires on the success path.
    assert.equal(calls.some((entry) => entry[0] === "void" || entry[0] === "voidByKey"), false);
  `);
});

test("a post-authorize network failure voids any hold by idempotency key", () => {
  runChargeScenario(`
    const { deps, calls } = harness({ authorized: approvedPayment, authorizeThrows: true });
    const result = await authorizeCaptureSquarePayment(baseInput, deps);
    assert.deepEqual(result, { ok: false, reason: "payment_failed" });
    assert.deepEqual(calls.filter((c) => c[0] === "voidByKey"), [["voidByKey", "charge-key-1"]]);
    // Never records or captures money after an authorization failure.
    assert.equal(calls.some((entry) => entry[0] === "finalize" || entry[0] === "capture"), false);
  `);
});

test("a non-APPROVED authorization voids the payment and never records money", () => {
  runChargeScenario(`
    const { deps, calls } = harness({ authorized: { ...approvedPayment, status: "FAILED" } });
    const result = await authorizeCaptureSquarePayment(baseInput, deps);
    assert.deepEqual(result, { ok: false, reason: "payment_not_authorized" });
    assert.deepEqual(calls.filter((c) => c[0] === "void"), [["void", "sq-payment-1"]]);
    assert.equal(calls.some((entry) => entry[0] === "finalize"), false);
  `);
});

test("an amount/currency mismatch on the authorization voids and never records money", () => {
  runChargeScenario(`
    const { deps: depsAmount, calls: callsAmount } = harness({
      authorized: { ...approvedPayment, amount_money: { amount: 4201, currency: "CAD" } },
    });
    const amountResult = await authorizeCaptureSquarePayment(baseInput, depsAmount);
    assert.deepEqual(amountResult, { ok: false, reason: "amount_mismatch" });
    assert.deepEqual(callsAmount.filter((c) => c[0] === "void"), [["void", "sq-payment-1"]]);
    assert.equal(callsAmount.some((entry) => entry[0] === "finalize"), false);

    const { deps: depsCurrency, calls: callsCurrency } = harness({
      authorized: { ...approvedPayment, amount_money: { amount: 4200, currency: "USD" } },
    });
    const currencyResult = await authorizeCaptureSquarePayment(baseInput, depsCurrency);
    assert.deepEqual(currencyResult, { ok: false, reason: "amount_mismatch" });
    assert.deepEqual(callsCurrency.filter((c) => c[0] === "void"), [["void", "sq-payment-1"]]);
  `);
});

test("a finalize failure voids the uncaptured authorization instead of leaving a captured orphan", () => {
  runChargeScenario(`
    const { deps, calls } = harness({ authorized: approvedPayment, finalizeThrows: true });
    const result = await authorizeCaptureSquarePayment(baseInput, deps);
    assert.deepEqual(result, { ok: false, reason: "finalize_failed" });
    // finalize ran (and threw), so it must be voided; capture must NOT run.
    const stages = calls.map((entry) => entry[0]);
    assert.deepEqual(stages, ["authorize", "finalize", "logError", "void"]);
    assert.equal(calls.some((entry) => entry[0] === "capture"), false);
  `);
});

test("a finalize conflict transition voids the hold and returns the transition as the reason", () => {
  runChargeScenario(`
    const { deps, calls } = harness({
      authorized: approvedPayment,
      finalizeTransition: "amount_or_currency_mismatch",
    });
    const result = await authorizeCaptureSquarePayment(baseInput, deps);
    assert.deepEqual(result, { ok: false, reason: "amount_or_currency_mismatch" });
    assert.deepEqual(calls.filter((c) => c[0] === "void"), [["void", "sq-payment-1"]]);
    assert.equal(calls.some((entry) => entry[0] === "capture"), false);
  `);
});

test("an already_applied replay records success but never re-captures the funds", () => {
  runChargeScenario(`
    const { deps, calls } = harness({
      authorized: approvedPayment,
      finalizeTransition: "already_applied",
    });
    const result = await authorizeCaptureSquarePayment(baseInput, deps);
    assert.deepEqual(result, { ok: true, squarePaymentId: "sq-payment-1", transition: "already_applied" });
    // A prior run already captured this payment: do not capture again.
    assert.equal(calls.some((entry) => entry[0] === "capture"), false);
    assert.equal(calls.some((entry) => entry[0] === "onCaptured"), false);
    // The success side effect still runs.
    assert.deepEqual(calls.filter((c) => c[0] === "onSuccess"), [["onSuccess", "lh-charge-1"]]);
  `);
});

test("a capture failure after a committed ledger does NOT void the paid order", () => {
  runChargeScenario(`
    const { deps, calls } = harness({ authorized: approvedPayment, captureThrows: true });
    const result = await authorizeCaptureSquarePayment(baseInput, deps);
    // The order is recorded paid; the reconciliation sweep completes the capture.
    assert.deepEqual(result, { ok: true, squarePaymentId: "sq-payment-1", transition: "applied" });
    assert.equal(calls.some((entry) => entry[0] === "void" || entry[0] === "voidByKey"), false);
    // onSuccess still runs even though the capture call threw.
    assert.deepEqual(calls.filter((c) => c[0] === "onSuccess"), [["onSuccess", "lh-charge-1"]]);
  `);
});

test("Afterpay uses the same authorization, ledger and capture sequence", () => {
  runChargeScenario(`
    const { deps, calls } = harness({ authorized: { ...approvedPayment, source_type: "BUY_NOW_PAY_LATER" } });
    let providerType;
    const finalize = deps.finalize;
    deps.finalize = async (input) => { providerType = input.providerType; return finalize(input); };
    const result = await authorizeCaptureSquarePayment({ ...baseInput, method: "afterpay", expectedAmountCents: 4200 }, deps);
    assert.equal(result.ok, true);
    assert.equal(providerType, "BUY_NOW_PAY_LATER");
    assert.deepEqual(calls.map((c) => c[0]), ["authorize", "finalize", "capture", "onCaptured", "onSuccess"]);
  `);
});

test("Afterpay rejects ineligible and changed totals before requesting authorization", () => {
  runChargeScenario(`
    for (const patch of [{ amountCents: 200001 }, { expectedAmountCents: 4199 }, { currency: "USD" }]) {
      const { deps, calls } = harness({ authorized: approvedPayment });
      const result = await authorizeCaptureSquarePayment({ ...baseInput, method: "afterpay", expectedAmountCents: 4200, ...patch }, deps);
      assert.deepEqual(result, { ok: false, reason: "afterpay_ineligible" });
      assert.deepEqual(calls, []);
    }
  `);
});

test("a forged payment method is voided before any ledger update or capture", () => {
  runChargeScenario(`
    for (const [method, source_type] of [["card", "BUY_NOW_PAY_LATER"], ["afterpay", "CARD"]]) {
      const { deps, calls } = harness({ authorized: { ...approvedPayment, source_type } });
      const result = await authorizeCaptureSquarePayment({ ...baseInput, method, expectedAmountCents: 4200 }, deps);
      assert.deepEqual(result, { ok: false, reason: "payment_method_mismatch" });
      assert.deepEqual(calls.map((c) => c[0]), ["authorize", "void"]);
    }
  `);
});

test("Afterpay ledger failure cancels the authorization without confirming the order", () => {
  runChargeScenario(`
    const { deps, calls } = harness({ authorized: { ...approvedPayment, source_type: "BUY_NOW_PAY_LATER" }, finalizeThrows: true });
    const result = await authorizeCaptureSquarePayment({ ...baseInput, method: "afterpay", expectedAmountCents: 4200 }, deps);
    assert.equal(result.ok, false);
    assert.ok(calls.some((c) => c[0] === "void"));
    assert.equal(calls.some((c) => c[0] === "capture" || c[0] === "onSuccess"), false);
  `);
});
