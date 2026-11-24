import "server-only";

import { getSquareCommerceEnv } from "@/lib/env/private-checkout";
import { getSquareCoursePayment } from "@/lib/payments/square/payments-client";
import { PurchaseDependencyError } from "./course-api";
import {
  COURSE_AGREEMENT_SUBJECT,
  COURSE_RECEIPT_AND_TERMS_SUBJECT,
  renderCourseAgreement,
  renderCourseReceipt,
} from "./receipt";
import { orderReference, type CourseOrder } from "./store";

function squareReceiptUrl(value?: string) {
  const url = value ? URL.parse(value) : null;
  if (
    !url ||
    !["https://squareup.com", "https://www.squareup.com"].includes(url.origin) ||
    url.username || url.password ||
    !url.pathname.startsWith("/receipt/")
  ) throw new PurchaseDependencyError(502);
  return url.href;
}

export async function courseSaleDocument(order: CourseOrder) {
  if (!order.squareOrderId) {
    return {
      subject: order.purchaseTerms ? COURSE_RECEIPT_AND_TERMS_SUBJECT : "Your Lash Her course payment receipt",
      html: renderCourseReceipt(order),
    };
  }

  const square = getSquareCommerceEnv(true);
  if (!square || !order.squarePaymentId || square.locationId !== order.squareLocationId)
    throw new PurchaseDependencyError(503);

  // Square doesn't host Sandbox payment receipts. Its protected synthetic
  // buyer can still receive the written agreement.
  if (square.environment === "sandbox") {
    return { subject: COURSE_AGREEMENT_SUBJECT, html: renderCourseAgreement(order, null) };
  }

  const { payment } = await getSquareCoursePayment(square, order.squarePaymentId);
  if (
    payment.id !== order.squarePaymentId || payment.order_id !== order.squareOrderId ||
    payment.reference_id !== orderReference(order.id) || payment.location_id !== order.squareLocationId ||
    payment.status !== "COMPLETED" || payment.source_type !== "CARD" ||
    payment.amount_money.currency !== "CAD" || payment.amount_money.amount !== order.totalCents
  ) throw new PurchaseDependencyError(502);

  return {
    subject: COURSE_AGREEMENT_SUBJECT,
    html: renderCourseAgreement(order, squareReceiptUrl(payment.receipt_url)),
  };
}
