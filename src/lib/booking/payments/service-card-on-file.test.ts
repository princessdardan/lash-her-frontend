import assert from "node:assert/strict";
import test from "node:test";

import type { BookingHoldRecord } from "@/lib/booking/holds";
import type { NoShowChargeStatus } from "@/lib/private-db/schema";
import type { BookingSettings } from "@/lib/booking/types";
import type { ServicePaymentAlertLogger } from "./service-payment-alerts";
import { createCardOnFileCalendarFinalizer } from "./service-card-on-file-calendar-finalizer";
import {
  SERVICE_NO_SHOW_POLICY_TEXT,
  SERVICE_NO_SHOW_POLICY_VERSION,
  hashServiceNoShowAuditValue,
  hashServiceNoShowPolicyText,
} from "./service-no-show-policy";
import type {
  CardOnFileBookingRequestBody,
  CardOnFileBookingResponseBody,
  CardOnFileBookingResult,
  CardOnFileCalendarFinalizer,
  CardOnFileRepository,
  ConfirmCardOnFileBookingDependencies,
  ExistingCardOnFileConfirmation,
  NoShowInstrumentStep,
  SavedPaymentMethodRecord,
  SquareCardGateway,
  SquareCustomerGateway,
} from "./service-card-on-file";
import { createCardOnFileNoShowInstrumentStep } from "./service-card-on-file-no-show-instrument";
import { NoShowInvoiceBlockedError } from "./service-no-show-invoice";
import type { CreateDraftNoShowInvoiceRepository } from "./service-no-show-invoice";
import type { SquareInvoicesClient } from "@/lib/payments/square/invoice-client";

const selectedStart = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
selectedStart.setUTCHours(14, 0, 0, 0);
const selectedEnd = new Date(selectedStart.getTime() + 60 * 60 * 1000);

function createHold(
  overrides: Partial<BookingHoldRecord> = {},
): BookingHoldRecord {
  return {
    id: "hold-internal-1",
    publicReference: "hold_public_1",
    paymentSessionReference: "pay_sess_1",
    state: "held",
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    selectedStart,
    selectedEnd,
    offeringId: "service-classic-fill",
    offeringSnapshot: {
      title: "Classic Fill",
      fullPrice: 150,
      currency: "CAD",
      selectedPayment: {
        amount: 150,
        description: "Classic Fill full payment",
        purpose: "appointment_full",
        sku: "BOOKING-FULL",
      },
    },
    customer: {
      name: "Client Name",
      email: "client@example.com",
      phone: "+14165550123",
    },
    googleEventId: null,
    payment: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    timezone: "America/Toronto",
    bookingType: "in-person-appointment",
    ...overrides,
  };
}

function createRequest(
  overrides: Partial<CardOnFileBookingRequestBody> = {},
): CardOnFileBookingRequestBody {
  return {
    cardholderName: "Client Name",
    holdReference: "hold_public_1",
    idempotencyKey: "idem-key-1",
    policy: {
      accepted: true,
      maxChargeCents: 15000,
    },
    sourceId: "cnon:card-token",
    verificationToken: "verf-token-1",
    ...overrides,
  };
}

let retryIdempotencyCounter = 0;
const now = new Date();

interface FakeRepositoryState {
  holds: BookingHoldRecord[];
  customers: Array<{ id: string; email: string; squareCustomerId: string }>;
  paymentMethods: SavedPaymentMethodRecord[];
  policyAcceptances: Array<{
    id: string;
    holdId: string;
    policyVersion: string;
    policyTextHash: string;
    maxChargeCents: number;
    currency: string;
    customerEmail: string;
    customerName: string;
    ipHash?: string;
    userAgentHash?: string;
  }>;
  noShowRecords: Array<{
    id: string;
    holdId: string;
    savedPaymentMethodId?: string;
    policyAcceptanceId?: string;
    squareCustomerId?: string;
    squareCardId?: string;
    status: NoShowChargeStatus;
    maxChargeCents: number;
    currency: string;
    squareInvoiceId?: string;
    squareOrderId?: string;
    squarePaymentId?: string;
    providerStatus?: string;
    providerFailureReason?: string;
    providerMetadata?: Record<string, unknown>;
    updatedAt?: Date;
  }>;
  alertCalls: unknown[];
  calendarCalls: unknown[];
  noShowInstrumentCalls: unknown[];
  beginCardOnFileConfirmationCalls: Array<{
    publicReference: string;
    idempotencyKey: string;
    now: Date;
  }>;
  failPersistSavedPaymentMethodOnce: boolean;
}

function createFakeRepository(
  initialHolds: BookingHoldRecord[] = [createHold()],
): {
  repository: CardOnFileRepository;
  state: FakeRepositoryState;
} {
  const state: FakeRepositoryState = {
    holds: initialHolds.map((hold) => ({ ...hold })),
    customers: [],
    paymentMethods: [],
    policyAcceptances: [],
    noShowRecords: [],
    alertCalls: [],
    calendarCalls: [],
    noShowInstrumentCalls: [],
    beginCardOnFileConfirmationCalls: [],
    failPersistSavedPaymentMethodOnce: false,
  };

  const repository: CardOnFileRepository = {
    async beginCardOnFileConfirmation(input) {
      state.beginCardOnFileConfirmationCalls.push(input);
      const hold = state.holds.find(
        (h) => h.publicReference === input.publicReference,
      );
      if (!hold) return { status: "unavailable" };

      const metadata = (hold.reconciliationMetadata ?? {}) as Record<
        string,
        unknown
      >;
      const confirmation = metadata.cardOnFileConfirmation as
        | ExistingCardOnFileConfirmation
        | undefined;
      if (confirmation !== undefined) {
        return { status: "confirmed", confirmation };
      }

      const inProgress = metadata.cardOnFileInProgress as
        | { startedAt?: string; idempotencyKey?: string }
        | undefined;
      if (isActiveMarker(inProgress, input.now)) {
        return { status: "in_progress" };
      }

      hold.reconciliationMetadata = {
        ...hold.reconciliationMetadata,
        cardOnFileInProgress: {
          startedAt: input.now.toISOString(),
          idempotencyKey: input.idempotencyKey,
        },
      };

      return { status: "available", hold: { ...hold } };
    },

    async findSquareCustomerByEmail(email) {
      const customer = state.customers.find((c) => c.email === email);
      return customer
        ? { id: customer.id, squareCustomerId: customer.squareCustomerId }
        : null;
    },

    async persistSquareCustomer(input) {
      const id = `sq-cust-local-${state.customers.length + 1}`;
      state.customers.push({
        id,
        email: input.email,
        squareCustomerId: input.squareCustomerId,
      });
      return { id, squareCustomerId: input.squareCustomerId };
    },

    async findSavedPaymentMethodBySquareCardId(squareCardId) {
      return (
        state.paymentMethods.find((pm) => pm.squareCardId === squareCardId) ??
        null
      );
    },

    async persistSavedPaymentMethod(input) {
      if (state.failPersistSavedPaymentMethodOnce) {
        state.failPersistSavedPaymentMethodOnce = false;
        throw new Error("Database write failed");
      }
      const id = `pm-local-${state.paymentMethods.length + 1}`;
      const record: SavedPaymentMethodRecord = {
        id,
        brand: input.brand,
        expMonth: input.expMonth,
        expYear: input.expYear,
        last4: input.last4,
        squareCardId: input.squareCardId,
      };
      state.paymentMethods.push(record);
      return record;
    },

    async findPolicyAcceptanceForHold(holdId) {
      return state.policyAcceptances.find((p) => p.holdId === holdId) ?? null;
    },

    async persistPolicyAcceptance(input) {
      const id = `policy-local-${state.policyAcceptances.length + 1}`;
      state.policyAcceptances.push({
        id,
        holdId: input.holdId,
        policyVersion: input.policyVersion,
        policyTextHash: input.policyTextHash,
        maxChargeCents: input.maxChargeCents,
        currency: input.currency,
        customerEmail: input.customerEmail,
        customerName: input.customerName,
        ipHash: input.ipHash,
        userAgentHash: input.userAgentHash,
      });
      return { id };
    },

    async findNoShowChargeRecordForHold(holdId) {
      return state.noShowRecords.find((r) => r.holdId === holdId) ?? null;
    },

    async createNoShowChargeRecord(input) {
      const id = `nsr-local-${state.noShowRecords.length + 1}`;
      state.noShowRecords.push({
        id,
        holdId: input.holdId,
        savedPaymentMethodId: input.savedPaymentMethodId,
        policyAcceptanceId: input.policyAcceptanceId,
        squareCustomerId: input.squareCustomerId,
        squareCardId: input.squareCardId,
        status: input.status,
        maxChargeCents: input.maxChargeCents,
        currency: input.currency,
      });
      return { id, status: input.status };
    },

    async updateNoShowChargeRecord(input) {
      const record = state.noShowRecords.find(
        (r) => r.id === input.noShowChargeRecordId,
      );
      if (!record) throw new Error("No-show record not found");
      if (input.status !== undefined) record.status = input.status;
      if (input.squareInvoiceId !== undefined)
        record.squareInvoiceId = input.squareInvoiceId;
      if (input.squareOrderId !== undefined)
        record.squareOrderId = input.squareOrderId;
      if (input.squarePaymentId !== undefined)
        record.squarePaymentId = input.squarePaymentId;
      if (input.providerStatus !== undefined)
        record.providerStatus = input.providerStatus;
      if (input.providerFailureReason !== undefined)
        record.providerFailureReason = input.providerFailureReason;
      if (input.providerMetadata !== undefined)
        record.providerMetadata = input.providerMetadata;
      if (input.updatedAt !== undefined) record.updatedAt = input.updatedAt;
      return { id: record.id, status: record.status };
    },
    async updateNoShowChargeRecordIfNotTerminal(input) {
      const record = state.noShowRecords.find(
        (r) => r.id === input.noShowChargeRecordId,
      );
      if (!record)
        throw new Error(
          "No-show record not found or is already in a terminal state",
        );
      if (record.status === "charged" || record.status === "charge_failed") {
        throw new Error(
          "No-show record not found or is already in a terminal state",
        );
      }
      if (input.status !== undefined) record.status = input.status;
      if (input.squareInvoiceId !== undefined)
        record.squareInvoiceId = input.squareInvoiceId;
      if (input.squareOrderId !== undefined)
        record.squareOrderId = input.squareOrderId;
      if (input.squarePaymentId !== undefined)
        record.squarePaymentId = input.squarePaymentId;
      if (input.providerStatus !== undefined)
        record.providerStatus = input.providerStatus;
      if (input.providerFailureReason !== undefined)
        record.providerFailureReason = input.providerFailureReason;
      if (input.providerMetadata !== undefined)
        record.providerMetadata = input.providerMetadata;
      return { id: record.id, status: record.status };
    },
    async updateNoShowChargeRecordIfExpectedState(input) {
      const record = state.noShowRecords.find(
        (r) => r.id === input.noShowChargeRecordId,
      );
      if (!record)
        throw new Error(
          "No-show record not found or is no longer in the expected state",
        );
      if (record.status !== input.expectedStatus) {
        throw new Error("No-show record is no longer in the expected state");
      }
      if (
        input.expectedProviderStatus !== undefined &&
        record.providerStatus !== input.expectedProviderStatus
      ) {
        throw new Error("No-show record is no longer in the expected state");
      }
      if (
        input.expectedSquareInvoiceId !== undefined &&
        record.squareInvoiceId !== input.expectedSquareInvoiceId
      ) {
        throw new Error("No-show record is no longer in the expected state");
      }
      if (
        input.expectedUpdatedAt !== undefined &&
        record.updatedAt?.getTime() !== input.expectedUpdatedAt.getTime()
      ) {
        throw new Error("No-show record is no longer in the expected state");
      }
      if (input.status !== undefined) record.status = input.status;
      if (input.squareInvoiceId !== undefined)
        record.squareInvoiceId = input.squareInvoiceId;
      if (input.squareOrderId !== undefined)
        record.squareOrderId = input.squareOrderId;
      if (input.squarePaymentId !== undefined)
        record.squarePaymentId = input.squarePaymentId;
      if (input.providerStatus !== undefined)
        record.providerStatus = input.providerStatus;
      if (input.providerFailureReason !== undefined)
        record.providerFailureReason = input.providerFailureReason;
      if (input.providerMetadata !== undefined)
        record.providerMetadata = input.providerMetadata;
      record.updatedAt = new Date();
      return { id: record.id, status: record.status };
    },

    async getNoShowChargeRecordById() {
      throw new Error(
        "getNoShowChargeRecordById not implemented in fake repository",
      );
    },
    async findNoShowChargeAttempt() {
      return null;
    },
    async createNoShowChargeAttempt() {
      throw new Error(
        "createNoShowChargeAttempt not implemented in fake repository",
      );
    },
    async updateNoShowChargeAttempt() {
      throw new Error(
        "updateNoShowChargeAttempt not implemented in fake repository",
      );
    },
    async claimNoShowChargeAttempt() {
      throw new Error(
        "claimNoShowChargeAttempt not implemented in fake repository",
      );
    },
    async recordNoShowAdminAction() {
      return { recorded: true };
    },
    async recoverStaleNoShowChargePending() {
      return null;
    },

    async loadCardOnFileProgress(holdId) {
      const hold = state.holds.find((h) => h.id === holdId);
      if (!hold) return null;
      const metadata = (hold.reconciliationMetadata ?? {}) as Record<
        string,
        unknown
      >;
      return (
        (metadata.cardOnFileProgress as Record<string, unknown> | undefined) ??
        null
      );
    },

    async saveCardOnFileProgress(input) {
      const hold = state.holds.find((h) => h.id === input.holdId);
      if (!hold) throw new Error("Hold not found");
      const metadata = (hold.reconciliationMetadata ?? {}) as Record<
        string,
        unknown
      >;
      const existing = (metadata.cardOnFileProgress ?? {}) as Record<
        string,
        unknown
      >;
      hold.reconciliationMetadata = {
        ...metadata,
        cardOnFileProgress: { ...existing, ...input.progress },
      };
    },

    async markHoldBookedWithConfirmation(input) {
      const hold = state.holds.find((h) => h.id === input.holdId);
      if (!hold) throw new Error("Hold not found");

      const metadata = (hold.reconciliationMetadata ?? {}) as Record<
        string,
        unknown
      >;
      const existingConfirmation = metadata.cardOnFileConfirmation as
        | ExistingCardOnFileConfirmation
        | undefined;
      if (existingConfirmation !== undefined) {
        throw new Error("Terminal confirmation already exists");
      }

      const inProgress = metadata.cardOnFileInProgress as
        | { startedAt?: string; idempotencyKey?: string }
        | undefined;
      if (
        isActiveMarker(inProgress, input.now) &&
        inProgress?.idempotencyKey !== input.idempotencyKey
      ) {
        throw new Error("Hold is locked by another attempt");
      }

      hold.state = "booked";
      hold.googleEventId = input.googleEventId;
      hold.reconciliationMetadata = {
        ...metadata,
        cardOnFileConfirmation: input.confirmation,
        cardOnFileInProgress: undefined,
      };
      return { ...hold };
    },

    async markHoldManualFollowupWithConfirmation(input) {
      const hold = state.holds.find((h) => h.id === input.holdId);
      if (!hold) throw new Error("Hold not found");

      const metadata = (hold.reconciliationMetadata ?? {}) as Record<
        string,
        unknown
      >;
      const existingConfirmation = metadata.cardOnFileConfirmation as
        | ExistingCardOnFileConfirmation
        | undefined;
      if (existingConfirmation !== undefined) {
        throw new Error("Terminal confirmation already exists");
      }

      const inProgress = metadata.cardOnFileInProgress as
        | { startedAt?: string; idempotencyKey?: string }
        | undefined;
      if (
        isActiveMarker(inProgress, input.now) &&
        inProgress?.idempotencyKey !== input.idempotencyKey
      ) {
        throw new Error("Hold is locked by another attempt");
      }

      hold.state = "manual_followup";
      hold.reconciliationMetadata = {
        ...metadata,
        cardOnFileConfirmation: input.confirmation,
        cardOnFileInProgress: undefined,
      };
      return { ...hold };
    },
  };

  return { repository: attachFakeRepositoryState(repository, state), state };
}

const FAKE_REPOSITORY_STATE = Symbol("fakeRepositoryState");

type FakeRepositoryWithState = CardOnFileRepository & {
  [FAKE_REPOSITORY_STATE]?: FakeRepositoryState;
};

function attachFakeRepositoryState(
  repository: CardOnFileRepository,
  state: FakeRepositoryState,
): FakeRepositoryWithState {
  const extended = repository as FakeRepositoryWithState;
  extended[FAKE_REPOSITORY_STATE] = state;
  return extended;
}

function getFakeRepositoryState(
  repository: CardOnFileRepository,
): FakeRepositoryState | undefined {
  return (repository as FakeRepositoryWithState)[FAKE_REPOSITORY_STATE];
}

function isActiveMarker(
  marker: { startedAt?: string } | undefined,
  now: Date,
): boolean {
  if (marker?.startedAt === undefined) return false;
  const startedAt = new Date(marker.startedAt).getTime();
  if (Number.isNaN(startedAt)) return false;
  return now.getTime() - startedAt < 30_000;
}

function createFakeSquareCustomers(): SquareCustomerGateway {
  return {
    async createCustomer(request) {
      return {
        customer: {
          id: `square-cust-${request.idempotency_key}`,
        },
      };
    },
  };
}

function createFakeSquareCards(): SquareCardGateway {
  return {
    async createCard() {
      return {
        card: {
          id: "ccof:test-card",
          card_brand: "VISA",
          last_4: "4242",
          exp_month: 12,
          exp_year: 2030,
        },
      };
    },
  };
}

function createFakeCalendarFinalizer(
  options: { fail?: boolean } = {},
): CardOnFileCalendarFinalizer {
  return {
    async finalize(input) {
      if (options.fail) {
        return {
          ok: false,
          status: "manual_followup",
          error: "Calendar event creation failed",
        };
      }
      return { ok: true, googleEventId: `event-${input.hold.id}` };
    },
  };
}

function createCalendarFinalizerFixture() {
  const hold = createHold({ googleEventId: null });
  let findBookingEventForHoldCallIndex = 0;

  const google = {
    findBookingEventForHoldResults: [] as Array<string | null>,
    insertBookingEventCalls: [] as unknown[],
    listCalendarEventsCalls: [] as unknown[],
  };

  const finalizer = createCardOnFileCalendarFinalizer({
    getBookingSettings: async () =>
      ({
        bookingHorizonDays: 30,
        bufferMinutes: 0,
        calendarId: "cal-primary",
        hoursOfOperation: [
          { day: "monday", isOpen: true, opensAt: "00:00", closesAt: "23:59" },
          { day: "tuesday", isOpen: true, opensAt: "00:00", closesAt: "23:59" },
          {
            day: "wednesday",
            isOpen: true,
            opensAt: "00:00",
            closesAt: "23:59",
          },
          {
            day: "thursday",
            isOpen: true,
            opensAt: "00:00",
            closesAt: "23:59",
          },
          { day: "friday", isOpen: true, opensAt: "00:00", closesAt: "23:59" },
          {
            day: "saturday",
            isOpen: true,
            opensAt: "00:00",
            closesAt: "23:59",
          },
          { day: "sunday", isOpen: true, opensAt: "00:00", closesAt: "23:59" },
        ],
        intakeQuestions: [],
        marketingOptInLabel: "",
        minimumLeadTimeHours: 0,
        slotIntervalMinutes: 60,
        timezone: "UTC",
      }) satisfies BookingSettings,
    googleCalendar: {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      async findBookingEventForHold(input: {
        calendarId: string;
        hold: { id: string };
      }) {
        const result =
          google.findBookingEventForHoldResults[
            findBookingEventForHoldCallIndex
          ];
        findBookingEventForHoldCallIndex += 1;
        return result ?? null;
      },
      async listCalendarEvents(input: {
        calendarId: string;
        timeMin: Date;
        timeMax: Date;
      }) {
        google.listCalendarEventsCalls.push(input);
        return [];
      },
      async insertBookingEvent(input: { calendarId: string; event: unknown }) {
        google.insertBookingEventCalls.push(input);
        return "event-new";
      },
      buildBookingEventPayload: () => ({
        summary: "Lash appointment",
        start: { dateTime: hold.selectedStart.toISOString() },
        end: { dateTime: hold.selectedEnd.toISOString() },
        extendedProperties: {
          private: {
            holdId: hold.id,
          },
        },
      }),
    },
    holds: {
      async listActiveAppointmentHolds() {
        return [];
      },
      getActiveHoldBusyEvents: () => [],
    } as unknown as typeof import("@/lib/booking/holds"),
    operationalStore: {
      async acquireCalendarLock() {
        return true;
      },
      async releaseCalendarLock() {},
    },
  });

  return {
    hold,
    finalizer,
    google,
  };
}

function createFakeNoShowInstrumentStep(
  status: "ready" | "provider_draft_created" | "manual_followup" = "ready",
): NoShowInstrumentStep {
  return {
    async createInstrument() {
      return { status };
    },
  };
}

function createFakeAlerts(calls: unknown[]): ServicePaymentAlertLogger {
  return {
    alert(input) {
      calls.push(input);
    },
  };
}

async function runSaga(
  input: CardOnFileBookingRequestBody,
  overrides: Partial<ConfirmCardOnFileBookingDependencies> & {
    initialHolds?: BookingHoldRecord[];
  } = {},
): Promise<{ result: CardOnFileBookingResult; state: FakeRepositoryState }> {
  const callerRepository = overrides.repository;
  const callerRepositoryState =
    callerRepository !== undefined
      ? getFakeRepositoryState(callerRepository)
      : undefined;

  const { repository, state } =
    callerRepositoryState !== undefined
      ? {
          repository: callerRepository as CardOnFileRepository,
          state: callerRepositoryState,
        }
      : createFakeRepository(overrides.initialHolds ?? [createHold()]);

  const overridesWithoutAlerts = { ...overrides };
  delete overridesWithoutAlerts.alerts;

  const dependencies: ConfirmCardOnFileBookingDependencies = {
    repository,
    squareCustomers: createFakeSquareCustomers(),
    squareCards: createFakeSquareCards(),
    calendarFinalizer: createFakeCalendarFinalizer(),
    noShowInstrumentStep: createFakeNoShowInstrumentStep(),
    alerts: createFakeAlerts(state.alertCalls),
    now,
    ...overridesWithoutAlerts,
  };

  // Honor a caller-supplied alerts logger while also recording to state.alertCalls
  // so existing assertions that inspect state.alertCalls continue to work.
  if (overrides.alerts !== undefined) {
    const callerAlerts = overrides.alerts;
    dependencies.alerts = {
      alert(input) {
        state.alertCalls.push(input);
        callerAlerts.alert(input);
      },
    };
  }

  const { confirmCardOnFileBooking } = await import("./service-card-on-file");
  const result = await confirmCardOnFileBooking(input, dependencies);
  return { result, state };
}

function assertSuccess(
  result: CardOnFileBookingResult,
): CardOnFileBookingResponseBody {
  if (!result.ok) {
    assert.fail(
      `Expected success but got error: ${result.error} - ${result.message}`,
    );
  }
  return result;
}

test("rejects missing policy acceptance", async () => {
  const { result } = await runSaga(
    createRequest({
      policy: {
        accepted: false,
        maxChargeCents: 15000,
      } as unknown as CardOnFileBookingRequestBody["policy"],
    }),
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error, "invalid_request");
  }
});

test("rejects expired hold", async () => {
  const { result } = await runSaga(createRequest(), {
    initialHolds: [
      createHold({ state: "held", expiresAt: new Date(Date.now() - 1000) }),
    ],
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error, "hold_unavailable");
  }
});

test("rejects non-held hold", async () => {
  const { result } = await runSaga(createRequest(), {
    initialHolds: [createHold({ state: "booked" })],
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error, "hold_unavailable");
  }
});

test("creates Square customer, card, policy, no-show record, finalizes Calendar, and returns booked", async () => {
  const { result, state } = await runSaga(createRequest());

  const success = assertSuccess(result);
  assert.equal(success.bookingStatus, "booked");
  assert.equal(success.holdReference, "hold_public_1");
  assert.equal(success.noShowChargeStatus, "ready");
  assert.deepEqual(success.card, {
    brand: "VISA",
    expMonth: 12,
    expYear: 2030,
    last4: "4242",
  });

  assert.equal(state.customers.length, 1);
  assert.equal(
    state.customers[0].squareCustomerId,
    "square-cust-card-on-file:customer:hold-internal-1",
  );

  assert.equal(state.paymentMethods.length, 1);
  assert.equal(state.paymentMethods[0].squareCardId, "ccof:test-card");

  assert.equal(state.policyAcceptances.length, 1);
  assert.equal(state.policyAcceptances[0].holdId, "hold-internal-1");

  assert.equal(state.noShowRecords.length, 1);
  assert.equal(state.noShowRecords[0].status, "ready");
  assert.equal(state.noShowRecords[0].maxChargeCents, 15000);

  const hold = state.holds[0];
  assert.equal(hold.state, "booked");
  assert.equal(hold.googleEventId, "event-hold-internal-1");
});

test("persists server-computed policy evidence even when client includes tampered hash/version", async () => {
  const { state } = await runSaga(
    createRequest({
      policy: {
        accepted: true,
        maxChargeCents: 15000,
        policyTextHash: "client-tampered-hash",
        policyVersion: "client-tampered-version",
      } as never,
    }),
  );

  assert.equal(state.policyAcceptances.length, 1);
  const acceptance = state.policyAcceptances[0];
  assert.equal(acceptance.policyVersion, SERVICE_NO_SHOW_POLICY_VERSION);
  assert.equal(
    acceptance.policyTextHash,
    hashServiceNoShowPolicyText(SERVICE_NO_SHOW_POLICY_TEXT),
  );
  assert.equal(
    acceptance.policyTextHash,
    hashServiceNoShowPolicyText(SERVICE_NO_SHOW_POLICY_TEXT),
  );
  assert.notEqual(acceptance.policyTextHash, "client-tampered-hash");
  assert.notEqual(acceptance.policyVersion, "client-tampered-version");
});

test("hashes optional IP and user-agent audit fields into persisted policy acceptance", async () => {
  const ipAddress = "192.168.1.1";
  const userAgent = "LashHerTest/1.0";

  const { state } = await runSaga(
    createRequest({
      ipAddress,
      userAgent,
    }),
  );

  assert.equal(state.policyAcceptances.length, 1);
  const acceptance = state.policyAcceptances[0];
  assert.equal(acceptance.ipHash, hashServiceNoShowAuditValue(ipAddress));
  assert.equal(
    acceptance.userAgentHash,
    hashServiceNoShowAuditValue(userAgent),
  );
});

test("if Square card save fails, hold remains unconfirmed and no Calendar event is created", async () => {
  const failingCards: SquareCardGateway = {
    async createCard() {
      throw new Error("Square card save failed");
    },
  };

  const { result, state } = await runSaga(createRequest(), {
    squareCards: failingCards,
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error, "square_api_error");
  }

  assert.equal(state.paymentMethods.length, 0);
  assert.equal(state.noShowRecords.length, 0);
  assert.equal(state.holds[0].state, "held");
  assert.equal(state.holds[0].googleEventId, null);
  assert.equal(state.calendarCalls.length, 0);
});

test("duplicate submit with same idempotency key returns existing state without duplicate Square or Calendar calls", async () => {
  const calendarCalls: unknown[] = [];
  const trackingCalendar: CardOnFileCalendarFinalizer = {
    async finalize(input) {
      calendarCalls.push(input);
      return { ok: true, googleEventId: `event-${input.hold.id}` };
    },
  };

  const first = await runSaga(createRequest(), {
    calendarFinalizer: trackingCalendar,
  });
  assert.equal(assertSuccess(first.result).bookingStatus, "booked");
  assert.equal(calendarCalls.length, 1);

  const second = await runSaga(createRequest(), {
    calendarFinalizer: trackingCalendar,
    initialHolds: [first.state.holds[0]],
  });

  assert.equal(assertSuccess(second.result).bookingStatus, "booked");
  assert.equal(calendarCalls.length, 1);
  assert.equal(second.state.customers.length, 0);
  assert.equal(second.state.paymentMethods.length, 0);
});

test("Calendar finalizer re-checks existing hold event after acquiring lock", async () => {
  const fixture = createCalendarFinalizerFixture();
  fixture.google.findBookingEventForHoldResults = [
    null,
    "event-existing-after-lock",
  ];

  const result = await fixture.finalizer.finalize({
    hold: fixture.hold,
    now: new Date("2026-06-20T12:00:00Z"),
  });

  assert.deepEqual(result, {
    ok: true,
    googleEventId: "event-existing-after-lock",
  });
  assert.equal(fixture.google.insertBookingEventCalls.length, 0);
});

test("calendar finalizer creates event when no correlation exists under lock", async () => {
  const fixture = createCalendarFinalizerFixture();
  fixture.google.findBookingEventForHoldResults = [null, null];

  const result = await fixture.finalizer.finalize({
    hold: fixture.hold,
    now: new Date("2026-06-20T12:00:00Z"),
  });

  assert.deepEqual(result, { ok: true, googleEventId: "event-new" });
  assert.equal(fixture.google.insertBookingEventCalls.length, 1);
});

test("Calendar finalization failure after card save sets manual follow-up and alerts", async () => {
  const { result, state } = await runSaga(createRequest(), {
    calendarFinalizer: createFakeCalendarFinalizer({ fail: true }),
  });

  const success = assertSuccess(result);
  assert.equal(success.bookingStatus, "manual_followup");
  assert.equal(success.noShowChargeStatus, "ready");

  assert.equal(state.holds[0].state, "manual_followup");
  assert.equal(state.alertCalls.length, 1);
  const alert = state.alertCalls[0] as { category: string; severity: string };
  assert.equal(alert.category, "booking_calendar_finalization_failed");
  assert.equal(alert.severity, "warning");
});

test("different idempotency key while hold is in progress blocks submit and avoids duplicate side effects", async () => {
  const squareCustomerCalls: unknown[] = [];
  const squareCardCalls: unknown[] = [];
  const calendarCalls: unknown[] = [];

  const delayingSquareCustomers: SquareCustomerGateway = {
    async createCustomer(request) {
      squareCustomerCalls.push(request);
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { customer: { id: `square-cust-${request.idempotency_key}` } };
    },
  };

  const trackingSquareCards: SquareCardGateway = {
    async createCard(request) {
      squareCardCalls.push(request);
      return {
        card: {
          id: "ccof:test-card",
          card_brand: "VISA",
          last_4: "4242",
          exp_month: 12,
          exp_year: 2030,
        },
      };
    },
  };

  const trackingCalendar: CardOnFileCalendarFinalizer = {
    async finalize(input) {
      calendarCalls.push(input);
      return { ok: true, googleEventId: `event-${input.hold.id}` };
    },
  };

  const { repository, state } = createFakeRepository();

  const first = runSaga(createRequest({ idempotencyKey: "idem-key-a" }), {
    repository,
    squareCustomers: delayingSquareCustomers,
    squareCards: trackingSquareCards,
    calendarFinalizer: trackingCalendar,
    initialHolds: [createHold()],
  });

  const second = runSaga(createRequest({ idempotencyKey: "idem-key-b" }), {
    repository,
    squareCustomers: delayingSquareCustomers,
    squareCards: trackingSquareCards,
    calendarFinalizer: trackingCalendar,
    initialHolds: state.holds,
  });

  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(firstResult.result.ok, true);
  assert.equal(secondResult.result.ok, false);
  if (!secondResult.result.ok) {
    assert.equal(secondResult.result.error, "infrastructure_error");
  }

  assert.equal(squareCustomerCalls.length, 1);
  assert.equal(squareCardCalls.length, 1);
  assert.equal(calendarCalls.length, 1);
});

test("retry after markHoldBookedWithConfirmation failure reuses persisted records and succeeds without duplicate inserts", async () => {
  const squareCardCalls: unknown[] = [];
  const trackingSquareCards: SquareCardGateway = {
    async createCard(request) {
      squareCardCalls.push(request);
      return {
        card: {
          id: "ccof:test-card",
          card_brand: "VISA",
          last_4: "4242",
          exp_month: 12,
          exp_year: 2030,
        },
      };
    },
  };

  const { repository, state } = createFakeRepository();
  let markBookedCalls = 0;

  repository.markHoldBookedWithConfirmation = async (input) => {
    markBookedCalls++;
    if (markBookedCalls === 1) {
      const hold = state.holds.find((h) => h.id === input.holdId);
      if (hold) {
        hold.reconciliationMetadata = {
          ...hold.reconciliationMetadata,
          cardOnFileInProgress: undefined,
        };
      }
      throw new Error("Database write failed");
    }
    const hold = state.holds.find((h) => h.id === input.holdId);
    if (!hold) throw new Error("Hold not found");
    hold.state = "booked";
    hold.googleEventId = input.googleEventId;
    hold.reconciliationMetadata = {
      ...hold.reconciliationMetadata,
      cardOnFileConfirmation: input.confirmation,
      cardOnFileInProgress: undefined,
    };
    return { ...hold };
  };

  const first = await runSaga(createRequest(), {
    repository,
    squareCards: trackingSquareCards,
  });
  assert.equal(first.result.ok, false);
  if (!first.result.ok) {
    assert.equal(first.result.error, "infrastructure_error");
  }

  assert.equal(state.paymentMethods.length, 1);
  assert.equal(state.policyAcceptances.length, 1);
  assert.equal(state.noShowRecords.length, 1);
  assert.equal(state.holds[0].state, "held");

  const second = await runSaga(
    createRequest({ idempotencyKey: `retry-key-${++retryIdempotencyCounter}` }),
    {
      repository,
      squareCards: trackingSquareCards,
      initialHolds: state.holds,
    },
  );

  assert.equal(assertSuccess(second.result).bookingStatus, "booked");
  assert.equal(state.paymentMethods.length, 1);
  assert.equal(state.policyAcceptances.length, 1);
  assert.equal(state.noShowRecords.length, 1);
  assert.equal(squareCardCalls.length, 1);
  assert.equal(state.holds[0].state, "booked");
});

test("retry after persisted card/policy/no-show but before final state reuses existing records", async () => {
  const squareCardCalls: unknown[] = [];
  const trackingSquareCards: SquareCardGateway = {
    async createCard(request) {
      squareCardCalls.push(request);
      return {
        card: {
          id: "ccof:test-card",
          card_brand: "VISA",
          last_4: "4242",
          exp_month: 12,
          exp_year: 2030,
        },
      };
    },
  };

  const { repository, state } = createFakeRepository();

  repository.markHoldBookedWithConfirmation = async (input) => {
    const hold = state.holds.find((h) => h.id === input.holdId);
    if (hold) {
      hold.reconciliationMetadata = {
        ...hold.reconciliationMetadata,
        cardOnFileInProgress: undefined,
      };
    }
    throw new Error("Database write failed");
  };

  const first = await runSaga(createRequest(), {
    repository,
    squareCards: trackingSquareCards,
  });
  assert.equal(first.result.ok, false);

  assert.equal(state.paymentMethods.length, 1);
  assert.equal(state.policyAcceptances.length, 1);
  assert.equal(state.noShowRecords.length, 1);

  repository.markHoldBookedWithConfirmation = async (input) => {
    const hold = state.holds.find((h) => h.id === input.holdId);
    if (!hold) throw new Error("Hold not found");
    hold.state = "booked";
    hold.googleEventId = input.googleEventId;
    hold.reconciliationMetadata = {
      ...hold.reconciliationMetadata,
      cardOnFileConfirmation: input.confirmation,
      cardOnFileInProgress: undefined,
    };
    return { ...hold };
  };

  const second = await runSaga(
    createRequest({ idempotencyKey: `retry-key-${++retryIdempotencyCounter}` }),
    {
      repository,
      squareCards: trackingSquareCards,
      initialHolds: state.holds,
    },
  );

  assert.equal(assertSuccess(second.result).bookingStatus, "booked");
  assert.equal(state.paymentMethods.length, 1);
  assert.equal(state.policyAcceptances.length, 1);
  assert.equal(state.noShowRecords.length, 1);
  assert.equal(squareCardCalls.length, 1);
});

test("card save persists Square card checkpoint before local saved-payment insert", async () => {
  const squareCardCalls: unknown[] = [];
  const trackingSquareCards: SquareCardGateway = {
    async createCard(request) {
      squareCardCalls.push(request);
      return {
        card: {
          id: "ccof:test-card",
          card_brand: "VISA",
          last_4: "4242",
          exp_month: 12,
          exp_year: 2030,
        },
      };
    },
  };

  const { repository, state } = createFakeRepository();
  state.failPersistSavedPaymentMethodOnce = true;

  const first = await runSaga(createRequest(), {
    repository,
    squareCards: trackingSquareCards,
  });
  assert.equal(first.result.ok, false);
  if (!first.result.ok) {
    assert.equal(first.result.error, "infrastructure_error");
  }

  const checkpoint = state.holds[0].reconciliationMetadata
    ?.cardOnFileProgress as Record<string, unknown> | undefined;
  assert.equal(checkpoint?.squareCardId, "ccof:test-card");
  assert.deepEqual(checkpoint?.card, {
    brand: "VISA",
    expMonth: 12,
    expYear: 2030,
    last4: "4242",
  });
  assert.equal(state.paymentMethods.length, 0);

  const second = await runSaga(
    createRequest({ idempotencyKey: `retry-key-${++retryIdempotencyCounter}` }),
    {
      repository,
      squareCards: trackingSquareCards,
      initialHolds: state.holds,
      now: new Date(now.getTime() + 60_000),
    },
  );

  assert.equal(assertSuccess(second.result).bookingStatus, "booked");
  assert.equal(state.paymentMethods.length, 1);
  assert.equal(squareCardCalls.length, 1);
});

test("markHoldBookedWithConfirmation failure after Calendar success returns infrastructure_error and leaves retry possible", async () => {
  const { repository, state } = createFakeRepository();
  let markBookedCalls = 0;

  repository.markHoldBookedWithConfirmation = async (input) => {
    markBookedCalls++;
    if (markBookedCalls === 1) {
      throw new Error("Database write failed");
    }
    const hold = state.holds.find((h) => h.id === input.holdId);
    if (!hold) throw new Error("Hold not found");
    hold.state = "booked";
    hold.googleEventId = input.googleEventId;
    hold.reconciliationMetadata = {
      ...hold.reconciliationMetadata,
      cardOnFileConfirmation: input.confirmation,
    };
    return { ...hold };
  };

  const { result } = await runSaga(createRequest(), { repository });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error, "infrastructure_error");
  }

  assert.equal(state.holds[0].state, "held");
});

test("markHoldManualFollowupWithConfirmation failure after Calendar failure returns infrastructure_error", async () => {
  const { repository, state } = createFakeRepository();

  repository.markHoldManualFollowupWithConfirmation = async () => {
    throw new Error("Database write failed");
  };

  const { result } = await runSaga(createRequest(), {
    calendarFinalizer: createFakeCalendarFinalizer({ fail: true }),
    repository,
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error, "infrastructure_error");
  }

  assert.equal(state.holds[0].state, "held");
});

test("concurrent same-idempotency submission returns infrastructure_error and avoids duplicate Square or Calendar calls", async () => {
  const squareCustomerCalls: unknown[] = [];
  const squareCardCalls: unknown[] = [];
  const calendarCalls: unknown[] = [];

  const delayingSquareCustomers: SquareCustomerGateway = {
    async createCustomer(request) {
      squareCustomerCalls.push(request);
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { customer: { id: `square-cust-${request.idempotency_key}` } };
    },
  };

  const trackingSquareCards: SquareCardGateway = {
    async createCard(request) {
      squareCardCalls.push(request);
      return {
        card: {
          id: "ccof:test-card",
          card_brand: "VISA",
          last_4: "4242",
          exp_month: 12,
          exp_year: 2030,
        },
      };
    },
  };

  const trackingCalendar: CardOnFileCalendarFinalizer = {
    async finalize(input) {
      calendarCalls.push(input);
      return { ok: true, googleEventId: `event-${input.hold.id}` };
    },
  };

  const { repository, state } = createFakeRepository();
  const request = createRequest();

  const [first, second] = await Promise.all([
    runSaga(request, {
      repository,
      squareCustomers: delayingSquareCustomers,
      squareCards: trackingSquareCards,
      calendarFinalizer: trackingCalendar,
      initialHolds: [createHold()],
    }),
    runSaga(request, {
      repository,
      squareCustomers: delayingSquareCustomers,
      squareCards: trackingSquareCards,
      calendarFinalizer: trackingCalendar,
      initialHolds: state.holds,
    }),
  ]);

  const outcomes = [first.result.ok, second.result.ok];
  assert.ok(
    outcomes.filter(Boolean).length <= 1,
    "At most one concurrent submission should succeed",
  );

  if (first.result.ok && !second.result.ok) {
    assert.equal(second.result.error, "infrastructure_error");
  } else if (second.result.ok && !first.result.ok) {
    assert.equal(first.result.error, "infrastructure_error");
  } else if (!first.result.ok && !second.result.ok) {
    // Both may fail if the second races past the first before the in-progress marker is set.
    // The important invariant is that duplicate side effects did not occur.
  }

  assert.equal(squareCustomerCalls.length, 1);
  assert.equal(squareCardCalls.length, 1);
  assert.equal(calendarCalls.length, 1);
});

test("retry after atomic booked confirmation returns recorded state without duplicate provider calls", async () => {
  const squareCardCalls: unknown[] = [];
  const trackingSquareCards: SquareCardGateway = {
    async createCard(request) {
      squareCardCalls.push(request);
      return {
        card: {
          id: "ccof:test-card",
          card_brand: "VISA",
          last_4: "4242",
          exp_month: 12,
          exp_year: 2030,
        },
      };
    },
  };

  const first = await runSaga(createRequest(), {
    squareCards: trackingSquareCards,
  });
  assert.equal(assertSuccess(first.result).bookingStatus, "booked");
  assert.equal(squareCardCalls.length, 1);

  const second = await runSaga(
    createRequest({ idempotencyKey: `retry-key-${++retryIdempotencyCounter}` }),
    {
      squareCards: trackingSquareCards,
      initialHolds: [first.state.holds[0]],
    },
  );

  assert.equal(assertSuccess(second.result).bookingStatus, "booked");
  assert.equal(squareCardCalls.length, 1);
});

test("tampered lower maxChargeCents is rejected with invalid_request", async () => {
  const { result } = await runSaga(
    createRequest({
      policy: { accepted: true, maxChargeCents: 5000 },
    }),
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error, "invalid_request");
  }
});

test("findSquareCustomerByEmail failure returns infrastructure_error", async () => {
  const { repository, state } = createFakeRepository();
  repository.findSquareCustomerByEmail = async () => {
    throw new Error("Database unavailable");
  };

  const { result } = await runSaga(createRequest(), { repository });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error, "infrastructure_error");
  }
  assert.equal(state.customers.length, 0);
});

test("persistSavedPaymentMethod failure returns infrastructure_error", async () => {
  const { repository } = createFakeRepository();
  repository.persistSavedPaymentMethod = async () => {
    throw new Error("Database unavailable");
  };

  const { result } = await runSaga(createRequest(), { repository });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error, "infrastructure_error");
  }
});

test("does not include billing postal code in Square card request or persisted payment method", async () => {
  const squareCardCalls: unknown[] = [];
  const trackingSquareCards: SquareCardGateway = {
    async createCard(request) {
      squareCardCalls.push(request);
      return {
        card: {
          id: "ccof:test-card",
          card_brand: "VISA",
          last_4: "4242",
          exp_month: 12,
          exp_year: 2030,
        },
      };
    },
  };

  const { result, state } = await runSaga(createRequest(), {
    squareCards: trackingSquareCards,
  });

  assert.equal(assertSuccess(result).bookingStatus, "booked");
  assert.equal(squareCardCalls.length, 1);

  const cardRequest = squareCardCalls[0] as {
    card?: { billing_address?: unknown };
  };
  assert.equal(cardRequest.card?.billing_address, undefined);
  assert.equal(state.paymentMethods.length, 1);
  assert.equal("billingPostalCode" in state.paymentMethods[0], false);
});

test("uses hold-scoped Square idempotency keys derived from hold id", async () => {
  const squareCustomerCalls: unknown[] = [];
  const squareCardCalls: unknown[] = [];

  const trackingSquareCustomers: SquareCustomerGateway = {
    async createCustomer(request) {
      squareCustomerCalls.push(request);
      return { customer: { id: `square-cust-${request.idempotency_key}` } };
    },
  };

  const trackingSquareCards: SquareCardGateway = {
    async createCard(request) {
      squareCardCalls.push(request);
      return {
        card: {
          id: "ccof:test-card",
          card_brand: "VISA",
          last_4: "4242",
          exp_month: 12,
          exp_year: 2030,
        },
      };
    },
  };

  const { result } = await runSaga(createRequest(), {
    squareCustomers: trackingSquareCustomers,
    squareCards: trackingSquareCards,
  });

  assert.equal(assertSuccess(result).bookingStatus, "booked");
  assert.equal(squareCustomerCalls.length, 1);
  assert.equal(squareCardCalls.length, 1);

  const customerRequest = squareCustomerCalls[0] as { idempotency_key: string };
  const cardRequest = squareCardCalls[0] as { idempotency_key: string };

  assert.equal(
    customerRequest.idempotency_key,
    "card-on-file:customer:hold-internal-1",
  );
  assert.equal(
    cardRequest.idempotency_key,
    "card-on-file:card:hold-internal-1",
  );
  assert.ok(!customerRequest.idempotency_key.includes("idem-key-1"));
  assert.ok(!cardRequest.idempotency_key.includes("idem-key-1"));
});

test("stores real Square card id and recovers it on retry with a different client idempotency key", async () => {
  const squareCardCalls: unknown[] = [];
  const trackingSquareCards: SquareCardGateway = {
    async createCard(request) {
      squareCardCalls.push(request);
      return {
        card: {
          id: "ccof:test-card",
          card_brand: "VISA",
          last_4: "4242",
          exp_month: 12,
          exp_year: 2030,
        },
      };
    },
  };

  const { repository, state } = createFakeRepository();

  const first = await runSaga(createRequest(), {
    repository,
    squareCards: trackingSquareCards,
  });
  assert.equal(assertSuccess(first.result).bookingStatus, "booked");
  assert.equal(state.paymentMethods[0].squareCardId, "ccof:test-card");

  const second = await runSaga(
    createRequest({ idempotencyKey: `retry-key-${++retryIdempotencyCounter}` }),
    {
      repository,
      squareCards: trackingSquareCards,
      initialHolds: state.holds,
    },
  );

  assert.equal(assertSuccess(second.result).bookingStatus, "booked");
  assert.equal(state.paymentMethods.length, 1);
  assert.equal(squareCardCalls.length, 1);
});

test("checkpoint does not store sensitive card input tokens", async () => {
  const { state } = await runSaga(createRequest());

  const checkpoint = (state.holds[0].reconciliationMetadata
    ?.cardOnFileProgress ?? {}) as Record<string, unknown>;

  assert.equal(checkpoint.sourceId, undefined);
  assert.equal(checkpoint.verificationToken, undefined);
  assert.equal(checkpoint.squareCardId, "ccof:test-card");
  assert.equal(
    checkpoint.squareCustomerId,
    "square-cust-card-on-file:customer:hold-internal-1",
  );
});

test("hold-wide in-progress marker blocks a different client idempotency key even after first request finishes partially", async () => {
  const { repository, state } = createFakeRepository();

  repository.markHoldBookedWithConfirmation = async (input) => {
    const hold = state.holds.find((h) => h.id === input.holdId);
    if (!hold) throw new Error("Hold not found");
    // Intentionally leave the in-progress marker in place to simulate a failure
    // before the terminal success marker is cleared.
    throw new Error("Database write failed");
  };

  const first = await runSaga(createRequest({ idempotencyKey: "idem-key-a" }), {
    repository,
  });
  assert.equal(first.result.ok, false);

  const second = await runSaga(
    createRequest({ idempotencyKey: "idem-key-b" }),
    {
      repository,
      initialHolds: state.holds,
    },
  );

  assert.equal(second.result.ok, false);
  if (!second.result.ok) {
    assert.equal(second.result.error, "infrastructure_error");
  }
});

test("stale original attempt cannot overwrite retry's terminal confirmation", async () => {
  const { repository, state } = createFakeRepository();

  // First request begins and leaves a stale marker that has expired.
  const staleNow = new Date(now.getTime() - 60_000);
  const firstBegin = await repository.beginCardOnFileConfirmation({
    publicReference: "hold_public_1",
    idempotencyKey: "stale-key",
    now: staleNow,
  });
  assert.equal(firstBegin.status, "available");

  // Retry begins with a fresh key while the stale marker is no longer active.
  const retryBegin = await repository.beginCardOnFileConfirmation({
    publicReference: "hold_public_1",
    idempotencyKey: "retry-key",
    now,
  });
  assert.equal(retryBegin.status, "available");

  // Retry completes the terminal confirmation.
  const retryConfirmation: ExistingCardOnFileConfirmation = {
    bookingStatus: "booked",
    card: { brand: "VISA", expMonth: 12, expYear: 2030, last4: "4242" },
    holdReference: "hold_public_1",
    noShowChargeStatus: "ready",
  };
  await repository.markHoldBookedWithConfirmation({
    holdId: "hold-internal-1",
    savedPaymentMethodId: "pm-1",
    policyAcceptanceId: "policy-1",
    noShowChargeRecordId: "nsr-1",
    squareCustomerId: "sq-cust-1",
    squareCardId: "sq-card-1",
    noShowChargeStatus: "ready",
    googleEventId: "event-1",
    idempotencyKey: "retry-key",
    confirmation: retryConfirmation,
    now,
  });

  assert.equal(state.holds[0].state, "booked");
  assert.equal(
    (
      state.holds[0].reconciliationMetadata?.cardOnFileConfirmation as
        | ExistingCardOnFileConfirmation
        | undefined
    )?.holdReference,
    "hold_public_1",
  );

  // Stale original now tries to finalize. It must not overwrite.
  const staleConfirmation: ExistingCardOnFileConfirmation = {
    bookingStatus: "manual_followup",
    card: { brand: "VISA", expMonth: 12, expYear: 2030, last4: "4242" },
    holdReference: "hold_public_1",
    noShowChargeStatus: "manual_followup",
  };

  await assert.rejects(
    async () =>
      repository.markHoldBookedWithConfirmation({
        holdId: "hold-internal-1",
        savedPaymentMethodId: "pm-stale",
        policyAcceptanceId: "policy-stale",
        noShowChargeRecordId: "nsr-stale",
        squareCustomerId: "sq-cust-stale",
        squareCardId: "sq-card-stale",
        noShowChargeStatus: "manual_followup",
        googleEventId: "event-stale",
        idempotencyKey: "stale-key",
        confirmation: staleConfirmation,
        now,
      }),
    /Terminal confirmation already exists/,
  );

  // Confirm the retry's terminal state remains intact.
  assert.equal(state.holds[0].state, "booked");
  assert.equal(
    (
      state.holds[0].reconciliationMetadata?.cardOnFileConfirmation as
        | ExistingCardOnFileConfirmation
        | undefined
    )?.bookingStatus,
    "booked",
  );
  assert.equal(state.holds[0].googleEventId, "event-1");
});

test("no-show instrument returning provider_draft_created books appointment and records Square draft status", async () => {
  const instrumentCalls: unknown[] = [];
  const draftingInstrument: NoShowInstrumentStep = {
    async createInstrument(input) {
      instrumentCalls.push(input);
      return { status: "provider_draft_created" };
    },
  };

  const { result, state } = await runSaga(createRequest(), {
    noShowInstrumentStep: draftingInstrument,
  });

  const success = assertSuccess(result);
  assert.equal(success.bookingStatus, "booked");
  assert.equal(success.noShowChargeStatus, "provider_draft_created");
  assert.equal(state.noShowRecords[0].status, "provider_draft_created");
  assert.equal(state.calendarCalls.length, 0);
  assert.equal(instrumentCalls.length, 1);
  const instrumentInput = instrumentCalls[0] as {
    customerEmail: string;
    holdId: string;
  };
  assert.equal(instrumentInput.customerEmail, "client@example.com");
  assert.equal(instrumentInput.holdId, "hold-internal-1");
});

test("no-show instrument throwing NoShowInvoiceBlockedError blocks booking and marks manual_followup", async () => {
  const calendarCalls: unknown[] = [];
  const trackingCalendar: CardOnFileCalendarFinalizer = {
    async finalize(input) {
      calendarCalls.push(input);
      return { ok: true, googleEventId: `event-${input.hold.id}` };
    },
  };

  const blockingInstrument: NoShowInstrumentStep = {
    async createInstrument() {
      throw new NoShowInvoiceBlockedError(
        "Square invoice creation required but failed",
      );
    },
  };

  const { result, state } = await runSaga(createRequest(), {
    noShowInstrumentStep: blockingInstrument,
    calendarFinalizer: trackingCalendar,
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error, "infrastructure_error");
  }

  assert.equal(state.noShowRecords[0].status, "manual_followup");
  assert.equal(state.holds[0].state, "held");
  assert.equal(calendarCalls.length, 0);
  assert.equal(state.alertCalls.length, 1);
  const alert = state.alertCalls[0] as { category: string; severity: string };
  assert.equal(alert.category, "stuck_payment_state");
  assert.equal(alert.severity, "error");
});

test("no-show instrument deliberately returning manual_followup allows booking to proceed", async () => {
  const manualInstrument: NoShowInstrumentStep = {
    async createInstrument() {
      return { status: "manual_followup" };
    },
  };

  const { result, state } = await runSaga(createRequest(), {
    noShowInstrumentStep: manualInstrument,
  });

  const success = assertSuccess(result);
  assert.equal(success.bookingStatus, "booked");
  assert.equal(success.noShowChargeStatus, "manual_followup");
  assert.equal(state.noShowRecords[0].status, "manual_followup");
  assert.equal(state.holds[0].state, "booked");
});

test("alert context includes newly-created Square card id when checkpoint persistence fails after Square card creation", async () => {
  const { repository, state } = createFakeRepository();

  repository.saveCardOnFileProgress = async () => {
    throw new Error("Database write failed");
  };

  const { result } = await runSaga(createRequest(), { repository });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error, "infrastructure_error");
  }

  const alert = state.alertCalls.find(
    (a) => (a as { category: string }).category === "stuck_payment_state",
  ) as
    | { category: string; severity: string; context: Record<string, unknown> }
    | undefined;

  assert.ok(alert, "Expected stuck_payment_state alert");
  assert.equal(alert.context.holdId, "hold-internal-1");
  assert.equal(alert.context.holdReference, "hold_public_1");
  assert.equal(alert.context.squareCardId, "ccof:test-card");
  assert.equal(alert.context.sourceId, undefined);
  assert.equal(alert.context.verificationToken, undefined);
});

test("malformed checkpoint card details fall back to new Square create and do not persist invalid values", async () => {
  const { repository, state } = createFakeRepository();

  const hold = state.holds[0];
  hold.reconciliationMetadata = {
    ...hold.reconciliationMetadata,
    cardOnFileProgress: {
      squareCardId: "orphan-square-card-1",
      card: { brand: "", last4: "42", expMonth: 13, expYear: "not-a-year" },
    },
  };

  const squareCardCalls: unknown[] = [];
  const trackingSquareCards: SquareCardGateway = {
    async createCard(request) {
      squareCardCalls.push(request);
      return {
        card: {
          id: "ccof:test-card",
          card_brand: "VISA",
          last_4: "4242",
          exp_month: 12,
          exp_year: 2030,
        },
      };
    },
  };

  const { result } = await runSaga(createRequest(), {
    repository,
    squareCards: trackingSquareCards,
  });

  const success = assertSuccess(result);
  assert.equal(success.bookingStatus, "booked");
  assert.equal(state.paymentMethods.length, 1);
  assert.equal(state.paymentMethods[0].brand, "VISA");
  assert.equal(state.paymentMethods[0].last4, "4242");
  assert.equal(state.paymentMethods[0].expMonth, 12);
  assert.equal(state.paymentMethods[0].expYear, 2030);
  assert.equal(squareCardCalls.length, 1);
});

test("malformed checkpoint card details return square_api_error when fallback Square create fails", async () => {
  const { repository, state } = createFakeRepository();

  const hold = state.holds[0];
  hold.reconciliationMetadata = {
    ...hold.reconciliationMetadata,
    cardOnFileProgress: {
      squareCardId: "orphan-square-card-1",
      card: { brand: "MASTERCARD", last4: "abc", expMonth: 0, expYear: 1999 },
    },
  };

  const failingSquareCards: SquareCardGateway = {
    async createCard() {
      throw new Error("Square card save failed");
    },
  };

  const { result } = await runSaga(createRequest(), {
    repository,
    squareCards: failingSquareCards,
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error, "square_api_error");
  }

  assert.equal(state.paymentMethods.length, 0);
});

test("malformed non-empty checkpoint squareCardId falls back to new Square create and does not persist invalid provider id", async () => {
  const { repository, state } = createFakeRepository();

  const hold = state.holds[0];
  hold.reconciliationMetadata = {
    ...hold.reconciliationMetadata,
    cardOnFileProgress: {
      squareCardId: "not-a-square-card-id",
      card: { brand: "VISA", last4: "4242", expMonth: 12, expYear: 2030 },
    },
  };

  const squareCardCalls: unknown[] = [];
  const trackingSquareCards: SquareCardGateway = {
    async createCard(request) {
      squareCardCalls.push(request);
      return {
        card: {
          id: "ccof:test-card",
          card_brand: "VISA",
          last_4: "4242",
          exp_month: 12,
          exp_year: 2030,
        },
      };
    },
  };

  const { result } = await runSaga(createRequest(), {
    repository,
    squareCards: trackingSquareCards,
  });

  const success = assertSuccess(result);
  assert.equal(success.bookingStatus, "booked");
  assert.equal(state.paymentMethods.length, 1);
  assert.equal(state.paymentMethods[0].squareCardId, "ccof:test-card");
  assert.notEqual(state.paymentMethods[0].squareCardId, "not-a-square-card-id");
  assert.equal(squareCardCalls.length, 1);
});

test("invalid checkpoint squareCardId values fall back to new Square create and are not persisted", async (t) => {
  const invalidCases: Array<{ label: string; squareCardId: unknown }> = [
    { label: "empty string", squareCardId: "" },
    { label: "whitespace only", squareCardId: "   " },
    { label: "non-string value", squareCardId: 12345 },
  ];

  for (const { label, squareCardId } of invalidCases) {
    await t.test(label, async () => {
      const { repository, state } = createFakeRepository();

      const hold = state.holds[0];
      hold.reconciliationMetadata = {
        ...hold.reconciliationMetadata,
        cardOnFileProgress: {
          squareCardId,
          card: { brand: "VISA", last4: "4242", expMonth: 12, expYear: 2030 },
        },
      };

      const squareCardCalls: unknown[] = [];
      const trackingSquareCards: SquareCardGateway = {
        async createCard(request) {
          squareCardCalls.push(request);
          return {
            card: {
              id: "ccof:test-card",
              card_brand: "VISA",
              last_4: "4242",
              exp_month: 12,
              exp_year: 2030,
            },
          };
        },
      };

      const { result } = await runSaga(createRequest(), {
        repository,
        squareCards: trackingSquareCards,
      });

      const success = assertSuccess(result);
      assert.equal(success.bookingStatus, "booked");
      assert.equal(state.paymentMethods.length, 1);
      assert.equal(state.paymentMethods[0].squareCardId, "ccof:test-card");
      assert.equal(squareCardCalls.length, 1);
    });
  }
});

test("empty checkpoint squareCardId returns square_api_error when fallback Square create fails", async () => {
  const { repository, state } = createFakeRepository();

  const hold = state.holds[0];
  hold.reconciliationMetadata = {
    ...hold.reconciliationMetadata,
    cardOnFileProgress: {
      squareCardId: "",
      card: { brand: "VISA", last4: "4242", expMonth: 12, expYear: 2030 },
    },
  };

  const failingSquareCards: SquareCardGateway = {
    async createCard() {
      throw new Error("Square card save failed");
    },
  };

  const { result } = await runSaga(createRequest(), {
    repository,
    squareCards: failingSquareCards,
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error, "square_api_error");
  }

  assert.equal(state.paymentMethods.length, 0);
});

function createInstrumentRepository(options: { failUpdate?: boolean } = {}): {
  repository: CreateDraftNoShowInvoiceRepository;
  records: Array<{
    id: string;
    status: NoShowChargeStatus;
    squareInvoiceId?: string;
    squareOrderId?: string;
    squarePaymentId?: string;
    providerStatus?: string;
    providerFailureReason?: string;
    providerMetadata?: Record<string, unknown>;
  }>;
  updateCalls: unknown[];
} {
  const records = [
    { id: "nsr-local-1", status: "ready" as NoShowChargeStatus },
  ] as Array<{
    id: string;
    status: NoShowChargeStatus;
    squareInvoiceId?: string;
    squareOrderId?: string;
    squarePaymentId?: string;
    providerStatus?: string;
    providerFailureReason?: string;
    providerMetadata?: Record<string, unknown>;
  }>;
  const updateCalls: unknown[] = [];

  return {
    repository: {
      async updateNoShowChargeRecord(update: {
        noShowChargeRecordId: string;
        status?: NoShowChargeStatus;
        squareInvoiceId?: string;
        squareOrderId?: string;
        squarePaymentId?: string;
        providerStatus?: string;
        providerFailureReason?: string;
        providerMetadata?: Record<string, unknown>;
      }) {
        updateCalls.push(update);
        if (options.failUpdate) {
          throw new Error("Database write failed");
        }
        const record = records.find(
          (r) => r.id === update.noShowChargeRecordId,
        );
        if (record === undefined) throw new Error("Record not found");
        if (update.status !== undefined) record.status = update.status;
        if (update.squareInvoiceId !== undefined)
          record.squareInvoiceId = update.squareInvoiceId;
        if (update.squareOrderId !== undefined)
          record.squareOrderId = update.squareOrderId;
        if (update.squarePaymentId !== undefined)
          record.squarePaymentId = update.squarePaymentId;
        if (update.providerStatus !== undefined)
          record.providerStatus = update.providerStatus;
        if (update.providerFailureReason !== undefined)
          record.providerFailureReason = update.providerFailureReason;
        if (update.providerMetadata !== undefined)
          record.providerMetadata = update.providerMetadata;
        return { id: record.id, status: record.status };
      },
    },
    records,
    updateCalls,
  };
}

function createInstrumentSquareInvoices(
  options: {
    fail?: boolean;
    failInvoice?: boolean;
    invoiceStatus?: string;
    failDelete?: boolean;
    invoiceId?: string;
    orderId?: string;
  } = {},
): {
  client: SquareInvoicesClient;
  deleteCalls: Array<{ invoiceId: string; version?: number }>;
} {
  const deleteCalls: Array<{ invoiceId: string; version?: number }> = [];

  return {
    client: {
      async createOrder(request) {
        if (options.fail) {
          throw new Error("Square order creation failed");
        }
        return {
          order: {
            id: options.orderId ?? "order_123",
            location_id: request.order.location_id,
          },
        };
      },
      async createInvoice(request) {
        if (options.fail || options.failInvoice) {
          throw new Error("Square invoice creation failed");
        }
        return {
          invoice: {
            id: options.invoiceId ?? "invoice_123",
            status: options.invoiceStatus ?? "DRAFT",
            order_id: request.invoice.order_id,
            version: 1,
          },
        };
      },
      async publishInvoice() {
        throw new Error("Publish not expected");
      },
      async getInvoice() {
        throw new Error("Get invoice not expected");
      },
      async deleteInvoice(invoiceId, version) {
        deleteCalls.push({ invoiceId, version });
        if (options.failDelete) {
          throw new Error("Square delete invoice failed");
        }
      },
    },
    deleteCalls,
  };
}

function createInstrumentAlerts(calls: unknown[]): ServicePaymentAlertLogger {
  return {
    alert(input) {
      calls.push(input);
    },
  };
}

test("instrument with local fallback enabled returns manual_followup when Square draft creation fails", async () => {
  const { repository, records, updateCalls } = createInstrumentRepository();
  const alertCalls: unknown[] = [];
  const { client } = createInstrumentSquareInvoices({ fail: true });
  const step = createCardOnFileNoShowInstrumentStep({
    allowLocalFallback: true,
    locationId: "LOC123",
    repository,
    squareInvoices: client,
    alerts: createInstrumentAlerts(alertCalls),
  });

  const result = await step.createInstrument({
    noShowChargeRecordId: "nsr-local-1",
    holdId: "hold-internal-1",
    squareCustomerId: "sq-cust-1",
    squareCardId: "sq-card-1",
    customerEmail: "client@example.com",
    maxChargeCents: 15000,
    currency: "CAD",
    idempotencyKey: "instrument-idem-1",
    serviceDescription: "Classic Fill",
  });

  assert.equal(result.status, "manual_followup");
  assert.equal(records[0].status, "manual_followup");
  assert.equal(updateCalls.length, 1);
  assert.equal(alertCalls.length, 1);
  const alert = alertCalls[0] as { category: string; severity: string };
  assert.equal(alert.category, "no_show_charge_failed");
  assert.equal(alert.severity, "warning");
});

test("instrument with local fallback disabled throws blocked when Square draft creation fails", async () => {
  const { repository, updateCalls } = createInstrumentRepository();
  const alertCalls: unknown[] = [];
  const { client } = createInstrumentSquareInvoices({ fail: true });
  const step = createCardOnFileNoShowInstrumentStep({
    allowLocalFallback: false,
    locationId: "LOC123",
    repository,
    squareInvoices: client,
    alerts: createInstrumentAlerts(alertCalls),
  });

  await assert.rejects(
    async () =>
      step.createInstrument({
        noShowChargeRecordId: "nsr-local-1",
        holdId: "hold-internal-1",
        squareCustomerId: "sq-cust-1",
        squareCardId: "sq-card-1",
        customerEmail: "client@example.com",
        maxChargeCents: 15000,
        currency: "CAD",
        idempotencyKey: "instrument-idem-1",
        serviceDescription: "Classic Fill",
      }),
    (error: Error) => {
      assert.equal(error.name, "NoShowInvoiceBlockedError");
      return true;
    },
  );

  assert.equal(updateCalls.length, 0);
});

test("instrument blocks booking and deletes DRAFT invoice when local persistence fails", async () => {
  const { repository, records, updateCalls } = createInstrumentRepository({
    failUpdate: true,
  });
  const alertCalls: unknown[] = [];
  const { client, deleteCalls } = createInstrumentSquareInvoices();
  const step = createCardOnFileNoShowInstrumentStep({
    allowLocalFallback: true,
    locationId: "LOC123",
    repository,
    squareInvoices: client,
    alerts: createInstrumentAlerts(alertCalls),
  });

  await assert.rejects(
    async () =>
      step.createInstrument({
        noShowChargeRecordId: "nsr-local-1",
        holdId: "hold-internal-1",
        squareCustomerId: "sq-cust-1",
        squareCardId: "sq-card-1",
        customerEmail: "client@example.com",
        maxChargeCents: 15000,
        currency: "CAD",
        idempotencyKey: "instrument-idem-1",
        serviceDescription: "Classic Fill",
      }),
    (error: Error) => {
      assert.equal(error.name, "NoShowInvoiceBlockedError");
      return true;
    },
  );

  assert.equal(updateCalls.length, 1);
  assert.equal(records[0].status, "ready");
  assert.equal(deleteCalls.length, 1);
  assert.equal(deleteCalls[0].invoiceId, "invoice_123");
  assert.equal(deleteCalls[0].version, 1);
  assert.equal(alertCalls.length, 0);
});

test("instrument blocks booking even when delete compensation fails after persistence failure", async () => {
  const { repository, updateCalls } = createInstrumentRepository({
    failUpdate: true,
  });
  const alertCalls: unknown[] = [];
  const { client, deleteCalls } = createInstrumentSquareInvoices({
    failDelete: true,
  });
  const step = createCardOnFileNoShowInstrumentStep({
    allowLocalFallback: true,
    locationId: "LOC123",
    repository,
    squareInvoices: client,
    alerts: createInstrumentAlerts(alertCalls),
  });

  await assert.rejects(
    async () =>
      step.createInstrument({
        noShowChargeRecordId: "nsr-local-1",
        holdId: "hold-internal-1",
        squareCustomerId: "sq-cust-1",
        squareCardId: "sq-card-1",
        customerEmail: "client@example.com",
        maxChargeCents: 15000,
        currency: "CAD",
        idempotencyKey: "instrument-idem-1",
        serviceDescription: "Classic Fill",
      }),
    (error: Error) => {
      assert.equal(error.name, "NoShowInvoiceBlockedError");
      return true;
    },
  );

  assert.equal(updateCalls.length, 1);
  assert.equal(deleteCalls.length, 1);
});

test("instrument preserves provider context in outer saga alert when persistence fails after DRAFT invoice creation", async () => {
  const { repository, records, updateCalls } = createInstrumentRepository({
    failUpdate: true,
  });
  const alertCalls: unknown[] = [];
  const { client, deleteCalls } = createInstrumentSquareInvoices({
    invoiceId: "draft_invoice_456",
    orderId: "draft_order_456",
    failDelete: true,
  });
  const step = createCardOnFileNoShowInstrumentStep({
    allowLocalFallback: true,
    locationId: "LOC123",
    repository,
    squareInvoices: client,
    alerts: createInstrumentAlerts(alertCalls),
  });

  await assert.rejects(
    async () =>
      step.createInstrument({
        noShowChargeRecordId: "nsr-local-1",
        holdId: "hold-internal-1",
        squareCustomerId: "sq-cust-1",
        squareCardId: "sq-card-1",
        customerEmail: "client@example.com",
        maxChargeCents: 15000,
        currency: "CAD",
        idempotencyKey: "instrument-idem-1",
        serviceDescription: "Classic Fill",
      }),
    (error: Error) => {
      assert.equal(error.name, "NoShowInvoiceBlockedError");
      const blocked = error as Error & { context?: Record<string, unknown> };
      assert.equal(blocked.context?.squareInvoiceId, "draft_invoice_456");
      assert.equal(blocked.context?.squareOrderId, "draft_order_456");
      assert.equal(blocked.context?.providerStatus, "DRAFT");
      assert.equal(blocked.context?.deleteFailed, true);
      return true;
    },
  );

  assert.equal(updateCalls.length, 1);
  assert.equal(deleteCalls.length, 1);
  assert.equal(records[0].status, "ready");
});

test("instrument preserves provider context when invoice creation fails after order and persistence also fails", async () => {
  const { repository, records, updateCalls } = createInstrumentRepository({
    failUpdate: true,
  });
  const alertCalls: unknown[] = [];
  const { client } = createInstrumentSquareInvoices({
    orderId: "orphan_order_789",
    failInvoice: true,
  });
  const step = createCardOnFileNoShowInstrumentStep({
    allowLocalFallback: true,
    locationId: "LOC123",
    repository,
    squareInvoices: client,
    alerts: createInstrumentAlerts(alertCalls),
  });

  await assert.rejects(
    async () =>
      step.createInstrument({
        noShowChargeRecordId: "nsr-local-1",
        holdId: "hold-internal-1",
        squareCustomerId: "sq-cust-1",
        squareCardId: "sq-card-1",
        customerEmail: "client@example.com",
        maxChargeCents: 15000,
        currency: "CAD",
        idempotencyKey: "instrument-idem-1",
        serviceDescription: "Classic Fill",
      }),
    (error: Error) => {
      assert.equal(error.name, "NoShowInvoiceBlockedError");
      const blocked = error as Error & { context?: Record<string, unknown> };
      assert.equal(blocked.context?.squareOrderId, "orphan_order_789");
      assert.equal(blocked.context?.squareInvoiceId, undefined);
      return true;
    },
  );

  assert.equal(updateCalls.length, 1);
  assert.equal(records[0].status, "ready");
});

test("outer saga alert includes safe provider context when no-show invoice is blocked with provider refs", async () => {
  const instrumentRepository = createInstrumentRepository();
  const alertCalls: unknown[] = [];
  const { client } = createInstrumentSquareInvoices({
    invoiceId: "blocked_invoice_111",
    orderId: "blocked_order_111",
    invoiceStatus: "UNPAID",
  });

  const instrumentStep = createCardOnFileNoShowInstrumentStep({
    allowLocalFallback: true,
    locationId: "LOC123",
    repository: instrumentRepository.repository,
    squareInvoices: client,
    alerts: createInstrumentAlerts([]),
  });

  const { repository, state } = createFakeRepository();
  repository.updateNoShowChargeRecord = async (input) => {
    const record = state.noShowRecords.find(
      (r) => r.id === input.noShowChargeRecordId,
    );
    if (!record) throw new Error("No-show record not found");
    if (input.status !== undefined) record.status = input.status;
    if (input.squareInvoiceId !== undefined)
      record.squareInvoiceId = input.squareInvoiceId;
    if (input.squareOrderId !== undefined)
      record.squareOrderId = input.squareOrderId;
    if (input.providerStatus !== undefined)
      record.providerStatus = input.providerStatus;
    return { id: record.id, status: record.status };
  };

  const { result, state: finalState } = await runSaga(createRequest(), {
    repository,
    noShowInstrumentStep: instrumentStep,
    alerts: createInstrumentAlerts(alertCalls),
  });

  if (result.ok) {
    assert.fail(`Expected failure but got success: ${JSON.stringify(result)}`);
  }
  assert.equal(result.error, "infrastructure_error");

  assert.equal(finalState.noShowRecords.length, 1);
  const noShowRecord = finalState.noShowRecords[0];
  assert.equal(noShowRecord.status, "manual_followup");
  assert.equal(noShowRecord.squareInvoiceId, "blocked_invoice_111");
  assert.equal(noShowRecord.squareOrderId, "blocked_order_111");

  const alert = alertCalls.find(
    (a) => (a as { category: string }).category === "stuck_payment_state",
  ) as
    | {
        category: string;
        severity: string;
        message: string;
        context: Record<string, unknown>;
      }
    | undefined;
  assert.ok(alert, "Expected stuck_payment_state alert");
  assert.equal(alert.context.holdId, "hold-internal-1");
  assert.equal(alert.context.squareInvoiceId, "blocked_invoice_111");
  assert.equal(alert.context.squareOrderId, "blocked_order_111");
  assert.equal(alert.context.providerStatus, "UNPAID");
  assert.equal(alert.context.sourceId, undefined);
  assert.equal(alert.context.verificationToken, undefined);
  assert.equal(alert.context.squareCardId, undefined);
});

test("outer saga alert includes provider context when invoice creation fails after order succeeds", async () => {
  const instrumentRepository = createInstrumentRepository();
  const alertCalls: unknown[] = [];
  const { client } = createInstrumentSquareInvoices({
    orderId: "orphan_order_222",
    failInvoice: true,
  });

  const instrumentStep = createCardOnFileNoShowInstrumentStep({
    allowLocalFallback: true,
    locationId: "LOC123",
    repository: instrumentRepository.repository,
    squareInvoices: client,
    alerts: createInstrumentAlerts([]),
  });

  const { repository, state } = createFakeRepository();
  repository.updateNoShowChargeRecord = async (input) => {
    const record = state.noShowRecords.find(
      (r) => r.id === input.noShowChargeRecordId,
    );
    if (!record) throw new Error("No-show record not found");
    if (input.status !== undefined) record.status = input.status;
    if (input.squareInvoiceId !== undefined)
      record.squareInvoiceId = input.squareInvoiceId;
    if (input.squareOrderId !== undefined)
      record.squareOrderId = input.squareOrderId;
    if (input.providerStatus !== undefined)
      record.providerStatus = input.providerStatus;
    return { id: record.id, status: record.status };
  };

  const { result, state: finalState } = await runSaga(createRequest(), {
    repository,
    noShowInstrumentStep: instrumentStep,
    alerts: createInstrumentAlerts(alertCalls),
  });

  if (result.ok) {
    assert.fail(`Expected failure but got success: ${JSON.stringify(result)}`);
  }
  assert.equal(result.error, "infrastructure_error");

  assert.equal(finalState.noShowRecords.length, 1);
  const noShowRecord = finalState.noShowRecords[0];
  assert.equal(noShowRecord.status, "manual_followup");
  assert.equal(noShowRecord.squareOrderId, "orphan_order_222");

  const alert = alertCalls.find(
    (a) => (a as { category: string }).category === "stuck_payment_state",
  ) as
    | {
        category: string;
        severity: string;
        message: string;
        context: Record<string, unknown>;
      }
    | undefined;
  assert.ok(alert, "Expected stuck_payment_state alert");
  assert.equal(alert.context.holdId, "hold-internal-1");
  assert.equal(alert.context.squareOrderId, "orphan_order_222");
  assert.equal(alert.context.squareInvoiceId, undefined);
  assert.equal(alert.context.providerStatus, "invoice_creation_failed");
  assert.equal(alert.context.sourceId, undefined);
  assert.equal(alert.context.verificationToken, undefined);
  assert.equal(alert.context.squareCardId, undefined);
});

test("outer saga alert includes provider context when persistence fails after DRAFT invoice creation", async () => {
  const instrumentRepository = createInstrumentRepository({ failUpdate: true });
  const alertCalls: unknown[] = [];
  const { client } = createInstrumentSquareInvoices({
    invoiceId: "draft_invoice_333",
    orderId: "draft_order_333",
    failDelete: true,
  });

  const instrumentStep = createCardOnFileNoShowInstrumentStep({
    allowLocalFallback: true,
    locationId: "LOC123",
    repository: instrumentRepository.repository,
    squareInvoices: client,
    alerts: createInstrumentAlerts([]),
  });

  const { repository, state } = createFakeRepository();
  repository.updateNoShowChargeRecord = async (input) => {
    const record = state.noShowRecords.find(
      (r) => r.id === input.noShowChargeRecordId,
    );
    if (!record) throw new Error("No-show record not found");
    if (input.status !== undefined) record.status = input.status;
    if (input.squareInvoiceId !== undefined)
      record.squareInvoiceId = input.squareInvoiceId;
    if (input.squareOrderId !== undefined)
      record.squareOrderId = input.squareOrderId;
    if (input.providerStatus !== undefined)
      record.providerStatus = input.providerStatus;
    return { id: record.id, status: record.status };
  };

  const { result, state: finalState } = await runSaga(createRequest(), {
    repository,
    noShowInstrumentStep: instrumentStep,
    alerts: createInstrumentAlerts(alertCalls),
  });

  if (result.ok) {
    assert.fail(`Expected failure but got success: ${JSON.stringify(result)}`);
  }
  assert.equal(result.error, "infrastructure_error");

  assert.equal(finalState.noShowRecords.length, 1);
  const noShowRecord = finalState.noShowRecords[0];
  assert.equal(noShowRecord.status, "manual_followup");
  assert.equal(noShowRecord.squareInvoiceId, "draft_invoice_333");
  assert.equal(noShowRecord.squareOrderId, "draft_order_333");
  assert.equal(noShowRecord.providerStatus, "DRAFT");

  const alert = alertCalls.find(
    (a) => (a as { category: string }).category === "stuck_payment_state",
  ) as
    | {
        category: string;
        severity: string;
        message: string;
        context: Record<string, unknown>;
      }
    | undefined;
  assert.ok(alert, "Expected stuck_payment_state alert");
  assert.equal(alert.context.holdId, "hold-internal-1");
  assert.equal(alert.context.squareInvoiceId, "draft_invoice_333");
  assert.equal(alert.context.squareOrderId, "draft_order_333");
  assert.equal(alert.context.providerStatus, "DRAFT");
  assert.equal(alert.context.deleteFailed, true);
  assert.equal(alert.context.sourceId, undefined);
  assert.equal(alert.context.verificationToken, undefined);
  assert.equal(alert.context.squareCardId, undefined);
});

test("instrument does not local fallback on unexpected non-DRAFT invoice status", async () => {
  const { repository, records, updateCalls } = createInstrumentRepository();
  const alertCalls: unknown[] = [];
  const { client } = createInstrumentSquareInvoices({
    invoiceStatus: "UNPAID",
  });
  const step = createCardOnFileNoShowInstrumentStep({
    allowLocalFallback: true,
    locationId: "LOC123",
    repository,
    squareInvoices: client,
    alerts: createInstrumentAlerts(alertCalls),
  });

  await assert.rejects(
    async () =>
      step.createInstrument({
        noShowChargeRecordId: "nsr-local-1",
        holdId: "hold-internal-1",
        squareCustomerId: "sq-cust-1",
        squareCardId: "sq-card-1",
        customerEmail: "client@example.com",
        maxChargeCents: 15000,
        currency: "CAD",
        idempotencyKey: "instrument-idem-1",
        serviceDescription: "Classic Fill",
      }),
    (error: Error) => {
      assert.equal(error.name, "NoShowInvoiceBlockedError");
      return true;
    },
  );

  assert.equal(updateCalls.length, 1);
  assert.equal(records[0].status, "manual_followup");
  assert.equal(records[0].squareInvoiceId, "invoice_123");
  assert.equal(records[0].squareOrderId, "order_123");
  assert.equal(alertCalls.length, 0);
});

test("instrument blocks booking and persists squareOrderId when Square invoice creation fails after order succeeds even with local fallback enabled", async () => {
  const { repository, records, updateCalls } = createInstrumentRepository();
  const alertCalls: unknown[] = [];
  const { client } = createInstrumentSquareInvoices({ failInvoice: true });
  const step = createCardOnFileNoShowInstrumentStep({
    allowLocalFallback: true,
    locationId: "LOC123",
    repository,
    squareInvoices: client,
    alerts: createInstrumentAlerts(alertCalls),
  });

  await assert.rejects(
    async () =>
      step.createInstrument({
        noShowChargeRecordId: "nsr-local-1",
        holdId: "hold-internal-1",
        squareCustomerId: "sq-cust-1",
        squareCardId: "sq-card-1",
        customerEmail: "client@example.com",
        maxChargeCents: 15000,
        currency: "CAD",
        idempotencyKey: "instrument-idem-1",
        serviceDescription: "Classic Fill",
      }),
    (error: Error) => {
      assert.equal(error.name, "NoShowInvoiceBlockedError");
      return true;
    },
  );

  assert.equal(updateCalls.length, 1);
  const update = updateCalls[0] as {
    status: string;
    squareInvoiceId?: string;
    squareOrderId?: string;
    providerStatus?: string;
  };
  assert.equal(update.status, "manual_followup");
  assert.equal(update.squareOrderId, "order_123");
  assert.equal(update.squareInvoiceId, undefined);
  assert.equal(update.providerStatus, "invoice_creation_failed");

  assert.equal(records[0].status, "manual_followup");
  assert.equal(records[0].squareOrderId, "order_123");
  assert.equal(records[0].squareInvoiceId, undefined);
  assert.equal(alertCalls.length, 0);
});
