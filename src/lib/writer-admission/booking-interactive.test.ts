import assert from "node:assert/strict";
import test from "node:test";
import { createEmailRetryPostHandler } from "@/app/api/admin/email-retries/handler";
import { NextRequest } from "next/server";
import { createCardOnFilePostHandler } from "@/app/api/booking/card-on-file/handler";
import { createServiceBookingPaymentConfirmPostHandler } from "@/app/api/booking/payment/confirm/handler";
import { createServiceBookingPromotionCodePostHandler } from "@/app/api/booking/payment/promotion-code/handler";
import { createAdminNoShowPostHandler } from "@/app/api/admin/appointments/[id]/no-show/handler";
import { withWriterAdmission } from "./route";
import { interactiveAdmissionFixture } from "./interactive-fixture";

const cardBody = {
  cardholderName: "Owned Person",
  paymentSessionReference: "owned-session",
  idempotencyKey: "owned-key",
  policy: { accepted: true, maxChargeCents: 5000 },
  sourceId: "owned-nonce",
};
const confirmBody = {
  paymentSessionReference: "owned-session",
  customer: {
    name: "Owned Person",
    email: "owned@example.invalid",
    phone: "4165550123",
    marketingOptIn: false,
  },
  payment: { option: "full", expectedAmountCents: 5000 },
  policy: { accepted: true, policyVersion: "owned", policyTextHash: "owned" },
  sourceId: "owned-nonce",
  idempotencyKey: "owned-key",
};
const request = (path: string, body: unknown) =>
  new NextRequest(`https://owned.invalid${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer owned-admin",
    },
    body: JSON.stringify(body),
  });
const noShowBody = {
  amountCents: 5000,
  confirmPolicyCharge: true,
  idempotencyKey: "owned-key",
  operatorId: "owned-admin",
  reason: "Owned no-show",
};
function noShow(charge: () => Promise<"charged" | "charge_failed">) {
  return createAdminNoShowPostHandler({
    getAdminSecret: () => "owned-admin",
    getNow: () => new Date("2026-11-05T14:00:00Z"),
    logError: () => {},
    logWarn: () => {},
    findBookedAppointmentWithNoShowRecord: async () => ({
      allowedChargeAmountCents: 5000,
      appointmentId: "owned",
      chargeStatus: "provider_draft_created",
      hasSavedCard: true,
      holdId: "owned-hold",
      maxChargeCents: 5000,
      noShowChargeRecordId: "owned-record",
      selectedEnd: new Date("2026-11-05T12:00:00Z"),
    }),
    chargeNoShow: async () => ({
      appointmentId: "owned",
      noShowChargeRecordId: "owned-record",
      chargeStatus: await charge(),
    }),
  });
}

test("closed initiation admission refuses card, payment, promotion and no-show effects before body consumption", async () => {
  let effects = 0;
  const effect = () => {
    effects++;
    throw new Error("unexpected-effect");
  };
  const handlers: ((request: NextRequest) => Promise<Response>)[] = [
    createCardOnFilePostHandler({
      alerts: { alert() {} },
      runCardOnFileBooking: async () => effect(),
    }),
    createServiceBookingPaymentConfirmPostHandler({
      alerts: { alert() {} },
      confirm: async () => effect(),
    }),
    createServiceBookingPromotionCodePostHandler({
      getHoldContext: async () => effect(),
      getPromotionCode: async () => effect(),
      resolveOperationalPromotionCode: async () => effect(),
      resolveSession: async () => effect(),
      updateHoldPromotionSnapshot: async () => effect(),
    }),
    noShow(async () => effect()),
  ];
  for (const handler of handlers) {
    const f = interactiveAdmissionFixture();
    f.state.open = false;
    const req = request("/api/booking/payment/confirm", confirmBody);
    assert.equal(
      (await withWriterAdmission("new-work", handler, f.run)(req)).status,
      503,
    );
    assert.equal(req.bodyUsed, false);
  }
  assert.equal(effects, 0);
});

test("booking card confirmation awaits caught provider email and cannot settle uncertain delivery", async () => {
  const f = interactiveAdmissionFixture();
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const handler = createCardOnFilePostHandler({
    alerts: { alert() {} },
    runCardOnFileBooking: async () => ({
      ok: true,
      bookingStatus: "booked",
      card: {},
      holdReference: "owned-hold",
      noShowChargeStatus: "ready",
    }),
    sendProviderBookingEmailForPublicReference: async () => {
      entered();
      await held;
      throw new Error("owned-private-marker");
    },
  });
  const pending = withWriterAdmission(
    "new-work",
    handler,
    f.run,
  )(request("/api/booking/card-on-file", cardBody));
  await started;
  assert.equal(f.state.finished, false);
  release();
  const response = await pending;
  assert.equal(response.status, 503);
  assert.equal(f.state.uncertain, true);
  assert.equal((await response.text()).includes("owned-private-marker"), false);
});

test("booking confirmation waits for asynchronous infrastructure alerts before settlement", async () => {
  const f = interactiveAdmissionFixture();
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const handler = createServiceBookingPaymentConfirmPostHandler({
    alerts: {
      async alert() {
        entered();
        await held;
      },
    },
    confirm: async () => ({
      ok: false,
      error: "square_api_error",
      message: "owned-private-marker",
    }),
  });
  const pending = withWriterAdmission(
    "new-work",
    handler,
    f.run,
  )(request("/api/booking/payment/confirm", confirmBody));
  await started;
  assert.equal(f.state.finished, false);
  release();
  assert.equal((await pending).status, 503);
  assert.equal(f.state.uncertain, true);
});

test("booking manual follow-up is not acknowledged as completed admission", async () => {
  const f = interactiveAdmissionFixture();
  const handler = createServiceBookingPaymentConfirmPostHandler({
    alerts: { alert() {} },
    confirm: async () => ({
      ok: true,
      bookingStatus: "manual_followup",
      card: {},
      holdReference: "owned",
      paymentStatus: "captured",
    }),
  });
  assert.equal(
    (
      await withWriterAdmission(
        "new-work",
        handler,
        f.run,
      )(request("/api/booking/payment/confirm", confirmBody))
    ).status,
    503,
  );
  assert.equal(f.state.uncertain, true);
});

test("admin no-show catches and non-final outcomes retain uncertainty while a confirmed charge settles cleanly", async () => {
  for (const mode of ["charged", "charge_failed", "throw"] as const) {
    const f = interactiveAdmissionFixture();
    const handler = noShow(async () => {
      assert.equal(f.events[0], "admitted");
      if (mode === "throw") throw new Error("owned-private-marker");
      return mode;
    });
    const response = await withWriterAdmission(
      "new-work",
      handler,
      f.run,
    )(request("/api/admin/appointments/owned/no-show", noShowBody));
    assert.equal(response.status, mode === "charged" ? 200 : 503, mode);
    assert.equal(f.state.uncertain, mode !== "charged", mode);
  }
});

test("manual transactional-email retry recovers only after admission and rejects before delivery when closed", async () => {
  const f = interactiveAdmissionFixture();
  let deliveries = 0;
  const handler = createEmailRetryPostHandler({
    getRetrySecret: () => "owned-admin",
    logError: () => {},
    retryTransactionalEmail: async (input) => {
      assert.equal(f.events[0], "admitted");
      deliveries++;
      return { flow: input.flow, orderId: input.orderId, status: "processed" };
    },
  });
  const admitted = withWriterAdmission("recovery", handler, f.run);
  f.state.open = false;
  assert.equal(
    (
      await admitted(
        request("/api/admin/email-retries", {
          flow: "booking",
          orderId: "owned-order",
        }),
      )
    ).status,
    503,
  );
  assert.equal(deliveries, 0);
  f.state.open = true;
  assert.equal(
    (
      await admitted(
        request("/api/admin/email-retries", {
          flow: "booking",
          orderId: "owned-order",
        }),
      )
    ).status,
    200,
  );
  assert.equal(deliveries, 1);
  assert.equal(f.state.uncertain, false);
});
