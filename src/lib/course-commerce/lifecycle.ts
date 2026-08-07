import type { CoursePaymentProvider } from "./entitlement-commands";

export interface CoursePaymentEventClaim {
  eventType: string;
  payloadHash: string;
  payloadSanitized?: Readonly<Record<string, unknown>>;
  providerEventId: string;
}

export interface FinalizeCoursePaymentInput {
  event?: CoursePaymentEventClaim;
  orderId: string;
  paidAt: Date;
  provider: CoursePaymentProvider;
  providerTransactionId: string;
}

export interface FinalizeCoursePaymentResult {
  duplicate: boolean;
  grantsEnqueued: number;
  itemsMarkedPaid: number;
  orderMarkedPaid: boolean;
}

export interface ClaimGuestCourseOrderInput {
  claimedAt: Date;
  normalizedEmail: string;
  orderId: string;
  userId: string;
}

export interface ClaimGuestCourseOrderResult {
  alreadyClaimed: boolean;
  grantsEnqueued: number;
  itemsClaimed: number;
}

export interface CourseLifecycleRepository {
  claimGuestCourseOrder(
    input: ClaimGuestCourseOrderInput,
  ): Promise<ClaimGuestCourseOrderResult>;
  finalizeCoursePayment(
    input: FinalizeCoursePaymentInput,
  ): Promise<FinalizeCoursePaymentResult>;
}

export class CourseLifecycleConflictError extends Error {
  constructor(
    message: string,
    readonly code:
      | "EVENT_PAYLOAD_COLLISION"
      | "PAYMENT_TRANSACTION_COLLISION"
      | "SPLIT_ORDER_OWNERSHIP",
  ) {
    super(message);
    this.name = "CourseLifecycleConflictError";
  }
}

export class CourseLifecycleValidationError extends Error {
  constructor(
    message: string,
    readonly code:
      | "EMAIL_NOT_VERIFIED_FOR_USER"
      | "COURSE_ORDER_ITEMS_MISSING"
      | "NOT_COURSE_ORDER"
      | "ORDER_EMAIL_MISMATCH"
      | "ORDER_NOT_FOUND",
  ) {
    super(message);
    this.name = "CourseLifecycleValidationError";
  }
}

export function assertCourseOrderHasItems(items: readonly unknown[]): void {
  if (items.length === 0) {
    throw new CourseLifecycleValidationError(
      "Course checkout order has no course items",
      "COURSE_ORDER_ITEMS_MISSING",
    );
  }
}

export function createCourseLifecycleService(
  repository: CourseLifecycleRepository,
): CourseLifecycleRepository {
  return {
    claimGuestCourseOrder(input) {
      assertDate(input.claimedAt, "claimedAt");
      assertNonEmpty(input.normalizedEmail, "normalizedEmail");
      assertNonEmpty(input.orderId, "orderId");
      assertNonEmpty(input.userId, "userId");
      return repository.claimGuestCourseOrder(input);
    },
    finalizeCoursePayment(input) {
      assertDate(input.paidAt, "paidAt");
      assertNonEmpty(input.orderId, "orderId");
      assertNonEmpty(input.providerTransactionId, "providerTransactionId");

      if (input.event) {
        assertNonEmpty(input.event.eventType, "event.eventType");
        assertNonEmpty(input.event.payloadHash, "event.payloadHash");
        assertNonEmpty(input.event.providerEventId, "event.providerEventId");
      }

      return repository.finalizeCoursePayment(input);
    },
  };
}

function assertDate(value: Date, field: string): void {
  if (Number.isNaN(value.getTime())) {
    throw new TypeError(`${field} must be a valid date`);
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new TypeError(`${field} must not be empty`);
  }
}
