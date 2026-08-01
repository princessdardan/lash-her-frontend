import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, afterEach } from "node:test";

import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import type { ResolvedOperationalBooking } from "@/lib/booking/operations/offering";
import {
  claimBookingConfirmationEmailByHoldId,
  listRetryableOperationalBookingOutcomeEmailHoldIds,
  markBookingConfirmationEmailSent,
  recordBookingConfirmationEmailFailure,
} from "@/lib/booking/holds";
import { createDrizzleServiceReconciliationRepository } from "@/lib/booking/payments/service-reconciliation-monitor";
import {
  confirmChargeAndStoreBooking,
  type ChargeAndStoreBookingRequestBody,
  type ChargeAndStoreRepository,
} from "@/lib/booking/payments/service-charge-and-store";
import {
  hashServiceNoShowPolicyText,
  SERVICE_NO_SHOW_POLICY_TEXT,
  SERVICE_NO_SHOW_POLICY_VERSION,
} from "@/lib/booking/payments/service-no-show-policy";

import {
  AppointmentFinalizationConflictError,
  BookingPaymentAttemptConflictError,
  createAppointmentFinalizationRepository,
} from "./appointment-finalization-repository";
import { createDrizzleBookingReservationRepository } from "./booking-reservation-repository";
import {
  claimProviderBookingEmail,
  markProviderBookingEmailSent,
} from "./booking-provider-email-repository";
import { createServiceBookingPaymentRepository } from "./service-booking-payment-repository";
import { createPrivateDbPoolConfig } from "./pool-config";
import { getOperationalAppointmentCalendarRouting } from "./operational-calendar-routing-repository";
import {
  appointmentCalendarEvents,
  appointmentEvents,
  appointmentHolds,
  appointments,
  bookingCalendarConnections,
  bookingNoShowChargeRecords,
  bookingPaymentAttempts,
  bookingPolicyAcceptances,
  bookingProviders,
  bookingResourceCalendarAssignments,
  bookingResourceReservations,
  bookingResources,
  bookingSavedPaymentMethods,
  bookingServices,
  bookingServiceOfferingResources,
  bookingServiceOfferings,
  bookingSquareCustomers,
} from "./schema";
import * as schema from "./schema";

const TEST_PREFIX = "v2-final-test-";
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const skipReason = testDatabaseUrl
  ? undefined
  : "set TEST_DATABASE_URL to run appointment finalization DB tests";
const pool = testDatabaseUrl
  ? new Pool(createPrivateDbPoolConfig(testDatabaseUrl))
  : null;
const db = pool ? drizzle({ client: pool, schema }) : null;

afterEach(async () => {
  if (db) {
    await cleanupTestRows();
  }
});

after(async () => {
  await pool?.end();
});

test(
  "V1 payment and appointment finalization remain on the legacy path",
  { skip: skipReason },
  async () => {
    const now = new Date("2032-01-01T12:00:00.000Z");
    const [hold] = await requireDb()
      .insert(appointmentHolds)
      .values({
        bookingType: "in-person-appointment",
        customerSnapshot: {
          email: "legacy@example.com",
          name: "Legacy Test",
          phone: "5555555555",
        },
        expiresAt: new Date("2032-01-01T12:10:00.000Z"),
        offeringId: "legacy-service",
        offeringSnapshot: { title: "Legacy service" },
        paymentSessionReference: `${TEST_PREFIX}session-${randomUUID()}`,
        publicReference: `${TEST_PREFIX}hold-${randomUUID()}`,
        selectedEnd: new Date("2032-01-03T16:00:00.000Z"),
        selectedStart: new Date("2032-01-03T15:00:00.000Z"),
        timezone: "America/Toronto",
      })
      .returning();
    const repository = createAppointmentFinalizationRepository(requireDb());
    const payment = createCapturedPayment();

    const attemptResult = await repository.recordPaymentAttempt({
      ...payment,
      holdId: hold.id,
      now,
      status: "captured",
    });
    const confirmationResult = await repository.confirmOperationalAppointment({
      calendar: { status: "pending" },
      holdId: hold.id,
      holdOutcome: "paid_pending_booking",
      now,
      payment,
    });
    const durableAppointments = await requireDb()
      .select({ id: appointments.id })
      .from(appointments)
      .where(eq(appointments.sourceHoldId, hold.id));
    const durableAttempts = await requireDb()
      .select({ id: bookingPaymentAttempts.id })
      .from(bookingPaymentAttempts)
      .where(eq(bookingPaymentAttempts.holdId, hold.id));

    assert.deepEqual(attemptResult, {
      bookingModelVersion: 1,
      status: "legacy",
    });
    assert.deepEqual(confirmationResult, {
      bookingModelVersion: 1,
      status: "legacy",
    });
    assert.equal(durableAppointments.length, 0);
    assert.equal(durableAttempts.length, 0);
  },
);

test(
  "captured V2 payment atomically creates one appointment and transfers every reservation",
  { skip: skipReason },
  async () => {
    const seeded = await seedOperationalHold({ secondaryResource: true });
    const policy = await seedPolicyRecords(seeded.holdId);
    const repository = createAppointmentFinalizationRepository(requireDb());
    const now = new Date("2032-02-01T12:01:00.000Z");
    const payment = createCapturedPayment();

    const first = await repository.confirmOperationalAppointment({
      calendar: { status: "pending" },
      holdId: seeded.holdId,
      holdOutcome: "paid_pending_booking",
      now,
      payment,
      source: "db_test",
    });
    const second = await repository.confirmOperationalAppointment({
      calendar: { status: "pending" },
      holdId: seeded.holdId,
      holdOutcome: "paid_pending_booking",
      now: new Date("2032-02-01T12:02:00.000Z"),
      payment,
      source: "db_test",
    });

    assert.equal(first.bookingModelVersion, 2);
    assert.equal(second.bookingModelVersion, 2);
    if (first.bookingModelVersion !== 2 || second.bookingModelVersion !== 2) {
      return;
    }
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.appointment.id, first.appointment.id);

    const [hold] = await requireDb()
      .select()
      .from(appointmentHolds)
      .where(eq(appointmentHolds.id, seeded.holdId));
    const durableAppointments = await requireDb()
      .select()
      .from(appointments)
      .where(eq(appointments.sourceHoldId, seeded.holdId));
    const reservations = await requireDb()
      .select()
      .from(bookingResourceReservations)
      .where(
        eq(bookingResourceReservations.appointmentId, first.appointment.id),
      );
    const attempts = await requireDb()
      .select()
      .from(bookingPaymentAttempts)
      .where(eq(bookingPaymentAttempts.holdId, seeded.holdId));
    const events = await requireDb()
      .select({ eventType: appointmentEvents.eventType })
      .from(appointmentEvents)
      .where(eq(appointmentEvents.appointmentId, first.appointment.id));
    const [acceptance] = await requireDb()
      .select()
      .from(bookingPolicyAcceptances)
      .where(eq(bookingPolicyAcceptances.id, policy.acceptanceId));
    const [noShowRecord] = await requireDb()
      .select()
      .from(bookingNoShowChargeRecords)
      .where(eq(bookingNoShowChargeRecords.id, policy.noShowRecordId));

    assert.equal(durableAppointments.length, 1);
    assert.equal(durableAppointments[0]?.paymentStatus, "partially_paid");
    assert.equal(durableAppointments[0]?.calendarSyncStatus, "pending");
    assert.deepEqual(durableAppointments[0]?.intakeSnapshot, {
      answers: [{ answer: "None", questionId: "allergies" }],
    });
    assert.equal(reservations.length, 2);
    assert.ok(
      reservations.every(
        (reservation) =>
          reservation.kind === "appointment" &&
          reservation.holdId === null &&
          reservation.expiresAt === null &&
          reservation.state === "active",
      ),
    );
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.appointmentId, first.appointment.id);
    assert.equal(attempts[0]?.providerPaymentId, payment.providerPaymentId);
    assert.equal(attempts[0]?.status, "captured");
    assert.equal(hold.status, "paid_pending_booking");
    assert.equal(hold.squarePaymentId, payment.providerPaymentId);
    assert.equal(hold.squareOrderId, payment.providerOrderId);
    assert.deepEqual(events.map((event) => event.eventType).sort(), [
      "appointment_confirmed",
      "payment_captured",
    ]);
    assert.equal(acceptance.appointmentId, first.appointment.id);
    assert.equal(noShowRecord.appointmentId, first.appointment.id);
  },
);

test(
  "calendar success projects one provider event and confirms the hold once",
  { skip: skipReason },
  async () => {
    const seeded = await seedOperationalHold();
    const repository = createAppointmentFinalizationRepository(requireDb());
    const payment = createCapturedPayment();
    const captured = await repository.confirmOperationalAppointment({
      calendar: { status: "pending" },
      holdId: seeded.holdId,
      holdOutcome: "paid_pending_booking",
      now: new Date("2032-03-01T12:01:00.000Z"),
      payment,
    });
    assert.equal(captured.bookingModelVersion, 2);
    if (captured.bookingModelVersion !== 2) return;

    const calendarInput = {
      calendar: {
        providerEventEtag: "etag-1",
        providerEventId: `${TEST_PREFIX}event-${randomUUID()}`,
        status: "synced" as const,
      },
      holdId: seeded.holdId,
      holdOutcome: "booked" as const,
      payment,
      source: "db_test",
    };
    await repository.confirmOperationalAppointment({
      ...calendarInput,
      now: new Date("2032-03-01T12:02:00.000Z"),
    });
    await repository.confirmOperationalAppointment({
      ...calendarInput,
      now: new Date("2032-03-01T12:03:00.000Z"),
    });

    const [appointment] = await requireDb()
      .select()
      .from(appointments)
      .where(eq(appointments.id, captured.appointment.id));
    const [hold] = await requireDb()
      .select()
      .from(appointmentHolds)
      .where(eq(appointmentHolds.id, seeded.holdId));
    const projections = await requireDb()
      .select()
      .from(appointmentCalendarEvents)
      .where(
        eq(appointmentCalendarEvents.appointmentId, captured.appointment.id),
      );
    const events = await requireDb()
      .select({ eventType: appointmentEvents.eventType })
      .from(appointmentEvents)
      .where(eq(appointmentEvents.appointmentId, captured.appointment.id));

    assert.equal(appointment.calendarSyncStatus, "synced");
    assert.equal(hold.status, "booked");
    assert.equal(hold.finalizationStatus, "booked");
    assert.equal(hold.googleEventId, calendarInput.calendar.providerEventId);
    assert.equal(projections.length, 1);
    assert.equal(projections[0]?.providerEventEtag, "etag-1");
    assert.equal(
      events.filter((event) => event.eventType === "calendar_synced").length,
      1,
    );
    assert.equal(
      events.filter((event) => event.eventType === "appointment_confirmed")
        .length,
      1,
    );
  },
);

test(
  "idempotency key reuse with different payment identity rolls back",
  { skip: skipReason },
  async () => {
    const seeded = await seedOperationalHold();
    const repository = createAppointmentFinalizationRepository(requireDb());
    const payment = createCapturedPayment();
    const first = await repository.confirmOperationalAppointment({
      calendar: { status: "pending" },
      holdId: seeded.holdId,
      holdOutcome: "paid_pending_booking",
      now: new Date("2032-04-01T12:01:00.000Z"),
      payment,
    });
    assert.equal(first.bookingModelVersion, 2);
    if (first.bookingModelVersion !== 2) return;

    await assert.rejects(
      repository.confirmOperationalAppointment({
        calendar: { status: "pending" },
        holdId: seeded.holdId,
        holdOutcome: "paid_pending_booking",
        now: new Date("2032-04-01T12:02:00.000Z"),
        payment: { ...payment, amountCents: payment.amountCents + 1 },
      }),
      BookingPaymentAttemptConflictError,
    );
    const attempts = await requireDb()
      .select()
      .from(bookingPaymentAttempts)
      .where(eq(bookingPaymentAttempts.holdId, seeded.holdId));
    const durableAppointments = await requireDb()
      .select()
      .from(appointments)
      .where(eq(appointments.sourceHoldId, seeded.holdId));

    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.amountCents, payment.amountCents);
    assert.equal(durableAppointments.length, 1);
    assert.equal(durableAppointments[0]?.id, first.appointment.id);
  },
);

test(
  "V2 appointment creation rejects a calendar outcome without captured payment evidence",
  { skip: skipReason },
  async () => {
    const seeded = await seedOperationalHold();
    const repository = createAppointmentFinalizationRepository(requireDb());
    await assert.rejects(
      repository.confirmOperationalAppointment({
        calendar: {
          errorCode: "calendar_write_failed",
          reason: "Google Calendar was unavailable",
          status: "manual_followup",
        },
        holdId: seeded.holdId,
        holdOutcome: "manual_followup",
        now: new Date("2032-05-01T12:01:00.000Z"),
        source: "card_on_file",
      }),
      AppointmentFinalizationConflictError,
    );
    const attempts = await requireDb()
      .select()
      .from(bookingPaymentAttempts)
      .where(eq(bookingPaymentAttempts.holdId, seeded.holdId));
    const durableAppointments = await requireDb()
      .select()
      .from(appointments)
      .where(eq(appointments.sourceHoldId, seeded.holdId));
    const reservations = await requireDb()
      .select()
      .from(bookingResourceReservations)
      .where(eq(bookingResourceReservations.holdId, seeded.holdId));

    assert.equal(attempts.length, 0);
    assert.equal(durableAppointments.length, 0);
    assert.equal(reservations.length, 1);
    assert.equal(reservations[0]?.kind, "hold");
  },
);

test(
  "a V2 hold without reservations cannot partially create an appointment or payment attempt",
  { skip: skipReason },
  async () => {
    const fixture = await seedFixture();
    const [hold] = await requireDb()
      .insert(appointmentHolds)
      .values(createRawOperationalHold(fixture))
      .returning();
    const repository = createAppointmentFinalizationRepository(requireDb());
    const payment = createCapturedPayment();

    await assert.rejects(
      repository.confirmOperationalAppointment({
        calendar: { status: "pending" },
        holdId: hold.id,
        holdOutcome: "paid_pending_booking",
        now: new Date("2032-06-01T12:01:00.000Z"),
        payment,
      }),
      AppointmentFinalizationConflictError,
    );
    const durableAppointments = await requireDb()
      .select()
      .from(appointments)
      .where(eq(appointments.sourceHoldId, hold.id));
    const attempts = await requireDb()
      .select()
      .from(bookingPaymentAttempts)
      .where(eq(bookingPaymentAttempts.holdId, hold.id));

    assert.equal(durableAppointments.length, 0);
    assert.equal(attempts.length, 0);
  },
);

test(
  "an initially unbookable paid hold creates a consistent rebooking-pending event",
  { skip: skipReason },
  async () => {
    const seeded = await seedOperationalHold();
    const repository = createAppointmentFinalizationRepository(requireDb());
    const result = await repository.confirmOperationalAppointment({
      calendar: {
        errorCode: "slot_no_longer_available",
        reason: "The assigned calendar became busy",
        status: "manual_followup",
      },
      holdId: seeded.holdId,
      holdOutcome: "paid_unbookable_rebooking_pending",
      now: new Date("2032-07-01T12:01:00.000Z"),
      payment: createCapturedPayment(),
    });

    assert.equal(result.bookingModelVersion, 2);
    if (result.bookingModelVersion !== 2) return;
    const events = await requireDb()
      .select({
        eventType: appointmentEvents.eventType,
        nextStatus: appointmentEvents.nextStatus,
      })
      .from(appointmentEvents)
      .where(eq(appointmentEvents.appointmentId, result.appointment.id));

    assert.equal(result.appointment.status, "rebooking_pending");
    assert.ok(
      events.some(
        (event) =>
          event.eventType === "appointment_created" &&
          event.nextStatus === "rebooking_pending",
      ),
    );
    assert.equal(
      events.some(
        (event) =>
          event.eventType === "appointment_confirmed" &&
          event.nextStatus === "confirmed",
      ),
      false,
    );
  },
);

test(
  "full payment is paid while deposit and custom-partial retries remain partially paid",
  { skip: skipReason },
  async () => {
    const fullSeeded = await seedOperationalHold({
      paymentPurpose: "appointment_full",
    });
    const repository = createAppointmentFinalizationRepository(requireDb());
    const fullPayment = createCapturedPayment();
    const full = await repository.confirmOperationalAppointment({
      calendar: { status: "pending" },
      holdId: fullSeeded.holdId,
      holdOutcome: "paid_pending_booking",
      now: new Date("2032-08-01T12:01:00.000Z"),
      payment: fullPayment,
    });
    assert.equal(full.bookingModelVersion, 2);
    if (full.bookingModelVersion !== 2) return;

    const partialSeeded = await seedOperationalHold({
      paymentPurpose: "appointment_custom_partial",
    });
    const partialPayment = createCapturedPayment();
    const partial = await repository.confirmOperationalAppointment({
      calendar: { status: "pending" },
      holdId: partialSeeded.holdId,
      holdOutcome: "paid_pending_booking",
      now: new Date("2032-08-01T12:02:00.000Z"),
      payment: partialPayment,
    });
    await repository.confirmOperationalAppointment({
      calendar: { status: "pending" },
      holdId: partialSeeded.holdId,
      holdOutcome: "paid_pending_booking",
      now: new Date("2032-08-01T12:03:00.000Z"),
      payment: partialPayment,
    });
    assert.equal(partial.bookingModelVersion, 2);
    if (partial.bookingModelVersion !== 2) return;

    const [fullAppointment] = await requireDb()
      .select()
      .from(appointments)
      .where(eq(appointments.id, full.appointment.id));
    const [partialAppointment] = await requireDb()
      .select()
      .from(appointments)
      .where(eq(appointments.id, partial.appointment.id));
    const partialAttempts = await requireDb()
      .select()
      .from(bookingPaymentAttempts)
      .where(eq(bookingPaymentAttempts.holdId, partialSeeded.holdId));

    assert.equal(fullAppointment.paymentStatus, "paid");
    assert.equal(partialAppointment.paymentStatus, "partially_paid");
    assert.equal(partialAttempts.length, 1);
  },
);

test(
  "partial release of a multi-resource hold fails closed before appointment conversion",
  { skip: skipReason },
  async () => {
    const seeded = await seedOperationalHold({ secondaryResource: true });
    const [released] = await requireDb()
      .select({ id: bookingResourceReservations.id })
      .from(bookingResourceReservations)
      .where(eq(bookingResourceReservations.holdId, seeded.holdId))
      .limit(1);
    await requireDb()
      .update(bookingResourceReservations)
      .set({
        releaseReason: "corruption_test",
        releasedAt: new Date("2032-09-01T12:00:00.000Z"),
        state: "released",
      })
      .where(eq(bookingResourceReservations.id, released.id));
    const repository = createAppointmentFinalizationRepository(requireDb());

    await assert.rejects(
      repository.confirmOperationalAppointment({
        calendar: { status: "pending" },
        holdId: seeded.holdId,
        holdOutcome: "paid_pending_booking",
        now: new Date("2032-09-01T12:01:00.000Z"),
        payment: createCapturedPayment(),
      }),
      AppointmentFinalizationConflictError,
    );
    const durableAppointments = await requireDb()
      .select()
      .from(appointments)
      .where(eq(appointments.sourceHoldId, seeded.holdId));
    const attempts = await requireDb()
      .select()
      .from(bookingPaymentAttempts)
      .where(eq(bookingPaymentAttempts.holdId, seeded.holdId));

    assert.equal(durableAppointments.length, 0);
    assert.equal(attempts.length, 0);
  },
);

test(
  "a paid hold keeps its persisted write assignment after the resource gets a replacement",
  { skip: skipReason },
  async () => {
    const seeded = await seedOperationalHold();
    await requireDb()
      .update(bookingResourceCalendarAssignments)
      .set({ acceptsBookings: false, status: "disabled" })
      .where(
        eq(bookingResourceCalendarAssignments.id, seeded.fixture.assignmentId),
      );
    await requireDb()
      .insert(bookingResourceCalendarAssignments)
      .values({
        acceptsBookings: true,
        calendarConnectionId: seeded.fixture.calendarConnectionId,
        calendarLabel: `${TEST_PREFIX}replacement-${randomUUID()}`,
        contributesBusy: true,
        providerCalendarId: `${TEST_PREFIX}replacement-id-${randomUUID()}`,
        resourceId: seeded.fixture.primaryResourceId,
        status: "active",
      });

    const routing = await getOperationalAppointmentCalendarRouting(
      seeded.holdId,
      requireDb(),
    );

    assert.equal(
      routing.writeCalendar.assignmentId,
      seeded.fixture.assignmentId,
    );
    assert.equal(routing.writeCalendar.calendarId, seeded.fixture.calendarId);
    assert.ok(
      routing.busyCalendars.some(
        (calendar) =>
          calendar.assignmentId === seeded.fixture.assignmentId &&
          calendar.calendarId === seeded.fixture.calendarId,
      ),
    );
  },
);

test(
  "V2 customer outcome email claims use appointment state and retry without duplicate sends",
  { skip: skipReason },
  async () => {
    const seeded = await seedOperationalHold();
    const repository = createAppointmentFinalizationRepository(requireDb());
    const payment = createCapturedPayment();
    const pending = await repository.confirmOperationalAppointment({
      calendar: { status: "pending" },
      holdId: seeded.holdId,
      holdOutcome: "paid_pending_booking",
      now: new Date("2032-10-01T12:01:00.000Z"),
      payment,
    });
    assert.equal(pending.bookingModelVersion, 2);
    if (pending.bookingModelVersion !== 2) return;
    await repository.confirmOperationalAppointment({
      calendar: {
        providerEventId: `${TEST_PREFIX}email-event-${randomUUID()}`,
        status: "synced",
      },
      holdId: seeded.holdId,
      holdOutcome: "booked",
      now: new Date("2032-10-01T12:02:00.000Z"),
      payment,
    });

    const firstClaim = await claimBookingConfirmationEmailByHoldId(
      {
        claimForMs: 60_000,
        holdId: seeded.holdId,
        now: new Date("2032-10-01T12:03:00.000Z"),
      },
      requireDb(),
    );
    const duplicateClaim = await claimBookingConfirmationEmailByHoldId(
      {
        claimForMs: 60_000,
        holdId: seeded.holdId,
        now: new Date("2032-10-01T12:03:30.000Z"),
      },
      requireDb(),
    );

    assert.equal(firstClaim?.bookingConfirmationStatus, "booked");
    assert.equal(duplicateClaim, null);

    await recordBookingConfirmationEmailFailure(
      {
        error: "provider unavailable",
        holdId: seeded.holdId,
        now: new Date("2032-10-01T12:04:00.000Z"),
      },
      requireDb(),
    );
    const retryClaim = await claimBookingConfirmationEmailByHoldId(
      {
        holdId: seeded.holdId,
        now: new Date("2032-10-01T12:05:00.000Z"),
      },
      requireDb(),
    );
    assert.equal(retryClaim?.bookingConfirmationStatus, "booked");

    await markBookingConfirmationEmailSent(
      {
        holdId: seeded.holdId,
        now: new Date("2032-10-01T12:06:00.000Z"),
      },
      requireDb(),
    );
    const afterSent = await claimBookingConfirmationEmailByHoldId(
      {
        holdId: seeded.holdId,
        now: new Date("2032-10-01T12:07:00.000Z"),
      },
      requireDb(),
    );
    const [appointment] = await requireDb()
      .select()
      .from(appointments)
      .where(eq(appointments.id, pending.appointment.id));

    assert.equal(afterSent, null);
    assert.equal(
      appointment.bookingConfirmationEmailSentAt?.toISOString(),
      "2032-10-01T12:06:00.000Z",
    );
    assert.equal(appointment.bookingConfirmationEmailClaimedUntil, null);
    assert.equal(appointment.bookingConfirmationEmailLastError, null);

    const [sentHold] = await requireDb()
      .select({
        reconciliationMetadata: appointmentHolds.reconciliationMetadata,
      })
      .from(appointmentHolds)
      .where(eq(appointmentHolds.id, seeded.holdId));
    const legacyMetadata = {
      ...(sentHold.reconciliationMetadata as Record<string, unknown>),
    };
    delete legacyMetadata.bookingConfirmationEmailOutcome;
    await requireDb()
      .update(appointmentHolds)
      .set({ reconciliationMetadata: legacyMetadata })
      .where(eq(appointmentHolds.id, seeded.holdId));
    const legacySentCandidates =
      await listRetryableOperationalBookingOutcomeEmailHoldIds(
        { now: new Date("2032-10-01T12:08:00.000Z") },
        requireDb(),
      );
    assert.equal(legacySentCandidates.includes(seeded.holdId), true);

    const providerClaim = await claimProviderBookingEmail(
      {
        lookup: { holdId: seeded.holdId },
        now: new Date("2032-10-01T12:09:00.000Z"),
      },
      requireDb(),
    );
    assert.equal(providerClaim?.holdId, seeded.holdId);
    assert.equal(providerClaim?.capturedAmountCents, payment.amountCents);
    assert.equal(providerClaim?.currency, payment.currency);
    await markProviderBookingEmailSent(
      {
        holdId: seeded.holdId,
        now: new Date("2032-10-01T12:10:00.000Z"),
      },
      requireDb(),
    );

    const fullySentCandidates =
      await listRetryableOperationalBookingOutcomeEmailHoldIds(
        { now: new Date("2032-10-01T12:11:00.000Z") },
        requireDb(),
      );
    assert.equal(fullySentCandidates.includes(seeded.holdId), false);
  },
);

test(
  "manual Calendar follow-up produces a manual customer outcome claim",
  { skip: skipReason },
  async () => {
    const seeded = await seedOperationalHold();
    const repository = createAppointmentFinalizationRepository(requireDb());
    await repository.confirmOperationalAppointment({
      calendar: {
        errorCode: "calendar_unavailable",
        reason: "Calendar needs staff review",
        status: "manual_followup",
      },
      holdId: seeded.holdId,
      holdOutcome: "manual_followup",
      now: new Date("2032-11-01T12:01:00.000Z"),
      payment: createCapturedPayment(),
    });

    const claim = await claimBookingConfirmationEmailByHoldId(
      {
        holdId: seeded.holdId,
        now: new Date("2032-11-01T12:02:00.000Z"),
      },
      requireDb(),
    );

    assert.equal(claim?.bookingConfirmationStatus, "manual_followup");

    await repository.confirmOperationalAppointment({
      calendar: {
        providerEventId: `${TEST_PREFIX}manual-upgrade-event-${randomUUID()}`,
        status: "synced",
      },
      holdId: seeded.holdId,
      holdOutcome: "booked",
      now: new Date("2032-11-01T12:03:00.000Z"),
    });
    const sent = await markBookingConfirmationEmailSent(
      {
        bookingStatus: "manual_followup",
        holdId: seeded.holdId,
        now: new Date("2032-11-01T12:04:00.000Z"),
      },
      requireDb(),
    );
    assert.equal(sent.correctionRequired, true);

    const retryableHoldIds =
      await listRetryableOperationalBookingOutcomeEmailHoldIds(
        { now: new Date("2032-11-01T12:04:30.000Z") },
        requireDb(),
      );
    assert.ok(retryableHoldIds.includes(seeded.holdId));

    const correctiveClaim = await claimBookingConfirmationEmailByHoldId(
      {
        holdId: seeded.holdId,
        now: new Date("2032-11-01T12:05:00.000Z"),
      },
      requireDb(),
    );
    assert.equal(correctiveClaim?.bookingConfirmationStatus, "booked");

    const correctiveSent = await markBookingConfirmationEmailSent(
      {
        bookingStatus: "booked",
        holdId: seeded.holdId,
        now: new Date("2032-11-01T12:06:00.000Z"),
      },
      requireDb(),
    );
    const staleManualSent = await markBookingConfirmationEmailSent(
      {
        bookingStatus: "manual_followup",
        holdId: seeded.holdId,
        now: new Date("2032-11-01T12:07:00.000Z"),
      },
      requireDb(),
    );
    const [emailHold] = await requireDb()
      .select({
        reconciliationMetadata: appointmentHolds.reconciliationMetadata,
      })
      .from(appointmentHolds)
      .where(eq(appointmentHolds.id, seeded.holdId));
    assert.equal(correctiveSent.correctionRequired, false);
    assert.equal(staleManualSent.correctionRequired, false);
    assert.equal(
      (
        emailHold.reconciliationMetadata as {
          bookingConfirmationEmailOutcome?: string;
        }
      ).bookingConfirmationEmailOutcome,
      "booked",
    );
    const retryableAfterBooked =
      await listRetryableOperationalBookingOutcomeEmailHoldIds(
        { now: new Date("2032-11-01T12:08:00.000Z") },
        requireDb(),
      );
    assert.equal(retryableAfterBooked.includes(seeded.holdId), true);

    const providerClaim = await claimProviderBookingEmail(
      {
        lookup: { holdId: seeded.holdId },
        now: new Date("2032-11-01T12:09:00.000Z"),
      },
      requireDb(),
    );
    assert.equal(providerClaim?.holdId, seeded.holdId);
    await markProviderBookingEmailSent(
      {
        holdId: seeded.holdId,
        now: new Date("2032-11-01T12:10:00.000Z"),
      },
      requireDb(),
    );

    const allEmailsSent =
      await listRetryableOperationalBookingOutcomeEmailHoldIds(
        { now: new Date("2032-11-01T12:11:00.000Z") },
        requireDb(),
      );
    assert.equal(allEmailsSent.includes(seeded.holdId), false);
  },
);

test(
  "V2 reconciliation queries surface stale Calendar and split payment-ledger state",
  { skip: skipReason },
  async () => {
    const seeded = await seedOperationalHold();
    const repository = createAppointmentFinalizationRepository(requireDb());
    const result = await repository.confirmOperationalAppointment({
      calendar: { status: "pending" },
      holdId: seeded.holdId,
      holdOutcome: "paid_pending_booking",
      now: new Date("2032-12-01T12:01:00.000Z"),
      payment: createCapturedPayment(),
    });
    assert.equal(result.bookingModelVersion, 2);
    if (result.bookingModelVersion !== 2 || result.paymentAttempt === null) {
      return;
    }
    const reconciliation =
      createDrizzleServiceReconciliationRepository(requireDb());
    const checkAt = new Date("2032-12-01T13:00:00.000Z");
    const pending =
      await reconciliation.findOperationalAppointmentsPendingCalendar(checkAt);

    assert.ok(
      pending.some(
        (finding) => finding.appointmentId === result.appointment.id,
      ),
    );
    assert.deepEqual(
      await reconciliation.findOperationalAppointmentsWithoutCapturedPayment(
        checkAt,
      ),
      [],
    );

    await requireDb()
      .update(bookingPaymentAttempts)
      .set({ appointmentId: null })
      .where(eq(bookingPaymentAttempts.id, result.paymentAttempt.id));

    const missingPayment =
      await reconciliation.findOperationalAppointmentsWithoutCapturedPayment(
        checkAt,
      );
    const orphanedCapture =
      await reconciliation.findCapturedPaymentsWithoutOperationalAppointment(
        checkAt,
      );

    assert.ok(
      missingPayment.some(
        (finding) => finding.appointmentId === result.appointment.id,
      ),
    );
    assert.ok(
      orphanedCapture.some(
        (finding) =>
          finding.paymentAttemptId === result.paymentAttempt?.id &&
          finding.holdId === seeded.holdId,
      ),
    );
  },
);

test(
  "an actual V2 reservation completes the direct Square charge-and-store path without exposing provider IDs",
  { skip: skipReason },
  async () => {
    const customerEmail = `${TEST_PREFIX}${randomUUID()}@example.com`;
    const seeded = await seedOperationalHold({
      customerEmail,
      leavePaymentPending: true,
    });
    const repository = await createServiceBookingPaymentRepository(requireDb());
    const emailHoldIds: string[] = [];
    const request: ChargeAndStoreBookingRequestBody = {
      customer: {
        email: customerEmail,
        marketingOptIn: false,
        name: "V2 Direct Customer",
        phone: "+14165550123",
      },
      idempotencyKey: `${TEST_PREFIX}direct-idem-${randomUUID()}`,
      payment: { expectedAmountCents: 12000, option: "full" },
      paymentSessionReference: seeded.paymentSessionReference,
      policy: {
        accepted: true,
        policyTextHash: hashServiceNoShowPolicyText(
          SERVICE_NO_SHOW_POLICY_TEXT,
        ),
        policyVersion: SERVICE_NO_SHOW_POLICY_VERSION,
      },
      sourceId: "cnon:v2-direct-test",
    };
    const squarePaymentId = `${TEST_PREFIX}direct-payment-${randomUUID()}`;
    const squareOrderId = `${TEST_PREFIX}direct-order-${randomUUID()}`;
    let providerIdempotencyKey = "";
    const result = await confirmChargeAndStoreBooking(request, {
      alerts: { alert() {} },
      calendarFinalizer: {
        async finalize() {
          return {
            googleEventId: `${TEST_PREFIX}direct-event-${randomUUID()}`,
            ok: true,
          };
        },
      },
      locationId: "test-location",
      now: new Date("2032-01-01T12:01:00.000Z"),
      repository,
      sendBookingConfirmationEmailForHold: async (holdId) => {
        emailHoldIds.push(holdId);
      },
      squareCards: {
        async createCard() {
          return {
            card: {
              card_brand: "VISA",
              exp_month: 12,
              exp_year: 2035,
              id: `${TEST_PREFIX}direct-card-${randomUUID()}`,
              last_4: "4242",
            },
          };
        },
      },
      squareCustomers: {
        async createCustomer() {
          return {
            customer: {
              id: `${TEST_PREFIX}direct-customer-${randomUUID()}`,
            },
          };
        },
      },
      squareInvoices: {
        async createInvoice() {
          throw new Error("Full payment must not create a no-show invoice");
        },
        async createOrder() {
          throw new Error("Full payment must not create a no-show order");
        },
        async deleteInvoice() {},
        async getInvoice() {
          throw new Error("Full payment must not read a no-show invoice");
        },
        async publishInvoice() {
          throw new Error("Full payment must not publish a no-show invoice");
        },
      },
      squarePayments: {
        async cancelPayment() {
          throw new Error("Completed payment must not be cancelled");
        },
        async cancelPaymentByIdempotencyKey() {
          throw new Error("Completed payment intent must not be cancelled");
        },
        async completePayment() {
          return {
            payment: {
              amount_money: { amount: 13560, currency: "CAD" },
              id: squarePaymentId,
              order_id: squareOrderId,
              status: "COMPLETED",
            },
          };
        },
        async createCardOnFilePayment(input) {
          providerIdempotencyKey = input.idempotency_key;
          return {
            payment: {
              amount_money: input.amount_money,
              customer_id: input.customer_id,
              id: squarePaymentId,
              order_id: squareOrderId,
              status: "APPROVED",
              version_token: "v2-direct-version",
            },
          };
        },
        async getPayment() {
          throw new Error("Successful capture must not require lookup");
        },
      },
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.bookingStatus, "booked");
    assert.equal("squarePaymentId" in result, false);
    assert.deepEqual(emailHoldIds, [seeded.holdId]);
    assert.notEqual(providerIdempotencyKey, request.idempotencyKey);
    assert.match(providerIdempotencyKey, /^cs:payment:[a-f0-9]{32}$/);

    const [appointment] = await requireDb()
      .select()
      .from(appointments)
      .where(eq(appointments.sourceHoldId, seeded.holdId));
    const [attempt] = await requireDb()
      .select()
      .from(bookingPaymentAttempts)
      .where(eq(bookingPaymentAttempts.holdId, seeded.holdId));
    const [hold] = await requireDb()
      .select()
      .from(appointmentHolds)
      .where(eq(appointmentHolds.id, seeded.holdId));
    const reservations = await requireDb()
      .select()
      .from(bookingResourceReservations)
      .where(eq(bookingResourceReservations.appointmentId, appointment.id));

    assert.equal(appointment.paymentStatus, "paid");
    assert.equal(appointment.calendarSyncStatus, "synced");
    assert.equal(appointment.customerEmailNormalized, customerEmail);
    assert.deepEqual(appointment.intakeSnapshot, {
      answers: [{ answer: "None", questionId: "allergies" }],
    });
    assert.equal(attempt.providerPaymentId, squarePaymentId);
    assert.equal(attempt.providerOrderId, squareOrderId);
    assert.equal(attempt.amountCents, 13560);
    assert.equal(hold.status, "booked");
    assert.equal(reservations.length, 1);
    assert.ok(
      reservations.every(
        (reservation) =>
          reservation.kind === "appointment" && reservation.holdId === null,
      ),
    );
  },
);

test(
  "a retry after Square capture but before the captured DB write resumes the same authorized payment",
  { skip: skipReason },
  async () => {
    const customerEmail = `${TEST_PREFIX}${randomUUID()}@example.com`;
    const seeded = await seedOperationalHold({
      customerEmail,
      leavePaymentPending: true,
    });
    const repository = await createServiceBookingPaymentRepository(requireDb());
    const authorizedAt = new Date("2032-01-01T12:01:00.000Z");
    const firstClientKey = `${TEST_PREFIX}client-first-${randomUUID()}`;
    const providerKey = `${TEST_PREFIX}provider-stable-${randomUUID()}`;
    const squarePaymentId = `${TEST_PREFIX}authorized-payment-${randomUUID()}`;
    const squareOrderId = `${TEST_PREFIX}authorized-order-${randomUUID()}`;
    const request: ChargeAndStoreBookingRequestBody = {
      customer: {
        email: customerEmail,
        marketingOptIn: false,
        name: "Authorized Recovery Customer",
        phone: "+14165550123",
      },
      idempotencyKey: `${TEST_PREFIX}client-retry-${randomUUID()}`,
      payment: { expectedAmountCents: 12000, option: "full" },
      paymentSessionReference: seeded.paymentSessionReference,
      policy: {
        accepted: true,
        policyTextHash: hashServiceNoShowPolicyText(
          SERVICE_NO_SHOW_POLICY_TEXT,
        ),
        policyVersion: SERVICE_NO_SHOW_POLICY_VERSION,
      },
      sourceId: "cnon:new-token-must-not-create-another-payment",
    };

    const initialClaim = await repository.claimPaymentAttempt({
      idempotencyKey: firstClientKey,
      now: authorizedAt,
      paymentSessionReference: seeded.paymentSessionReference,
    });
    assert.equal(initialClaim.status, "available");
    await repository.persistCustomerAndSelection({
      customer: request.customer,
      holdId: seeded.holdId,
      now: authorizedAt,
      payment: {
        amountCents: 12000,
        currency: "CAD",
        description: "Authorized recovery full payment",
        option: "full",
        purpose: "appointment_full",
        sku: "BOOKING-FULL",
      },
    });
    const acceptance = await repository.persistPolicyAcceptance({
      currency: "CAD",
      customerEmail,
      customerName: request.customer.name,
      holdId: seeded.holdId,
      maxChargeCents: 12000,
      now: authorizedAt,
      policyTextHash: request.policy.policyTextHash,
      policyVersion: request.policy.policyVersion,
    });
    const squareCustomer = await repository.persistSquareCustomer({
      email: customerEmail,
      name: request.customer.name,
      now: authorizedAt,
      phone: request.customer.phone,
      squareCustomerId: `${TEST_PREFIX}authorized-customer-${randomUUID()}`,
    });
    const savedCard = await repository.persistSavedPaymentMethod({
      brand: "VISA",
      expMonth: 12,
      expYear: 2035,
      last4: "4242",
      now: authorizedAt,
      squareCardId: `${TEST_PREFIX}authorized-card-${randomUUID()}`,
      squareCustomerRecordId: squareCustomer.id,
    });
    await repository.createNoShowChargeRecord({
      currency: "CAD",
      holdId: seeded.holdId,
      maxChargeCents: 12000,
      now: authorizedAt,
      policyAcceptanceId: acceptance.id,
      savedPaymentMethodId: savedCard.id,
      squareCardId: savedCard.squareCardId,
      squareCustomerId: squareCustomer.squareCustomerId,
      status: "ready",
    });
    await prepareOperationalPaymentIntentForTest(repository, {
      holdId: seeded.holdId,
      idempotencyKey: providerKey,
      now: authorizedAt,
      squareCustomerId: squareCustomer.squareCustomerId,
    });
    const recordAuthorized = repository.recordAuthorizedOperationalPayment;
    assert.ok(recordAuthorized);
    await recordAuthorized({
      amountCents: 13560,
      currency: "CAD",
      holdId: seeded.holdId,
      idempotencyKey: providerKey,
      now: authorizedAt,
      squareOrderId,
      squarePaymentId,
      versionToken: "authorized-version",
    });
    const [attemptBeforeRetry] = await requireDb()
      .select()
      .from(bookingPaymentAttempts)
      .where(eq(bookingPaymentAttempts.holdId, seeded.holdId));
    assert.equal(attemptBeforeRetry.status, "authorized");

    // A worker that started before authorization was persisted must not erase
    // the recovery evidence when its stale failure callback arrives later.
    await repository.markHoldPaymentFailed({
      holdId: seeded.holdId,
      now: new Date("2032-01-01T12:01:30.000Z"),
      reason: "stale pre-authorization worker failure",
    });
    const [attemptAfterStaleFailure] = await requireDb()
      .select()
      .from(bookingPaymentAttempts)
      .where(eq(bookingPaymentAttempts.id, attemptBeforeRetry.id));
    assert.equal(attemptAfterStaleFailure.status, "authorized");

    const providerCalls: string[] = [];
    const result = await confirmChargeAndStoreBooking(request, {
      alerts: { alert() {} },
      calendarFinalizer: {
        async finalize() {
          return {
            googleEventId: `${TEST_PREFIX}authorized-event-${randomUUID()}`,
            ok: true as const,
          };
        },
      },
      locationId: "test-location",
      now: new Date("2032-01-01T12:01:31.000Z"),
      repository,
      squareCards: {
        async createCard() {
          providerCalls.push("cards.create");
          throw new Error("Authorized recovery must not create a card");
        },
      },
      squareCustomers: {
        async createCustomer() {
          providerCalls.push("customers.create");
          throw new Error("Authorized recovery must not create a customer");
        },
      },
      squareInvoices: {
        async createInvoice() {
          providerCalls.push("invoices.create");
          throw new Error("Authorized recovery must not create an invoice");
        },
        async createOrder() {
          providerCalls.push("orders.create");
          throw new Error("Authorized recovery must not create an order");
        },
        async deleteInvoice() {
          providerCalls.push("invoices.delete");
          throw new Error("Authorized recovery must not delete an invoice");
        },
        async getInvoice() {
          providerCalls.push("invoices.get");
          throw new Error("Authorized recovery must not read an invoice");
        },
        async publishInvoice() {
          providerCalls.push("invoices.publish");
          throw new Error("Authorized recovery must not publish an invoice");
        },
      },
      squarePayments: {
        async cancelPayment() {
          providerCalls.push("payments.cancel");
          throw new Error("Authorized recovery must not cancel the payment");
        },
        async cancelPaymentByIdempotencyKey() {
          providerCalls.push("payments.cancel-by-idempotency-key");
          throw new Error("Authorized recovery must not cancel the payment");
        },
        async completePayment() {
          providerCalls.push("payments.complete");
          throw new Error("Completed recovery must not capture again");
        },
        async createCardOnFilePayment() {
          providerCalls.push("payments.create");
          throw new Error("Authorized recovery must not create a payment");
        },
        async getPayment(paymentId) {
          providerCalls.push("payments.get");
          assert.equal(paymentId, squarePaymentId);
          return {
            payment: {
              amount_money: { amount: 13560, currency: "CAD" },
              id: squarePaymentId,
              order_id: squareOrderId,
              status: "COMPLETED",
              version_token: "captured-version",
            },
          };
        },
      },
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.bookingStatus, "booked");
    assert.deepEqual(providerCalls, ["payments.get"]);

    const durableAttempts = await requireDb()
      .select()
      .from(bookingPaymentAttempts)
      .where(eq(bookingPaymentAttempts.holdId, seeded.holdId));
    const durableAppointments = await requireDb()
      .select()
      .from(appointments)
      .where(eq(appointments.sourceHoldId, seeded.holdId));
    assert.equal(durableAttempts.length, 1);
    assert.equal(durableAttempts[0]?.id, attemptBeforeRetry.id);
    assert.equal(durableAttempts[0]?.idempotencyKey, providerKey);
    assert.equal(durableAttempts[0]?.status, "captured");
    assert.equal(durableAppointments.length, 1);
  },
);

test(
  "concurrent terminal writers preserve booked over manual, refund, and payment-failed outcomes",
  { skip: skipReason },
  async () => {
    const captured = await seedCapturedChargeAndStoreCrash();
    const [initialHold] = await requireDb()
      .select()
      .from(appointmentHolds)
      .where(eq(appointmentHolds.id, captured.holdId));
    const bookedConfirmation = {
      bookingStatus: "booked" as const,
      card: { brand: "VISA", last4: "4242" },
      holdReference: initialHold.publicReference,
      ok: true as const,
      paymentStatus: "captured" as const,
    };
    const manualConfirmation = {
      ...bookedConfirmation,
      bookingStatus: "manual_followup" as const,
    };
    const googleEventId = `${TEST_PREFIX}terminal-event-${randomUUID()}`;

    await Promise.all([
      captured.repository.markHoldManualFollowup({
        confirmation: manualConfirmation,
        holdId: captured.holdId,
        now: new Date("2032-01-01T12:02:01.000Z"),
        reason: "stale calendar worker",
      }),
      captured.repository.markHoldBooked({
        confirmation: bookedConfirmation,
        googleEventId,
        holdId: captured.holdId,
        now: new Date("2032-01-01T12:02:01.000Z"),
      }),
    ]);

    const lateManual = await captured.repository.markHoldManualFollowup({
      confirmation: manualConfirmation,
      holdId: captured.holdId,
      now: new Date("2032-01-01T12:03:02.000Z"),
      reason: "late worker after its lease expired",
    });
    assert.equal(lateManual.state, "booked");

    const refundResult = await captured.repository.markHoldRefundRequired({
      holdId: captured.holdId,
      now: new Date("2032-01-01T12:03:03.000Z"),
      reason: "stale refund fallback",
      squarePaymentId: captured.squarePaymentId,
    });
    assert.equal(refundResult?.status, "booking_outcome_preserved");
    await captured.repository.markHoldPaymentFailed({
      holdId: captured.holdId,
      now: new Date("2032-01-01T12:03:04.000Z"),
      reason: "stale failure fallback",
    });

    const [hold] = await requireDb()
      .select()
      .from(appointmentHolds)
      .where(eq(appointmentHolds.id, captured.holdId));
    const [appointment] = await requireDb()
      .select()
      .from(appointments)
      .where(eq(appointments.sourceHoldId, captured.holdId));
    const calendarEvents = await requireDb()
      .select()
      .from(appointmentCalendarEvents)
      .where(eq(appointmentCalendarEvents.appointmentId, appointment.id));
    const events = await requireDb()
      .select()
      .from(appointmentEvents)
      .where(eq(appointmentEvents.appointmentId, appointment.id));
    const metadata = hold.reconciliationMetadata as {
      chargeAndStoreConfirmation?: { bookingStatus?: string };
      chargeAndStoreInProgress?: unknown;
    };

    assert.equal(hold.status, "booked");
    assert.equal(hold.finalizationStatus, "booked");
    assert.equal(hold.googleEventId, googleEventId);
    assert.equal(metadata.chargeAndStoreConfirmation?.bookingStatus, "booked");
    assert.equal(metadata.chargeAndStoreInProgress, undefined);
    assert.equal(appointment.status, "confirmed");
    assert.equal(appointment.calendarSyncStatus, "synced");
    assert.equal(calendarEvents.length, 1);
    assert.equal(calendarEvents[0]?.providerEventId, googleEventId);
    assert.equal(
      events.filter((event) => event.eventType === "calendar_synced").length,
      1,
    );
  },
);

test(
  "a legacy split-gap booked projection is healed instead of downgraded by a late manual writer",
  { skip: skipReason },
  async () => {
    const captured = await seedCapturedChargeAndStoreCrash();
    const [initialHold] = await requireDb()
      .select()
      .from(appointmentHolds)
      .where(eq(appointmentHolds.id, captured.holdId));
    const eventId = `${TEST_PREFIX}split-gap-event-${randomUUID()}`;
    await createAppointmentFinalizationRepository(
      requireDb(),
    ).confirmOperationalAppointment({
      calendar: { providerEventId: eventId, status: "synced" },
      holdId: captured.holdId,
      holdOutcome: "booked",
      now: new Date("2032-01-01T12:02:00.000Z"),
      source: "split_gap_fixture",
    });

    const manualAttempt = await captured.repository.markHoldManualFollowup({
      confirmation: {
        bookingStatus: "manual_followup",
        card: { brand: "VISA", last4: "4242" },
        holdReference: initialHold.publicReference,
        ok: true,
        paymentStatus: "captured",
      },
      holdId: captured.holdId,
      now: new Date("2032-01-01T12:03:01.000Z"),
      reason: "late split-gap fallback",
    });

    const confirmation = manualAttempt.reconciliationMetadata
      ?.chargeAndStoreConfirmation as { bookingStatus?: string } | undefined;
    assert.equal(manualAttempt.state, "booked");
    assert.equal(manualAttempt.googleEventId, eventId);
    assert.equal(confirmation?.bookingStatus, "booked");
  },
);

test(
  "stale payment and refund fallbacks cannot regress an already-refunded hold",
  { skip: skipReason },
  async () => {
    const seeded = await seedOperationalHold({ leavePaymentPending: true });
    const repository = await createServiceBookingPaymentRepository(requireDb());
    await requireDb()
      .update(appointmentHolds)
      .set({
        finalizationStatus: "refunded",
        reconciliationMetadata: {},
        status: "refunded",
      })
      .where(eq(appointmentHolds.id, seeded.holdId));

    await repository.markHoldPaymentFailed({
      holdId: seeded.holdId,
      now: new Date("2032-01-01T12:04:00.000Z"),
      reason: "stale payment failure",
    });
    const outcome = await repository.markHoldRefundRequired({
      holdId: seeded.holdId,
      now: new Date("2032-01-01T12:04:01.000Z"),
      reason: "stale refund fallback",
      squarePaymentId: `${TEST_PREFIX}stale-refund-payment`,
    });
    const [hold] = await requireDb()
      .select()
      .from(appointmentHolds)
      .where(eq(appointmentHolds.id, seeded.holdId));

    assert.equal(outcome?.status, "booking_outcome_preserved");
    assert.equal(hold.status, "refunded");
    assert.equal(hold.finalizationStatus, "refunded");
  },
);

test(
  "provider-confirmed cancellation terminates the matching authorization before payment failure",
  { skip: skipReason },
  async () => {
    const seeded = await seedOperationalHold({ leavePaymentPending: true });
    const repository = await createServiceBookingPaymentRepository(requireDb());
    const paymentId = `${TEST_PREFIX}cancelled-auth-${randomUUID()}`;
    const providerKey = `${TEST_PREFIX}cancelled-key-${randomUUID()}`;
    const recordAuthorized = repository.recordAuthorizedOperationalPayment;
    const terminate = repository.markAuthorizedOperationalPaymentTerminated;
    assert.ok(recordAuthorized);
    assert.ok(terminate);
    await prepareOperationalPaymentIntentForTest(repository, {
      holdId: seeded.holdId,
      idempotencyKey: providerKey,
      now: new Date("2032-01-01T12:05:00.000Z"),
      squareCustomerId: `${TEST_PREFIX}cancelled-customer`,
    });
    await recordAuthorized({
      amountCents: 13560,
      currency: "CAD",
      holdId: seeded.holdId,
      idempotencyKey: providerKey,
      now: new Date("2032-01-01T12:05:00.000Z"),
      squarePaymentId: paymentId,
    });

    const outcome = await terminate({
      holdId: seeded.holdId,
      now: new Date("2032-01-01T12:05:01.000Z"),
      squarePaymentId: paymentId,
      status: "cancelled",
    });
    await repository.markHoldPaymentFailed({
      holdId: seeded.holdId,
      now: new Date("2032-01-01T12:05:02.000Z"),
      reason: "provider cancellation confirmed",
    });

    const [attempt] = await requireDb()
      .select()
      .from(bookingPaymentAttempts)
      .where(eq(bookingPaymentAttempts.holdId, seeded.holdId));
    const [hold] = await requireDb()
      .select()
      .from(appointmentHolds)
      .where(eq(appointmentHolds.id, seeded.holdId));
    assert.equal(outcome, "cancelled");
    assert.equal(attempt.status, "cancelled");
    assert.equal(hold.status, "payment_failed");
  },
);

test(
  "provider-confirmed cancellation terminalizes a pending operational attempt by idempotency key",
  { skip: skipReason },
  async () => {
    const seeded = await seedOperationalHold({ leavePaymentPending: true });
    const repository = await createServiceBookingPaymentRepository(requireDb());
    const terminate = repository.markAuthorizedOperationalPaymentTerminated;
    assert.ok(terminate);
    const providerKey = `${TEST_PREFIX}pending-cancel-key-${randomUUID()}`;
    const paymentId = `${TEST_PREFIX}pending-cancel-payment-${randomUUID()}`;
    await prepareOperationalPaymentIntentForTest(repository, {
      holdId: seeded.holdId,
      idempotencyKey: providerKey,
      now: new Date("2032-01-01T12:05:10.000Z"),
      squareCustomerId: `${TEST_PREFIX}pending-cancel-customer`,
    });

    const outcome = await terminate({
      holdId: seeded.holdId,
      idempotencyKey: providerKey,
      now: new Date("2032-01-01T12:05:11.000Z"),
      squarePaymentId: paymentId,
      status: "cancelled",
    });
    const [attempt] = await requireDb()
      .select()
      .from(bookingPaymentAttempts)
      .where(eq(bookingPaymentAttempts.idempotencyKey, providerKey));

    assert.equal(outcome, "cancelled");
    assert.equal(attempt.status, "cancelled");
    assert.equal(attempt.providerPaymentId, paymentId);
  },
);

test(
  "provider-completed evidence overrides the active-authorization stale fallback guard",
  { skip: skipReason },
  async () => {
    const seeded = await seedOperationalHold({ leavePaymentPending: true });
    const repository = await createServiceBookingPaymentRepository(requireDb());
    const recordAuthorized = repository.recordAuthorizedOperationalPayment;
    assert.ok(recordAuthorized);
    const providerKey = `${TEST_PREFIX}completed-refund-key-${randomUUID()}`;
    const paymentId = `${TEST_PREFIX}completed-refund-payment-${randomUUID()}`;
    const now = new Date("2032-01-01T12:05:20.000Z");
    await prepareOperationalPaymentIntentForTest(repository, {
      holdId: seeded.holdId,
      idempotencyKey: providerKey,
      now,
      squareCustomerId: `${TEST_PREFIX}completed-refund-customer`,
    });
    await recordAuthorized({
      amountCents: 13560,
      currency: "CAD",
      holdId: seeded.holdId,
      idempotencyKey: providerKey,
      now,
      squarePaymentId: paymentId,
    });

    const outcome = await repository.markHoldRefundRequired({
      holdId: seeded.holdId,
      idempotencyKey: providerKey,
      now: new Date("2032-01-01T12:05:21.000Z"),
      providerEvidence: "completed",
      reason: "completed attribution mismatch",
      squarePaymentId: paymentId,
    });
    const [attempt] = await requireDb()
      .select()
      .from(bookingPaymentAttempts)
      .where(eq(bookingPaymentAttempts.idempotencyKey, providerKey));
    const [hold] = await requireDb()
      .select()
      .from(appointmentHolds)
      .where(eq(appointmentHolds.id, seeded.holdId));

    assert.equal(outcome?.status, "refund_required");
    assert.equal(attempt.status, "captured");
    assert.equal(attempt.capturedAt?.toISOString(), "2032-01-01T12:05:21.000Z");
    assert.equal(hold.status, "refund_required");
    assert.equal(hold.finalizationStatus, "refund_required");
  },
);

for (const losingState of ["payment_failed", "refund_required"] as const) {
  test(
    `${losingState} winning the hold lock prevents a later Square authorization insert`,
    { skip: skipReason },
    async () => {
      const seeded = await seedOperationalHold({ leavePaymentPending: true });
      const repository =
        await createServiceBookingPaymentRepository(requireDb());
      const now = new Date("2032-01-01T12:06:00.000Z");

      if (losingState === "payment_failed") {
        await repository.markHoldPaymentFailed({
          holdId: seeded.holdId,
          now,
          reason: "failure won before authorization",
        });
      } else {
        await repository.markHoldRefundRequired({
          holdId: seeded.holdId,
          now,
          reason: "refund won before authorization",
          squarePaymentId: `${TEST_PREFIX}pre-auth-refund-${randomUUID()}`,
        });
      }

      const recordAuthorized = repository.recordAuthorizedOperationalPayment;
      assert.ok(recordAuthorized);
      await assert.rejects(
        () =>
          recordAuthorized({
            amountCents: 13560,
            currency: "CAD",
            holdId: seeded.holdId,
            idempotencyKey: `${TEST_PREFIX}pre-auth-key-${randomUUID()}`,
            now: new Date("2032-01-01T12:06:01.000Z"),
            squarePaymentId: `${TEST_PREFIX}pre-auth-payment-${randomUUID()}`,
          }),
        AppointmentFinalizationConflictError,
      );
      const attempts = await requireDb()
        .select()
        .from(bookingPaymentAttempts)
        .where(eq(bookingPaymentAttempts.holdId, seeded.holdId));
      assert.equal(attempts.length, 0);
    },
  );
}

for (const expectedBookingStatus of ["booked", "manual_followup"] as const) {
  test(
    `a retry after durable capture resumes only ${expectedBookingStatus} finalization without another Square operation`,
    { skip: skipReason },
    async () => {
      const captured = await seedCapturedChargeAndStoreCrash();
      const providerCalls: string[] = [];
      const emailHoldIds: string[] = [];
      const adminFailures: string[] = [];
      const googleEventId = `${TEST_PREFIX}recovery-event-${randomUUID()}`;

      const result = await confirmChargeAndStoreBooking(captured.request, {
        alerts: { alert() {} },
        calendarFinalizer: {
          async finalize() {
            return expectedBookingStatus === "booked"
              ? { googleEventId, ok: true as const }
              : {
                  error: "Calendar unavailable during recovery test",
                  ok: false as const,
                  status: "manual_followup" as const,
                };
          },
        },
        locationId: "test-location",
        now: new Date("2032-01-01T12:01:31.000Z"),
        repository: captured.repository,
        sendBookingConfirmationEmailForHold: async (holdId) => {
          emailHoldIds.push(holdId);
        },
        sendBookingSchedulingFailureAdminEmail: async (input) => {
          adminFailures.push(input.failureReason);
        },
        squareCards: {
          async createCard() {
            providerCalls.push("cards.create");
            throw new Error("Recovery must not create a Square card");
          },
        },
        squareCustomers: {
          async createCustomer() {
            providerCalls.push("customers.create");
            throw new Error("Recovery must not create a Square customer");
          },
        },
        squareInvoices: {
          async createInvoice() {
            providerCalls.push("invoices.create");
            throw new Error("Recovery must not create a Square invoice");
          },
          async createOrder() {
            providerCalls.push("orders.create");
            throw new Error("Recovery must not create a Square order");
          },
          async deleteInvoice() {
            providerCalls.push("invoices.delete");
            throw new Error("Recovery must not delete a Square invoice");
          },
          async getInvoice() {
            providerCalls.push("invoices.get");
            throw new Error("Recovery must not read a Square invoice");
          },
          async publishInvoice() {
            providerCalls.push("invoices.publish");
            throw new Error("Recovery must not publish a Square invoice");
          },
        },
        squarePayments: {
          async cancelPayment() {
            providerCalls.push("payments.cancel");
            throw new Error("Recovery must not cancel a Square payment");
          },
          async cancelPaymentByIdempotencyKey() {
            providerCalls.push("payments.cancel-by-idempotency-key");
            throw new Error("Recovery must not cancel a Square payment");
          },
          async completePayment() {
            providerCalls.push("payments.complete");
            throw new Error("Recovery must not capture a Square payment");
          },
          async createCardOnFilePayment() {
            providerCalls.push("payments.create");
            throw new Error("Recovery must not create a Square payment");
          },
          async getPayment() {
            providerCalls.push("payments.get");
            throw new Error("Recovery must not read a Square payment");
          },
        },
      });

      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.bookingStatus, expectedBookingStatus);
      assert.deepEqual(result.card, {
        brand: "VISA",
        expMonth: 12,
        expYear: 2035,
        last4: "4242",
      });
      assert.deepEqual(providerCalls, []);
      assert.deepEqual(emailHoldIds, [captured.holdId]);
      assert.equal(
        adminFailures.length,
        expectedBookingStatus === "manual_followup" ? 1 : 0,
      );

      const durableAppointments = await requireDb()
        .select()
        .from(appointments)
        .where(eq(appointments.sourceHoldId, captured.holdId));
      const durableAttempts = await requireDb()
        .select()
        .from(bookingPaymentAttempts)
        .where(eq(bookingPaymentAttempts.holdId, captured.holdId));
      const [hold] = await requireDb()
        .select()
        .from(appointmentHolds)
        .where(eq(appointmentHolds.id, captured.holdId));

      assert.equal(durableAppointments.length, 1);
      assert.equal(durableAttempts.length, 1);
      // The appointment remains confirmed when only its Calendar projection
      // needs manual follow-up; calendarSyncStatus carries that distinction.
      assert.equal(durableAppointments[0]?.status, "confirmed");
      assert.equal(
        durableAppointments[0]?.calendarSyncStatus,
        expectedBookingStatus === "booked" ? "synced" : "manual_followup",
      );
      assert.equal(durableAttempts[0]?.status, "captured");
      assert.equal(
        durableAttempts[0]?.providerPaymentId,
        captured.squarePaymentId,
      );
      assert.equal(hold.status, expectedBookingStatus);
      assert.deepEqual(
        (
          hold.reconciliationMetadata as {
            chargeAndStoreConfirmation?: unknown;
            chargeAndStoreInProgress?: unknown;
          }
        ).chargeAndStoreConfirmation,
        result,
      );
      assert.equal(
        (
          hold.reconciliationMetadata as {
            chargeAndStoreInProgress?: unknown;
          }
        ).chargeAndStoreInProgress,
        undefined,
      );
    },
  );
}

interface SeededFixture {
  assignmentId: string;
  calendarConnectionId: string;
  calendarId: string;
  offeringId: string;
  offeringKey: string;
  primaryResourceId: string;
  providerId: string;
  providerKey: string;
  secondaryResourceId?: string;
  serviceId: string;
  serviceKey: string;
}

async function seedCapturedChargeAndStoreCrash(): Promise<{
  holdId: string;
  repository: Awaited<ReturnType<typeof createServiceBookingPaymentRepository>>;
  request: ChargeAndStoreBookingRequestBody;
  squarePaymentId: string;
}> {
  const customerEmail = `${TEST_PREFIX}${randomUUID()}@example.com`;
  const seeded = await seedOperationalHold({
    customerEmail,
    leavePaymentPending: true,
  });
  const repository = await createServiceBookingPaymentRepository(requireDb());
  const now = new Date("2032-01-01T12:01:00.000Z");
  const idempotencyKey = `${TEST_PREFIX}recovery-idem-${randomUUID()}`;
  const request: ChargeAndStoreBookingRequestBody = {
    customer: {
      email: customerEmail,
      marketingOptIn: false,
      name: "Captured Recovery Customer",
      phone: "+14165550123",
    },
    idempotencyKey,
    payment: { expectedAmountCents: 12000, option: "full" },
    paymentSessionReference: seeded.paymentSessionReference,
    policy: {
      accepted: true,
      policyTextHash: hashServiceNoShowPolicyText(SERVICE_NO_SHOW_POLICY_TEXT),
      policyVersion: SERVICE_NO_SHOW_POLICY_VERSION,
    },
    sourceId: "cnon:must-not-be-used-during-recovery",
  };
  const claim = await repository.claimPaymentAttempt({
    idempotencyKey,
    now,
    paymentSessionReference: seeded.paymentSessionReference,
  });
  assert.equal(claim.status, "available");

  await repository.persistCustomerAndSelection({
    customer: request.customer,
    holdId: seeded.holdId,
    now,
    payment: {
      amountCents: 12000,
      currency: "CAD",
      description: "Finalization test service full payment",
      option: "full",
      purpose: "appointment_full",
      sku: "BOOKING-FULL",
    },
  });
  const acceptance = await repository.persistPolicyAcceptance({
    currency: "CAD",
    customerEmail,
    customerName: request.customer.name,
    holdId: seeded.holdId,
    maxChargeCents: 12000,
    now,
    policyTextHash: request.policy.policyTextHash,
    policyVersion: request.policy.policyVersion,
  });
  const squareCustomer = await repository.persistSquareCustomer({
    email: customerEmail,
    name: request.customer.name,
    now,
    phone: request.customer.phone,
    squareCustomerId: `${TEST_PREFIX}recovery-customer-${randomUUID()}`,
  });
  const savedCard = await repository.persistSavedPaymentMethod({
    brand: "VISA",
    expMonth: 12,
    expYear: 2035,
    last4: "4242",
    now,
    squareCardId: `${TEST_PREFIX}recovery-card-${randomUUID()}`,
    squareCustomerRecordId: squareCustomer.id,
  });
  await repository.createNoShowChargeRecord({
    currency: "CAD",
    holdId: seeded.holdId,
    maxChargeCents: 12000,
    now,
    policyAcceptanceId: acceptance.id,
    savedPaymentMethodId: savedCard.id,
    squareCardId: savedCard.squareCardId,
    squareCustomerId: squareCustomer.squareCustomerId,
    status: "ready",
  });

  const squarePaymentId = `${TEST_PREFIX}recovery-payment-${randomUUID()}`;
  const recordCapturedOperationalPayment =
    repository.recordCapturedOperationalPayment;
  assert.ok(recordCapturedOperationalPayment);
  await recordCapturedOperationalPayment({
    amountCents: 13560,
    currency: "CAD",
    holdId: seeded.holdId,
    idempotencyKey,
    now,
    squareOrderId: `${TEST_PREFIX}recovery-order-${randomUUID()}`,
    squarePaymentId,
  });

  // Simulate a stale failure callback racing after the atomic capture. The
  // paid-pending state is authoritative and must not be made retryable.
  await repository.markHoldPaymentFailed({
    holdId: seeded.holdId,
    now: new Date("2032-01-01T12:01:01.000Z"),
    reason: "stale post-capture failure",
  });
  const [capturedHold] = await requireDb()
    .select({ status: appointmentHolds.status })
    .from(appointmentHolds)
    .where(eq(appointmentHolds.id, seeded.holdId));
  assert.equal(capturedHold.status, "paid_pending_booking");

  return { holdId: seeded.holdId, repository, request, squarePaymentId };
}

async function seedOperationalHold(
  options: {
    customerEmail?: string;
    leavePaymentPending?: boolean;
    paymentPurpose?:
      | "appointment_deposit"
      | "appointment_full"
      | "appointment_custom_partial";
    secondaryResource?: boolean;
  } = {},
): Promise<{
  fixture: SeededFixture;
  holdId: string;
  paymentSessionReference: string;
}> {
  const fixture = await seedFixture(options);
  const now = new Date("2032-01-01T12:00:00.000Z");
  const start = new Date("2032-01-03T15:00:00.000Z");
  const end = new Date("2032-01-03T16:00:00.000Z");
  const booking: ResolvedOperationalBooking = {
    bookingModelVersion: 2,
    calendar: {
      assignmentId: fixture.assignmentId,
      calendarId: fixture.calendarId,
      connectionId: fixture.calendarConnectionId,
    },
    configurationVersion: 1,
    durationMinutes: 60,
    occupiedEnd: end,
    occupiedStart: start,
    offeringId: fixture.offeringId,
    offeringKey: fixture.offeringKey,
    pricing: {
      addOnPriceCents: 0,
      currency: "CAD",
      depositAmountCents: 5000,
      fullPriceCents: 12000,
    },
    providerId: fixture.providerId,
    providerSnapshot: {
      displayName: "Finalization test provider",
      providerKey: fixture.providerKey,
    },
    resourceId: fixture.primaryResourceId,
    selectedEnd: end,
    selectedStart: start,
    serviceSnapshot: {
      displayTitle: "Finalization test service",
      serviceId: fixture.serviceId,
      serviceKey: fixture.serviceKey,
    },
    timezone: "America/Toronto",
  };
  const repository = createDrizzleBookingReservationRepository(requireDb());
  const created = await repository.createV2Hold({
    answers: [{ answer: "None", questionId: "allergies" }],
    booking,
    customer: {
      email: options.customerEmail ?? "Finalization.Test@Example.com ",
      name: "Finalization Test",
      phone: "5555555555",
    },
    expiresAt: new Date("2032-01-01T12:10:00.000Z"),
    marketingOptInLabel: "Send me finalization updates.",
    now,
    paymentSessionReference: `${TEST_PREFIX}session-${randomUUID()}`,
    publicReference: `${TEST_PREFIX}hold-${randomUUID()}`,
  });
  assert.equal(created.ok, true);
  if (!created.ok) {
    throw new Error("Unable to seed operational hold");
  }

  if (!options.leavePaymentPending) {
    await requireDb()
      .update(appointmentHolds)
      .set({
        offeringSnapshot: {
          ...created.hold.offeringSnapshot,
          customerStatus: "captured",
          paymentStatus: "selected",
          selectedPayment: {
            amount: 50,
            description: "Finalization test payment",
            purpose: options.paymentPurpose ?? "appointment_deposit",
            sku:
              options.paymentPurpose === "appointment_full"
                ? "BOOKING-FULL"
                : options.paymentPurpose === "appointment_custom_partial"
                  ? "BOOKING-CUSTOM-PARTIAL"
                  : "BOOKING-DEPOSIT",
          },
        },
      })
      .where(eq(appointmentHolds.id, created.hold.id));
  }

  return {
    fixture,
    holdId: created.hold.id,
    paymentSessionReference: created.hold.paymentSessionReference,
  };
}

async function seedFixture(
  options: { secondaryResource?: boolean } = {},
): Promise<SeededFixture> {
  const suffix = randomUUID();
  const database = requireDb();
  const [primaryResource] = await database
    .insert(bookingResources)
    .values({
      kind: "provider",
      name: `Finalization resource ${suffix}`,
      resourceKey: `${TEST_PREFIX}resource-${suffix}`,
      status: "active",
      timezone: "America/Toronto",
    })
    .returning();
  const [provider] = await database
    .insert(bookingProviders)
    .values({
      displayName: `Finalization provider ${suffix}`,
      primaryResourceId: primaryResource.id,
      providerKey: `${TEST_PREFIX}provider-${suffix}`,
      publicSlug: `${TEST_PREFIX}provider-${suffix}`,
      status: "active",
    })
    .returning();
  const [service] = await database
    .insert(bookingServices)
    .values({
      displayTitle: `Finalization service ${suffix}`,
      publicSlug: `${TEST_PREFIX}service-${suffix}`,
      serviceKey: `${TEST_PREFIX}service-${suffix}`,
      status: "active",
    })
    .returning();
  const [offering] = await database
    .insert(bookingServiceOfferings)
    .values({
      bookingType: "in-person-appointment",
      depositAmountCents: 5000,
      durationMinutes: 60,
      fullPriceCents: 12000,
      offeringKey: `${TEST_PREFIX}offering-${suffix}`,
      primaryResourceId: primaryResource.id,
      providerId: provider.id,
      serviceId: service.id,
      slotIntervalMinutes: 15,
      status: "active",
      version: 1,
    })
    .returning();
  const [connection] = await database
    .insert(bookingCalendarConnections)
    .values({
      accountEmail: `${TEST_PREFIX}${suffix}@example.com`,
      credentialSecretRef: `${TEST_PREFIX}secret-${suffix}`,
      provider: "google",
      providerAccountId: `${TEST_PREFIX}account-${suffix}`,
      status: "active",
    })
    .returning();
  const calendarId = `${TEST_PREFIX}calendar-id-${suffix}`;
  const [assignment] = await database
    .insert(bookingResourceCalendarAssignments)
    .values({
      acceptsBookings: true,
      calendarConnectionId: connection.id,
      calendarLabel: `${TEST_PREFIX}calendar-${suffix}`,
      contributesBusy: true,
      providerCalendarId: calendarId,
      resourceId: primaryResource.id,
      status: "active",
    })
    .returning();
  let secondaryResourceId: string | undefined;

  if (options.secondaryResource) {
    const [secondary] = await database
      .insert(bookingResources)
      .values({
        kind: "room",
        name: `Finalization room ${suffix}`,
        resourceKey: `${TEST_PREFIX}room-${suffix}`,
        status: "active",
        timezone: "America/Toronto",
      })
      .returning();
    secondaryResourceId = secondary.id;
    await database.insert(bookingServiceOfferingResources).values({
      isRequired: true,
      offeringId: offering.id,
      resourceId: secondary.id,
      role: "room",
    });
  }

  return {
    assignmentId: assignment.id,
    calendarConnectionId: connection.id,
    calendarId,
    offeringId: offering.id,
    offeringKey: offering.offeringKey,
    primaryResourceId: primaryResource.id,
    providerId: provider.id,
    providerKey: provider.providerKey,
    secondaryResourceId,
    serviceId: service.id,
    serviceKey: service.serviceKey,
  };
}

function createRawOperationalHold(fixture: SeededFixture) {
  return {
    bookingModelVersion: 2,
    bookingType: "in-person-appointment",
    calendarAssignmentId: fixture.assignmentId,
    configurationVersion: 1,
    customerSnapshot: {
      email: "no-reservation@example.com",
      name: "No Reservation",
      phone: "5555555555",
    },
    expiresAt: new Date("2032-06-01T12:10:00.000Z"),
    googleCalendarId: fixture.calendarId,
    occupiedEnd: new Date("2032-06-03T16:00:00.000Z"),
    occupiedStart: new Date("2032-06-03T15:00:00.000Z"),
    offeringId: fixture.offeringKey,
    offeringSnapshot: { title: "No reservation service" },
    paymentProvider: "square" as const,
    paymentSessionReference: `${TEST_PREFIX}session-${randomUUID()}`,
    primaryResourceId: fixture.primaryResourceId,
    providerId: fixture.providerId,
    providerSnapshot: {
      displayName: "No Reservation Provider",
      providerKey: fixture.providerKey,
    },
    publicReference: `${TEST_PREFIX}hold-${randomUUID()}`,
    selectedEnd: new Date("2032-06-03T16:00:00.000Z"),
    selectedStart: new Date("2032-06-03T15:00:00.000Z"),
    serviceOfferingId: fixture.offeringId,
    timezone: "America/Toronto",
  };
}

function createCapturedPayment() {
  const suffix = randomUUID();
  return {
    amountCents: 5000,
    currency: "CAD",
    idempotencyKey: `${TEST_PREFIX}payment-key-${suffix}`,
    operation: "service_booking_charge",
    paymentProvider: "square" as const,
    providerMetadata: { testCorrelationId: suffix },
    providerOrderId: `${TEST_PREFIX}order-${suffix}`,
    providerPaymentId: `${TEST_PREFIX}payment-${suffix}`,
  };
}

async function seedPolicyRecords(holdId: string): Promise<{
  acceptanceId: string;
  noShowRecordId: string;
}> {
  const [acceptance] = await requireDb()
    .insert(bookingPolicyAcceptances)
    .values({
      acceptedAt: new Date("2032-01-01T12:00:30.000Z"),
      currency: "CAD",
      customerEmail: "finalization.test@example.com",
      customerName: "Finalization Test",
      holdId,
      maxChargeCents: 7500,
      policyType: "service_no_show",
      policyVersion: "test-v1",
    })
    .returning();
  const [record] = await requireDb()
    .insert(bookingNoShowChargeRecords)
    .values({
      currency: "CAD",
      holdId,
      maxChargeCents: 7500,
      policyAcceptanceId: acceptance.id,
      status: "draft",
    })
    .returning();

  return { acceptanceId: acceptance.id, noShowRecordId: record.id };
}

function requireDb() {
  if (!db) {
    throw new Error("TEST_DATABASE_URL not configured");
  }

  return db;
}

async function prepareOperationalPaymentIntentForTest(
  repository: ChargeAndStoreRepository,
  input: {
    holdId: string;
    idempotencyKey: string;
    now: Date;
    squareCustomerId: string;
  },
): Promise<void> {
  const prepare = repository.prepareOperationalPaymentIntent;
  assert.ok(prepare);
  const [hold] = await requireDb()
    .select({ publicReference: appointmentHolds.publicReference })
    .from(appointmentHolds)
    .where(eq(appointmentHolds.id, input.holdId));
  assert.ok(hold);
  const result = await prepare({
    amountCents: 13560,
    currency: "CAD",
    holdId: input.holdId,
    idempotencyKeyCandidate: input.idempotencyKey,
    leaseExpiresAt: new Date(input.now.getTime() + 5 * 60 * 1000),
    now: input.now,
    referenceId: hold.publicReference,
    requestBodyHash: `${TEST_PREFIX}request-body-hash`,
    sourceIdHash: `${TEST_PREFIX}source-id-hash`,
    squareCustomerId: input.squareCustomerId,
  });
  assert.equal(result.status, "ready");
}

async function cleanupTestRows(): Promise<void> {
  const database = requireDb();

  await database.execute(
    sql`delete from ${bookingPaymentAttempts} where ${bookingPaymentAttempts.idempotencyKey} like ${`${TEST_PREFIX}%`}`,
  );
  await database.execute(
    sql`delete from ${appointments} where ${appointments.sourceHoldPublicReference} like ${`${TEST_PREFIX}%`}`,
  );
  await database.execute(
    sql`delete from ${appointmentHolds} where ${appointmentHolds.publicReference} like ${`${TEST_PREFIX}%`}`,
  );
  await database.execute(
    sql`delete from ${bookingSavedPaymentMethods} where ${bookingSavedPaymentMethods.customerId} in (select ${bookingSquareCustomers.id} from ${bookingSquareCustomers} where ${bookingSquareCustomers.emailNormalized} like ${`${TEST_PREFIX}%`})`,
  );
  await database.execute(
    sql`delete from ${bookingSquareCustomers} where ${bookingSquareCustomers.emailNormalized} like ${`${TEST_PREFIX}%`}`,
  );

  const offeringRows = await database
    .select({ id: bookingServiceOfferings.id })
    .from(bookingServiceOfferings)
    .where(
      sql`${bookingServiceOfferings.offeringKey} like ${`${TEST_PREFIX}%`}`,
    );
  const offeringIds = offeringRows.map((row) => row.id);
  if (offeringIds.length > 0) {
    await database
      .delete(bookingServiceOfferingResources)
      .where(inArray(bookingServiceOfferingResources.offeringId, offeringIds));
    await database
      .delete(bookingServiceOfferings)
      .where(inArray(bookingServiceOfferings.id, offeringIds));
  }

  await database.execute(
    sql`delete from ${bookingResourceCalendarAssignments} where ${bookingResourceCalendarAssignments.calendarLabel} like ${`${TEST_PREFIX}%`}`,
  );
  await database.execute(
    sql`delete from ${bookingCalendarConnections} where ${bookingCalendarConnections.accountEmail} like ${`${TEST_PREFIX}%`}`,
  );
  await database.execute(
    sql`delete from ${bookingProviders} where ${bookingProviders.providerKey} like ${`${TEST_PREFIX}%`}`,
  );
  await database.execute(
    sql`delete from ${bookingServices} where ${bookingServices.serviceKey} like ${`${TEST_PREFIX}%`}`,
  );
  await database.execute(
    sql`delete from ${bookingResources} where ${bookingResources.resourceKey} like ${`${TEST_PREFIX}%`}`,
  );
}
