import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { BookingHoldRecord } from "@/lib/booking/holds";
import type {
  SquareCard,
  SquareCardsClient,
  SquareCreateCardRequest,
} from "@/lib/payments/square/cards-client";
import type {
  SquareCreateCustomerRequest,
  SquareCreateCustomerResponse,
} from "@/lib/payments/square/customers-client";
import type {
  SquareCreatePaymentRequest,
  SquareCreatePaymentResponse,
  SquareGetPaymentResponse,
  SquarePaymentsClient,
} from "@/lib/payments/square/payments-client";

import type { CardOnFileCalendarFinalizer } from "./service-card-on-file";
import type { ServicePaymentAlertLogger } from "./service-payment-alerts";
import {
  SERVICE_NO_SHOW_POLICY_TEXT,
  SERVICE_NO_SHOW_POLICY_VERSION,
  hashServiceNoShowPolicyText,
} from "./service-no-show-policy";
import type { ResolvedServicePaymentSelection } from "./service-payment-selection";
import {
  confirmChargeAndStoreBooking,
  type ChargeAndStoreBookingRequestBody,
  type ChargeAndStoreBookingResult,
  type ChargeAndStoreRepository,
  type RecordMarketingChoiceInput,
} from "./service-charge-and-store";

const selectedStart = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
selectedStart.setUTCHours(14, 0, 0, 0);
const selectedEnd = new Date(selectedStart.getTime() + 60 * 60 * 1000);
const now = new Date();

function expectedSquareIdempotencyKey(scope: string, holdId: string): string {
  const hash = createHash("sha256")
    .update(`${scope}:${holdId}`)
    .digest("hex")
    .slice(0, 32);
  return `cs:${scope}:${hash}`;
}

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
      customerStatus: "pending",
      paymentStatus: "pending",
      pricing: {
        depositAmount: 50,
        fullPrice: 130,
        currency: "CAD",
        customAmountMinimum: 50,
        customAmountMaximum: 130,
        addOnPrice: 25,
      },
      selectedAddOn: {
        key: "addon-removal",
        name: "Removal",
        description: "Gentle removal before fill",
        price: 25,
        currency: "CAD",
      },
    },
    customer: {
      name: "Pending service booking customer",
      email: "pending-service-booking@example.invalid",
      phone: "0000000000",
    },
    googleEventId: null,
    payment: null,
    createdAt: now,
    updatedAt: now,
    timezone: "America/Toronto",
    bookingType: "in-person-appointment",
    ...overrides,
  };
}

function createRequest(
  overrides: Partial<ChargeAndStoreBookingRequestBody> = {},
): ChargeAndStoreBookingRequestBody {
  return {
    customer: {
      email: "client@example.com",
      marketingOptIn: false,
      name: "Client Name",
      phone: "+14165550123",
    },
    idempotencyKey: "idem-key-1",
    payment: {
      expectedAmountCents: 5000,
      option: "deposit",
    },
    paymentSessionReference: "pay_sess_1",
    policy: {
      accepted: true,
      policyTextHash: hashServiceNoShowPolicyText(SERVICE_NO_SHOW_POLICY_TEXT),
      policyVersion: SERVICE_NO_SHOW_POLICY_VERSION,
    },
    sourceId: "cnon:card-token",
    verificationToken: "verf-token-1",
    ...overrides,
  };
}

interface FakeState {
  events: string[];
  holds: BookingHoldRecord[];
  persistCustomerAndSelectionCalls: Array<{
    holdId: string;
    customer: ChargeAndStoreBookingRequestBody["customer"];
    payment: ResolvedServicePaymentSelection;
  }>;
  policyAcceptances: Array<{
    id: string;
    holdId: string;
    policyVersion: string;
    policyTextHash: string;
    maxChargeCents: number;
    currency: "CAD";
    customerEmail: string;
    customerName: string;
    ipHash?: string;
    userAgentHash?: string;
  }>;
  squareCustomers: Array<{
    id: string;
    email: string;
    name: string;
    phone: string;
    squareCustomerId: string;
    now: Date;
  }>;
  savedPaymentMethods: Array<{
    id: string;
    squareCustomerRecordId: string;
    squareCardId: string;
    brand?: string;
    last4?: string;
    expMonth?: number;
    expYear?: number;
  }>;
  noShowRecords: Array<{
    id: string;
    holdId: string;
    savedPaymentMethodId: string;
    policyAcceptanceId: string;
    squareCustomerId: string;
    squareCardId: string;
    maxChargeCents: number;
    currency: "CAD";
    status: "ready";
  }>;
  markHoldBookedCalls: Array<{
    holdId: string;
    confirmation: Extract<ChargeAndStoreBookingResult, { ok: true }>;
    googleEventId: string;
  }>;
  markHoldManualFollowupCalls: Array<{
    holdId: string;
    confirmation: Extract<ChargeAndStoreBookingResult, { ok: true }>;
    reason: string;
  }>;
  markHoldPaymentFailedCalls: Array<{ holdId: string; reason: string }>;
  markHoldRefundRequiredCalls: Array<{
    holdId: string;
    squarePaymentId: string;
    reason: string;
  }>;
  squarePaymentCreates: Array<SquareCreatePaymentRequest>;
  squarePaymentCancels: string[];
  squarePaymentCompletes: string[];
  squarePaymentGets: string[];
  squareCardCreates: Array<SquareCreateCardRequest>;
  squareCustomerCreates: Array<SquareCreateCustomerRequest>;
  calendarFinalizeCalls: Array<{ holdId: string }>;
  alertCalls: Array<{ category: string; severity: string; message: string }>;
  sagaOrderEvents: string[];
  failPersistSavedPaymentMethodOnce: boolean;
  completePaymentReturnsNoCardId: boolean;
  missingCardIdOnCreate: boolean;
  createPaymentStatus: string;
  completePaymentStatus: string;
  getPaymentStatus: string;
  throwCompletePayment: boolean;
  throwGetPayment: boolean;
  throwCancelPayment: boolean;
  throwCreateCard: boolean;
  createPaymentId: string;
  createCardResponse?: SquareCard;
  cardBrand?: string;
  cardLast4?: string;
  cardExpMonth?: number;
  cardExpYear?: number;
}

interface FakeSquareCustomersClient {
  createCustomer: (
    request: SquareCreateCustomerRequest,
  ) => Promise<SquareCreateCustomerResponse>;
  events: string[];
}

interface FakeSquarePaymentsClient extends SquarePaymentsClient {
  events: string[];
}

interface FakeSquareCardsClient extends SquareCardsClient {
  events: string[];
}

interface FakeCalendarFinalizer extends CardOnFileCalendarFinalizer {
  events: string[];
}

interface FakeAlertLogger extends ServicePaymentAlertLogger {
  events: string[];
}

function createFakes(initialHolds: BookingHoldRecord[] = [createHold()]): {
  repository: ChargeAndStoreRepository;
  squarePayments: FakeSquarePaymentsClient;
  squareCards: FakeSquareCardsClient;
  squareCustomers: FakeSquareCustomersClient;
  calendarFinalizer: FakeCalendarFinalizer;
  alerts: FakeAlertLogger;
  state: FakeState;
} {
  const state: FakeState = {
    events: [],
    holds: initialHolds.map((hold) => ({ ...hold })),
    persistCustomerAndSelectionCalls: [],
    policyAcceptances: [],
    squareCustomers: [],
    savedPaymentMethods: [],
    noShowRecords: [],
    markHoldBookedCalls: [],
    markHoldManualFollowupCalls: [],
    markHoldPaymentFailedCalls: [],
    markHoldRefundRequiredCalls: [],
    squarePaymentCreates: [],
    squarePaymentCancels: [],
    squarePaymentCompletes: [],
    squarePaymentGets: [],
    squareCardCreates: [],
    squareCustomerCreates: [],
    calendarFinalizeCalls: [],
    alertCalls: [],
    sagaOrderEvents: [],
    failPersistSavedPaymentMethodOnce: false,
    completePaymentReturnsNoCardId: false,
    missingCardIdOnCreate: false,
    createPaymentStatus: "APPROVED",
    completePaymentStatus: "COMPLETED",
    getPaymentStatus: "COMPLETED",
    throwCompletePayment: false,
    throwGetPayment: false,
    throwCancelPayment: false,
    throwCreateCard: false,
    createPaymentId: "pay_1",
  };

  const repository: ChargeAndStoreRepository = {
    async claimPaymentAttempt(input) {
      state.events.push("claimHold");
      state.sagaOrderEvents.push("claimHold");
      const hold = state.holds.find(
        (h) => h.paymentSessionReference === input.paymentSessionReference,
      );
      if (!hold) return { status: "unavailable" };

      const metadata = (hold.reconciliationMetadata ?? {}) as Record<
        string,
        unknown
      >;
      const confirmation = metadata.chargeAndStoreConfirmation as
        | Extract<ChargeAndStoreBookingResult, { ok: true }>
        | undefined;
      if (confirmation !== undefined) {
        return { status: "confirmed", confirmation };
      }

      const inProgress = metadata.chargeAndStoreInProgress as
        | { startedAt?: string; idempotencyKey?: string }
        | undefined;
      if (
        inProgress !== undefined &&
        inProgress.idempotencyKey !== undefined &&
        inProgress.idempotencyKey !== input.idempotencyKey &&
        input.now.getTime() - new Date(inProgress.startedAt ?? 0).getTime() <
          30_000
      ) {
        return { status: "in_progress" };
      }

      hold.reconciliationMetadata = {
        ...hold.reconciliationMetadata,
        chargeAndStoreInProgress: {
          startedAt: input.now.toISOString(),
          idempotencyKey: input.idempotencyKey,
        },
      };

      return { status: "available", hold: { ...hold } };
    },

    async persistCustomerAndSelection(input) {
      state.persistCustomerAndSelectionCalls.push(input);
      state.sagaOrderEvents.push("persistCustomerAndSelection");
      const hold = state.holds.find((h) => h.id === input.holdId);
      if (hold) {
        hold.customer = {
          name: input.customer.name,
          email: input.customer.email,
          phone: input.customer.phone,
        };
        hold.offeringSnapshot = {
          ...hold.offeringSnapshot,
          selectedPayment: input.payment,
          customerStatus: "captured",
          paymentStatus: "selected",
        };
      }
    },

    async persistPolicyAcceptance(input) {
      state.events.push("persistPolicyAcceptance");
      state.sagaOrderEvents.push("persistPolicyAcceptance");
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

    async persistSquareCustomer(input) {
      state.events.push("createSquareCustomer");
      state.sagaOrderEvents.push("createSquareCustomer");
      const id = `sq-cust-local-${state.squareCustomers.length + 1}`;
      state.squareCustomers.push({
        id,
        email: input.email,
        name: input.name,
        phone: input.phone,
        squareCustomerId: input.squareCustomerId,
        now: input.now,
      });
      return { id, squareCustomerId: input.squareCustomerId };
    },

    async findSquareCustomerByEmail(email) {
      const customer = state.squareCustomers.find((c) => c.email === email);
      return customer
        ? { id: customer.id, squareCustomerId: customer.squareCustomerId }
        : null;
    },

    async persistSavedPaymentMethod(input) {
      state.events.push("persistSavedPaymentMethod");
      state.sagaOrderEvents.push("persistSavedPaymentMethod");
      if (state.failPersistSavedPaymentMethodOnce) {
        state.failPersistSavedPaymentMethodOnce = false;
        throw new Error("Database write failed");
      }
      const id = `pm-local-${state.savedPaymentMethods.length + 1}`;
      const record = {
        id,
        squareCustomerRecordId: input.squareCustomerRecordId,
        squareCardId: input.squareCardId,
        brand: input.brand,
        last4: input.last4,
        expMonth: input.expMonth,
        expYear: input.expYear,
      };
      state.savedPaymentMethods.push(record);
      return record;
    },

    async createNoShowChargeRecord(input) {
      state.events.push("createNoShowChargeRecord");
      state.sagaOrderEvents.push("createNoShowChargeRecord");
      const id = `nsr-local-${state.noShowRecords.length + 1}`;
      state.noShowRecords.push({
        id,
        holdId: input.holdId,
        savedPaymentMethodId: input.savedPaymentMethodId,
        policyAcceptanceId: input.policyAcceptanceId,
        squareCustomerId: input.squareCustomerId,
        squareCardId: input.squareCardId,
        maxChargeCents: input.maxChargeCents,
        currency: input.currency,
        status: input.status,
      });
      return { id, status: input.status };
    },

    async markHoldBooked(input) {
      state.events.push("markHoldBooked");
      state.sagaOrderEvents.push("markHoldBooked");
      state.markHoldBookedCalls.push(input);
      const hold = state.holds.find((h) => h.id === input.holdId);
      if (!hold) throw new Error("Hold not found");
      hold.state = "booked";
      hold.googleEventId = input.googleEventId;
      hold.reconciliationMetadata = {
        ...hold.reconciliationMetadata,
        chargeAndStoreConfirmation: input.confirmation,
      };
      return { ...hold };
    },

    async markHoldManualFollowup(input) {
      state.events.push("markHoldManualFollowup");
      state.sagaOrderEvents.push("markHoldManualFollowup");
      state.markHoldManualFollowupCalls.push(input);
      const hold = state.holds.find((h) => h.id === input.holdId);
      if (!hold) throw new Error("Hold not found");
      hold.state = "manual_followup";
      hold.reconciliationMetadata = {
        ...hold.reconciliationMetadata,
        chargeAndStoreConfirmation: input.confirmation,
      };
      return { ...hold };
    },

    async markHoldPaymentFailed(input) {
      state.events.push("markHoldPaymentFailed");
      state.sagaOrderEvents.push("markHoldPaymentFailed");
      state.markHoldPaymentFailedCalls.push(input);
      const hold = state.holds.find((h) => h.id === input.holdId);
      if (!hold) return;

      // Terminal-safety mirror of the real repository: a stale failure/cancel
      // path must not overwrite an already-finalized hold state.
      const terminalStatuses = new Set([
        "booked",
        "manual_followup",
        "refund_required",
      ]);
      const metadata = (hold.reconciliationMetadata ?? {}) as Record<
        string,
        unknown
      >;
      if (
        terminalStatuses.has(hold.state) ||
        metadata.chargeAndStoreConfirmation !== undefined ||
        metadata.chargeAndStoreRefundRequired !== undefined
      ) {
        return;
      }

      hold.state = "payment_failed";
      hold.failureReason = input.reason;
    },

    async markHoldRefundRequired(input) {
      state.events.push("markHoldRefundRequired");
      state.sagaOrderEvents.push("markHoldRefundRequired");
      state.markHoldRefundRequiredCalls.push(input);
      const hold = state.holds.find((h) => h.id === input.holdId);
      if (hold) {
        hold.state = "refund_required";
      }
    },
  };

  const squareCustomers: FakeSquareCustomersClient = {
    events: [],
    async createCustomer(
      request: SquareCreateCustomerRequest,
    ): Promise<SquareCreateCustomerResponse> {
      squareCustomers.events.push("createCustomer");
      state.squareCustomerCreates.push(request);
      const id = `sq-cust-${state.squareCustomers.length + 1}`;
      return {
        customer: {
          id,
        },
      };
    },
  };

  const squarePayments: FakeSquarePaymentsClient = {
    events: [],
    async createCardOnFilePayment(
      request: SquareCreatePaymentRequest,
    ): Promise<SquareCreatePaymentResponse> {
      state.events.push("createPayment");
      state.sagaOrderEvents.push("createPayment");
      squarePayments.events.push("createPayment");
      state.squarePaymentCreates.push(request);
      const paymentId = state.createPaymentId;
      return {
        payment: {
          id: paymentId,
          status: state.createPaymentStatus,
          amount_money: request.amount_money,
          version_token: "vt-1",
          card_details: state.missingCardIdOnCreate
            ? undefined
            : {
                card: {
                  id: `ccof:${request.source_id.replace(/:/g, "_")}`,
                  card_brand: state.cardBrand,
                  last_4: state.cardLast4,
                  exp_month: state.cardExpMonth,
                  exp_year: state.cardExpYear,
                },
              },
        },
      } as SquareCreatePaymentResponse;
    },
    async getPayment(paymentId: string): Promise<SquareGetPaymentResponse> {
      state.events.push("getPayment");
      state.sagaOrderEvents.push("getPayment");
      squarePayments.events.push("getPayment");
      state.squarePaymentGets.push(paymentId);
      if (state.throwGetPayment) {
        throw new Error("Square get payment failed");
      }
      return {
        payment: {
          id: paymentId,
          status: state.getPaymentStatus,
          amount_money: { amount: 5000, currency: "CAD" },
          card_details: {
            card: { id: "ccof:card-token" },
          },
        },
      } as SquareGetPaymentResponse;
    },
    async completePayment(
      paymentId: string,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _versionToken?: string,
    ): Promise<SquareGetPaymentResponse> {
      state.events.push("completePayment");
      state.sagaOrderEvents.push("completePayment");
      squarePayments.events.push("completePayment");
      state.squarePaymentCompletes.push(paymentId);
      if (state.throwCompletePayment) {
        state.throwCompletePayment = false;
        throw new Error("Square capture failed");
      }
      return {
        payment: {
          id: paymentId,
          status: state.completePaymentStatus,
          amount_money: { amount: 5000, currency: "CAD" },
          card_details: state.completePaymentReturnsNoCardId
            ? undefined
            : { card: { id: "ccof:card-token" } },
        },
      } as SquareGetPaymentResponse;
    },
    async cancelPayment(paymentId: string): Promise<SquareGetPaymentResponse> {
      state.events.push("cancelPayment");
      state.sagaOrderEvents.push("cancelPayment");
      squarePayments.events.push("cancelPayment");
      state.squarePaymentCancels.push(paymentId);
      if (state.throwCancelPayment) {
        state.throwCancelPayment = false;
        throw new Error("Square cancel payment failed");
      }
      return {
        payment: {
          id: paymentId,
          status: "CANCELED",
          amount_money: { amount: 5000, currency: "CAD" },
        },
      };
    },
  };

  const squareCards: FakeSquareCardsClient = {
    events: [],
    async createCard(
      request: SquareCreateCardRequest,
    ): Promise<{ card: SquareCard }> {
      state.events.push("createCard");
      state.sagaOrderEvents.push("createCard");
      squareCards.events.push("createCard");
      state.squareCardCreates.push(request);
      if (state.throwCreateCard) {
        state.throwCreateCard = false;
        throw new Error("Square CreateCard failed");
      }
      const response = state.createCardResponse ?? {
        id: `ccof:${request.source_id.replace(/:/g, "_")}`,
        card_brand: state.cardBrand ?? "VISA",
        last_4: state.cardLast4 ?? "0000",
        exp_month: state.cardExpMonth ?? 12,
        exp_year: state.cardExpYear ?? 2030,
      };
      return { card: response };
    },
  };

  const calendarFinalizer: FakeCalendarFinalizer = {
    events: [],
    async finalize({ hold }) {
      calendarFinalizer.events.push("finalizeCalendar");
      state.calendarFinalizeCalls.push({ holdId: hold.id });
      return { ok: true, googleEventId: "gcal-event-1" };
    },
  };

  const alerts: FakeAlertLogger = {
    events: [],
    alert(input) {
      alerts.events.push("alert");
      state.alertCalls.push(input);
    },
  };

  return {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    state,
  };
}

test("persists consent before creating Square payment", async () => {
  const {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    state,
  } = createFakes();

  const result = await confirmChargeAndStoreBooking(createRequest(), {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    now,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(state.events.slice(0, 4), [
    "claimHold",
    "persistPolicyAcceptance",
    "createSquareCustomer",
    "createPayment",
  ]);
  assert.deepEqual(state.sagaOrderEvents, [
    "claimHold",
    "persistCustomerAndSelection",
    "persistPolicyAcceptance",
    "createSquareCustomer",
    "createPayment",
    "createCard",
    "persistSavedPaymentMethod",
    "createNoShowChargeRecord",
    "completePayment",
    "markHoldBooked",
  ]);
});

test("captures payment only after Square card is created", async () => {
  const {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    state,
  } = createFakes();

  await confirmChargeAndStoreBooking(createRequest(), {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    now,
  });

  const createIndex = state.events.indexOf("createPayment");
  const createCardIndex = state.events.indexOf("createCard");
  const saveCardIndex = state.events.indexOf("persistSavedPaymentMethod");
  const noShowIndex = state.events.indexOf("createNoShowChargeRecord");
  const completeIndex = state.events.indexOf("completePayment");

  assert.ok(createIndex > -1);
  assert.ok(createCardIndex > createIndex);
  assert.ok(saveCardIndex > createCardIndex);
  assert.ok(noShowIndex > saveCardIndex);
  assert.ok(completeIndex > noShowIndex);
});

test("returns booked only after payment, card, no-show record, and calendar finalization", async () => {
  const {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    state,
  } = createFakes();

  const result = await confirmChargeAndStoreBooking(createRequest(), {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    now,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.bookingStatus, "booked");
  assert.equal(result.paymentStatus, "captured");
  assert.equal(state.savedPaymentMethods.length, 1);
  assert.equal(state.noShowRecords.length, 1);
  assert.equal(state.markHoldBookedCalls.length, 1);
  assert.equal(state.markHoldBookedCalls[0]?.googleEventId, "gcal-event-1");
});

test("records marketing choice after customer details are persisted", async () => {
  const baseHold = createHold();
  const hold = createHold({
    offeringSnapshot: {
      ...baseHold.offeringSnapshot,
      answers: [{ questionId: "allergies", answer: "No allergies" }],
      sourcePath: "/services/lash-fill/booking",
    },
  });
  const {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
  } = createFakes([hold]);

  const marketingChoices: RecordMarketingChoiceInput[] = [];
  const result = await confirmChargeAndStoreBooking(
    createRequest({
      customer: {
        email: "client@example.com",
        marketingOptIn: true,
        name: "Client Name",
        phone: "+14165550123",
      },
    }),
    {
      repository,
      squarePayments,
      squareCards,
      squareCustomers,
      calendarFinalizer,
      alerts,
      now,
      recordMarketingChoice: async (input) => {
        marketingChoices.push(input);
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(marketingChoices.length, 1);
  assert.deepEqual(marketingChoices[0], {
    answers: [{ questionId: "allergies", answer: "No allergies" }],
    bookingType: "in-person-appointment",
    consentText:
      "I would like to receive updates and offers from Lash Her by Nataliea.",
    email: "client@example.com",
    marketingOptIn: true,
    name: "Client Name",
    phone: "+14165550123",
    sourcePath: "/services/lash-fill/booking",
  });
});

test("does not block confirmation when marketing choice persistence fails", async () => {
  const baseHold = createHold();
  const hold = createHold({
    offeringSnapshot: {
      ...baseHold.offeringSnapshot,
      answers: [{ questionId: "allergies", answer: "No allergies" }],
      sourcePath: "/services/lash-fill/booking",
    },
  });
  const {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    state,
  } = createFakes([hold]);

  const result = await confirmChargeAndStoreBooking(
    createRequest({
      customer: {
        email: "client@example.com",
        marketingOptIn: true,
        name: "Client Name",
        phone: "+14165550123",
      },
    }),
    {
      repository,
      squarePayments,
      squareCards,
      squareCustomers,
      calendarFinalizer,
      alerts,
      now,
      recordMarketingChoice: async () => {
        throw new Error("Marketing store unavailable");
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(state.markHoldBookedCalls.length, 1);
});

test("continues to success before a slow marketing choice promise resolves", async () => {
  const baseHold = createHold();
  const hold = createHold({
    offeringSnapshot: {
      ...baseHold.offeringSnapshot,
      answers: [{ questionId: "allergies", answer: "No allergies" }],
      sourcePath: "/services/lash-fill/booking",
    },
  });
  const {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    state,
  } = createFakes([hold]);

  let resolveMarketing: (() => void) | undefined;
  const marketingPromise = new Promise<void>((resolve) => {
    resolveMarketing = resolve;
  });
  let marketingCalled = false;

  const result = await confirmChargeAndStoreBooking(
    createRequest({
      customer: {
        email: "client@example.com",
        marketingOptIn: true,
        name: "Client Name",
        phone: "+14165550123",
      },
    }),
    {
      repository,
      squarePayments,
      squareCards,
      squareCustomers,
      calendarFinalizer,
      alerts,
      now,
      recordMarketingChoice: async () => {
        marketingCalled = true;
        await marketingPromise;
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(state.markHoldBookedCalls.length, 1);
  assert.equal(marketingCalled, true);
  assert.equal(resolveMarketing !== undefined, true);

  resolveMarketing?.();
  await marketingPromise;
});

test("logs asynchronous marketing choice persistence failures without blocking", async () => {
  const baseHold = createHold();
  const hold = createHold({
    offeringSnapshot: {
      ...baseHold.offeringSnapshot,
      answers: [{ questionId: "allergies", answer: "No allergies" }],
      sourcePath: "/services/lash-fill/booking",
    },
  });
  const {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    state,
  } = createFakes([hold]);

  const logged: unknown[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logged.push(args);
  };

  let rejectMarketing: ((reason: Error) => void) | undefined;
  const marketingPromise = new Promise<void>((_, reject) => {
    rejectMarketing = reject;
  });

  try {
    const result = await confirmChargeAndStoreBooking(
      createRequest({
        customer: {
          email: "client@example.com",
          marketingOptIn: true,
          name: "Client Name",
          phone: "+14165550123",
        },
      }),
      {
        repository,
        squarePayments,
        squareCards,
        squareCustomers,
        calendarFinalizer,
        alerts,
        now,
        recordMarketingChoice: async () => marketingPromise,
      },
    );

    assert.equal(result.ok, true);
    assert.equal(state.markHoldBookedCalls.length, 1);

    rejectMarketing?.(new Error("Async marketing store unavailable"));
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.ok(
      logged.some(
        (args) =>
          Array.isArray(args) &&
          args.some(
            (arg: unknown) =>
              typeof arg === "string" &&
              arg.includes(
                "[booking payment] Marketing consent persistence failed",
              ),
          ),
      ),
    );

    await marketingPromise.catch(() => {
      // The production catch handler is responsible for logging; consume the
      // rejection in the test so it is not reported as unhandled.
    });
  } finally {
    console.log = originalLog;
  }
});

test("rejects unchecked consent before Square calls", async () => {
  const {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    state,
  } = createFakes();

  const result = await confirmChargeAndStoreBooking(
    createRequest({
      policy: {
        accepted: false,
        policyTextHash: "hash",
        policyVersion: "v1",
      } as never,
    }),
    {
      repository,
      squarePayments,
      squareCards,
      squareCustomers,
      calendarFinalizer,
      alerts,
      now,
    },
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "invalid_request");
  assert.equal(state.events.includes("createSquareCustomer"), false);
  assert.equal(state.events.includes("createPayment"), false);
});

test("rejects mismatched policy version before Square calls", async () => {
  const {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    state,
  } = createFakes();

  const result = await confirmChargeAndStoreBooking(
    createRequest({
      policy: {
        accepted: true,
        policyTextHash: hashServiceNoShowPolicyText(
          SERVICE_NO_SHOW_POLICY_TEXT,
        ),
        policyVersion: "old-version",
      },
    }),
    {
      repository,
      squarePayments,
      squareCards,
      squareCustomers,
      calendarFinalizer,
      alerts,
      now,
    },
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "invalid_request");
  assert.equal(state.events.includes("createSquareCustomer"), false);
  assert.equal(state.events.includes("createPayment"), false);
  assert.equal(state.events.includes("claimHold"), false);
});

test("rejects mismatched policy text hash before Square calls", async () => {
  const {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    state,
  } = createFakes();

  const result = await confirmChargeAndStoreBooking(
    createRequest({
      policy: {
        accepted: true,
        policyTextHash: "deadbeef",
        policyVersion: SERVICE_NO_SHOW_POLICY_VERSION,
      },
    }),
    {
      repository,
      squarePayments,
      squareCards,
      squareCustomers,
      calendarFinalizer,
      alerts,
      now,
    },
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "invalid_request");
  assert.equal(state.events.includes("createSquareCustomer"), false);
  assert.equal(state.events.includes("createPayment"), false);
  assert.equal(state.events.includes("claimHold"), false);
});

test("rejects client amount mismatch before Square calls", async () => {
  const {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    state,
  } = createFakes();

  const result = await confirmChargeAndStoreBooking(
    createRequest({
      payment: { expectedAmountCents: 9999, option: "deposit" },
    }),
    {
      repository,
      squarePayments,
      squareCards,
      squareCustomers,
      calendarFinalizer,
      alerts,
      now,
    },
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "invalid_request");
  assert.equal(state.events.includes("createSquareCustomer"), false);
  assert.equal(state.events.includes("createPayment"), false);
});

test("continues to success when Square payment response omits card details", async () => {
  const {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    state,
  } = createFakes();
  state.missingCardIdOnCreate = true;

  const result = await confirmChargeAndStoreBooking(createRequest(), {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    now,
  });

  assert.equal(result.ok, true);
  assert.equal(state.squarePaymentCancels.length, 0);
  assert.equal(state.squarePaymentCompletes.length, 1);
  assert.equal(state.savedPaymentMethods.length, 1);
});

test("marks refund required when Square capture throws and payment is completed", async () => {
  const {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    state,
  } = createFakes();
  state.throwCompletePayment = true;

  const result = await confirmChargeAndStoreBooking(createRequest(), {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    now,
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "square_api_error");
  assert.equal(state.markHoldRefundRequiredCalls.length, 1);
});

test("returns existing terminal confirmation for duplicate submits", async () => {
  const {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    state,
  } = createFakes();

  const first = await confirmChargeAndStoreBooking(createRequest(), {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    now,
  });

  assert.equal(first.ok, true);

  const second = await confirmChargeAndStoreBooking(createRequest(), {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    now,
  });

  assert.equal(second.ok, true);
  assert.deepEqual(second, first);
  assert.equal(state.markHoldBookedCalls.length, 1);
});

test("marks manual follow-up when calendar finalization fails after capture", async () => {
  const {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    state,
  } = createFakes();

  calendarFinalizer.finalize = async ({ hold }) => {
    state.calendarFinalizeCalls.push({ holdId: hold.id });
    return {
      ok: false,
      status: "manual_followup",
      error: "Calendar booking failed.",
    };
  };

  const result = await confirmChargeAndStoreBooking(createRequest(), {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    now,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.bookingStatus, "manual_followup");
  assert.equal(result.paymentStatus, "captured");
  assert.equal(state.markHoldManualFollowupCalls.length, 1);
  assert.equal(
    state.markHoldManualFollowupCalls[0]?.confirmation.paymentStatus,
    "captured",
  );
  assert.equal(state.markHoldBookedCalls.length, 0);
});

test("marks refund required when calendar failure and manual follow-up marker both fail", async () => {
  const {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    state,
  } = createFakes();

  calendarFinalizer.finalize = async ({ hold }) => {
    state.calendarFinalizeCalls.push({ holdId: hold.id });
    return {
      ok: false,
      status: "manual_followup",
      error: "Calendar booking failed.",
    };
  };

  repository.markHoldManualFollowup = async () => {
    throw new Error("Database write failed");
  };

  const result = await confirmChargeAndStoreBooking(createRequest(), {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    now,
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "infrastructure_error");
  assert.equal(state.markHoldRefundRequiredCalls.length, 1);
  assert.equal(state.markHoldRefundRequiredCalls[0]?.squarePaymentId, "pay_1");
  assert.equal(state.markHoldManualFollowupCalls.length, 0);
  assert.equal(
    state.holds[0]?.reconciliationMetadata?.chargeAndStoreConfirmation,
    undefined,
  );
});

test("falls back to manual follow-up when booking finalization fails after calendar success", async () => {
  const {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    state,
  } = createFakes();

  repository.markHoldBooked = async () => {
    throw new Error("Database write failed");
  };

  const result = await confirmChargeAndStoreBooking(createRequest(), {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    now,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.bookingStatus, "manual_followup");
  assert.equal(result.paymentStatus, "captured");
  assert.equal(state.markHoldManualFollowupCalls.length, 1);
  assert.equal(
    state.markHoldManualFollowupCalls[0]?.confirmation.bookingStatus,
    "manual_followup",
  );
  assert.equal(state.markHoldBookedCalls.length, 0);
});

test("marks refund required when booking and manual follow-up markers both fail after calendar success", async () => {
  const {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    state,
  } = createFakes();

  repository.markHoldBooked = async () => {
    throw new Error("Database write failed");
  };

  repository.markHoldManualFollowup = async () => {
    throw new Error("Database write failed");
  };

  const result = await confirmChargeAndStoreBooking(createRequest(), {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    now,
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "infrastructure_error");
  assert.equal(state.markHoldRefundRequiredCalls.length, 1);
  assert.equal(state.markHoldRefundRequiredCalls[0]?.squarePaymentId, "pay_1");
  assert.equal(state.markHoldManualFollowupCalls.length, 0);
  assert.equal(
    state.holds[0]?.reconciliationMetadata?.chargeAndStoreConfirmation,
    undefined,
  );
});

test("returns payment_declined when Square create payment status is not APPROVED", async () => {
  const {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    state,
  } = createFakes();
  state.createPaymentStatus = "DECLINED";

  const result = await confirmChargeAndStoreBooking(createRequest(), {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    now,
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "payment_declined");
  assert.equal(state.markHoldPaymentFailedCalls.length, 1);
  assert.equal(state.savedPaymentMethods.length, 0);
  assert.equal(state.noShowRecords.length, 0);
  assert.equal(state.squarePaymentCompletes.length, 0);
  assert.equal(state.calendarFinalizeCalls.length, 0);
});

test("sends delayed capture payload to Square with request values", async () => {
  const {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    state,
  } = createFakes();

  const request = createRequest({
    sourceId: "cnon:provided-token",
    verificationToken: "verf-provided",
  });

  await confirmChargeAndStoreBooking(request, {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    now,
  });

  assert.equal(state.squarePaymentCreates.length, 1);
  const paymentRequest = state.squarePaymentCreates[0];
  assert.equal(paymentRequest.autocomplete, false);
  assert.equal(paymentRequest.source_id, request.sourceId);
  assert.equal(paymentRequest.verification_token, request.verificationToken);
  assert.equal(
    paymentRequest.customer_id,
    state.squareCustomers[0]?.squareCustomerId,
  );
  assert.deepEqual(paymentRequest.amount_money, {
    amount: 5650,
    currency: "CAD",
  });
  assert.ok(
    paymentRequest.note?.includes("Ontario HST"),
    "Square payment note should disclose Ontario HST",
  );
  assert.equal(paymentRequest.idempotency_key, request.idempotencyKey);
});

test("charges Ontario HST on the trusted server-side payment amount while keeping no-show max on the pre-tax service amount", async () => {
  const {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    state,
  } = createFakes();

  const result = await confirmChargeAndStoreBooking(createRequest(), {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    now,
  });

  assert.equal(result.ok, true);
  assert.equal(state.squarePaymentCreates.length, 1);
  assert.equal(state.squarePaymentCreates[0]?.amount_money.amount, 5650);
  assert.ok(
    state.squarePaymentCreates[0]?.note?.includes("Ontario HST"),
    "Square payment note should disclose Ontario HST",
  );

  // The client contract remains pre-tax, and persisted service/no-show amounts
  // stay tied to the selected service amount (not the tax-inclusive total).
  assert.equal(state.persistCustomerAndSelectionCalls.length, 1);
  assert.equal(
    state.persistCustomerAndSelectionCalls[0]?.payment.amountCents,
    5000,
  );
  assert.equal(state.policyAcceptances.length, 1);
  assert.equal(state.policyAcceptances[0]?.maxChargeCents, 5000);
  assert.equal(state.noShowRecords.length, 1);
  assert.equal(state.noShowRecords[0]?.maxChargeCents, 5000);
});

test("sends CreateCard request with payment id source and Canadian billing details", async () => {
  const {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    state,
  } = createFakes();

  const request = createRequest({
    sourceId: "cnon:provided-token",
    verificationToken: "verf-provided",
  });

  await confirmChargeAndStoreBooking(request, {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    now,
  });

  assert.equal(state.squareCardCreates.length, 1);
  const cardRequest = state.squareCardCreates[0];
  assert.ok(cardRequest);
  assert.equal(cardRequest.source_id, "pay_1");
  assert.equal(cardRequest.verification_token, request.verificationToken);
  assert.equal(
    cardRequest.idempotency_key,
    expectedSquareIdempotencyKey("card", "pay_1"),
  );
  assert.equal(
    cardRequest.card.customer_id,
    state.squareCustomers[0]?.squareCustomerId,
  );
  assert.equal(cardRequest.card.cardholder_name, request.customer.name);
  assert.equal(cardRequest.card.reference_id, "hold_public_1");
  assert.equal(cardRequest.card.billing_address?.country, "CA");
});

test("keeps Square customer and card idempotency keys within 45 characters for UUID hold IDs", async () => {
  const uuidHoldId = "550e8400-e29b-41d4-a716-446655440000";
  const {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    state,
  } = createFakes([createHold({ id: uuidHoldId })]);

  const request = createRequest();

  await confirmChargeAndStoreBooking(request, {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    now,
  });

  const customerRequest = state.squareCustomerCreates[0];
  const cardRequest = state.squareCardCreates[0];
  assert.ok(customerRequest);
  assert.ok(cardRequest);

  const customerKey = customerRequest.idempotency_key;
  const cardKey = cardRequest.idempotency_key;

  assert.equal(
    customerKey,
    expectedSquareIdempotencyKey("customer", uuidHoldId),
  );
  assert.equal(cardKey, expectedSquareIdempotencyKey("card", "pay_1"));
  assert.ok(
    customerKey.length <= 45,
    `customer key length ${customerKey.length}`,
  );
  assert.ok(cardKey.length <= 45, `card key length ${cardKey.length}`);
  assert.notEqual(
    cardKey,
    expectedSquareIdempotencyKey("card", uuidHoldId),
    "CreateCard idempotency key must be derived from the Square payment id, not the hold id",
  );
});

test("derives CreateCard idempotency key from the actual Square payment id when retry produces a different payment", async () => {
  const {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    state,
  } = createFakes();

  state.createPaymentId = "pay_retry_abc123";

  await confirmChargeAndStoreBooking(createRequest(), {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    now,
  });

  const cardRequest = state.squareCardCreates[0];
  assert.ok(cardRequest);
  assert.equal(cardRequest.source_id, "pay_retry_abc123");
  assert.equal(
    cardRequest.idempotency_key,
    expectedSquareIdempotencyKey("card", "pay_retry_abc123"),
  );
  assert.ok(
    cardRequest.idempotency_key.length <= 45,
    `card key length ${cardRequest.idempotency_key.length}`,
  );
});

test("repository fake does not overwrite a booked terminal state with a stale payment failed marker", async () => {
  const { repository, state } = createFakes();

  state.holds[0] = {
    ...state.holds[0]!,
    state: "booked",
    reconciliationMetadata: {
      chargeAndStoreConfirmation: {
        ok: true,
        bookingStatus: "booked",
        holdReference: "hold_public_1",
        paymentStatus: "captured",
        card: { last4: "4242" },
      },
    },
  };

  await repository.markHoldPaymentFailed({
    holdId: "hold-internal-1",
    reason: "stale failure after booking",
    now,
  });

  assert.equal(state.holds[0]?.state, "booked");
  assert.equal(state.holds[0]?.failureReason, undefined);
});

test("repository fake does not overwrite refund_required terminal state with a stale payment failed marker", async () => {
  const { repository, state } = createFakes();

  state.holds[0] = {
    ...state.holds[0]!,
    state: "refund_required",
    reconciliationMetadata: {
      chargeAndStoreRefundRequired: {
        squarePaymentId: "pay_1",
        reason: "Capture failed",
        markedAt: now.toISOString(),
      },
    },
  };

  await repository.markHoldPaymentFailed({
    holdId: "hold-internal-1",
    reason: "stale failure after refund required",
    now,
  });

  assert.equal(state.holds[0]?.state, "refund_required");
  assert.equal(state.holds[0]?.failureReason, undefined);
});

test("repository fake still marks non-terminal holds as payment failed", async () => {
  const { repository, state } = createFakes();

  await repository.markHoldPaymentFailed({
    holdId: "hold-internal-1",
    reason: "declined",
    now,
  });

  assert.equal(state.holds[0]?.state, "payment_failed");
  assert.equal(state.holds[0]?.failureReason, "declined");
});

test("reuses existing Square customer instead of creating a new one", async () => {
  const {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    state,
  } = createFakes();
  state.squareCustomers.push({
    id: "existing-local",
    email: "client@example.com",
    name: "Existing Client",
    phone: "+14165550123",
    squareCustomerId: "sq-cust-existing",
    now,
  });

  const result = await confirmChargeAndStoreBooking(createRequest(), {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    now,
  });

  assert.equal(result.ok, true);
  assert.equal(squareCustomers.events.includes("createCustomer"), false);
  assert.equal(
    state.events.filter((e) => e === "createSquareCustomer").length,
    0,
  );
  assert.equal(state.squarePaymentCreates.length, 1);
  assert.equal(state.squarePaymentCreates[0]?.customer_id, "sq-cust-existing");
});

test("uses injected now when persisting new Square customer", async () => {
  const fixedNow = new Date("2026-06-15T12:00:00.000Z");
  const {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    state,
  } = createFakes();

  const result = await confirmChargeAndStoreBooking(createRequest(), {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    now: fixedNow,
  });

  assert.equal(result.ok, true);
  assert.equal(state.squareCustomers.length, 1);
  assert.equal(state.squareCustomers[0]?.now, fixedNow);
});

test("marks refund required when capture throws and Square status lookup fails", async () => {
  const {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    state,
  } = createFakes();
  state.throwCompletePayment = true;
  state.throwGetPayment = true;

  const result = await confirmChargeAndStoreBooking(createRequest(), {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    now,
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "square_api_error");
  assert.equal(state.markHoldRefundRequiredCalls.length, 1);
  assert.equal(state.markHoldRefundRequiredCalls[0]?.squarePaymentId, "pay_1");
  assert.equal(state.markHoldPaymentFailedCalls.length, 0);
  assert.equal(state.markHoldManualFollowupCalls.length, 0);
  assert.equal(
    state.holds[0]?.reconciliationMetadata?.chargeAndStoreConfirmation,
    undefined,
  );
  assert.equal(state.markHoldBookedCalls.length, 0);
});

test("cancels authorization and marks payment failed when capture throws with non-completed status", async () => {
  const {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    state,
  } = createFakes();
  state.throwCompletePayment = true;
  state.getPaymentStatus = "APPROVED";

  const result = await confirmChargeAndStoreBooking(createRequest(), {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    now,
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "infrastructure_error");
  assert.equal(state.squarePaymentCancels.length, 1);
  assert.equal(state.squarePaymentCancels[0], "pay_1");
  assert.equal(state.markHoldPaymentFailedCalls.length, 1);
  assert.equal(state.markHoldRefundRequiredCalls.length, 0);
  assert.equal(state.markHoldManualFollowupCalls.length, 0);
  assert.equal(
    state.holds[0]?.reconciliationMetadata?.chargeAndStoreConfirmation,
    undefined,
  );
});

test("marks refund required when capture throws with non-completed status but cancellation fails", async () => {
  const {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    state,
  } = createFakes();
  state.throwCompletePayment = true;
  state.getPaymentStatus = "APPROVED";
  state.throwCancelPayment = true;

  const result = await confirmChargeAndStoreBooking(createRequest(), {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    now,
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(state.squarePaymentCancels.length, 1);
  assert.equal(state.markHoldRefundRequiredCalls.length, 1);
  assert.equal(state.markHoldRefundRequiredCalls[0]?.squarePaymentId, "pay_1");
  assert.equal(state.markHoldPaymentFailedCalls.length, 0);
  assert.equal(state.markHoldManualFollowupCalls.length, 0);
  assert.equal(
    state.holds[0]?.reconciliationMetadata?.chargeAndStoreConfirmation,
    undefined,
  );
});

test("cancels authorization and marks payment failed when Square capture returns non-completed", async () => {
  const {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    state,
  } = createFakes();
  state.completePaymentStatus = "FAILED";

  const result = await confirmChargeAndStoreBooking(createRequest(), {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    now,
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "infrastructure_error");
  assert.equal(state.squarePaymentCancels.length, 1);
  assert.equal(state.squarePaymentCancels[0], "pay_1");
  assert.equal(state.markHoldPaymentFailedCalls.length, 1);
  assert.equal(state.markHoldRefundRequiredCalls.length, 0);
  assert.equal(
    state.holds[0]?.reconciliationMetadata?.chargeAndStoreConfirmation,
    undefined,
  );
});

test("marks refund required when Square capture returns non-completed and cancellation fails", async () => {
  const {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    state,
  } = createFakes();
  state.completePaymentStatus = "FAILED";
  state.throwCancelPayment = true;

  const result = await confirmChargeAndStoreBooking(createRequest(), {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    now,
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(state.squarePaymentCancels.length, 1);
  assert.equal(state.markHoldRefundRequiredCalls.length, 1);
  assert.equal(state.markHoldRefundRequiredCalls[0]?.squarePaymentId, "pay_1");
  assert.equal(state.markHoldPaymentFailedCalls.length, 0);
  assert.equal(
    state.holds[0]?.reconciliationMetadata?.chargeAndStoreConfirmation,
    undefined,
  );
});

test("duplicate submit after capture uncertainty does not return an authorized confirmation", async () => {
  const fakes = createFakes();
  fakes.state.throwCompletePayment = true;
  fakes.state.throwGetPayment = true;
  fakes.squarePayments.completePayment = async () => {
    throw new Error("Square capture failed");
  };

  const first = await confirmChargeAndStoreBooking(createRequest(), {
    repository: fakes.repository,
    squarePayments: fakes.squarePayments,
    squareCards: fakes.squareCards,
    squareCustomers: fakes.squareCustomers,
    calendarFinalizer: fakes.calendarFinalizer,
    alerts: fakes.alerts,
    now,
  });

  assert.equal(first.ok, false);
  assert.equal(fakes.state.markHoldRefundRequiredCalls.length, 1);

  const second = await confirmChargeAndStoreBooking(createRequest(), {
    repository: fakes.repository,
    squarePayments: fakes.squarePayments,
    squareCards: fakes.squareCards,
    squareCustomers: fakes.squareCustomers,
    calendarFinalizer: fakes.calendarFinalizer,
    alerts: fakes.alerts,
    now,
  });

  assert.equal(second.ok, false);
  assert.equal(
    fakes.state.holds[0]?.reconciliationMetadata?.chargeAndStoreConfirmation,
    undefined,
  );
});

test("marks payment failed when hold state is invalid after claim", async () => {
  const {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    state,
  } = createFakes([
    createHold({
      state: "expired",
      offeringSnapshot: {
        ...createHold().offeringSnapshot,
        customerStatus: "pending",
      },
    }),
  ]);

  const result = await confirmChargeAndStoreBooking(createRequest(), {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    now,
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "hold_unavailable");
  assert.equal(state.markHoldPaymentFailedCalls.length, 1);
});

test("marks payment failed when customer status is not pending after claim", async () => {
  const {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    state,
  } = createFakes([
    createHold({
      offeringSnapshot: {
        ...createHold().offeringSnapshot,
        customerStatus: "captured",
      },
    }),
  ]);

  const result = await confirmChargeAndStoreBooking(createRequest(), {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    now,
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "hold_unavailable");
  assert.equal(state.markHoldPaymentFailedCalls.length, 1);
});

test("marks payment failed when amount mismatch is detected after claim", async () => {
  const {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    state,
  } = createFakes();

  const result = await confirmChargeAndStoreBooking(
    createRequest({
      payment: { expectedAmountCents: 9999, option: "deposit" },
    }),
    {
      repository,
      squarePayments,
      squareCards,
      squareCustomers,
      calendarFinalizer,
      alerts,
      now,
    },
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "invalid_request");
  assert.equal(state.markHoldPaymentFailedCalls.length, 1);
});

test("marks payment failed when Square create payment throws", async () => {
  const {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    state,
  } = createFakes();
  squarePayments.createCardOnFilePayment = async () => {
    throw new Error("Square API error");
  };

  const result = await confirmChargeAndStoreBooking(createRequest(), {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    now,
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "square_api_error");
  assert.equal(state.markHoldPaymentFailedCalls.length, 1);
});

test("cancels authorization and marks payment failed when CreateCard fails", async () => {
  const {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    state,
  } = createFakes();
  state.throwCreateCard = true;

  const result = await confirmChargeAndStoreBooking(createRequest(), {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    now,
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "square_api_error");
  assert.equal(result.message, "Unable to save card with payment provider");
  assert.equal(state.squarePaymentCancels.length, 1);
  assert.equal(state.squarePaymentCompletes.length, 0);
  assert.equal(state.markHoldPaymentFailedCalls.length, 1);
  assert.equal(state.savedPaymentMethods.length, 0);
});

test("persists card display fields from CreateCard response", async () => {
  const {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    state,
  } = createFakes();
  state.createCardResponse = {
    id: "ccof:create-card-id",
    card_brand: "VISA",
    last_4: "4242",
    exp_month: 12,
    exp_year: 2030,
  };

  await confirmChargeAndStoreBooking(createRequest(), {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    now,
  });

  assert.equal(state.savedPaymentMethods.length, 1);
  const saved = state.savedPaymentMethods[0];
  assert.equal(saved?.squareCardId, "ccof:create-card-id");
  assert.equal(saved?.brand, "VISA");
  assert.equal(saved?.last4, "4242");
  assert.equal(saved?.expMonth, 12);
  assert.equal(saved?.expYear, 2030);
});

test("persists card display fields from CreateCard response when payment omits card details", async () => {
  const {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    state,
  } = createFakes();
  state.missingCardIdOnCreate = true;
  state.createCardResponse = {
    id: "ccof:create-card-id",
    card_brand: "VISA",
    last_4: "4242",
    exp_month: 12,
    exp_year: 2030,
  };

  await confirmChargeAndStoreBooking(createRequest(), {
    repository,
    squarePayments,
    squareCards,
    squareCustomers,
    calendarFinalizer,
    alerts,
    now,
  });

  assert.equal(state.savedPaymentMethods.length, 1);
  const saved = state.savedPaymentMethods[0];
  assert.equal(saved?.squareCardId, "ccof:create-card-id");
  assert.equal(saved?.brand, "VISA");
  assert.equal(saved?.last4, "4242");
  assert.equal(saved?.expMonth, 12);
  assert.equal(saved?.expYear, 2030);
});
