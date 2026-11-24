import "server-only";

import { createHash, randomUUID } from "node:crypto";
import type { CustomerActor } from "@/lib/customer-auth/session";
import { getSquareCommerceEnv } from "@/lib/env/private-checkout";
import {
  cancelSquareCoursePayment,
  completeSquareCoursePayment,
  createSquareCoursePayment,
  SquareApiError,
} from "@/lib/payments/square/payments-client";
import { markWriterOperationUncertain } from "@/lib/writer-admission/context";
import { readCourseOffer, PurchaseDependencyError } from "./course-api";
import { calculateCourseTax, getCourseSalesPolicy, readCourseTaxComponents } from "./tax";
import type { CourseBilling } from "./schema";
import {
  hasLiveCourseOrder,
  observeCoursePayment,
  orderReference,
  readCourseOrder,
  recordDecline,
  reserveCourseCharge,
  saveCourseQuote,
  type CourseOrder,
} from "./store";

export function requireCourseSquare() {
  const square = getSquareCommerceEnv(true);
  if (!square) throw new PurchaseDependencyError(503);
  return square;
}

export function publicCourseOrder(order: CourseOrder) {
  return {
    id: order.id,
    courseId: order.courseId,
    slug: order.courseSlug,
    status: order.status,
    access: order.access,
    currency: "CAD" as const,
    priceCents: order.priceCents,
    taxCents: order.taxCents,
    taxComponents: readCourseTaxComponents(order.taxBreakdown).map(
      ({ taxCode, label, amount }) => ({ taxCode, label, amount }),
    ),
    taxBehavior: order.taxBehavior,
    totalCents: order.totalCents,
    refundedCents: order.refundedCents,
    disclosure: order.disclosure,
    purchaseTerms: order.purchaseTerms,
    seller: order.receiptSeller,
    expiresAt: order.quoteExpiresAt.toISOString(),
  };
}

export async function quoteCourse(
  actor: CustomerActor,
  courseId: string,
  billing: CourseBilling,
  scopedOrderId?: string,
) {
  const square = requireCourseSquare();
  if (scopedOrderId && await readCourseOrder(scopedOrderId))
    throw new PurchaseDependencyError(409, "This checkout already has an order.");
  const offer = await readCourseOffer(actor.id, courseId);
  if (offer.hasAccess || (await hasLiveCourseOrder(actor.id, courseId)))
    throw new PurchaseDependencyError(
      409,
      "Access or a purchase already exists for this course.",
    );
  const policy = getCourseSalesPolicy(billing, offer.taxClassification);
  const id = scopedOrderId ?? randomUUID();
  const tax = await calculateCourseTax(id, offer.priceCents, billing, policy);
  // Ontario's covered internet agreements require a supplier telephone number.
  if (square.environment === "production" && tax.totalCents > 5_000 && !policy.receiptSeller?.phone)
    throw new PurchaseDependencyError(503);
  return saveCourseQuote({
    id,
    customerId: actor.id,
    email: actor.email,
    courseId,
    courseRevision: offer.revision,
    courseSlug: offer.slug,
    courseTitle: offer.title,
    taxClassification: offer.taxClassification,
    billing,
    policyHash: policy.hash,
    policyVersion: policy.version,
    disclosure: policy.disclosure,
    receiptSeller: policy.receiptSeller,
    purchaseTerms: policy.purchaseTerms && {
      version: policy.purchaseTerms.version,
      text: policy.purchaseTerms.text.replaceAll("[course title]", () => offer.title),
    },
    taxBehavior: policy.behavior,
    taxCode: policy.taxCode,
    priceCents: offer.priceCents,
    squareLocationId: square.locationId,
    ...tax,
  }, scopedOrderId !== undefined);
}

const cardDeclines = new Set([
  "CARD_DECLINED",
  "GENERIC_DECLINE",
  "CVV_FAILURE",
  "ADDRESS_VERIFICATION_FAILURE",
  "INSUFFICIENT_FUNDS",
  "CARD_EXPIRED",
  "INVALID_EXPIRATION",
]);

export async function payForCourse(
  actor: CustomerActor,
  input: {
    orderId: string;
    sourceId: string;
    verificationToken?: string;
    acceptedTermsVersion?: string;
  },
  scopedCourseId?: string,
) {
  const square = requireCourseSquare();
  const current = await readCourseOrder(input.orderId, actor.id);
  if (!current || (scopedCourseId && current.courseId !== scopedCourseId))
    throw new PurchaseDependencyError(404);
  if (
    current.status !== "quoted" &&
    (current.status !== "charging" || current.squarePaymentId)
  )
    return current;
  if (current.quoteExpiresAt.getTime() <= Date.now()) {
    if (current.status === "charging") return current;
    throw new PurchaseDependencyError(
      409,
      "This quote expired. Calculate the total again.",
    );
  }
  const [offer, hasOrder] = await Promise.all([
    readCourseOffer(actor.id, current.courseId),
    hasLiveCourseOrder(actor.id, current.courseId, current.id),
  ]);
  const policy = getCourseSalesPolicy(current.billing, offer.taxClassification);
  if (
    offer.revision !== current.courseRevision ||
    offer.priceCents !== current.priceCents ||
    policy.hash !== current.policyHash ||
    square.locationId !== current.squareLocationId
  )
    throw new PurchaseDependencyError(
      409,
      "The course or tax policy changed. Calculate the total again.",
    );
  if (offer.hasAccess || hasOrder)
    throw new PurchaseDependencyError(
      409,
      "Access or a purchase already exists for this course.",
    );
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([input.sourceId, input.verificationToken ?? null]))
    .digest("hex");
  const { order, send } = await reserveCourseCharge(
    current.id,
    actor.id,
    fingerprint,
    input.acceptedTermsVersion,
  );
  if (!send) {
    if (order.status === "quoted")
      throw new PurchaseDependencyError(
        409,
        "This quote expired. Calculate the total again.",
      );
    return order;
  }
  try {
    const { payment } = await createSquareCoursePayment(square, {
      location_id: order.squareLocationId,
      reference_id: orderReference(order.id),
      idempotency_key: `cp-${order.id}`,
      source_id: input.sourceId,
      autocomplete: false,
      amount_money: { amount: order.totalCents, currency: "CAD" },
      ...(input.verificationToken
        ? { verification_token: input.verificationToken }
        : {}),
    });
    const authorized = await observeCoursePayment(order.id, payment);
    if (authorized.status !== "charging" || payment.status !== "APPROVED")
      return authorized;
    // Require a card authorization before capturing the payment.
    const response =
      payment.source_type === "CARD"
        ? await completeSquareCoursePayment(square, payment)
        : await cancelSquareCoursePayment(square, payment.id);
    return await observeCoursePayment(order.id, response.payment);
  } catch (error) {
    if (
      error instanceof SquareApiError &&
      error.status >= 400 &&
      error.status < 500 &&
      error.code &&
      cardDeclines.has(error.code)
    )
      return (await recordDecline(order.id)) ?? order;
    // Capture may have completed. A verified Square callback or recovery read must settle it.
    markWriterOperationUncertain();
    return (await readCourseOrder(order.id, actor.id)) ?? order;
  }
}
