import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  SquareListPaymentsParams,
  SquareListPaymentsResponse,
  SquarePayment,
} from "@/lib/payments/square/payments-client";
import { verifySquareCommercePayment } from "./product-stock-abandoned-sweep";

// The live Square re-verification the sweep runs before cancelling an abandoned
// order. Square offers no server-side reference_id filter, so the reader pages a
// created_at window and matches the order's reference client-side; these cover
// the status -> verdict mapping, cross-page matching, and the page budget.

function payment(reference: string, status: string): SquarePayment {
  return {
    id: "sq-" + reference + "-" + status,
    status,
    reference_id: reference,
    amount_money: { amount: 5000, currency: "CAD" },
  };
}

/** A listPayments fake that serves a scripted sequence of pages and counts calls. */
function reader(pages: SquareListPaymentsResponse[]) {
  const calls: SquareListPaymentsParams[] = [];
  return {
    calls,
    listPayments: async (
      params: SquareListPaymentsParams,
    ): Promise<SquareListPaymentsResponse> => {
      const page = pages[calls.length] ?? { payments: [] };
      calls.push(params);
      return page;
    },
  };
}

const input = { orderReference: "order-ref-1", createdAt: new Date(0) };

describe("verifySquareCommercePayment", () => {
  it("reports captured for a COMPLETED payment matching the reference", async () => {
    const client = reader([
      { payments: [payment("order-ref-1", "COMPLETED")] },
    ]);
    assert.equal(await verifySquareCommercePayment(client, input), "captured");
    assert.equal(client.calls.length, 1);
  });

  it("reports authorized for an APPROVED (uncaptured) payment", async () => {
    const client = reader([{ payments: [payment("order-ref-1", "APPROVED")] }]);
    assert.equal(
      await verifySquareCommercePayment(client, input),
      "authorized",
    );
  });

  it("treats a CANCELED/FAILED payment as absent (no live claim on funds)", async () => {
    const canceled = reader([
      { payments: [payment("order-ref-1", "CANCELED")] },
    ]);
    assert.equal(await verifySquareCommercePayment(canceled, input), "absent");
    const failed = reader([{ payments: [payment("order-ref-1", "FAILED")] }]);
    assert.equal(await verifySquareCommercePayment(failed, input), "absent");
  });

  it("ignores payments for other orders and reports absent", async () => {
    const client = reader([
      { payments: [payment("some-other-order", "COMPLETED")] },
    ]);
    assert.equal(await verifySquareCommercePayment(client, input), "absent");
  });

  it("prefers a later COMPLETED capture over an earlier dead attempt for the same reference", async () => {
    // An earlier CANCELED/FAILED attempt must never shadow a real capture and
    // cause a genuinely-paid order to be swept.
    const client = reader([
      {
        payments: [
          payment("order-ref-1", "CANCELED"),
          payment("order-ref-1", "COMPLETED"),
        ],
      },
    ]);
    assert.equal(await verifySquareCommercePayment(client, input), "captured");
  });

  it("surfaces a held authorization when no capture exists for the reference", async () => {
    const client = reader([
      { payments: [payment("order-ref-1", "CANCELED")], cursor: "c1" },
      { payments: [payment("order-ref-1", "APPROVED")] },
    ]);
    assert.equal(
      await verifySquareCommercePayment(client, input),
      "authorized",
    );
  });

  it("follows the pagination cursor until the reference is found", async () => {
    const client = reader([
      { payments: [payment("noise-a", "COMPLETED")], cursor: "c1" },
      { payments: [payment("order-ref-1", "COMPLETED")], cursor: "c2" },
    ]);
    assert.equal(await verifySquareCommercePayment(client, input), "captured");
    // Stops as soon as it matches — the third page is never requested.
    assert.equal(client.calls.length, 2);
    assert.equal(client.calls[1].cursor, "c1");
  });

  it("stops at the page budget and reports absent when never matched", async () => {
    // Every page returns a cursor, so only the 4-page budget bounds the scan.
    const alwaysMore: SquareListPaymentsResponse = {
      payments: [payment("noise", "COMPLETED")],
      cursor: "more",
    };
    const client = reader([
      alwaysMore,
      alwaysMore,
      alwaysMore,
      alwaysMore,
      alwaysMore,
    ]);
    assert.equal(await verifySquareCommercePayment(client, input), "absent");
    assert.equal(client.calls.length, 4, "the scan is bounded to four pages");
  });

  it("reports absent when the window has no payments at all", async () => {
    const client = reader([{ payments: [] }]);
    assert.equal(await verifySquareCommercePayment(client, input), "absent");
  });
});
