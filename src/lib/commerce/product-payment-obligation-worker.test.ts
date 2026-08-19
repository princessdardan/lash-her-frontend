import assert from "node:assert/strict";
import test from "node:test";

import {
  paymentObligationInitializationProviderPhase,
  paymentObligationInitializationReconciliationScope,
} from "./product-payment-obligation-initialization-plan";

test("ambiguous invoice creation stays fenced until authoritative absence evidence queues invoice creation", () => {
  assert.equal(
    paymentObligationInitializationProviderPhase({
      providerInvoiceId: null,
      providerInvoiceNumber: null,
    }),
    "create_invoice",
  );
});

test("ambiguous initialize-pay recovery reuses the recorded immutable invoice", () => {
  assert.equal(
    paymentObligationInitializationProviderPhase({
      providerInvoiceId: 918273,
      providerInvoiceNumber: "INV-918273",
    }),
    "initialize_pay",
  );
  assert.equal(
    paymentObligationInitializationProviderPhase({
      providerInvoiceId: 918273,
      providerInvoiceNumber: null,
    }),
    "manual_review",
  );
  assert.equal(
    paymentObligationInitializationProviderPhase({
      providerInvoiceId: null,
      providerInvoiceNumber: "INV-918273",
    }),
    "manual_review",
  );
});

test("owner reconciliation step-up scope binds action, evidence, version, and provider identity", () => {
  const base = {
    action: "adopt_invoice",
    evidenceReference: "helcim-dashboard://invoice/918273",
    expectedStateVersion: 7,
    obligationId: "obligation-1",
    orderId: "order-1",
    providerEvidenceHash: "a".repeat(64),
    providerEvidenceKind: "invoice_verified",
    rationale: "Exact immutable merchant identity and amount match.",
  };
  const scope = paymentObligationInitializationReconciliationScope(base);
  for (const changed of [
    { ...base, action: "record_manual_handoff" },
    { ...base, evidenceReference: "helcim-case://different" },
    { ...base, expectedStateVersion: 8 },
    { ...base, providerEvidenceHash: "b".repeat(64) },
    { ...base, providerEvidenceKind: "invoice_absent" },
  ]) {
    assert.notDeepEqual(
      paymentObligationInitializationReconciliationScope(changed),
      scope,
    );
  }
});
