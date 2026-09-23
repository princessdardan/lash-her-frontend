import assert from "node:assert/strict";
import test from "node:test";
import { createSplitStatusHandler } from "./handler";

const request = (body: unknown) =>
  new Request("https://lash.test/api/training-checkout/split-status", {
    method: "POST",
    body: JSON.stringify(body),
  });
const body = {
  reservationKey: "existing-reservation-123",
  customerEmail: "buyer@example.test",
};
test("split recovery requires both opaque attempt key and matching buyer", async () => {
  let recoveries = 0;
  const handler = createSplitStatusHandler({
    findOrder: async () => ({
      orderId: "order",
      customerEmail: body.customerEmail,
      isSplit: true,
    }),
    recover: async () => {
      recoveries++;
      return { ok: true, squarePaymentId: "ap", transition: "applied" };
    },
  });
  assert.equal(
    (await handler(request({ ...body, reservationKey: "short" }))).status,
    400,
  );
  assert.equal(
    (await handler(request({ ...body, customerEmail: "another@example.test" })))
      .status,
    404,
  );
  assert.equal(recoveries, 0);
  const response = await handler(request(body));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { orderId: "order", status: "paid" });
});
test("unknown and partially captured payments stay pending; cancellation explicitly permits retry", async () => {
  for (const retryWithNewReservation of [false, true]) {
    const handler = createSplitStatusHandler({
      findOrder: async () => ({
        orderId: "order",
        customerEmail: body.customerEmail,
        isSplit: true,
      }),
      recover: async () => ({
        ok: false,
        reason: "pending",
        retryWithNewReservation,
      }),
    });
    const response = await handler(request(body));
    assert.equal(response.status, retryWithNewReservation ? 402 : 503);
    assert.equal(
      (await response.json()).retryWithNewReservation,
      retryWithNewReservation,
    );
  }
});
