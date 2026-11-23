import assert from "node:assert/strict";
import { test } from "node:test";
import { PurchaseDependencyError } from "./course-api";
import { formatRateTableRefundReceipt } from "./store";

const order = {
  id: "order-1",
  taxCents: 2,
  totalCents: 19,
  receiptSeller: { name: "Fixture seller", address: "100 Test Street", email: "seller@example.test" },
  taxBreakdown: [
    { taxCode: "gst", label: "GST", amount: 1, ratePartsPerMillion: 50_000 },
    { taxCode: "pst", label: "PST", amount: 1, ratePartsPerMillion: 60_000 },
    { taxCode: "zero", label: "Zero", amount: 0, ratePartsPerMillion: 0 },
  ],
};

test("adjacent penny refunds stay bounded and fully reverse each original tax component", () => {
  const reversed = [0, 0, 0];
  for (let previousRefunds = 0; previousRefunds < 19; previousRefunds++) {
    const refundId = `refund-${previousRefunds}`;
    const receipt = JSON.parse(
      formatRateTableRefundReceipt(order, refundId, previousRefunds, 1),
    );
    assert.equal(receipt.version, 1);
    assert.equal(receipt.taxTransactionId, "rate-table:order-1");
    assert.equal(receipt.refundId, refundId);
    assert.equal(receipt.fullyRefunded, previousRefunds === 18);
    assert.deepEqual(
      receipt.components.map(({ taxCode }: { taxCode: string }) => taxCode),
      ["gst", "pst", "zero"],
    );
    const taxAmounts: number[] = receipt.components.map(
      ({ taxCents }: { taxCents: number }) => taxCents,
    );
    assert.deepEqual(taxAmounts, [
      Number(previousRefunds === 4),
      Number(previousRefunds === 14),
      0,
    ]);
    assert.equal(
      receipt.taxCents,
      taxAmounts.reduce((sum, amount) => sum + amount, 0),
    );
    assert.ok(receipt.taxCents <= 1);
    taxAmounts.forEach((amount, index) => {
      reversed[index] += amount;
    });
  }
  assert.deepEqual(reversed, [1, 1, 0]);
});

test("component refund receipts reject a snapshot that disagrees with original tax", () => {
  assert.throws(
    () => formatRateTableRefundReceipt({ ...order, taxCents: 3 }, "refund", 0, 19),
    PurchaseDependencyError,
  );
  assert.throws(
    () => formatRateTableRefundReceipt({ ...order, taxBreakdown: [] }, "refund", 0, 19),
    PurchaseDependencyError,
  );
});

test("legacy rate-table refund receipts retain their original string format", () => {
  const legacyOrder = {
    ...order,
    receiptSeller: null,
    taxBreakdown: [{ amount: 2, rate_basis_points: 1_300 }],
  };
  assert.equal(
    formatRateTableRefundReceipt(legacyOrder, "refund", 0, 19),
    "rate-table:order-1:refund:refund:2",
  );
});
