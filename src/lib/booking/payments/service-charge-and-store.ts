import type { BookingHoldRecord } from "@/lib/booking/holds";
import { resolveBookingModelVersion } from "@/lib/booking/booking-model-version";
import { readBookingMarketingOptInLabelSnapshot } from "@/lib/booking/operational-ui-settings";
import type {
  SquareCreateCustomerRequest,
  SquareCreateCustomerResponse,
} from "@/lib/payments/square/customers-client";
import type {
  SquareCard,
  SquareCardsClient,
} from "@/lib/payments/square/cards-client";
import type {
  SquareCreatePaymentRequest,
  SquareCreatePaymentResponse,
  SquareGetPaymentResponse,
  SquarePaymentsClient,
} from "@/lib/payments/square/payments-client";
import type { SquareInvoicesClient } from "@/lib/payments/square/invoice-client";
import {
  calculateServiceBookingHstQuote,
  SERVICE_BOOKING_HST_POLICY_VERSION,
  SERVICE_BOOKING_HST_RATE,
  SERVICE_BOOKING_HST_TAX_NAME,
} from "@/lib/booking/service-tax-policy";

import type { CardOnFileCalendarFinalizer } from "./service-card-on-file";
import type { ServicePaymentAlertLogger } from "./service-payment-alerts";
import type { SendBookingSchedulingFailureAdminEmailInput } from "@/lib/booking/email";
import {
  getCanonicalServiceNoShowPolicyEvidence,
  hashServiceNoShowPolicyText,
  SERVICE_NO_SHOW_POLICY_TEXT,
  SERVICE_NO_SHOW_POLICY_VERSION,
} from "./service-no-show-policy";
import {
  resolveServicePaymentSelection,
  type ResolvedServicePaymentSelection,
  type ServicePaymentPricingSnapshot,
} from "./service-payment-selection";
import {
  createDraftNoShowInvoice,
  type CreateDraftNoShowInvoiceRepository,
} from "./service-no-show-invoice";
import { readServicePromotionSnapshot } from "./service-promotion";

export interface ChargeAndStoreBookingRequestBody {
  customer: {
    email: string;
    marketingOptIn: boolean;
    name: string;
    phone: string;
  };
  idempotencyKey: string;
  payment: {
    customAmountCents?: number;
    expectedAmountCents: number;
    option: "deposit" | "full" | "customPartial";
  };
  paymentSessionReference: string;
  policy: {
    accepted: true;
    policyTextHash: string;
    policyVersion: string;
  };
  sourceId: string;
  verificationToken?: string;
  ipAddress?: string;
  userAgent?: string;
}

export type ChargeAndStoreBookingResult =
  | {
      ok: true;
      bookingStatus: "booked" | "manual_followup";
      holdReference: string;
      paymentStatus: "captured";
      card: {
        last4?: string;
        brand?: string;
        expMonth?: number;
        expYear?: number;
      };
    }
  | {
      ok: false;
      error:
        | "invalid_request"
        | "hold_unavailable"
        | "payment_declined"
        | "square_api_error"
        | "infrastructure_error";
      message: string;
    };

export interface CapturedChargeAndStorePaymentEvidence {
  amountCents: number;
  currency: string;
  idempotencyKey: string;
  squareOrderId?: string;
  squarePaymentId: string;
  status: "COMPLETED";
}

export interface AuthorizedChargeAndStorePaymentEvidence {
  amountCents: number;
  captureLeaseId: string;
  currency: string;
  idempotencyKey: string;
  squareOrderId?: string;
  squarePaymentId: string;
  status: "APPROVED";
  squareTeamMemberId?: string;
  versionToken?: string;
}

export interface ChargeAndStoreCardDisplay {
  brand?: string;
  expMonth?: number;
  expYear?: number;
  last4?: string;
}

export interface ChargeAndStoreRepository extends CreateDraftNoShowInvoiceRepository {
  claimPaymentAttempt(input: {
    paymentSessionReference: string;
    idempotencyKey: string;
    now: Date;
  }): Promise<
    | { status: "available"; hold: BookingHoldRecord }
    | {
        status: "confirmed";
        confirmation: Extract<ChargeAndStoreBookingResult, { ok: true }>;
        holdId?: string;
      }
    | {
        status: "captured_pending_finalization";
        card: ChargeAndStoreCardDisplay;
        hold: BookingHoldRecord;
        payment: CapturedChargeAndStorePaymentEvidence;
      }
    | {
        status: "authorized_pending_capture";
        card: ChargeAndStoreCardDisplay;
        hold: BookingHoldRecord;
        payment: AuthorizedChargeAndStorePaymentEvidence;
      }
    | { status: "in_progress" }
    | { status: "unavailable" }
  >;
  persistCustomerAndSelection(input: {
    holdId: string;
    customer: ChargeAndStoreBookingRequestBody["customer"];
    payment: ResolvedServicePaymentSelection;
    now: Date;
  }): Promise<void>;
  persistPolicyAcceptance(input: {
    holdId: string;
    policyVersion: string;
    policyTextHash: string;
    maxChargeCents: number;
    currency: "CAD";
    customerEmail: string;
    customerName: string;
    ipHash?: string;
    userAgentHash?: string;
    now: Date;
  }): Promise<{ id: string }>;
  persistSquareCustomer(input: {
    email: string;
    name: string;
    phone: string;
    squareCustomerId: string;
    now: Date;
  }): Promise<{ id: string; squareCustomerId: string }>;
  findSquareCustomerByEmail(
    email: string,
  ): Promise<{ id: string; squareCustomerId: string } | null>;
  // Idempotent by squareCardId for the same Square customer record: calling
  // this twice with the same squareCardId must return the existing saved
  // payment method without creating a duplicate.
  persistSavedPaymentMethod(input: {
    squareCustomerRecordId: string;
    squareCardId: string;
    brand?: string;
    last4?: string;
    expMonth?: number;
    expYear?: number;
    now: Date;
  }): Promise<{
    id: string;
    squareCardId: string;
    brand?: string;
    last4?: string;
    expMonth?: number;
    expYear?: number;
  }>;
  // Idempotent by (holdId, policyAcceptanceId, squareCardId): calling this
  // twice for the same hold and saved card must not create duplicate no-show
  // charge records.
  createNoShowChargeRecord(input: {
    holdId: string;
    savedPaymentMethodId: string;
    policyAcceptanceId: string;
    squareCustomerId: string;
    squareCardId: string;
    maxChargeCents: number;
    currency: "CAD";
    status: "ready";
    providerMetadata?: Record<string, unknown>;
    now: Date;
  }): Promise<{ id: string; status: "ready" }>;
  /**
   * Production repositories use this hook to durably convert a V2 hold into
   * an appointment immediately after Square capture. It is optional so
   * existing V1-only adapters and focused service fakes remain compatible.
   */
  recordCapturedOperationalPayment?(input: {
    amountCents: number;
    currency: string;
    holdId: string;
    idempotencyKey: string;
    now: Date;
    squareOrderId?: string;
    squarePaymentId: string;
  }): Promise<void>;
  /**
   * Persists the provider payment identity before capture so a retry can
   * query and complete the same Square payment instead of creating another.
   */
  recordAuthorizedOperationalPayment?(input: {
    amountCents: number;
    currency: string;
    holdId: string;
    idempotencyKey: string;
    now: Date;
    squareOrderId?: string;
    squarePaymentId: string;
    versionToken?: string;
  }): Promise<{ bookingModelVersion: 1 | 2 }>;
  prepareOperationalPaymentIntent?(input: {
    amountCents: number;
    currency: string;
    holdId: string;
    idempotencyKeyCandidate: string;
    leaseExpiresAt: Date;
    now: Date;
    referenceId: string;
    requestBodyHash: string;
    sourceIdHash: string;
    squareCustomerId: string;
    squareTeamMemberId?: string;
    verificationTokenHash?: string;
  }): Promise<
    | {
        captureLeaseId: string;
        idempotencyKey: string;
        reused: boolean;
        status: "ready";
      }
    | { idempotencyKey: string; status: "changed_request" }
    | { status: "unavailable" }
  >;
  terminateOperationalPaymentIntent?(input: {
    holdId: string;
    idempotencyKey: string;
    now: Date;
    status: "cancelled" | "failed";
  }): Promise<boolean>;
  validateOperationalCaptureLease?(input: {
    captureLeaseId: string;
    holdId: string;
    idempotencyKey: string;
    leaseExpiresAt: Date;
    now: Date;
    squarePaymentId: string;
  }): Promise<boolean>;
  markHoldBooked(input: {
    holdId: string;
    confirmation: Extract<ChargeAndStoreBookingResult, { ok: true }>;
    googleEventId: string;
    now: Date;
  }): Promise<BookingHoldRecord>;
  markHoldManualFollowup(input: {
    holdId: string;
    confirmation: Extract<ChargeAndStoreBookingResult, { ok: true }>;
    reason: string;
    now: Date;
  }): Promise<BookingHoldRecord>;
  markHoldPaymentFailed(input: {
    holdId: string;
    reason: string;
    now: Date;
  }): Promise<void>;
  markAuthorizedOperationalPaymentTerminated?(input: {
    holdId: string;
    idempotencyKey?: string;
    now: Date;
    squarePaymentId: string;
    status: "cancelled" | "failed";
  }): Promise<"cancelled" | "failed" | "capture_preserved" | "not_found">;
  markHoldRefundRequired(input: {
    holdId: string;
    idempotencyKey?: string;
    squarePaymentId: string;
    providerEvidence?: "cancellation_unconfirmed" | "completed";
    reason: string;
    now: Date;
  }): Promise<
    | void
    | { status: "refund_required" }
    | {
        status: "booking_outcome_preserved";
        confirmation?: Extract<ChargeAndStoreBookingResult, { ok: true }>;
      }
  >;
}

export interface SquareCustomerGateway {
  createCustomer(
    request: SquareCreateCustomerRequest,
  ): Promise<SquareCreateCustomerResponse>;
}

import { createHash, randomUUID } from "node:crypto";

import type { BookingAnswerInput } from "@/lib/booking/types";

export interface RecordMarketingChoiceInput {
  answers: BookingAnswerInput[];
  bookingType: string;
  consentText: string;
  email: string;
  marketingOptIn: boolean;
  name: string;
  phone: string;
  sourcePath?: string;
}

export interface ConfirmChargeAndStoreBookingDependencies {
  alerts: ServicePaymentAlertLogger;
  calendarFinalizer: CardOnFileCalendarFinalizer;
  locationId: string;
  now?: Date;
  recordMarketingChoice?: (input: RecordMarketingChoiceInput) => Promise<void>;
  repository: ChargeAndStoreRepository;
  sendBookingConfirmationEmailForHold?: (holdId: string) => Promise<void>;
  sendBookingSchedulingFailureAdminEmail?: (
    input: SendBookingSchedulingFailureAdminEmailInput,
  ) => Promise<void>;
  squareCards: SquareCardsClient;
  squareCustomers: SquareCustomerGateway;
  squareInvoices: SquareInvoicesClient;
  squarePayments: SquarePaymentsClient;
}

export const OPERATIONAL_CAPTURE_LEASE_MS = 5 * 60 * 1000;

export async function confirmChargeAndStoreBooking(
  input: ChargeAndStoreBookingRequestBody,
  dependencies: ConfirmChargeAndStoreBookingDependencies,
): Promise<ChargeAndStoreBookingResult> {
  const now = dependencies.now ?? new Date();

  const validationMessage = validateChargeAndStoreBookingRequest(input);
  if (validationMessage !== null) {
    return { ok: false, error: "invalid_request", message: validationMessage };
  }

  const canonicalPolicyHash = hashServiceNoShowPolicyText(
    SERVICE_NO_SHOW_POLICY_TEXT,
  );
  if (
    input.policy.policyVersion !== SERVICE_NO_SHOW_POLICY_VERSION ||
    input.policy.policyTextHash !== canonicalPolicyHash
  ) {
    return {
      ok: false,
      error: "invalid_request",
      message: "Policy evidence does not match the current no-show policy",
    };
  }

  let claimResult: Awaited<
    ReturnType<ChargeAndStoreRepository["claimPaymentAttempt"]>
  >;

  try {
    claimResult = await dependencies.repository.claimPaymentAttempt({
      paymentSessionReference: input.paymentSessionReference,
      idempotencyKey: input.idempotencyKey,
      now,
    });
  } catch (error) {
    await alertInfrastructureError(
      dependencies,
      "Failed to claim booking hold",
      {
        error: getErrorMessage(error),
        paymentSessionReference: input.paymentSessionReference,
      },
    );
    return {
      ok: false,
      error: "infrastructure_error",
      message: "Unable to load booking hold",
    };
  }

  if (claimResult.status === "unavailable") {
    return {
      ok: false,
      error: "hold_unavailable",
      message: "Booking hold is no longer available",
    };
  }

  if (claimResult.status === "in_progress") {
    await dependencies.alerts.alert({
      category: "stuck_payment_state",
      severity: "warning",
      message: "Charge-and-store confirmation already in progress",
      context: {
        paymentSessionReference: input.paymentSessionReference,
        idempotencyKey: input.idempotencyKey,
      },
    });
    return {
      ok: false,
      error: "infrastructure_error",
      message: "Booking confirmation is already in progress",
    };
  }

  if (claimResult.status === "confirmed") {
    if (claimResult.holdId !== undefined) {
      await sendBookingConfirmationEmailForHoldSafe(
        dependencies,
        claimResult.holdId,
      );
    }
    return claimResult.confirmation;
  }

  if (claimResult.status === "captured_pending_finalization") {
    if (
      dependencies.repository.recordCapturedOperationalPayment === undefined
    ) {
      return {
        ok: false,
        error: "infrastructure_error",
        message: "Payment was captured and is being reconciled",
      };
    }
    try {
      await dependencies.repository.recordCapturedOperationalPayment({
        amountCents: claimResult.payment.amountCents,
        currency: claimResult.payment.currency,
        holdId: claimResult.hold.id,
        idempotencyKey: claimResult.payment.idempotencyKey,
        now,
        squareOrderId: claimResult.payment.squareOrderId,
        squarePaymentId: claimResult.payment.squarePaymentId,
      });
    } catch (error) {
      await alertInfrastructureError(
        dependencies,
        "Failed to resume captured operational appointment projection",
        {
          error: getErrorMessage(error),
          holdId: claimResult.hold.id,
          squarePaymentId: claimResult.payment.squarePaymentId,
        },
      );
      return {
        ok: false,
        error: "infrastructure_error",
        message: "Payment was captured and is being reconciled",
      };
    }
    return finalizeCapturedChargeAndStoreBooking({
      card: claimResult.card,
      dependencies,
      hold: claimResult.hold,
      now,
      payment: claimResult.payment,
    });
  }

  if (claimResult.status === "authorized_pending_capture") {
    return resumeAuthorizedChargeAndStorePayment({
      card: claimResult.card,
      dependencies,
      hold: claimResult.hold,
      now,
      payment: claimResult.payment,
    });
  }

  let hold = claimResult.hold;
  const operationalBooking = resolveBookingModelVersion(hold) === 2;

  if (!isChargeAndStoreHoldAvailable(hold, now)) {
    await markHoldPaymentFailedSafe(
      dependencies,
      hold.id,
      "Booking hold is no longer available",
      now,
    );
    return {
      ok: false,
      error: "hold_unavailable",
      message: "Booking hold is no longer available",
    };
  }

  if (
    hold.offeringSnapshot.customerStatus !== "pending" &&
    !(operationalBooking && hold.offeringSnapshot.customerStatus === "captured")
  ) {
    await markHoldPaymentFailedSafe(
      dependencies,
      hold.id,
      "Booking hold customer status is not pending",
      now,
    );
    return {
      ok: false,
      error: "hold_unavailable",
      message: "Booking hold is no longer available",
    };
  }

  const pricing = readPricingSnapshot(hold.offeringSnapshot);
  if (pricing === null) {
    await markHoldPaymentFailedSafe(
      dependencies,
      hold.id,
      "Booking pricing is not configured",
      now,
    );
    return {
      ok: false,
      error: "invalid_request",
      message: "Booking pricing is not configured",
    };
  }

  const selectionResult = resolveServicePaymentSelection({
    pricing,
    selection: {
      option: input.payment.option,
      customAmountCents: input.payment.customAmountCents,
    },
  });

  if (!selectionResult.ok) {
    await markHoldPaymentFailedSafe(
      dependencies,
      hold.id,
      `Payment selection invalid: ${selectionResult.error}`,
      now,
    );
    return {
      ok: false,
      error: "invalid_request",
      message: selectionResult.error,
    };
  }

  const resolvedPayment = selectionResult.payment;

  if (input.payment.expectedAmountCents !== resolvedPayment.amountCents) {
    await markHoldPaymentFailedSafe(
      dependencies,
      hold.id,
      "Payment amount does not match the booking amount",
      now,
    );
    return {
      ok: false,
      error: "invalid_request",
      message: "Payment amount does not match the booking amount",
    };
  }

  // The card-on-file flow requires a positive amount to authorize, store the
  // card, and complete the booking. A zero-total confirmation is only possible
  // when add-ons remain to be charged; otherwise the online flow cannot
  // proceed.
  if (resolvedPayment.amountCents <= 0) {
    return {
      ok: false,
      error: "invalid_request",
      message:
        "This booking has no remaining balance to pay online. Please choose an option that covers the total, or contact us to book.",
    };
  }

  // The policy max and no-show charge record must reflect the full booked
  // service value, not the amount paid at booking time. This lets admin
  // no-show charges collect the remaining balance for deposit or custom
  // partial bookings. When a service promotion is active, the booked total
  // uses the discounted pretax base price, not the original full price.
  const fullBookedServiceAmountCents =
    (pricing.discountedBasePriceCents ?? pricing.fullPriceCents) +
    pricing.addOnPriceCents;
  const paidAtBookingCents = resolvedPayment.amountCents;
  const remainingBalanceCents = Math.max(
    0,
    fullBookedServiceAmountCents - paidAtBookingCents,
  );
  const fullBookedTaxQuote =
    fullBookedServiceAmountCents > 0
      ? calculateServiceBookingHstQuote(fullBookedServiceAmountCents)
      : zeroTaxQuote();
  const remainingBalanceTaxQuote =
    remainingBalanceCents > 0
      ? calculateServiceBookingHstQuote(remainingBalanceCents)
      : undefined;

  // The client contract keeps expectedAmountCents as the pre-tax service
  // amount. Tax is computed server-side from the trusted resolved amount and
  // charged to Square so Ontario HST is actually collected, not just displayed.
  const taxQuote = calculateServiceBookingHstQuote(resolvedPayment.amountCents);

  try {
    await dependencies.repository.persistCustomerAndSelection({
      holdId: hold.id,
      customer: input.customer,
      payment: resolvedPayment,
      now,
    });
  } catch (error) {
    await alertInfrastructureError(
      dependencies,
      "Failed to persist customer and payment selection",
      { error: getErrorMessage(error), holdId: hold.id },
    );
    await markHoldPaymentFailedSafe(
      dependencies,
      hold.id,
      "Unable to save booking details",
      now,
    );
    return {
      ok: false,
      error: "infrastructure_error",
      message: "Unable to save booking details",
    };
  }

  // Keep the local hold in sync with the repository so downstream steps use
  // the real customer and selected payment rather than placeholder data.
  hold = {
    ...hold,
    customer: {
      name: input.customer.name,
      email: input.customer.email,
      phone: input.customer.phone,
    },
    offeringSnapshot: {
      ...hold.offeringSnapshot,
      selectedPayment: resolvedPayment,
      customerStatus: "captured",
      paymentStatus: "selected",
    },
  };

  // Persist the marketing choice as a private contact side effect after real
  // customer details are on the hold. The durable outbox worker handles Resend
  // sync; failures here are infrastructure errors because the marketing consent
  // record must be durably persisted before payment proceeds.
  if (dependencies.recordMarketingChoice !== undefined) {
    try {
      const consentText = readBookingMarketingOptInLabelSnapshot(
        hold.offeringSnapshot.marketingOptInLabel,
      );
      await dependencies.recordMarketingChoice({
        answers: readBookingAnswers(hold.offeringSnapshot.answers),
        bookingType: hold.bookingType,
        consentText,
        email: input.customer.email,
        marketingOptIn: input.customer.marketingOptIn,
        name: input.customer.name,
        phone: input.customer.phone,
        sourcePath:
          typeof hold.offeringSnapshot.sourcePath === "string"
            ? hold.offeringSnapshot.sourcePath
            : undefined,
      });
    } catch (error) {
      await alertInfrastructureError(
        dependencies,
        "Failed to persist marketing choice",
        { error: getErrorMessage(error), holdId: hold.id },
      );
      await markHoldPaymentFailedSafe(
        dependencies,
        hold.id,
        "Unable to persist marketing consent",
        now,
      );
      return {
        ok: false,
        error: "infrastructure_error",
        message: "Unable to persist marketing consent",
      };
    }
  }

  const policyEvidence = getCanonicalServiceNoShowPolicyEvidence({
    acceptedAt: now,
    customerEmail: input.customer.email,
    customerName: input.customer.name,
    ipAddress: input.ipAddress,
    maxChargeCents: fullBookedServiceAmountCents,
    userAgent: input.userAgent,
  });

  let policyAcceptance: { id: string };

  try {
    policyAcceptance = await dependencies.repository.persistPolicyAcceptance({
      holdId: hold.id,
      policyVersion: policyEvidence.policyVersion,
      policyTextHash: policyEvidence.policyTextHash,
      maxChargeCents: policyEvidence.maxChargeCents,
      currency: policyEvidence.currency,
      customerEmail: policyEvidence.customerEmail,
      customerName: policyEvidence.customerName,
      ipHash: policyEvidence.ipAddressHash,
      userAgentHash: policyEvidence.userAgentHash,
      now,
    });
  } catch (error) {
    await alertInfrastructureError(
      dependencies,
      "Failed to persist policy acceptance",
      { error: getErrorMessage(error), holdId: hold.id },
    );
    await markHoldPaymentFailedSafe(
      dependencies,
      hold.id,
      "Unable to record policy acceptance",
      now,
    );
    return {
      ok: false,
      error: "infrastructure_error",
      message: "Unable to record policy acceptance",
    };
  }

  let squareCustomer: { id: string; squareCustomerId: string };

  try {
    squareCustomer = await createOrReuseSquareCustomer({
      hold,
      now,
      repository: dependencies.repository,
      squareCustomers: dependencies.squareCustomers,
    });
  } catch (error) {
    const isInfrastructure = error instanceof ChargeAndStoreInfrastructureError;
    await dependencies.alerts.alert({
      category: isInfrastructure
        ? "stuck_payment_state"
        : "square_customer_creation_failed",
      severity: isInfrastructure ? "error" : "warning",
      message: isInfrastructure
        ? "Database failure while resolving Square customer for charge-and-store booking"
        : "Square customer creation failed for charge-and-store booking",
      context: { holdId: hold.id, holdReference: hold.publicReference },
    });
    await markHoldPaymentFailedSafe(
      dependencies,
      hold.id,
      isInfrastructure
        ? "Unable to confirm booking details"
        : "Unable to save card with payment provider",
      now,
    );
    return {
      ok: false,
      error: isInfrastructure ? "infrastructure_error" : "square_api_error",
      message: isInfrastructure
        ? "Unable to confirm booking details"
        : "Unable to save card with payment provider",
    };
  }

  const paymentRequestWithoutIdempotency: Omit<
    SquareCreatePaymentRequest,
    "idempotency_key"
  > = {
    source_id: input.sourceId,
    customer_id: squareCustomer.squareCustomerId,
    amount_money: {
      amount: taxQuote.expectedAmountCents,
      currency: "CAD",
    },
    autocomplete: false,
    verification_token: input.verificationToken,
    reference_id: hold.publicReference,
    note: `${resolvedPayment.description} (includes ${taxQuote.taxName})`,
    team_member_id: operationalBooking
      ? (hold.squareTeamMemberId ?? undefined)
      : undefined,
  };
  let providerPaymentIdempotencyKey = input.idempotencyKey;
  let captureLeaseId: string | undefined;

  if (operationalBooking) {
    const prepareIntent =
      dependencies.repository.prepareOperationalPaymentIntent;
    const terminateIntent =
      dependencies.repository.terminateOperationalPaymentIntent;

    if (prepareIntent === undefined || terminateIntent === undefined) {
      await alertInfrastructureError(
        dependencies,
        "Operational payment repository cannot persist Square request intent",
        { holdId: hold.id },
      );
      return {
        ok: false,
        error: "infrastructure_error",
        message: "Unable to secure payment request",
      };
    }

    const intentInput = {
      amountCents: taxQuote.expectedAmountCents,
      currency: "CAD",
      holdId: hold.id,
      idempotencyKeyCandidate: makeSquareIdempotencyKey(
        "payment",
        randomUUID(),
      ),
      leaseExpiresAt: new Date(now.getTime() + OPERATIONAL_CAPTURE_LEASE_MS),
      now,
      referenceId: hold.publicReference,
      requestBodyHash: hashSquarePaymentRequestIntent(
        paymentRequestWithoutIdempotency,
      ),
      sourceIdHash: hashProviderToken(input.sourceId),
      squareCustomerId: squareCustomer.squareCustomerId,
      squareTeamMemberId: hold.squareTeamMemberId ?? undefined,
      verificationTokenHash:
        input.verificationToken === undefined
          ? undefined
          : hashProviderToken(input.verificationToken),
    };

    let prepared: Awaited<ReturnType<typeof prepareIntent>>;
    try {
      prepared = await prepareIntent(intentInput);
    } catch (error) {
      await alertInfrastructureError(
        dependencies,
        "Failed to persist Square request intent and capture lease",
        { error: getErrorMessage(error), holdId: hold.id },
      );
      return {
        ok: false,
        error: "infrastructure_error",
        message: "Unable to secure payment request",
      };
    }

    if (prepared.status === "changed_request") {
      try {
        await dependencies.squarePayments.cancelPaymentByIdempotencyKey(
          prepared.idempotencyKey,
        );
      } catch {
        return {
          ok: false,
          error: "infrastructure_error",
          message: "Payment status is being reconciled. Please try again.",
        };
      }

      const terminated = await terminateIntent({
        holdId: hold.id,
        idempotencyKey: prepared.idempotencyKey,
        now,
        status: "cancelled",
      });
      if (!terminated) {
        return {
          ok: false,
          error: "infrastructure_error",
          message: "Payment status is being reconciled. Please try again.",
        };
      }

      try {
        prepared = await prepareIntent({
          ...intentInput,
          idempotencyKeyCandidate: makeSquareIdempotencyKey(
            "payment",
            randomUUID(),
          ),
        });
      } catch (error) {
        await alertInfrastructureError(
          dependencies,
          "Failed to replace a cancelled Square request intent",
          { error: getErrorMessage(error), holdId: hold.id },
        );
        return {
          ok: false,
          error: "infrastructure_error",
          message: "Payment status is being reconciled. Please try again.",
        };
      }
    }

    if (prepared.status !== "ready") {
      return {
        ok: false,
        error: "hold_unavailable",
        message: "Booking hold is no longer available",
      };
    }

    providerPaymentIdempotencyKey = prepared.idempotencyKey;
    captureLeaseId = prepared.captureLeaseId;
  }

  let paymentResponse: SquareCreatePaymentResponse;

  try {
    paymentResponse = await dependencies.squarePayments.createCardOnFilePayment(
      {
        idempotency_key: providerPaymentIdempotencyKey,
        ...paymentRequestWithoutIdempotency,
      },
    );
  } catch {
    await dependencies.alerts.alert({
      category: "square_webhook_retryable_failure",
      severity: "warning",
      message: "Square payment creation failed for charge-and-store booking",
      context: { holdId: hold.id, holdReference: hold.publicReference },
    });
    if (operationalBooking) {
      return {
        ok: false,
        error: "infrastructure_error",
        message: "Payment status is being reconciled. Please try again.",
      };
    }
    await markHoldPaymentFailedSafe(
      dependencies,
      hold.id,
      "Unable to process payment with provider",
      now,
    );
    return {
      ok: false,
      error: "square_api_error",
      message: "Unable to process payment with provider",
    };
  }

  if (paymentResponse.payment.status !== "APPROVED") {
    await markHoldPaymentFailedSafe(
      dependencies,
      hold.id,
      `Square payment status: ${paymentResponse.payment.status}`,
      now,
    );
    return {
      ok: false,
      error: "payment_declined",
      message: "Payment was declined",
    };
  }

  if (
    operationalBooking &&
    !hasExpectedSquareTeamAttribution(paymentResponse, hold)
  ) {
    await alertSquareTeamAttributionMismatch(
      dependencies,
      hold,
      paymentResponse.payment,
      "Square authorization did not preserve the hold's team attribution",
    );
    return cancelAuthorizationAndReturnFailure({
      dependencies,
      hold,
      idempotencyKey: providerPaymentIdempotencyKey,
      message: "Payment attribution could not be verified",
      now,
      squarePaymentId: paymentResponse.payment.id,
    });
  }

  let cardResponse: { card: SquareCard };

  try {
    // Derive the CreateCard idempotency key from the actual Square payment
    // identity, not the hold id. If a retry produces a different Square payment
    // for the same hold, reusing a hold-scoped key would conflict with Square
    // idempotency because the request body (source_id) has changed.
    cardResponse = await dependencies.squareCards.createCard({
      idempotency_key: makeSquareIdempotencyKey(
        "card",
        paymentResponse.payment.id,
      ),
      source_id: paymentResponse.payment.id,
      verification_token: input.verificationToken,
      card: {
        customer_id: squareCustomer.squareCustomerId,
        cardholder_name: input.customer.name,
        reference_id: hold.publicReference,
        billing_address: {
          country: "CA",
        },
      },
    });
  } catch (error) {
    await dependencies.alerts.alert({
      category: "square_card_save_failed",
      severity: "warning",
      message: "Square CreateCard failed for charge-and-store booking",
      context: {
        holdId: hold.id,
        holdReference: hold.publicReference,
        squarePaymentId: paymentResponse.payment.id,
        error: getErrorMessage(error),
      },
    });

    try {
      await dependencies.squarePayments.cancelPayment(
        paymentResponse.payment.id,
      );
    } catch {
      await dependencies.alerts.alert({
        category: "square_webhook_retryable_failure",
        severity: "warning",
        message:
          "Failed to cancel Square payment after CreateCard failure for charge-and-store booking",
        context: {
          holdId: hold.id,
          holdReference: hold.publicReference,
          squarePaymentId: paymentResponse.payment.id,
        },
      });
    }

    await markHoldPaymentFailedSafe(
      dependencies,
      hold.id,
      "Unable to save card with payment provider",
      now,
    );

    return {
      ok: false,
      error: "square_api_error",
      message: "Unable to save card with payment provider",
    };
  }

  const squareCardId = cardResponse.card.id;
  const cardDetails = cardResponse.card;

  let savedPaymentMethod: {
    id: string;
    squareCardId: string;
    brand?: string;
    last4?: string;
    expMonth?: number;
    expYear?: number;
  } | null = null;

  try {
    savedPaymentMethod =
      await dependencies.repository.persistSavedPaymentMethod({
        squareCustomerRecordId: squareCustomer.id,
        squareCardId,
        brand: cardDetails.card_brand,
        last4: cardDetails.last_4,
        expMonth: cardDetails.exp_month,
        expYear: cardDetails.exp_year,
        now,
      });
  } catch (error) {
    await alertInfrastructureError(
      dependencies,
      "Failed to persist saved payment method after Square payment approval",
      { error: getErrorMessage(error), holdId: hold.id },
    );

    // The payment is only authorized at this point (autocomplete: false). If
    // we cannot store the card for no-show protection, cancel the authorization
    // so the customer is not charged for a booking we cannot secure.
    try {
      await dependencies.squarePayments.cancelPayment(
        paymentResponse.payment.id,
      );
    } catch {
      await dependencies.alerts.alert({
        category: "square_webhook_retryable_failure",
        severity: "warning",
        message:
          "Failed to cancel Square payment after saved payment method persistence failed",
        context: {
          holdId: hold.id,
          holdReference: hold.publicReference,
          squarePaymentId: paymentResponse.payment.id,
        },
      });
    }

    await markHoldPaymentFailedSafe(
      dependencies,
      hold.id,
      "Unable to save card details",
      now,
    );

    return {
      ok: false,
      error: "infrastructure_error",
      message: "Unable to save card details",
    };
  }

  const noShowAmountSnapshot = {
    fullBookedServiceAmountCents,
    fullBookedServiceTaxCents: fullBookedTaxQuote.taxAmountCents,
    fullBookedServiceTotalCents: fullBookedTaxQuote.expectedAmountCents,
    paidAtBookingCents,
    paidAtBookingTaxCents: taxQuote.taxAmountCents,
    paidAtBookingTotalCents: taxQuote.expectedAmountCents,
    remainingBalanceCents,
    remainingBalanceTaxCents: remainingBalanceTaxQuote?.taxAmountCents ?? 0,
    remainingBalanceWithTaxCents:
      remainingBalanceTaxQuote?.expectedAmountCents ?? 0,
  };

  let noShowChargeRecord: { id: string; status: "ready" };

  try {
    noShowChargeRecord = await dependencies.repository.createNoShowChargeRecord(
      {
        holdId: hold.id,
        savedPaymentMethodId: savedPaymentMethod.id,
        policyAcceptanceId: policyAcceptance.id,
        squareCustomerId: squareCustomer.squareCustomerId,
        squareCardId: savedPaymentMethod.squareCardId,
        maxChargeCents: fullBookedServiceAmountCents,
        currency: "CAD",
        status: "ready",
        providerMetadata: {
          amountSnapshot: noShowAmountSnapshot,
        },
        now,
      },
    );
  } catch (error) {
    await alertInfrastructureError(
      dependencies,
      "Failed to create no-show charge record",
      { error: getErrorMessage(error), holdId: hold.id },
    );

    try {
      await dependencies.squarePayments.cancelPayment(
        paymentResponse.payment.id,
      );
    } catch {
      await dependencies.alerts.alert({
        category: "square_webhook_retryable_failure",
        severity: "warning",
        message:
          "Failed to cancel Square payment after no-show charge record creation failed",
        context: {
          holdId: hold.id,
          holdReference: hold.publicReference,
          squarePaymentId: paymentResponse.payment.id,
        },
      });
    }

    await markHoldPaymentFailedSafe(
      dependencies,
      hold.id,
      "Unable to initialize no-show charge record",
      now,
    );

    return {
      ok: false,
      error: "infrastructure_error",
      message: "Unable to initialize no-show charge record",
    };
  }

  // If the customer did not pay the full service amount up front, create a
  // Square draft no-show invoice for the remaining balance so the admin
  // no-show path can charge it later without storing additional card details.
  if (remainingBalanceCents > 0) {
    try {
      await createDraftNoShowInvoice(
        {
          cardId: savedPaymentMethod.squareCardId,
          customerEmail: input.customer.email,
          customerId: squareCustomer.squareCustomerId,
          holdId: hold.id,
          idempotencyKey: makeSquareIdempotencyKey("noshow-invoice", hold.id),
          maxChargeCents: fullBookedServiceAmountCents,
          chargeableAmountCents: remainingBalanceCents,
          noShowChargeRecordId: noShowChargeRecord.id,
          providerMetadata: {
            amountSnapshot: noShowAmountSnapshot,
          },
          serviceDescription: resolvedPayment.description,
        },
        {
          locationId: dependencies.locationId,
          repository: dependencies.repository,
          squareInvoices: dependencies.squareInvoices,
        },
      );
    } catch (error) {
      const reason =
        error instanceof Error
          ? error.message
          : "Unknown no-show invoice failure";

      await dependencies.alerts.alert({
        category: "no_show_charge_failed",
        severity: "warning",
        message:
          "Square no-show draft invoice creation failed for charge-and-store booking",
        context: {
          holdId: hold.id,
          holdReference: hold.publicReference,
          squarePaymentId: paymentResponse.payment.id,
          reason,
        },
      });

      try {
        await dependencies.squarePayments.cancelPayment(
          paymentResponse.payment.id,
        );
      } catch {
        await dependencies.alerts.alert({
          category: "square_webhook_retryable_failure",
          severity: "warning",
          message:
            "Failed to cancel Square payment after no-show draft invoice creation failed",
          context: {
            holdId: hold.id,
            holdReference: hold.publicReference,
            squarePaymentId: paymentResponse.payment.id,
          },
        });
      }

      await markHoldPaymentFailedSafe(
        dependencies,
        hold.id,
        "Unable to secure remaining balance for no-show protection",
        now,
      );

      return {
        ok: false,
        error: "square_api_error",
        message: "Unable to secure remaining balance for no-show protection",
      };
    }
  }

  const squarePaymentId = paymentResponse.payment.id;

  if (
    operationalBooking &&
    dependencies.repository.recordAuthorizedOperationalPayment === undefined
  ) {
    await alertInfrastructureError(
      dependencies,
      "Operational payment repository cannot persist Square authorization",
      { holdId: hold.id, squarePaymentId },
    );
    return cancelAuthorizationAndReturnFailure({
      dependencies,
      hold,
      idempotencyKey: providerPaymentIdempotencyKey,
      message: "Unable to secure payment recovery before capture",
      now,
      squarePaymentId,
    });
  }

  try {
    await dependencies.repository.recordAuthorizedOperationalPayment?.({
      amountCents: paymentResponse.payment.amount_money.amount,
      currency: paymentResponse.payment.amount_money.currency,
      holdId: hold.id,
      idempotencyKey: providerPaymentIdempotencyKey,
      now,
      squareOrderId: paymentResponse.payment.order_id,
      squarePaymentId,
      versionToken: paymentResponse.payment.version_token,
    });
  } catch (error) {
    await alertInfrastructureError(
      dependencies,
      "Failed to persist Square authorization before capture",
      { error: getErrorMessage(error), holdId: hold.id, squarePaymentId },
    );
    return cancelAuthorizationAndReturnFailure({
      dependencies,
      hold,
      idempotencyKey: providerPaymentIdempotencyKey,
      message: "Unable to secure payment recovery before capture",
      now,
      squarePaymentId,
    });
  }

  if (operationalBooking) {
    const validateLease =
      dependencies.repository.validateOperationalCaptureLease;
    const captureNow = dependencies.now ?? new Date();
    let leaseIsValid = false;

    if (validateLease !== undefined && captureLeaseId !== undefined) {
      try {
        leaseIsValid = await validateLease({
          captureLeaseId,
          holdId: hold.id,
          idempotencyKey: providerPaymentIdempotencyKey,
          leaseExpiresAt: new Date(
            captureNow.getTime() + OPERATIONAL_CAPTURE_LEASE_MS,
          ),
          now: captureNow,
          squarePaymentId,
        });
      } catch (error) {
        await alertInfrastructureError(
          dependencies,
          "Failed to revalidate operational capture lease",
          { error: getErrorMessage(error), holdId: hold.id, squarePaymentId },
        );
      }
    }

    if (!leaseIsValid) {
      return cancelAuthorizationAndReturnFailure({
        dependencies,
        hold,
        idempotencyKey: providerPaymentIdempotencyKey,
        message: "Booking reservation changed before payment capture",
        now: captureNow,
        squarePaymentId,
      });
    }
  }

  let capturedPayment: SquareGetPaymentResponse | undefined;

  try {
    capturedPayment = await dependencies.squarePayments.completePayment(
      squarePaymentId,
      paymentResponse.payment.version_token,
    );
  } catch {
    // Capture failed before we received a final response. Query Square to
    // determine whether the payment was actually completed so we know whether
    // to request a refund or leave the hold for manual follow-up.
    let lookupPayment: SquareGetPaymentResponse | undefined;
    try {
      lookupPayment =
        await dependencies.squarePayments.getPayment(squarePaymentId);
    } catch (lookupError) {
      await dependencies.alerts.alert({
        category: "square_webhook_retryable_failure",
        severity: "warning",
        message:
          "Could not determine Square payment status after capture failure",
        context: {
          holdId: hold.id,
          holdReference: hold.publicReference,
          squarePaymentId,
          error: getErrorMessage(lookupError),
        },
      });
    }

    if (lookupPayment?.payment.status === "COMPLETED") {
      return persistCapturedPaymentAndFinalize({
        card: savedPaymentMethod,
        dependencies,
        hold,
        idempotencyKey: providerPaymentIdempotencyKey,
        now,
        payment: lookupPayment,
      });
    }

    const paymentStatus = lookupPayment?.payment.status;
    if (paymentStatus !== undefined) {
      // The payment is only authorized. Cancel it so the customer cannot be
      // charged for a booking we cannot finalize.
      const cancelResult = await cancelSquarePaymentSafe(
        dependencies,
        hold,
        squarePaymentId,
        now,
        providerPaymentIdempotencyKey,
      );
      if (cancelResult.ok) {
        await markHoldPaymentFailedSafe(
          dependencies,
          hold.id,
          `Capture failed and Square payment status was ${paymentStatus}`,
          now,
        );
        return {
          ok: false,
          error: "infrastructure_error",
          message: "Payment capture failed and booking could not be finalized",
        };
      }
      return await markRefundRequiredAndReturnFailure(
        dependencies,
        hold.id,
        squarePaymentId,
        `Capture failed with status ${paymentStatus} and cancellation failed; refund required`,
        now,
        "Payment capture failed and booking could not be finalized",
        "square_api_error",
        {
          idempotencyKey: providerPaymentIdempotencyKey,
          providerEvidence: "cancellation_unconfirmed",
        },
      );
    }

    // V2 has a durable authorized attempt containing this provider payment ID.
    // Leave it reclaimable so a retry can query the same Square payment rather
    // than creating a new charge when the capture outcome is ambiguous.
    if (operationalBooking) {
      return {
        ok: false,
        error: "infrastructure_error",
        message: "Payment status is being reconciled. Please try again.",
      };
    }

    // Legacy V1 has no durable authorized-payment recovery path.
    return await markRefundRequiredAndReturnFailure(
      dependencies,
      hold.id,
      squarePaymentId,
      "Payment capture failed and Square status could not be determined; refund required",
      now,
      "Payment capture failed and booking could not be finalized",
    );
  }

  if (capturedPayment.payment.status !== "COMPLETED") {
    // Square returned a definitive non-completed status. Cancel the
    // authorization, then fail retryably if the cancellation succeeded.
    const cancelResult = await cancelSquarePaymentSafe(
      dependencies,
      hold,
      capturedPayment.payment.id,
      now,
      providerPaymentIdempotencyKey,
    );
    if (cancelResult.ok) {
      await markHoldPaymentFailedSafe(
        dependencies,
        hold.id,
        `Square capture returned status ${capturedPayment.payment.status}`,
        now,
      );
      return {
        ok: false,
        error: "infrastructure_error",
        message: "Payment capture did not complete",
      };
    }
    return await markRefundRequiredAndReturnFailure(
      dependencies,
      hold.id,
      capturedPayment.payment.id,
      `Square capture returned status ${capturedPayment.payment.status} and cancellation failed; refund required`,
      now,
      "Payment capture did not complete",
      "square_api_error",
      {
        idempotencyKey: providerPaymentIdempotencyKey,
        providerEvidence: "cancellation_unconfirmed",
      },
    );
  }

  return persistCapturedPaymentAndFinalize({
    card: savedPaymentMethod,
    dependencies,
    hold,
    idempotencyKey: providerPaymentIdempotencyKey,
    now,
    payment: capturedPayment,
  });
}

async function resumeAuthorizedChargeAndStorePayment(input: {
  card: ChargeAndStoreCardDisplay;
  dependencies: ConfirmChargeAndStoreBookingDependencies;
  hold: BookingHoldRecord;
  now: Date;
  payment: AuthorizedChargeAndStorePaymentEvidence;
}): Promise<ChargeAndStoreBookingResult> {
  let observed: SquareGetPaymentResponse;

  try {
    observed = await input.dependencies.squarePayments.getPayment(
      input.payment.squarePaymentId,
    );
  } catch (error) {
    await alertInfrastructureError(
      input.dependencies,
      "Failed to query durable Square authorization during recovery",
      {
        error: getErrorMessage(error),
        holdId: input.hold.id,
        squarePaymentId: input.payment.squarePaymentId,
      },
    );
    return {
      ok: false,
      error: "infrastructure_error",
      message: "Payment status is being reconciled. Please try again.",
    };
  }

  if (!matchesAuthorizedPaymentEvidence(observed, input.payment)) {
    await alertInfrastructureError(
      input.dependencies,
      "Square authorization recovery evidence did not match the durable attempt",
      {
        holdId: input.hold.id,
        squarePaymentId: input.payment.squarePaymentId,
      },
    );
    return {
      ok: false,
      error: "infrastructure_error",
      message: "Payment status requires manual reconciliation",
    };
  }

  if (
    !hasExpectedSquareTeamAttribution(observed, input.hold) ||
    normalizeSquareTeamMemberId(input.payment.squareTeamMemberId) !==
      normalizeSquareTeamMemberId(input.hold.squareTeamMemberId)
  ) {
    await alertSquareTeamAttributionMismatch(
      input.dependencies,
      input.hold,
      observed.payment,
      "Recovered Square authorization did not match the hold's team attribution",
    );

    if (observed.payment.status === "APPROVED") {
      return cancelAuthorizationAndReturnFailure({
        dependencies: input.dependencies,
        hold: input.hold,
        idempotencyKey: input.payment.idempotencyKey,
        message: "Payment attribution could not be verified",
        now: input.now,
        squarePaymentId: observed.payment.id,
      });
    }

    if (observed.payment.status === "COMPLETED") {
      return markRefundRequiredAndReturnFailure(
        input.dependencies,
        input.hold.id,
        observed.payment.id,
        "Captured Square payment team attribution did not match the hold snapshot; refund required",
        input.now,
        "Payment was captured with invalid attribution and requires manual follow-up",
        "infrastructure_error",
        {
          idempotencyKey: input.payment.idempotencyKey,
          providerEvidence: "completed",
        },
      );
    }

    return {
      ok: false,
      error: "infrastructure_error",
      message: "Payment status requires manual reconciliation",
    };
  }

  if (observed.payment.status === "COMPLETED") {
    return persistCapturedPaymentAndFinalize({
      card: input.card,
      dependencies: input.dependencies,
      hold: input.hold,
      idempotencyKey: input.payment.idempotencyKey,
      now: input.now,
      payment: observed,
    });
  }

  if (observed.payment.status !== "APPROVED") {
    if (
      observed.payment.status !== "CANCELED" &&
      observed.payment.status !== "FAILED"
    ) {
      return {
        ok: false,
        error: "infrastructure_error",
        message: "Payment status is being reconciled. Please try again.",
      };
    }

    const terminateAttempt =
      input.dependencies.repository.markAuthorizedOperationalPaymentTerminated;
    if (terminateAttempt === undefined) {
      return {
        ok: false,
        error: "infrastructure_error",
        message: "Payment status requires manual reconciliation",
      };
    }

    try {
      const outcome = await terminateAttempt({
        holdId: input.hold.id,
        now: input.now,
        squarePaymentId: input.payment.squarePaymentId,
        status: observed.payment.status === "CANCELED" ? "cancelled" : "failed",
      });
      if (outcome === "capture_preserved" || outcome === "not_found") {
        return {
          ok: false,
          error: "infrastructure_error",
          message: "Payment status is being reconciled. Please try again.",
        };
      }
    } catch (error) {
      await alertInfrastructureError(
        input.dependencies,
        "Failed to persist terminal Square authorization status",
        {
          error: getErrorMessage(error),
          holdId: input.hold.id,
          squarePaymentId: input.payment.squarePaymentId,
        },
      );
      return {
        ok: false,
        error: "infrastructure_error",
        message: "Payment status is being reconciled. Please try again.",
      };
    }

    await markHoldPaymentFailedSafe(
      input.dependencies,
      input.hold.id,
      `Durable Square authorization is ${observed.payment.status}`,
      input.now,
    );
    return {
      ok: false,
      error: "payment_declined",
      message: "Payment authorization is no longer available",
    };
  }

  const validateLease =
    input.dependencies.repository.validateOperationalCaptureLease;
  const captureNow = input.dependencies.now ?? new Date();
  let leaseIsValid = false;
  if (validateLease !== undefined) {
    try {
      leaseIsValid = await validateLease({
        captureLeaseId: input.payment.captureLeaseId,
        holdId: input.hold.id,
        idempotencyKey: input.payment.idempotencyKey,
        leaseExpiresAt: new Date(
          captureNow.getTime() + OPERATIONAL_CAPTURE_LEASE_MS,
        ),
        now: captureNow,
        squarePaymentId: input.payment.squarePaymentId,
      });
    } catch (error) {
      await alertInfrastructureError(
        input.dependencies,
        "Failed to revalidate recovered operational capture lease",
        {
          error: getErrorMessage(error),
          holdId: input.hold.id,
          squarePaymentId: input.payment.squarePaymentId,
        },
      );
    }
  }

  if (!leaseIsValid) {
    return cancelAuthorizationAndReturnFailure({
      dependencies: input.dependencies,
      hold: input.hold,
      idempotencyKey: input.payment.idempotencyKey,
      message: "Booking reservation changed before payment capture",
      now: captureNow,
      squarePaymentId: input.payment.squarePaymentId,
    });
  }

  let completed: SquareGetPaymentResponse | undefined;
  try {
    completed = await input.dependencies.squarePayments.completePayment(
      input.payment.squarePaymentId,
      observed.payment.version_token ?? input.payment.versionToken,
    );
  } catch (completeError) {
    try {
      const afterError = await input.dependencies.squarePayments.getPayment(
        input.payment.squarePaymentId,
      );
      if (
        matchesAuthorizedPaymentEvidence(afterError, input.payment) &&
        afterError.payment.status === "COMPLETED"
      ) {
        completed = afterError;
      }
    } catch (lookupError) {
      await input.dependencies.alerts.alert({
        category: "square_webhook_retryable_failure",
        severity: "warning",
        message:
          "Could not resolve Square status after recovered capture failed",
        context: {
          completeError: getErrorMessage(completeError),
          holdId: input.hold.id,
          lookupError: getErrorMessage(lookupError),
          squarePaymentId: input.payment.squarePaymentId,
        },
      });
    }
  }

  if (completed?.payment.status !== "COMPLETED") {
    return {
      ok: false,
      error: "infrastructure_error",
      message: "Payment status is being reconciled. Please try again.",
    };
  }

  return persistCapturedPaymentAndFinalize({
    card: input.card,
    dependencies: input.dependencies,
    hold: input.hold,
    idempotencyKey: input.payment.idempotencyKey,
    now: input.now,
    payment: completed,
  });
}

async function persistCapturedPaymentAndFinalize(input: {
  card: ChargeAndStoreCardDisplay;
  dependencies: ConfirmChargeAndStoreBookingDependencies;
  hold: BookingHoldRecord;
  idempotencyKey: string;
  now: Date;
  payment: SquareGetPaymentResponse;
}): Promise<ChargeAndStoreBookingResult> {
  const payment = input.payment.payment;
  const operationalBooking = resolveBookingModelVersion(input.hold) === 2;

  if (payment.status !== "COMPLETED") {
    throw new TypeError(
      "Captured payment finalization requires COMPLETED evidence",
    );
  }

  if (
    operationalBooking &&
    !hasExpectedSquareTeamAttribution(input.payment, input.hold)
  ) {
    await alertSquareTeamAttributionMismatch(
      input.dependencies,
      input.hold,
      payment,
      "Captured Square payment did not match the hold's team attribution",
    );
    return markRefundRequiredAndReturnFailure(
      input.dependencies,
      input.hold.id,
      payment.id,
      "Captured Square payment team attribution did not match the hold snapshot; refund required",
      input.now,
      "Payment was captured with invalid attribution and requires manual follow-up",
      "infrastructure_error",
      {
        idempotencyKey: input.idempotencyKey,
        providerEvidence: "completed",
      },
    );
  }

  if (
    operationalBooking &&
    input.dependencies.repository.recordCapturedOperationalPayment === undefined
  ) {
    await alertInfrastructureError(
      input.dependencies,
      "Operational payment repository cannot persist captured evidence",
      { holdId: input.hold.id, squarePaymentId: payment.id },
    );
    return {
      ok: false,
      error: "infrastructure_error",
      message: "Payment was captured and is being reconciled",
    };
  }

  try {
    await input.dependencies.repository.recordCapturedOperationalPayment?.({
      amountCents: payment.amount_money.amount,
      currency: payment.amount_money.currency,
      holdId: input.hold.id,
      idempotencyKey: input.idempotencyKey,
      now: input.now,
      squareOrderId: payment.order_id,
      squarePaymentId: payment.id,
    });
  } catch (error) {
    await alertInfrastructureError(
      input.dependencies,
      "Failed to persist captured payment before Calendar finalization",
      {
        error: getErrorMessage(error),
        holdId: input.hold.id,
        squarePaymentId: payment.id,
      },
    );

    // V2 keeps the durable authorized attempt reclaimable. A later request
    // queries the same provider payment and retries only the local projection.
    if (operationalBooking) {
      return {
        ok: false,
        error: "infrastructure_error",
        message: "Payment was captured and is being reconciled",
      };
    }

    return markRefundRequiredAndReturnFailure(
      input.dependencies,
      input.hold.id,
      payment.id,
      "Payment was captured but the authoritative appointment could not be persisted; refund required",
      input.now,
      "Payment was captured but booking could not be finalized",
      "infrastructure_error",
      {
        idempotencyKey: input.idempotencyKey,
        providerEvidence: "completed",
      },
    );
  }

  return finalizeCapturedChargeAndStoreBooking({
    card: input.card,
    dependencies: input.dependencies,
    hold: input.hold,
    now: input.now,
    payment: {
      amountCents: payment.amount_money.amount,
      currency: payment.amount_money.currency,
      idempotencyKey: input.idempotencyKey,
      squareOrderId: payment.order_id,
      squarePaymentId: payment.id,
      status: "COMPLETED",
    },
  });
}

function matchesAuthorizedPaymentEvidence(
  response: SquareGetPaymentResponse,
  evidence: AuthorizedChargeAndStorePaymentEvidence,
): boolean {
  return (
    response.payment.id === evidence.squarePaymentId &&
    response.payment.amount_money.amount === evidence.amountCents &&
    response.payment.amount_money.currency.trim().toUpperCase() ===
      evidence.currency.trim().toUpperCase()
  );
}

function hasExpectedSquareTeamAttribution(
  response: SquareGetPaymentResponse,
  hold: BookingHoldRecord,
): boolean {
  return (
    normalizeSquareTeamMemberId(response.payment.team_member_id) ===
    normalizeSquareTeamMemberId(hold.squareTeamMemberId)
  );
}

function normalizeSquareTeamMemberId(
  value: string | null | undefined,
): string | null {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0
    ? null
    : normalized;
}

async function alertSquareTeamAttributionMismatch(
  dependencies: ConfirmChargeAndStoreBookingDependencies,
  hold: BookingHoldRecord,
  payment: SquareGetPaymentResponse["payment"],
  message: string,
): Promise<void> {
  await dependencies.alerts.alert({
    category: "stuck_payment_state",
    severity: "error",
    message,
    context: {
      expectedSquareTeamMemberId: hold.squareTeamMemberId ?? null,
      holdId: hold.id,
      holdReference: hold.publicReference,
      observedSquareTeamMemberId: payment.team_member_id ?? null,
      squarePaymentId: payment.id,
      squarePaymentStatus: payment.status,
    },
  });
}

async function cancelAuthorizationAndReturnFailure(input: {
  dependencies: ConfirmChargeAndStoreBookingDependencies;
  hold: BookingHoldRecord;
  idempotencyKey?: string;
  message: string;
  now: Date;
  squarePaymentId: string;
}): Promise<ChargeAndStoreBookingResult> {
  const cancellation = await cancelSquarePaymentSafe(
    input.dependencies,
    input.hold,
    input.squarePaymentId,
    input.now,
    input.idempotencyKey,
  );

  if (cancellation.ok) {
    await markHoldPaymentFailedSafe(
      input.dependencies,
      input.hold.id,
      input.message,
      input.now,
    );
    return {
      ok: false,
      error: "infrastructure_error",
      message: input.message,
    };
  }

  return markRefundRequiredAndReturnFailure(
    input.dependencies,
    input.hold.id,
    input.squarePaymentId,
    `${input.message}; Square authorization cancellation failed`,
    input.now,
    input.message,
    "infrastructure_error",
    {
      idempotencyKey: input.idempotencyKey,
      providerEvidence: "cancellation_unconfirmed",
    },
  );
}

async function finalizeCapturedChargeAndStoreBooking(input: {
  card: ChargeAndStoreCardDisplay;
  dependencies: ConfirmChargeAndStoreBookingDependencies;
  hold: BookingHoldRecord;
  now: Date;
  payment: CapturedChargeAndStorePaymentEvidence;
}): Promise<ChargeAndStoreBookingResult> {
  let calendarResult: Awaited<
    ReturnType<CardOnFileCalendarFinalizer["finalize"]>
  >;

  try {
    calendarResult = await input.dependencies.calendarFinalizer.finalize({
      hold: input.hold,
      now: input.now,
    });
  } catch (error) {
    calendarResult = {
      ok: false,
      status: "manual_followup",
      error: getErrorMessage(error),
    };
  }

  const successResult: Extract<ChargeAndStoreBookingResult, { ok: true }> = {
    ...buildSuccessResult(input.hold, input.card),
    bookingStatus: calendarResult.ok ? "booked" : "manual_followup",
  };

  if (!calendarResult.ok) {
    let terminalHold: BookingHoldRecord;
    try {
      terminalHold = await input.dependencies.repository.markHoldManualFollowup(
        {
          holdId: input.hold.id,
          confirmation: successResult,
          reason: calendarResult.error,
          now: input.now,
        },
      );
    } catch (error) {
      await alertInfrastructureError(
        input.dependencies,
        "Failed to mark hold for manual follow-up after calendar failure",
        { error: getErrorMessage(error), holdId: input.hold.id },
      );
      const fallback = await markRefundRequiredAndReturnFailure(
        input.dependencies,
        input.hold.id,
        input.payment.squarePaymentId,
        "Calendar finalization failed and manual follow-up marker could not be persisted; refund required",
        input.now,
        "Unable to finalize booking after payment capture",
        "infrastructure_error",
        {
          idempotencyKey: input.payment.idempotencyKey,
          providerEvidence: "completed",
        },
      );
      await sendTerminalOutcomeSideEffects({
        confirmation: fallback,
        currentBookingStatus: calendarResult.status,
        dependencies: input.dependencies,
        failureReason: calendarResult.error,
        hold: input.hold,
        payment: input.payment,
      });
      return fallback;
    }

    const effectiveConfirmation =
      readStoredChargeAndStoreConfirmation(terminalHold) ?? successResult;

    await sendTerminalOutcomeSideEffects({
      confirmation: effectiveConfirmation,
      currentBookingStatus: calendarResult.status,
      dependencies: input.dependencies,
      failureReason: calendarResult.error,
      hold: input.hold,
      payment: input.payment,
    });

    return effectiveConfirmation;
  }

  try {
    const bookedHold = await input.dependencies.repository.markHoldBooked({
      holdId: input.hold.id,
      confirmation: successResult,
      googleEventId: calendarResult.googleEventId,
      now: input.now,
    });

    const effectiveConfirmation = {
      ...(readStoredChargeAndStoreConfirmation(bookedHold) ?? successResult),
      holdReference: bookedHold.publicReference,
    };
    await sendTerminalOutcomeSideEffects({
      confirmation: effectiveConfirmation,
      dependencies: input.dependencies,
      hold: input.hold,
      payment: input.payment,
    });
    return effectiveConfirmation;
  } catch (error) {
    await alertInfrastructureError(
      input.dependencies,
      "Failed to finalize booking after Calendar success",
      { error: getErrorMessage(error), holdId: input.hold.id },
    );

    const manualFollowupConfirmation: Extract<
      ChargeAndStoreBookingResult,
      { ok: true }
    > = {
      ...successResult,
      bookingStatus: "manual_followup",
    };

    try {
      const manualHold =
        await input.dependencies.repository.markHoldManualFollowup({
          holdId: input.hold.id,
          confirmation: manualFollowupConfirmation,
          reason: "Booking finalization failed after calendar success",
          now: input.now,
        });

      const effectiveConfirmation =
        readStoredChargeAndStoreConfirmation(manualHold) ??
        manualFollowupConfirmation;
      await sendTerminalOutcomeSideEffects({
        confirmation: effectiveConfirmation,
        currentBookingStatus: "manual_followup",
        dependencies: input.dependencies,
        failureReason: "Booking finalization failed after calendar success",
        hold: input.hold,
        payment: input.payment,
      });
      return effectiveConfirmation;
    } catch (manualError) {
      await alertInfrastructureError(
        input.dependencies,
        "Failed to mark hold manual follow-up after calendar booking failure",
        { error: getErrorMessage(manualError), holdId: input.hold.id },
      );
      const fallback = await markRefundRequiredAndReturnFailure(
        input.dependencies,
        input.hold.id,
        input.payment.squarePaymentId,
        "Booking finalization failed and manual follow-up marker could not be persisted; refund required",
        input.now,
        "Unable to finalize booking after Calendar success",
        "infrastructure_error",
        {
          idempotencyKey: input.payment.idempotencyKey,
          providerEvidence: "completed",
        },
      );
      await sendTerminalOutcomeSideEffects({
        confirmation: fallback,
        currentBookingStatus: "manual_followup",
        dependencies: input.dependencies,
        failureReason: "Booking finalization failed after calendar success",
        hold: input.hold,
        payment: input.payment,
      });
      return fallback;
    }
  }
}

async function sendTerminalOutcomeSideEffects(input: {
  confirmation: ChargeAndStoreBookingResult;
  currentBookingStatus?: string;
  dependencies: ConfirmChargeAndStoreBookingDependencies;
  failureReason?: string;
  hold: BookingHoldRecord;
  payment: CapturedChargeAndStorePaymentEvidence;
}): Promise<void> {
  if (!input.confirmation.ok) {
    return;
  }

  if (
    input.confirmation.bookingStatus === "manual_followup" &&
    input.failureReason !== undefined
  ) {
    await input.dependencies.alerts.alert({
      category: "booking_calendar_finalization_failed",
      severity: "warning",
      message:
        "Calendar finalization failed after payment capture; manual follow-up required",
      context: {
        holdId: input.hold.id,
        holdReference: input.hold.publicReference,
        reason: input.failureReason,
      },
    });

    await sendBookingSchedulingFailureAdminEmailSafe(input.dependencies, {
      amountCents: input.payment.amountCents,
      currency: input.payment.currency,
      currentBookingStatus: input.currentBookingStatus ?? "manual_followup",
      failureReason: input.failureReason,
      hold: input.hold,
      paymentProvider: "square",
      paymentReference: input.payment.squarePaymentId,
      paymentStatus: input.payment.status,
    });
  }

  await sendBookingConfirmationEmailForHoldSafe(
    input.dependencies,
    input.hold.id,
  );
}

class ChargeAndStoreInfrastructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChargeAndStoreInfrastructureError";
  }
}

async function createOrReuseSquareCustomer(input: {
  hold: BookingHoldRecord;
  now: Date;
  repository: ChargeAndStoreRepository;
  squareCustomers: SquareCustomerGateway;
}): Promise<{ id: string; squareCustomerId: string }> {
  try {
    const existing = await input.repository.findSquareCustomerByEmail(
      input.hold.customer.email,
    );
    if (existing !== null) {
      return existing;
    }
  } catch (error) {
    throw new ChargeAndStoreInfrastructureError(getErrorMessage(error));
  }

  const idempotencyKey = makeSquareIdempotencyKey("customer", input.hold.id);

  let response: SquareCreateCustomerResponse;

  try {
    response = await input.squareCustomers.createCustomer({
      idempotency_key: idempotencyKey,
      email_address: input.hold.customer.email,
      given_name: parseFirstName(input.hold.customer.name),
      family_name: parseLastName(input.hold.customer.name),
      phone_number: input.hold.customer.phone,
      reference_id: input.hold.publicReference,
    });
  } catch (error) {
    throw new Error(getErrorMessage(error));
  }

  try {
    return await input.repository.persistSquareCustomer({
      email: input.hold.customer.email,
      name: input.hold.customer.name,
      phone: input.hold.customer.phone,
      squareCustomerId: response.customer.id,
      now: input.now,
    });
  } catch (error) {
    const existingAfterError = await safeFindSquareCustomerByEmail(
      input.repository,
      input.hold.customer.email,
    );
    if (existingAfterError !== null) {
      return existingAfterError;
    }
    throw new ChargeAndStoreInfrastructureError(getErrorMessage(error));
  }
}

async function safeFindSquareCustomerByEmail(
  repository: ChargeAndStoreRepository,
  email: string,
): Promise<{ id: string; squareCustomerId: string } | null> {
  try {
    return await repository.findSquareCustomerByEmail(email);
  } catch {
    return null;
  }
}

function makeSquareIdempotencyKey(scope: string, holdId: string): string {
  // Square idempotency keys are capped at 45 characters. Real hold IDs are
  // UUIDs, so a plain scope + holdId string would exceed the limit. Use a
  // short prefix plus a deterministic hash slice so keys stay stable, unique
  // per scope+hold, and within Square's bound.
  const hash = createHash("sha256")
    .update(`${scope}:${holdId}`)
    .digest("hex")
    .slice(0, 32);
  return `cs:${scope}:${hash}`;
}

function hashProviderToken(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashSquarePaymentRequestIntent(
  request: Omit<SquareCreatePaymentRequest, "idempotency_key">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        amountMoney: request.amount_money,
        autocomplete: request.autocomplete ?? true,
        customerId: request.customer_id,
        note: request.note ?? null,
        referenceId: request.reference_id ?? null,
        sourceId: request.source_id,
        teamMemberId: request.team_member_id ?? null,
        verificationToken: request.verification_token ?? null,
      }),
    )
    .digest("hex");
}

export function getChargeAndStoreSquarePaymentIdempotencyKey(
  holdId: string,
): string {
  return makeSquareIdempotencyKey("payment", holdId);
}

function readStoredChargeAndStoreConfirmation(
  hold: BookingHoldRecord,
): Extract<ChargeAndStoreBookingResult, { ok: true }> | undefined {
  const value = hold.reconciliationMetadata?.chargeAndStoreConfirmation;
  if (value === null || typeof value !== "object") {
    return undefined;
  }

  const confirmation = value as Partial<
    Extract<ChargeAndStoreBookingResult, { ok: true }>
  >;
  return confirmation.ok === true &&
    (confirmation.bookingStatus === "booked" ||
      confirmation.bookingStatus === "manual_followup") &&
    confirmation.paymentStatus === "captured" &&
    typeof confirmation.holdReference === "string" &&
    confirmation.card !== null &&
    typeof confirmation.card === "object"
    ? (confirmation as Extract<ChargeAndStoreBookingResult, { ok: true }>)
    : undefined;
}

function buildSuccessResult(
  hold: BookingHoldRecord,
  savedPaymentMethod: {
    brand?: string;
    last4?: string;
    expMonth?: number;
    expYear?: number;
  },
): Extract<ChargeAndStoreBookingResult, { ok: true }> {
  return {
    ok: true,
    bookingStatus: "booked",
    holdReference: hold.publicReference,
    paymentStatus: "captured",
    card: {
      brand: savedPaymentMethod.brand,
      last4: savedPaymentMethod.last4,
      expMonth: savedPaymentMethod.expMonth,
      expYear: savedPaymentMethod.expYear,
    },
  };
}

function validateChargeAndStoreBookingRequest(body: unknown): string | null {
  if (!isRecord(body)) {
    return "Invalid request body";
  }

  if (!isRecord(body.customer)) {
    return "Customer details are required";
  }

  if (
    typeof body.customer.name !== "string" ||
    body.customer.name.trim().length === 0
  ) {
    return "Customer name is required";
  }

  if (
    typeof body.customer.email !== "string" ||
    body.customer.email.trim().length === 0 ||
    !body.customer.email.includes("@")
  ) {
    return "Customer email is required";
  }

  if (
    typeof body.customer.phone !== "string" ||
    body.customer.phone.trim().length === 0
  ) {
    return "Customer phone is required";
  }

  if (typeof body.customer.marketingOptIn !== "boolean") {
    return "Marketing opt-in is required";
  }

  if (
    typeof body.paymentSessionReference !== "string" ||
    body.paymentSessionReference.trim().length === 0
  ) {
    return "Payment session reference is required";
  }

  if (
    typeof body.idempotencyKey !== "string" ||
    body.idempotencyKey.trim().length === 0
  ) {
    return "Idempotency key is required";
  }

  if (!isRecord(body.payment)) {
    return "Payment selection is required";
  }

  if (
    body.payment.option !== "deposit" &&
    body.payment.option !== "full" &&
    body.payment.option !== "customPartial"
  ) {
    return "Payment option is required";
  }

  if (
    typeof body.payment.expectedAmountCents !== "number" ||
    !Number.isInteger(body.payment.expectedAmountCents) ||
    body.payment.expectedAmountCents < 0
  ) {
    return "Expected payment amount must be a non-negative integer";
  }

  const customAmountCents = body.payment.customAmountCents;
  if (
    customAmountCents !== undefined &&
    (typeof customAmountCents !== "number" ||
      !Number.isInteger(customAmountCents) ||
      customAmountCents <= 0)
  ) {
    return "Custom amount must be a positive integer";
  }

  if (!isRecord(body.policy)) {
    return "Policy acceptance is required";
  }

  if (body.policy.accepted !== true) {
    return "Policy acceptance is required";
  }

  if (
    typeof body.policy.policyVersion !== "string" ||
    body.policy.policyVersion.trim().length === 0
  ) {
    return "Policy version is required";
  }

  if (
    typeof body.policy.policyTextHash !== "string" ||
    body.policy.policyTextHash.trim().length === 0
  ) {
    return "Policy text hash is required";
  }

  if (typeof body.sourceId !== "string" || body.sourceId.trim().length === 0) {
    return "Card source identifier is required";
  }

  if (
    body.verificationToken !== undefined &&
    (typeof body.verificationToken !== "string" ||
      body.verificationToken.trim().length === 0)
  ) {
    return "Verification token must be a non-empty string when provided";
  }

  return null;
}

function isChargeAndStoreHoldAvailable(
  hold: BookingHoldRecord,
  now: Date,
): boolean {
  return hold.state === "held" && hold.expiresAt > now;
}

function readPricingSnapshot(
  snapshot: Record<string, unknown>,
): ServicePaymentPricingSnapshot | null {
  const pricing = isRecord(snapshot.pricing) ? snapshot.pricing : null;
  if (pricing === null) return null;

  const currency = pricing.currency;
  if (currency !== "CAD") return null;

  const depositAmountCents = dollarsToCents(pricing.depositAmount);
  const fullPriceCents = dollarsToCents(pricing.fullPrice);
  const addOnPriceCents = dollarsToCents(
    isRecord(snapshot.selectedAddOn) ? snapshot.selectedAddOn.price : 0,
  );

  if (
    !isPositiveInteger(depositAmountCents) ||
    !isPositiveInteger(fullPriceCents) ||
    !isNonNegativeInteger(addOnPriceCents)
  ) {
    return null;
  }

  const customAmountMinimumCents = dollarsToCents(pricing.customAmountMinimum);
  const customAmountMaximumCents = dollarsToCents(pricing.customAmountMaximum);

  const title =
    typeof snapshot.title === "string" && snapshot.title.trim().length > 0
      ? snapshot.title
      : "Lash appointment";

  const selectedAddOnName = isRecord(snapshot.selectedAddOn)
    ? typeof snapshot.selectedAddOn.name === "string"
      ? snapshot.selectedAddOn.name
      : undefined
    : undefined;

  const promotionSnapshot = readServicePromotionSnapshot(
    snapshot,
    fullPriceCents,
  );
  const discountedBasePriceCents =
    promotionSnapshot?.discountedBasePriceCents ?? fullPriceCents;

  return {
    addOnPriceCents,
    currency: "CAD",
    customAmountMaximumCents: isPositiveInteger(customAmountMaximumCents)
      ? customAmountMaximumCents
      : fullPriceCents,
    customAmountMinimumCents: isPositiveInteger(customAmountMinimumCents)
      ? customAmountMinimumCents
      : depositAmountCents,
    depositAmountCents,
    ...(discountedBasePriceCents !== fullPriceCents
      ? { discountedBasePriceCents }
      : {}),
    fullPriceCents,
    ...(promotionSnapshot !== null
      ? {
          promotionCode: promotionSnapshot.code,
          promotionDiscountCents: promotionSnapshot.discountCents,
        }
      : {}),
    selectedAddOnName,
    serviceTitle: title,
  };
}

function dollarsToCents(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.round(value * 100);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function parseFirstName(fullName: string): string {
  const trimmed = fullName.trim();
  const parts = trimmed.split(/\s+/);
  return parts[0] ?? trimmed;
}

function parseLastName(fullName: string): string {
  const trimmed = fullName.trim();
  const parts = trimmed.split(/\s+/);
  return parts.length > 1 ? parts.slice(1).join(" ") : "";
}

async function alertInfrastructureError(
  dependencies: ConfirmChargeAndStoreBookingDependencies,
  message: string,
  context: Record<string, unknown>,
): Promise<void> {
  dependencies.alerts.alert({
    category: "stuck_payment_state",
    severity: "error",
    message,
    context,
  });
}

async function markHoldPaymentFailedSafe(
  dependencies: ConfirmChargeAndStoreBookingDependencies,
  holdId: string,
  reason: string,
  now: Date,
): Promise<void> {
  try {
    await dependencies.repository.markHoldPaymentFailed({
      holdId,
      reason,
      now,
    });
  } catch (error) {
    await alertInfrastructureError(
      dependencies,
      "Failed to mark hold payment failed",
      { error: getErrorMessage(error), holdId },
    );
  }
}

async function cancelSquarePaymentSafe(
  dependencies: ConfirmChargeAndStoreBookingDependencies,
  hold: BookingHoldRecord,
  squarePaymentId: string,
  now: Date,
  idempotencyKey?: string,
): Promise<{ ok: true } | { ok: false }> {
  try {
    const response =
      await dependencies.squarePayments.cancelPayment(squarePaymentId);
    if (
      response.payment.id !== squarePaymentId ||
      response.payment.status !== "CANCELED"
    ) {
      await dependencies.alerts.alert({
        category: "stuck_payment_state",
        severity: "error",
        message:
          "Square cancellation did not return matching CANCELED evidence",
        context: {
          holdId: hold.id,
          returnedPaymentId: response.payment.id,
          returnedStatus: response.payment.status,
          squarePaymentId,
        },
      });
      return { ok: false };
    }

    try {
      const terminateAuthorization =
        dependencies.repository.markAuthorizedOperationalPaymentTerminated;
      const ledgerOutcome =
        terminateAuthorization === undefined
          ? "not_found"
          : await terminateAuthorization({
              holdId: hold.id,
              idempotencyKey,
              now,
              squarePaymentId,
              status: "cancelled",
            });
      if (ledgerOutcome === "capture_preserved") {
        return { ok: false };
      }
      if (
        ledgerOutcome === "not_found" &&
        resolveBookingModelVersion(hold) === 2
      ) {
        const terminateIntent =
          dependencies.repository.terminateOperationalPaymentIntent;
        const pendingTerminated =
          idempotencyKey !== undefined &&
          terminateIntent !== undefined &&
          (await terminateIntent({
            holdId: hold.id,
            idempotencyKey,
            now,
            status: "cancelled",
          }));
        if (!pendingTerminated) {
          await alertInfrastructureError(
            dependencies,
            "Square cancellation succeeded but no operational payment attempt was terminalized",
            { holdId: hold.id, squarePaymentId },
          );
          return { ok: false };
        }
      }
    } catch (ledgerError) {
      // Square is definitively canceled. Keep any durable authorization row
      // recoverable; a retry can observe CANCELED and repeat this DB step.
      await alertInfrastructureError(
        dependencies,
        "Square cancellation succeeded but its ledger transition failed",
        {
          error: getErrorMessage(ledgerError),
          holdId: hold.id,
          squarePaymentId,
        },
      );
      return { ok: false };
    }
    return { ok: true };
  } catch {
    await dependencies.alerts.alert({
      category: "square_webhook_retryable_failure",
      severity: "warning",
      message: "Failed to cancel Square payment after non-completed capture",
      context: {
        holdId: hold.id,
        holdReference: hold.publicReference,
        squarePaymentId,
      },
    });
    return { ok: false };
  }
}

async function markRefundRequiredAndReturnFailure(
  dependencies: ConfirmChargeAndStoreBookingDependencies,
  holdId: string,
  squarePaymentId: string,
  reason: string,
  now: Date,
  message: string,
  errorCode: "square_api_error" | "infrastructure_error" = "square_api_error",
  evidence?: {
    idempotencyKey?: string;
    providerEvidence: "cancellation_unconfirmed" | "completed";
  },
): Promise<ChargeAndStoreBookingResult> {
  try {
    const outcome = await dependencies.repository.markHoldRefundRequired({
      holdId,
      idempotencyKey: evidence?.idempotencyKey,
      squarePaymentId,
      providerEvidence: evidence?.providerEvidence,
      reason,
      now,
    });
    if (
      outcome?.status === "booking_outcome_preserved" &&
      outcome.confirmation !== undefined
    ) {
      return outcome.confirmation;
    }
  } catch (error) {
    await alertInfrastructureError(
      dependencies,
      "Failed to mark hold refund required after capture failure",
      { error: getErrorMessage(error), holdId, squarePaymentId },
    );
  }
  return {
    ok: false,
    error: errorCode,
    message,
  };
}

async function sendBookingSchedulingFailureAdminEmailSafe(
  dependencies: ConfirmChargeAndStoreBookingDependencies,
  input: SendBookingSchedulingFailureAdminEmailInput,
): Promise<void> {
  if (dependencies.sendBookingSchedulingFailureAdminEmail === undefined) {
    return;
  }

  try {
    await dependencies.sendBookingSchedulingFailureAdminEmail(input);
  } catch (emailError) {
    dependencies.alerts.alert({
      category: "stuck_payment_state",
      severity: "error",
      message: "Failed to send admin alert for booking scheduling failure",
      context: {
        error: getErrorMessage(emailError),
        holdId: input.hold?.id,
        reason: input.failureReason,
      },
    });
  }
}

async function sendBookingConfirmationEmailForHoldSafe(
  dependencies: ConfirmChargeAndStoreBookingDependencies,
  holdId: string,
): Promise<void> {
  if (dependencies.sendBookingConfirmationEmailForHold === undefined) {
    return;
  }

  try {
    await dependencies.sendBookingConfirmationEmailForHold(holdId);
  } catch (emailError) {
    dependencies.alerts.alert({
      category: "stuck_payment_state",
      severity: "error",
      message: "Failed to send customer booking outcome email",
      context: { error: getErrorMessage(emailError), holdId },
    });
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function zeroTaxQuote(): ReturnType<typeof calculateServiceBookingHstQuote> {
  return {
    expectedAmountCents: 0,
    policyVersion: SERVICE_BOOKING_HST_POLICY_VERSION,
    taxAmountCents: 0,
    taxableAmountCents: 0,
    taxName: SERVICE_BOOKING_HST_TAX_NAME,
    taxRate: SERVICE_BOOKING_HST_RATE,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBookingAnswers(value: unknown): BookingAnswerInput[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .map((item) => ({
      questionId: typeof item.questionId === "string" ? item.questionId : "",
      answer: typeof item.answer === "string" ? item.answer : "",
    }))
    .filter((item) => item.questionId.length > 0);
}
