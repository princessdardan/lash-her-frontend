import "server-only";

import { and, eq } from "drizzle-orm";
import { getPrivateDb } from "@/lib/private-db/client";
import { getResendClient } from "@/lib/transactional-email";
import type { resolveP407CheckoutScope } from "./p407-checkout-scope";
import {
  courseRefundReceiptSubject,
  renderCourseRefundReceipt,
} from "./receipt";
import { resolveCourseReceiptDestination } from "./receipt-destination";
import { courseSaleDocument } from "./sale-document";
import { coursePurchaseJobs } from "./schema";
import { readCourseOrder, readCourseRefundConfirmation } from "./store";

const providerMessageId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;

export async function readCourseReceiptQualification(
  scope: NonNullable<ReturnType<typeof resolveP407CheckoutScope>>,
  kind: "receipt" | "refund_receipt",
) {
  const recipient = resolveCourseReceiptDestination({
    id: scope.orderId,
    customerId: scope.customerId,
    courseId: scope.courseId,
    email: `p408-sandbox-${scope.customerId}@example.invalid`,
  }, kind);
  if (!recipient) return { httpStatus: 409 } as const;

  const order = await readCourseOrder(scope.orderId, scope.customerId);
  if (!order) return { httpStatus: 200, evidence: { status: "awaiting_purchase" } } as const;
  if (
    resolveCourseReceiptDestination(order, kind) !== recipient ||
    !order.purchaseTerms || !order.termsAcceptedAt || !order.chargedAt
  ) return { httpStatus: 409 } as const;

  const [job, duplicate] = await getPrivateDb().transaction((tx) =>
    tx.select({
      status: coursePurchaseJobs.status,
      receipt: coursePurchaseJobs.destinationReceipt,
      refundId: coursePurchaseJobs.refundId,
      createdAt: coursePurchaseJobs.createdAt,
    })
      .from(coursePurchaseJobs)
      .where(and(eq(coursePurchaseJobs.orderId, order.id), eq(coursePurchaseJobs.kind, kind)))
      .limit(2), { accessMode: "read only" });
  if (duplicate || job?.status !== "done" || !job.receipt || !providerMessageId.test(job.receipt))
    return { httpStatus: 409 } as const;

  let subject: string;
  let html: string;
  if (kind === "refund_receipt") {
    if (!job.refundId) return { httpStatus: 409 } as const;
    const confirmation = await readCourseRefundConfirmation(order.id, job.refundId);
    if (!confirmation?.taxReceipt) return { httpStatus: 409 } as const;
    subject = courseRefundReceiptSubject(order.id);
    html = renderCourseRefundReceipt(order, confirmation.refund, confirmation.taxReceipt, job.createdAt);
  } else {
    ({ subject, html } = await courseSaleDocument(order));
  }

  const { data, error } = await getResendClient().emails.get(job.receipt);
  if (error || !data) return { httpStatus: 503 } as const;
  return {
    httpStatus: 200,
    evidence: {
      status: data.last_event,
      exactRecipient: data.to.length === 1 && data.to[0] === recipient && !data.cc?.length && !data.bcc?.length,
      receiptMatchesOrder: data.id === job.receipt && data.subject === subject && data.html === html,
      ...(kind === "receipt" && {
        termsVersion: order.purchaseTerms.version,
        termsAcceptedAt: order.termsAcceptedAt.toISOString(),
      }),
    },
  } as const;
}
