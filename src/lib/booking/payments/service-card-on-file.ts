import type { BookingHoldRecord } from "@/lib/booking/holds";
import type { NoShowChargeStatus } from "@/lib/private-db/schema";
import type {
  SquareCreateCardRequest,
  SquareCreateCardResponse,
} from "@/lib/payments/square/cards-client";
import type {
  SquareCreateCustomerRequest,
  SquareCreateCustomerResponse,
} from "@/lib/payments/square/customers-client";

import type { NoShowInvoiceRepository } from "./service-no-show-invoice";
import type { ServicePaymentAlertLogger } from "./service-payment-alerts";
import {
  calculateServiceNoShowMaxChargeCents,
  getCanonicalServiceNoShowPolicyEvidence,
} from "./service-no-show-policy";
import {
  NoShowInvoiceBlockedError,
  NoShowInvoicePersistenceError,
} from "./service-no-show-invoice";

export class CardOnFileInfrastructureError extends Error {
  context?: Record<string, unknown>;

  constructor(message: string, context?: Record<string, unknown>) {
    super(message);
    this.name = "CardOnFileInfrastructureError";
    if (context !== undefined) {
      this.context = context;
    }
  }
}

export class CardOnFileSquareApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CardOnFileSquareApiError";
  }
}

export interface CardOnFileBookingRequestBody {
  cardholderName: string;
  holdReference: string;
  idempotencyKey: string;
  ipAddress?: string;
  policy: {
    accepted: true;
    maxChargeCents: number;
  };
  sourceId: string;
  userAgent?: string;
  verificationToken?: string;
}

export interface CardOnFileBookingResponseBody {
  bookingStatus: "booked" | "manual_followup";
  card: { brand?: string; expMonth?: number; expYear?: number; last4?: string };
  holdReference: string;
  noShowChargeStatus: "ready" | "provider_draft_created" | "manual_followup";
}

export type CardOnFileBookingError =
  | "invalid_request"
  | "hold_unavailable"
  | "square_api_error"
  | "infrastructure_error";

export interface CardOnFileBookingSuccessResult extends CardOnFileBookingResponseBody {
  ok: true;
}

export interface CardOnFileBookingFailureResult {
  ok: false;
  error: CardOnFileBookingError;
  message: string;
}

export type CardOnFileBookingResult =
  | CardOnFileBookingSuccessResult
  | CardOnFileBookingFailureResult;

export interface ExistingCardOnFileConfirmation {
  bookingStatus: "booked" | "manual_followup";
  card: { brand?: string; expMonth?: number; expYear?: number; last4?: string };
  holdReference: string;
  noShowChargeStatus: "ready" | "provider_draft_created" | "manual_followup";
}

export interface SquareCustomerRecord {
  id: string;
  squareCustomerId: string;
}

export interface SavedPaymentMethodRecord {
  id: string;
  brand?: string;
  expMonth?: number;
  expYear?: number;
  last4?: string;
  squareCardId: string;
}

export interface PolicyAcceptanceRecord {
  id: string;
}

export interface NoShowChargeRecordSummary {
  id: string;
  status: NoShowChargeStatus;
}

export interface CardOnFileProgressCheckpoint {
  squareCustomerId?: string;
  squareCustomerIdempotencyKey?: string;
  squareCardId?: string;
  squareCardIdempotencyKey?: string;
  savedPaymentMethodId?: string;
  policyAcceptanceId?: string;
  noShowChargeRecordId?: string;
  card?: {
    brand?: string;
    expMonth?: number;
    expYear?: number;
    last4?: string;
  };
}

export type BeginCardOnFileConfirmationResult =
  | { status: "available"; hold: BookingHoldRecord }
  | { status: "confirmed"; confirmation: ExistingCardOnFileConfirmation }
  | { status: "in_progress" }
  | { status: "unavailable" };

export interface CardOnFileRepository extends NoShowInvoiceRepository {
  beginCardOnFileConfirmation(input: {
    publicReference: string;
    idempotencyKey: string;
    now: Date;
  }): Promise<BeginCardOnFileConfirmationResult>;
  findSquareCustomerByEmail(
    email: string,
  ): Promise<SquareCustomerRecord | null>;
  persistSquareCustomer(input: {
    email: string;
    name: string;
    phone?: string;
    squareCustomerId: string;
    now: Date;
  }): Promise<SquareCustomerRecord>;
  findSavedPaymentMethodBySquareCardId(
    squareCardId: string,
  ): Promise<SavedPaymentMethodRecord | null>;
  persistSavedPaymentMethod(input: {
    squareCustomerRecordId: string;
    squareCardId: string;
    brand: string;
    last4: string;
    expMonth: number;
    expYear: number;
    now: Date;
  }): Promise<SavedPaymentMethodRecord>;
  findPolicyAcceptanceForHold(
    holdId: string,
  ): Promise<PolicyAcceptanceRecord | null>;
  persistPolicyAcceptance(input: {
    holdId: string;
    policyVersion: string;
    policyTextHash: string;
    maxChargeCents: number;
    currency: string;
    customerEmail: string;
    customerName: string;
    ipHash?: string;
    userAgentHash?: string;
    now: Date;
  }): Promise<PolicyAcceptanceRecord>;
  findNoShowChargeRecordForHold(
    holdId: string,
  ): Promise<NoShowChargeRecordSummary | null>;
  createNoShowChargeRecord(input: {
    holdId: string;
    savedPaymentMethodId?: string;
    policyAcceptanceId?: string;
    squareCustomerId?: string;
    squareCardId?: string;
    maxChargeCents: number;
    currency: string;
    status: NoShowChargeStatus;
    now: Date;
  }): Promise<NoShowChargeRecordSummary>;
  loadCardOnFileProgress(
    holdId: string,
  ): Promise<CardOnFileProgressCheckpoint | null>;
  saveCardOnFileProgress(input: {
    holdId: string;
    progress: Partial<CardOnFileProgressCheckpoint>;
    now: Date;
  }): Promise<void>;
  markHoldBookedWithConfirmation(input: {
    holdId: string;
    savedPaymentMethodId: string;
    policyAcceptanceId: string;
    noShowChargeRecordId: string;
    squareCustomerId: string;
    squareCardId: string;
    noShowChargeStatus: NoShowChargeStatus;
    googleEventId: string;
    idempotencyKey: string;
    confirmation: ExistingCardOnFileConfirmation;
    now: Date;
  }): Promise<BookingHoldRecord>;
  markHoldManualFollowupWithConfirmation(input: {
    holdId: string;
    savedPaymentMethodId: string;
    policyAcceptanceId: string;
    noShowChargeRecordId: string;
    squareCustomerId: string;
    squareCardId: string;
    noShowChargeStatus: NoShowChargeStatus;
    reason: string;
    idempotencyKey: string;
    confirmation: ExistingCardOnFileConfirmation;
    now: Date;
  }): Promise<BookingHoldRecord>;
}

export interface SquareCustomerGateway {
  createCustomer(
    request: SquareCreateCustomerRequest,
  ): Promise<SquareCreateCustomerResponse>;
}

export interface SquareCardGateway {
  createCard(
    request: SquareCreateCardRequest,
  ): Promise<SquareCreateCardResponse>;
}

export interface CardOnFileCalendarFinalizer {
  finalize(input: {
    hold: BookingHoldRecord;
    now: Date;
  }): Promise<
    | { ok: true; googleEventId: string }
    | { ok: false; status: "manual_followup"; error: string }
  >;
}

export interface NoShowInstrumentStep {
  createInstrument(input: {
    noShowChargeRecordId: string;
    holdId: string;
    squareCustomerId: string;
    squareCardId: string;
    customerEmail: string;
    maxChargeCents: number;
    currency: string;
    idempotencyKey: string;
    serviceDescription: string;
  }): Promise<{
    status: "ready" | "provider_draft_created" | "manual_followup";
  }>;
}

export interface ConfirmCardOnFileBookingDependencies {
  now?: Date;
  repository: CardOnFileRepository;
  squareCustomers: SquareCustomerGateway;
  squareCards: SquareCardGateway;
  calendarFinalizer: CardOnFileCalendarFinalizer;
  noShowInstrumentStep: NoShowInstrumentStep;
  alerts: ServicePaymentAlertLogger;
}

export async function confirmCardOnFileBooking(
  input: CardOnFileBookingRequestBody,
  dependencies: ConfirmCardOnFileBookingDependencies,
): Promise<CardOnFileBookingResult> {
  const now = dependencies.now ?? new Date();

  const validationMessage = validateCardOnFileBookingRequest(input);
  if (validationMessage !== null) {
    return { ok: false, error: "invalid_request", message: validationMessage };
  }

  let beginResult: BeginCardOnFileConfirmationResult;

  try {
    beginResult = await dependencies.repository.beginCardOnFileConfirmation({
      publicReference: input.holdReference,
      idempotencyKey: input.idempotencyKey,
      now,
    });
  } catch (error) {
    await alertInfrastructureError(
      dependencies,
      "Failed to load booking hold",
      {
        error: getErrorMessage(error),
        holdReference: input.holdReference,
      },
    );

    return {
      ok: false,
      error: "infrastructure_error",
      message: "Unable to load booking hold",
    };
  }

  if (beginResult.status === "unavailable") {
    return {
      ok: false,
      error: "hold_unavailable",
      message: "Booking hold is no longer available",
    };
  }

  if (beginResult.status === "in_progress") {
    await dependencies.alerts.alert({
      category: "stuck_payment_state",
      severity: "warning",
      message: "Card-on-file confirmation already in progress",
      context: {
        holdReference: input.holdReference,
        idempotencyKey: input.idempotencyKey,
      },
    });

    return {
      ok: false,
      error: "infrastructure_error",
      message: "Booking confirmation is already in progress",
    };
  }

  if (beginResult.status === "confirmed") {
    return { ok: true, ...beginResult.confirmation };
  }

  const hold = beginResult.hold;

  if (!isCardOnFileHoldAvailable(hold, now)) {
    return {
      ok: false,
      error: "hold_unavailable",
      message: "Booking hold is no longer available",
    };
  }

  const expectedMaxChargeCents = calculateServiceNoShowMaxChargeCents(
    hold.offeringSnapshot,
  );

  if (expectedMaxChargeCents <= 0) {
    return {
      ok: false,
      error: "invalid_request",
      message: "Hold does not have a valid no-show charge amount",
    };
  }

  if (input.policy.maxChargeCents !== expectedMaxChargeCents) {
    return {
      ok: false,
      error: "invalid_request",
      message: "Policy maximum charge does not match the booking amount",
    };
  }

  const checkpoint = await loadCheckpoint(dependencies.repository, hold.id);

  const squareCustomerResult = await createOrReuseSquareCustomer({
    checkpoint,
    hold,
    repository: dependencies.repository,
    squareCustomers: dependencies.squareCustomers,
  });

  if (!squareCustomerResult.ok) {
    const isInfrastructureError =
      squareCustomerResult.error instanceof CardOnFileInfrastructureError;

    await dependencies.alerts.alert({
      category: isInfrastructureError
        ? "stuck_payment_state"
        : "square_customer_creation_failed",
      severity: isInfrastructureError ? "error" : "warning",
      message: isInfrastructureError
        ? "Database failure while resolving Square customer for card-on-file booking"
        : "Square customer creation failed for card-on-file booking",
      context: {
        holdId: hold.id,
        holdReference: hold.publicReference,
      },
    });

    return {
      ok: false,
      error: isInfrastructureError
        ? "infrastructure_error"
        : "square_api_error",
      message: isInfrastructureError
        ? "Unable to confirm booking details"
        : "Unable to save card with payment provider",
    };
  }

  const squareCustomer = squareCustomerResult.customer;

  const cardResult = await createOrReuseSquareCard({
    cardholderName: input.cardholderName,
    checkpoint,
    hold,
    repository: dependencies.repository,
    sourceId: input.sourceId,
    squareCards: dependencies.squareCards,
    squareCustomer,
    verificationToken: input.verificationToken,
  });

  if (!cardResult.ok) {
    const isInfrastructureError =
      cardResult.error instanceof CardOnFileInfrastructureError;
    const errorContext =
      cardResult.error instanceof CardOnFileInfrastructureError
        ? cardResult.error.context
        : undefined;

    await dependencies.alerts.alert({
      category: isInfrastructureError
        ? "stuck_payment_state"
        : "square_card_save_failed",
      severity: isInfrastructureError ? "error" : "warning",
      message: isInfrastructureError
        ? "Database failure while saving card details for card-on-file booking"
        : "Square card save failed for card-on-file booking",
      context: {
        holdId: hold.id,
        holdReference: hold.publicReference,
        ...(errorContext ?? {}),
      },
    });

    return {
      ok: false,
      error: isInfrastructureError
        ? "infrastructure_error"
        : "square_api_error",
      message: isInfrastructureError
        ? "Unable to confirm booking details"
        : "Unable to save card with payment provider",
    };
  }

  const savedPaymentMethod = cardResult.paymentMethod;

  const policyAcceptanceEvidence = getCanonicalServiceNoShowPolicyEvidence({
    acceptedAt: now,
    customerEmail: hold.customer.email,
    customerName: hold.customer.name,
    ipAddress: input.ipAddress,
    maxChargeCents: input.policy.maxChargeCents,
    userAgent: input.userAgent,
  });

  let policyAcceptance: PolicyAcceptanceRecord;

  try {
    policyAcceptance = await resolvePolicyAcceptance(dependencies.repository, {
      holdId: hold.id,
      policyVersion: policyAcceptanceEvidence.policyVersion,
      policyTextHash: policyAcceptanceEvidence.policyTextHash,
      maxChargeCents: policyAcceptanceEvidence.maxChargeCents,
      currency: policyAcceptanceEvidence.currency,
      customerEmail: policyAcceptanceEvidence.customerEmail,
      customerName: policyAcceptanceEvidence.customerName,
      ipHash: policyAcceptanceEvidence.ipAddressHash,
      userAgentHash: policyAcceptanceEvidence.userAgentHash,
      now,
    });
  } catch (error) {
    await alertInfrastructureError(
      dependencies,
      "Failed to persist policy acceptance",
      {
        error: getErrorMessage(error),
        holdId: hold.id,
      },
    );

    return {
      ok: false,
      error: "infrastructure_error",
      message: "Unable to record policy acceptance",
    };
  }

  let noShowRecord: NoShowChargeRecordSummary;

  try {
    noShowRecord = await resolveNoShowChargeRecordSummary(
      dependencies.repository,
      {
        holdId: hold.id,
        savedPaymentMethodId: savedPaymentMethod.id,
        policyAcceptanceId: policyAcceptance.id,
        squareCustomerId: squareCustomer.squareCustomerId,
        squareCardId: savedPaymentMethod.squareCardId,
        maxChargeCents: input.policy.maxChargeCents,
        currency: "CAD",
        status: "ready",
        now,
      },
    );
  } catch (error) {
    await alertInfrastructureError(
      dependencies,
      "Failed to create no-show charge record",
      {
        error: getErrorMessage(error),
        holdId: hold.id,
      },
    );

    return {
      ok: false,
      error: "infrastructure_error",
      message: "Unable to initialize no-show charge record",
    };
  }

  let noShowInstrumentStatus:
    | "ready"
    | "provider_draft_created"
    | "manual_followup" = "ready";

  try {
    const instrumentResult =
      await dependencies.noShowInstrumentStep.createInstrument({
        noShowChargeRecordId: noShowRecord.id,
        holdId: hold.id,
        squareCustomerId: squareCustomer.squareCustomerId,
        squareCardId: savedPaymentMethod.squareCardId,
        customerEmail: hold.customer.email,
        maxChargeCents: input.policy.maxChargeCents,
        currency: "CAD",
        idempotencyKey: makeSquareIdempotencyKey("instrument", hold.id),
        serviceDescription: getServiceDescription(hold),
      });

    noShowInstrumentStatus = instrumentResult.status;

    if (noShowInstrumentStatus !== "ready") {
      const recordStatus: NoShowChargeStatus =
        noShowInstrumentStatus === "provider_draft_created"
          ? "provider_draft_created"
          : "manual_followup";

      noShowRecord = await dependencies.repository.updateNoShowChargeRecord({
        noShowChargeRecordId: noShowRecord.id,
        status: recordStatus,
      });
    }
  } catch (error) {
    noShowInstrumentStatus = "manual_followup";

    const message =
      error instanceof NoShowInvoiceBlockedError
        ? "No-show charge instrument could not be created"
        : "No-show instrument step failed";

    const providerContext =
      error instanceof NoShowInvoiceBlockedError ||
      error instanceof NoShowInvoicePersistenceError
        ? pickSafeProviderContext(error.context)
        : {};

    await alertInfrastructureError(dependencies, message, {
      error: getErrorMessage(error),
      holdId: hold.id,
      ...providerContext,
    });

    try {
      noShowRecord = await dependencies.repository.updateNoShowChargeRecord({
        noShowChargeRecordId: noShowRecord.id,
        status: "manual_followup",
        ...providerContext,
      });
    } catch {
      // Best-effort update; the response will still indicate manual follow-up.
    }

    return {
      ok: false,
      error: "infrastructure_error",
      message: "Unable to initialize no-show charge record",
    };
  }

  let calendarResult: Awaited<
    ReturnType<CardOnFileCalendarFinalizer["finalize"]>
  >;

  try {
    calendarResult = await dependencies.calendarFinalizer.finalize({
      hold,
      now,
    });
  } catch (error) {
    calendarResult = {
      ok: false,
      status: "manual_followup",
      error: getErrorMessage(error),
    };
  }

  const response: CardOnFileBookingSuccessResult = {
    ok: true,
    bookingStatus: calendarResult.ok ? "booked" : "manual_followup",
    card: cardDisplay(savedPaymentMethod),
    holdReference: hold.publicReference,
    noShowChargeStatus: noShowInstrumentStatus,
  };

  if (!calendarResult.ok) {
    await dependencies.alerts.alert({
      category: "booking_calendar_finalization_failed",
      severity: "warning",
      message:
        "Calendar finalization failed after card save; manual follow-up required",
      context: {
        holdId: hold.id,
        holdReference: hold.publicReference,
        reason: calendarResult.error,
      },
    });

    try {
      await dependencies.repository.markHoldManualFollowupWithConfirmation({
        holdId: hold.id,
        savedPaymentMethodId: savedPaymentMethod.id,
        policyAcceptanceId: policyAcceptance.id,
        noShowChargeRecordId: noShowRecord.id,
        squareCustomerId: squareCustomer.squareCustomerId,
        squareCardId: savedPaymentMethod.squareCardId,
        noShowChargeStatus: noShowRecord.status,
        reason: calendarResult.error,
        idempotencyKey: input.idempotencyKey,
        confirmation: response,
        now,
      });
    } catch (error) {
      await alertInfrastructureError(
        dependencies,
        "Failed to mark hold for manual follow-up",
        {
          error: getErrorMessage(error),
          holdId: hold.id,
        },
      );

      return {
        ok: false,
        error: "infrastructure_error",
        message: "Unable to finalize booking after card save",
      };
    }

    return response;
  }

  try {
    const bookedHold =
      await dependencies.repository.markHoldBookedWithConfirmation({
        holdId: hold.id,
        savedPaymentMethodId: savedPaymentMethod.id,
        policyAcceptanceId: policyAcceptance.id,
        noShowChargeRecordId: noShowRecord.id,
        squareCustomerId: squareCustomer.squareCustomerId,
        squareCardId: savedPaymentMethod.squareCardId,
        noShowChargeStatus: noShowRecord.status,
        googleEventId: calendarResult.googleEventId,
        idempotencyKey: input.idempotencyKey,
        confirmation: response,
        now,
      });

    return {
      ...response,
      holdReference: bookedHold.publicReference,
    };
  } catch (error) {
    await alertInfrastructureError(
      dependencies,
      "Failed to finalize booking after Calendar success",
      {
        error: getErrorMessage(error),
        holdId: hold.id,
      },
    );

    return {
      ok: false,
      error: "infrastructure_error",
      message: "Unable to finalize booking after Calendar success",
    };
  }
}

async function createOrReuseSquareCustomer(input: {
  checkpoint: CardOnFileProgressCheckpoint;
  hold: BookingHoldRecord;
  repository: CardOnFileRepository;
  squareCustomers: SquareCustomerGateway;
}): Promise<
  { ok: true; customer: SquareCustomerRecord } | { ok: false; error: Error }
> {
  // A previously persisted customer can always be recovered by email because the
  // hold itself carries the canonical customer email.
  try {
    const existing = await input.repository.findSquareCustomerByEmail(
      input.hold.customer.email,
    );

    if (existing !== null) {
      return { ok: true, customer: existing };
    }
  } catch (error) {
    return {
      ok: false,
      error: new CardOnFileInfrastructureError(getErrorMessage(error)),
    };
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
    return {
      ok: false,
      error: new CardOnFileSquareApiError(getErrorMessage(error)),
    };
  }

  try {
    const customer = await input.repository.persistSquareCustomer({
      email: input.hold.customer.email,
      name: input.hold.customer.name,
      phone: input.hold.customer.phone,
      squareCustomerId: response.customer.id,
      now: new Date(),
    });

    await saveCheckpoint(input.repository, input.hold.id, {
      squareCustomerId: response.customer.id,
      squareCustomerIdempotencyKey: idempotencyKey,
    });

    return { ok: true, customer };
  } catch (error) {
    const existingAfterError = await safeFindSquareCustomerByEmail(
      input.repository,
      input.hold.customer.email,
    );

    if (existingAfterError !== null) {
      return { ok: true, customer: existingAfterError };
    }

    return {
      ok: false,
      error: new CardOnFileInfrastructureError(getErrorMessage(error)),
    };
  }
}

async function createOrReuseSquareCard(input: {
  cardholderName: string;
  checkpoint: CardOnFileProgressCheckpoint;
  hold: BookingHoldRecord;
  repository: CardOnFileRepository;
  sourceId: string;
  squareCards: SquareCardGateway;
  squareCustomer: SquareCustomerRecord;
  verificationToken?: string;
}): Promise<
  | { ok: true; paymentMethod: SavedPaymentMethodRecord }
  | { ok: false; error: Error }
> {
  // Recover a card created by a previous attempt for this hold using the real
  // Square card id stored in the checkpoint. The checkpoint is best-effort and
  // may be JSON-cast or partially written, so validate the id before using it
  // for lookups or persistence. Real Square card-on-file ids start with "ccof:"
  // followed by a non-empty suffix without whitespace.
  const checkpointSquareCardId = input.checkpoint.squareCardId;
  if (isValidSquareCardId(checkpointSquareCardId)) {
    try {
      const existing =
        await input.repository.findSavedPaymentMethodBySquareCardId(
          checkpointSquareCardId,
        );
      if (existing !== null) {
        return { ok: true, paymentMethod: existing };
      }
    } catch (error) {
      return {
        ok: false,
        error: new CardOnFileInfrastructureError(getErrorMessage(error)),
      };
    }

    // If a previous attempt created the Square card but failed before persisting
    // the local saved-payment record, reuse the provider card and complete the
    // local persistence without creating another Square card. Validate the
    // checkpoint card details first because the checkpoint may be JSON-cast or
    // partially written.
    const checkpointCard = input.checkpoint.card;
    if (checkpointCard !== undefined && isValidCheckpointCard(checkpointCard)) {
      try {
        const paymentMethod = await input.repository.persistSavedPaymentMethod({
          squareCustomerRecordId: input.squareCustomer.id,
          squareCardId: checkpointSquareCardId,
          brand: checkpointCard.brand,
          last4: checkpointCard.last4,
          expMonth: checkpointCard.expMonth,
          expYear: checkpointCard.expYear,
          now: new Date(),
        });

        await saveCheckpoint(input.repository, input.hold.id, {
          savedPaymentMethodId: paymentMethod.id,
        });

        return { ok: true, paymentMethod };
      } catch (error) {
        const existingAfterError =
          await input.repository.findSavedPaymentMethodBySquareCardId(
            checkpointSquareCardId,
          );

        if (existingAfterError !== null) {
          return { ok: true, paymentMethod: existingAfterError };
        }

        return {
          ok: false,
          error: new CardOnFileInfrastructureError(getErrorMessage(error)),
        };
      }
    }
  }

  const idempotencyKey = makeSquareIdempotencyKey("card", input.hold.id);

  let response: SquareCreateCardResponse;

  try {
    response = await input.squareCards.createCard({
      idempotency_key: idempotencyKey,
      source_id: input.sourceId,
      verification_token: input.verificationToken,
      card: {
        customer_id: input.squareCustomer.squareCustomerId,
        cardholder_name: input.cardholderName,
        reference_id: input.hold.publicReference,
      },
    });
  } catch (error) {
    return {
      ok: false,
      error: new CardOnFileSquareApiError(getErrorMessage(error)),
    };
  }

  // Persist a checkpoint immediately after Square card creation so a retry can
  // recover the provider card id even if the local saved-payment insert fails.
  try {
    await input.repository.saveCardOnFileProgress({
      holdId: input.hold.id,
      progress: {
        squareCardId: response.card.id,
        squareCardIdempotencyKey: idempotencyKey,
        card: {
          brand: response.card.card_brand,
          expMonth: response.card.exp_month,
          expYear: response.card.exp_year,
          last4: response.card.last_4,
        },
      },
      now: new Date(),
    });
  } catch (error) {
    return {
      ok: false,
      error: new CardOnFileInfrastructureError(
        `Square card was created but local checkpoint failed: ${getErrorMessage(error)}`,
        { squareCardId: response.card.id },
      ),
    };
  }

  try {
    const paymentMethod = await input.repository.persistSavedPaymentMethod({
      squareCustomerRecordId: input.squareCustomer.id,
      squareCardId: response.card.id,
      brand: response.card.card_brand,
      last4: response.card.last_4,
      expMonth: response.card.exp_month,
      expYear: response.card.exp_year,
      now: new Date(),
    });

    await saveCheckpoint(input.repository, input.hold.id, {
      savedPaymentMethodId: paymentMethod.id,
    });

    return { ok: true, paymentMethod };
  } catch (error) {
    const existingAfterError =
      await input.repository.findSavedPaymentMethodBySquareCardId(
        response.card.id,
      );

    if (existingAfterError !== null) {
      return { ok: true, paymentMethod: existingAfterError };
    }

    return {
      ok: false,
      error: new CardOnFileInfrastructureError(getErrorMessage(error)),
    };
  }
}

async function resolvePolicyAcceptance(
  repository: CardOnFileRepository,
  input: {
    holdId: string;
    policyVersion: string;
    policyTextHash: string;
    maxChargeCents: number;
    currency: string;
    customerEmail: string;
    customerName: string;
    ipHash?: string;
    userAgentHash?: string;
    now: Date;
  },
): Promise<PolicyAcceptanceRecord> {
  const existing = await safeFindPolicyAcceptanceForHold(
    repository,
    input.holdId,
  );
  if (existing !== null) {
    return existing;
  }

  try {
    return await repository.persistPolicyAcceptance(input);
  } catch (error) {
    const afterError = await safeFindPolicyAcceptanceForHold(
      repository,
      input.holdId,
    );
    if (afterError !== null) {
      return afterError;
    }
    throw error;
  }
}

async function resolveNoShowChargeRecordSummary(
  repository: CardOnFileRepository,
  input: {
    holdId: string;
    savedPaymentMethodId?: string;
    policyAcceptanceId?: string;
    squareCustomerId?: string;
    squareCardId?: string;
    maxChargeCents: number;
    currency: string;
    status: NoShowChargeStatus;
    now: Date;
  },
): Promise<NoShowChargeRecordSummary> {
  const existing = await safeFindNoShowChargeRecordSummaryForHold(
    repository,
    input.holdId,
  );
  if (existing !== null) {
    return existing;
  }

  try {
    return await repository.createNoShowChargeRecord(input);
  } catch (error) {
    const afterError = await safeFindNoShowChargeRecordSummaryForHold(
      repository,
      input.holdId,
    );
    if (afterError !== null) {
      return afterError;
    }
    throw error;
  }
}

function makeSquareIdempotencyKey(scope: string, holdId: string): string {
  return `card-on-file:${scope}:${holdId}`;
}

async function loadCheckpoint(
  repository: CardOnFileRepository,
  holdId: string,
): Promise<CardOnFileProgressCheckpoint> {
  try {
    return (await repository.loadCardOnFileProgress(holdId)) ?? {};
  } catch {
    return {};
  }
}

async function saveCheckpoint(
  repository: CardOnFileRepository,
  holdId: string,
  progress: Partial<CardOnFileProgressCheckpoint>,
): Promise<void> {
  try {
    await repository.saveCardOnFileProgress({
      holdId,
      progress,
      now: new Date(),
    });
  } catch {
    // Checkpoint is best-effort; record-level idempotency still protects against duplicates.
  }
}

async function safeFindSquareCustomerByEmail(
  repository: CardOnFileRepository,
  email: string,
): Promise<SquareCustomerRecord | null> {
  try {
    return await repository.findSquareCustomerByEmail(email);
  } catch {
    return null;
  }
}

async function safeFindPolicyAcceptanceForHold(
  repository: CardOnFileRepository,
  holdId: string,
): Promise<PolicyAcceptanceRecord | null> {
  try {
    return await repository.findPolicyAcceptanceForHold(holdId);
  } catch {
    return null;
  }
}

async function safeFindNoShowChargeRecordSummaryForHold(
  repository: CardOnFileRepository,
  holdId: string,
): Promise<NoShowChargeRecordSummary | null> {
  try {
    return await repository.findNoShowChargeRecordForHold(holdId);
  } catch {
    return null;
  }
}

function validateCardOnFileBookingRequest(
  body: CardOnFileBookingRequestBody,
): string | null {
  if (!isRecord(body)) {
    return "Invalid request body";
  }

  if (!isRecord(body.policy)) {
    return "Policy acceptance is required";
  }

  if (body.policy.accepted !== true) {
    return "Policy acceptance is required";
  }

  if (
    typeof body.cardholderName !== "string" ||
    body.cardholderName.trim().length === 0
  ) {
    return "Cardholder name is required";
  }

  if (
    typeof body.holdReference !== "string" ||
    body.holdReference.trim().length === 0
  ) {
    return "Hold reference is required";
  }

  if (
    typeof body.idempotencyKey !== "string" ||
    body.idempotencyKey.trim().length === 0
  ) {
    return "Idempotency key is required";
  }

  if (typeof body.sourceId !== "string" || body.sourceId.trim().length === 0) {
    return "Card source identifier is required";
  }

  if (
    typeof body.policy.maxChargeCents !== "number" ||
    !Number.isFinite(body.policy.maxChargeCents) ||
    body.policy.maxChargeCents <= 0
  ) {
    return "Policy maximum charge must be a positive amount";
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

function isCardOnFileHoldAvailable(
  hold: BookingHoldRecord,
  now: Date,
): boolean {
  return hold.state === "held" && hold.expiresAt > now;
}

function cardDisplay(paymentMethod: SavedPaymentMethodRecord): {
  brand?: string;
  expMonth?: number;
  expYear?: number;
  last4?: string;
} {
  return {
    brand: paymentMethod.brand,
    expMonth: paymentMethod.expMonth,
    expYear: paymentMethod.expYear,
    last4: paymentMethod.last4,
  };
}

function isValidCheckpointCard(
  card: unknown,
): card is { brand: string; expMonth: number; expYear: number; last4: string } {
  if (!isRecord(card)) return false;

  const { brand, last4, expMonth, expYear } = card;

  if (typeof brand !== "string" || brand.trim().length === 0) return false;
  if (typeof last4 !== "string" || !/^\d{4}$/.test(last4)) return false;
  if (
    typeof expMonth !== "number" ||
    !Number.isInteger(expMonth) ||
    expMonth < 1 ||
    expMonth > 12
  ) {
    return false;
  }
  if (
    typeof expYear !== "number" ||
    !Number.isInteger(expYear) ||
    expYear < 2000 ||
    expYear > 9999
  ) {
    return false;
  }

  return true;
}

function isValidSquareCardId(value: unknown): value is string {
  return typeof value === "string" && /^ccof:\S+$/.test(value);
}

function getServiceDescription(hold: BookingHoldRecord): string {
  const title = hold.offeringSnapshot.title;

  return typeof title === "string" && title.trim().length > 0
    ? title
    : "Lash appointment";
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
  dependencies: ConfirmCardOnFileBookingDependencies,
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

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickSafeProviderContext(
  context:
    | {
        squareInvoiceId?: string;
        squareOrderId?: string;
        deleteFailed?: boolean;
        providerStatus?: string;
      }
    | undefined,
): Record<string, unknown> {
  if (context === undefined) return {};

  const safe: Record<string, unknown> = {};
  if (typeof context.squareInvoiceId === "string")
    safe.squareInvoiceId = context.squareInvoiceId;
  if (typeof context.squareOrderId === "string")
    safe.squareOrderId = context.squareOrderId;
  if (typeof context.deleteFailed === "boolean")
    safe.deleteFailed = context.deleteFailed;
  if (typeof context.providerStatus === "string")
    safe.providerStatus = context.providerStatus;

  return safe;
}
