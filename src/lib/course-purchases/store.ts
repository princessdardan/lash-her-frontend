import "server-only";

import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  lte,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getPrivateDb } from "@/lib/private-db/client";
import { customerUsers } from "@/lib/customer-auth/schema";
import {
  compareSquareDisputeRevisions,
  type SquareDispute,
  type SquarePayment,
  type SquareRefund,
} from "@/lib/payments/square/payments-client";
import { PurchaseDependencyError } from "./course-api";
import { rateTableRefundTax, rateTableTaxReference } from "./tax";
import { purchaseJobKey, type JobDetails } from "./job-key";
import {
  coursePurchaseDisputes as disputes,
  coursePurchaseOrders as orders,
  coursePurchaseJobs as jobs,
  coursePurchaseRefunds as refunds,
  coursePurchaseJobReplays as replays,
} from "./schema";

export type CourseOrder = typeof orders.$inferSelect;
export type CourseJob = typeof jobs.$inferSelect;
type Transaction = Parameters<
  Parameters<ReturnType<typeof getPrivateDb>["transaction"]>[0]
>[0];
export const orderReference = (id: string) => `co-${id}`;
export const lookupReference = (reference?: string) =>
  reference &&
  /^co-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(reference)
    ? reference.slice(3)
    : undefined;

export async function readCourseOrder(id: string, customerId?: string) {
  const [order] = await getPrivateDb()
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.id, id),
        customerId ? eq(orders.customerId, customerId) : undefined,
      ),
    );
  return order;
}

export async function findCoursePayment(paymentId: string) {
  const [order] = await getPrivateDb()
    .select()
    .from(orders)
    .where(eq(orders.squarePaymentId, paymentId));
  return order;
}

export async function unresolvedCoursePaymentExists() {
  const [order] = await getPrivateDb()
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.status, "charging"),
        sql`${orders.squarePaymentId} is null`,
      ),
    )
    .limit(1);
  return Boolean(order);
}

export async function hasLiveCourseOrder(
  customerId: string,
  courseId: string,
  except?: string,
) {
  const rows = await getPrivateDb()
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.customerId, customerId),
        eq(orders.courseId, courseId),
        inArray(orders.status, ["charging", "paid"]),
        except ? sql`${orders.id} <> ${except}` : undefined,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function saveCourseQuote(input: typeof orders.$inferInsert, singleOrder = false) {
  const insert = getPrivateDb().insert(orders).values(input);
  if (!singleOrder) {
    const [order] = await insert.returning();
    return order;
  }
  const [order] = await insert.onConflictDoNothing({ target: orders.id }).returning();
  if (!order)
    throw new PurchaseDependencyError(409, "This checkout already has an order.");
  return order;
}

async function lockOrder(tx: Transaction, id: string) {
  const [order] = await tx
    .select()
    .from(orders)
    .where(eq(orders.id, id))
    .for("update");
  return order;
}

export async function reserveCourseCharge(
  id: string,
  customerId: string,
  fingerprint: string,
) {
  try {
    return await getPrivateDb().transaction(async (tx) => {
      const [actor] = await tx
        .select({ status: customerUsers.status })
        .from(customerUsers)
        .where(eq(customerUsers.id, customerId))
        .for("share");
      if (actor?.status !== "active") throw new PurchaseDependencyError(403);
      const order = await lockOrder(tx, id);
      if (!order || order.customerId !== customerId)
        throw new PurchaseDependencyError(404);
      if (
        order.status === "quoted" &&
        order.quoteExpiresAt.getTime() > Date.now()
      ) {
        const [reserved] = await tx
          .update(orders)
          .set({ status: "charging", sourceFingerprint: fingerprint })
          .where(eq(orders.id, id))
          .returning();
        return { order: reserved, send: true };
      }
      if (
        order.status === "charging" &&
        !order.squarePaymentId &&
        order.sourceFingerprint === fingerprint &&
        order.quoteExpiresAt.getTime() > Date.now()
      )
        return { order, send: true };
      return { order, send: false };
    });
  } catch (error) {
    if (
      error instanceof Error &&
      "cause" in error &&
      error.cause &&
      typeof error.cause === "object" &&
      "constraint" in error.cause &&
      error.cause.constraint === "course_purchase_live_customer_course"
    )
      throw new PurchaseDependencyError(
        409,
        "A purchase is already in progress for this course.",
      );
    throw error;
  }
}

export async function recordDecline(id: string) {
  await getPrivateDb()
    .update(orders)
    .set({ status: "failed", sourceFingerprint: null })
    .where(
      and(
        eq(orders.id, id),
        eq(orders.status, "charging"),
        sql`${orders.squarePaymentId} is null`,
      ),
    );
  return readCourseOrder(id);
}

const entitledKinds = ["grant", "revoke"] as const;

async function queueJob(
  tx: Transaction,
  orderId: string,
  kind: CourseJob["kind"],
  effectiveAt: Date,
  details: JobDetails = {},
) {
  await tx
    .insert(jobs)
    .values({
      id: purchaseJobKey(kind, orderId, details),
      orderId,
      kind,
      effectiveAt,
      ...details,
    })
    .onConflictDoNothing();
}

function checkMoney(
  amount: unknown,
  currency: unknown,
  max: number,
  min = 0,
): number {
  if (
    typeof amount !== "number" ||
    !Number.isSafeInteger(amount) ||
    amount < min ||
    amount > max ||
    currency !== "CAD"
  )
    throw new PurchaseDependencyError(502);
  return amount;
}

function verifiedAt(timestamp?: string) {
  const parsed = new Date(timestamp ?? "");
  if (!Number.isFinite(parsed.getTime()))
    throw new PurchaseDependencyError(502);
  return parsed;
}

const blockingDisputeStates = [
  "EVIDENCE_REQUIRED",
  "PROCESSING",
  "LOST",
  "ACCEPTED",
];

async function recordCourseDispute(
  tx: Transaction,
  order: CourseOrder,
  payment: SquarePayment,
  dispute: SquareDispute,
) {
  const captureUnconfirmed =
    !order.chargedAt && ["APPROVED", "PENDING"].includes(payment.status);
  if (
    !dispute.id ||
    dispute.location_id !== order.squareLocationId ||
    dispute.disputed_payment.payment_id !== payment.id ||
    (dispute.state === "WON" &&
      payment.status !== "COMPLETED" &&
      !captureUnconfirmed)
  )
    throw new PurchaseDependencyError(502);
  const observed = {
    amountCents: checkMoney(
      dispute.amount_money.amount,
      dispute.amount_money.currency,
      order.totalCents,
      1,
    ),
    state: dispute.state,
    version: dispute.version ?? null,
    updatedAt: verifiedAt(dispute.updated_at),
  };
  const [previous] = await tx
    .select()
    .from(disputes)
    .where(eq(disputes.id, dispute.id));
  if (previous) {
    if (
      previous.orderId !== order.id ||
      previous.amountCents !== observed.amountCents
    )
      throw new PurchaseDependencyError(502);
    const revision = compareSquareDisputeRevisions(observed, previous);
    if (revision === 0 && previous.state !== observed.state)
      throw new PurchaseDependencyError(502);
    if (revision <= 0) return order.disputeBlocked;
    if (
      blockingDisputeStates.includes(previous.state) &&
      !blockingDisputeStates.includes(observed.state) &&
      observed.state !== "WON"
    )
      throw new PurchaseDependencyError(502);
    await tx.update(disputes).set(observed).where(eq(disputes.id, dispute.id));
  } else {
    await tx
      .insert(disputes)
      .values({ ...observed, id: dispute.id, orderId: order.id });
  }
  const [blocking] = await tx
    .select({ id: disputes.id })
    .from(disputes)
    .where(
      and(
        eq(disputes.orderId, order.id),
        inArray(disputes.state, blockingDisputeStates),
      ),
    )
    .limit(1);
  return Boolean(blocking);
}

async function retireCourseGrant(
  tx: Transaction,
  order: CourseOrder,
  reason: "dispute" | "refund",
  effectiveAt: Date,
): Promise<CourseOrder["access"]> {
  const details = { accessGeneration: order.accessGeneration };
  const [grant] = await tx
    .select()
    .from(jobs)
    .where(eq(jobs.id, purchaseJobKey("grant", order.id, details)))
    .for("update");
  if (grant && grant.status !== "processing" && grant.status !== "done")
    await tx
      .update(jobs)
      .set({ status: "canceled" })
      .where(eq(jobs.id, grant.id));
  // Audited replay resets the attempts counter, even after an uncertain delivery.
  const replayed =
    grant && grant.attempts === 0
      ? await tx
          .select({ id: replays.id })
          .from(replays)
          .where(eq(replays.jobId, grant.id))
          .limit(1)
      : [];
  if (grant && (grant.attempts > 0 || replayed.length > 0))
    await queueJob(tx, order.id, "revoke", effectiveAt, {
      ...details,
      revokeReason:
        reason === "dispute" ||
        order.disputeStartedAt ||
        order.accessGeneration > 0
          ? reason
          : null,
    });
  const [unsettled] = await unsettledCourseRevocations(tx, order.id);
  return unsettled ? "revocation_pending" : "revoked";
}

type CaptureRecoveryBinding = {
  paymentId: string;
  unboundFingerprint?: string;
  customerId: string;
  courseId: string;
};

function captureTimestamp(value: unknown) {
  const rfc3339 =
    /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
  if (typeof value !== "string" || !rfc3339.test(value))
    throw new PurchaseDependencyError(502);
  const day = value.slice(0, 10);
  if (verifiedAt(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day)
    throw new PurchaseDependencyError(502);
  return verifiedAt(value);
}

function verifyInitialCaptureTimes(order: CourseOrder, payment: SquarePayment) {
  const createdAt = captureTimestamp(payment.created_at);
  const updatedAt = captureTimestamp(payment.updated_at);
  // CreatePayment is sent only while the stored quote is valid. Capture and
  // subsequent processor updates may occur after the quote expires.
  if (
    createdAt < order.createdAt ||
    createdAt > order.quoteExpiresAt ||
    updatedAt < createdAt ||
    updatedAt.getTime() > Date.now()
  )
    throw new PurchaseDependencyError(502);
}

export function observeCoursePayment(
  id: string,
  payment: SquarePayment,
  refund?: SquareRefund,
  dispute?: SquareDispute,
): Promise<CourseOrder>;
export function observeCoursePayment(
  id: string,
  payment: SquarePayment,
  refund: undefined,
  dispute: undefined,
  captureBinding: CaptureRecoveryBinding,
): Promise<CourseOrder | undefined>;
export async function observeCoursePayment(
  id: string,
  payment: SquarePayment,
  refund?: SquareRefund,
  dispute?: SquareDispute,
  captureBinding?: CaptureRecoveryBinding,
) {
  return getPrivateDb().transaction(async (tx) => {
    const order = await lockOrder(tx, id);
    if (
      captureBinding !== undefined &&
      (!order ||
        order.customerId !== captureBinding.customerId ||
        order.courseId !== captureBinding.courseId ||
        order.status !== "charging" ||
        order.chargedAt ||
        (captureBinding.unboundFingerprint !== undefined
          ? order.squarePaymentId !== null ||
            order.sourceFingerprint !== captureBinding.unboundFingerprint
          : order.squarePaymentId !== captureBinding.paymentId))
    )
      return;
    if (
      !order ||
      order.status === "quoted" ||
      orderReference(id) !== payment.reference_id ||
      payment.location_id !== order.squareLocationId ||
      !payment.id ||
      (order.squarePaymentId && order.squarePaymentId !== payment.id) ||
      checkMoney(
        payment.amount_money.amount,
        payment.amount_money.currency,
        order.totalCents,
      ) !== order.totalCents
    )
      throw new PurchaseDependencyError(502);

    if (captureBinding !== undefined) {
      const pending = payment.status === "APPROVED" || payment.status === "PENDING";
      if (
        payment.id !== captureBinding.paymentId ||
        payment.source_type !== "CARD" ||
        (!pending && !["COMPLETED", "CANCELED", "FAILED"].includes(payment.status))
      )
        throw new PurchaseDependencyError(502);
      if (captureBinding.unboundFingerprint !== undefined) {
        verifyInitialCaptureTimes(order, payment);
      } else {
        if (pending) return order;
        verifiedAt(payment.updated_at);
      }
    }
    const completed = payment.status === "COMPLETED";
    if (!completed && !refund && !dispute && order.status !== "charging")
      return order;
    if ((completed || refund || dispute) && payment.source_type !== "CARD")
      throw new PurchaseDependencyError(502);
    const disputeBlocked = dispute
      ? await recordCourseDispute(tx, order, payment, dispute)
      : order.disputeBlocked;
    // Square can report a dispute win before its payment read confirms
    // capture. The later payment event can rely on the recorded win.
    const [firstDeliveryWin] =
      !disputeBlocked &&
      !order.disputeBlocked &&
      order.accessGeneration === 0 &&
      (!order.chargedAt || order.access === "pending") &&
      (dispute?.state === "WON" || order.disputeStartedAt !== null)
        ? await tx
            .select({ updatedAt: disputes.updatedAt })
            .from(disputes)
            .where(and(eq(disputes.orderId, id), eq(disputes.state, "WON")))
            .orderBy(desc(disputes.updatedAt))
            .limit(1)
        : [];
    const firstWonAt = firstDeliveryWin?.updatedAt;
    const disputeStartedAt =
      order.disputeStartedAt ??
      (dispute && disputeBlocked
        ? verifiedAt(dispute.updated_at)
        : firstWonAt
          // The order start bounds administrator decisions when the dispute
          // has already resolved by the first authoritative observation.
          ? order.createdAt
          : null);

    // Square can return a completed refund before its payment read reflects capture.
    if (refund) {
      if (
        !refund.id ||
        refund.payment_id !== payment.id ||
        refund.location_id !== order.squareLocationId ||
        refund.status !== "COMPLETED"
      )
        throw new PurchaseDependencyError(502);
      const amountCents = checkMoney(
        refund.amount_money.amount,
        refund.amount_money.currency,
        order.totalCents,
        1,
      );
      const confirmedAt = verifiedAt(refund.updated_at);
      await tx
        .insert(refunds)
        .values({ id: refund.id, orderId: id, amountCents, confirmedAt })
        .onConflictDoNothing();
      const [record] = await tx
        .select()
        .from(refunds)
        .where(eq(refunds.id, refund.id));
      if (record?.orderId !== id || record.amountCents !== amountCents)
        throw new PurchaseDependencyError(502);
      await queueJob(tx, id, "tax_refund", record.confirmedAt, {
        refundId: record.id,
      });
    }
    const [sum] = await tx
      .select({
        amount: sql<number>`coalesce(sum(${refunds.amountCents}),0)::int`,
      })
      .from(refunds)
      .where(eq(refunds.orderId, id));
    const refunded = Math.max(
      order.refundedCents,
      sum.amount,
      completed && payment.refunded_money
        ? checkMoney(
            payment.refunded_money.amount,
            payment.refunded_money.currency,
            order.totalCents,
          )
        : 0,
    );
    if (refunded > order.totalCents) throw new PurchaseDependencyError(502);
    if (!completed && !order.chargedAt) {
      const failed =
        order.status === "charging" &&
        refunded === 0 &&
        !disputeBlocked &&
        (payment.status === "CANCELED" || payment.status === "FAILED");
      const [updated] = await tx
        .update(orders)
        .set({
          squarePaymentId: payment.id,
          status: failed ? "failed" : order.status,
          refundedCents: refunded,
          disputeBlocked,
          disputeStartedAt,
          ...(failed ? { sourceFingerprint: null } : {}),
        })
        .where(eq(orders.id, id))
        .returning();
      return updated;
    }

    const chargedAt = order.chargedAt ?? verifiedAt(payment.updated_at);
    const fullRefund = refunded === order.totalCents;
    let access = order.access;
    let accessGeneration = order.accessGeneration;
    if (fullRefund && order.status !== "refunded") {
      access = await retireCourseGrant(
        tx,
        order,
        "refund",
        verifiedAt(refund?.updated_at ?? payment.updated_at),
      );
    } else if (
      !fullRefund &&
      disputeBlocked &&
      (!order.disputeBlocked || !order.chargedAt)
    ) {
      access = await retireCourseGrant(
        tx,
        order,
        "dispute",
        verifiedAt(dispute?.updated_at ?? payment.updated_at),
      );
    } else if (
      !fullRefund &&
      !disputeBlocked &&
      (!order.chargedAt || order.disputeBlocked || firstWonAt)
    ) {
      if (firstWonAt && order.chargedAt)
        await retireCourseGrant(tx, order, "dispute", firstWonAt);
      access = "pending";
      if (order.disputeBlocked || firstWonAt) accessGeneration++;
      await queueJob(
        tx,
        id,
        "grant",
        firstWonAt ??
          (accessGeneration > 0 ? verifiedAt(dispute?.updated_at) : chargedAt),
        { accessGeneration },
      );
    }
    await queueJob(tx, id, "tax_sale", chargedAt);
    await queueJob(tx, id, "receipt", chargedAt);
    const [updated] = await tx
      .update(orders)
      .set({
        status: fullRefund ? "refunded" : "paid",
        access,
        chargedAt,
        sourceFingerprint: null,
        squarePaymentId: payment.id,
        refundedCents: refunded,
        disputeBlocked,
        disputeStartedAt,
        accessGeneration,
      })
      .where(eq(orders.id, id))
      .returning();
    return updated;
  });
}

function due(now: Date) {
  return or(
    and(eq(jobs.status, "pending"), lte(jobs.availableAt, now)),
    and(eq(jobs.status, "processing"), lte(jobs.leaseUntil, now)),
  );
}

const unsettledRefunds = alias(jobs, "unsettled_refunds");
const unsettledRevokes = alias(jobs, "unsettled_revokes");

function unsettledCourseRevocations(
  database: Pick<ReturnType<typeof getPrivateDb>, "select">,
  orderId: string | typeof orders.id,
) {
  return database
    .select({ id: unsettledRevokes.id })
    .from(unsettledRevokes)
    .where(
      and(
        eq(unsettledRevokes.orderId, orderId),
        eq(unsettledRevokes.kind, "revoke"),
        inArray(unsettledRevokes.status, ["pending", "processing", "dead"]),
      ),
    )
    .limit(1);
}

function isCurrentGrant(order: CourseOrder, job: CourseJob) {
  return (
    order.status === "paid" &&
    !order.disputeBlocked &&
    order.accessGeneration === job.accessGeneration
  );
}

function firstUnsettledTaxRefund(
  database: Pick<ReturnType<typeof getPrivateDb>, "select">,
  orderId: string | typeof orders.id,
) {
  return database
    .select({ id: unsettledRefunds.id })
    .from(unsettledRefunds)
    .where(
      and(
        eq(unsettledRefunds.orderId, orderId),
        eq(unsettledRefunds.kind, "tax_refund"),
        inArray(unsettledRefunds.status, ["pending", "processing", "dead"]),
      ),
    )
    .orderBy(asc(unsettledRefunds.createdAt), asc(unsettledRefunds.id))
    .limit(1);
}

export async function claimCourseJob(orderId?: string) {
  const database = getPrivateDb();
  const now = new Date();
  const rows = await database
    .select({ id: jobs.id, orderId: jobs.orderId })
    .from(jobs)
    .innerJoin(orders, eq(jobs.orderId, orders.id))
    .where(
      and(
        due(now),
        orderId ? eq(jobs.orderId, orderId) : undefined,
        or(
          ne(jobs.kind, "grant"),
          notExists(unsettledCourseRevocations(database, orders.id)),
        ),
        // A blocked reversal must not take a slot from runnable work. Recheck
        // under the order lock before claiming the candidate.
        or(
          ne(jobs.kind, "tax_refund"),
          and(
            isNotNull(orders.taxTransactionId),
            eq(jobs.id, sql`(${firstUnsettledTaxRefund(database, orders.id)})`),
          ),
        ),
      ),
    )
    .orderBy(asc(jobs.availableAt), asc(jobs.createdAt), asc(jobs.id))
    .limit(40);
  for (const row of rows) {
    const claim = await database.transaction(async (tx) => {
      const order = await lockOrder(tx, row.orderId);
      const [job] = await tx
        .select()
        .from(jobs)
        .where(and(eq(jobs.id, row.id), due(now)))
        .for("update");
      if (!order || !job) return;
      if (job.kind === "grant" && !isCurrentGrant(order, job)) {
        await tx
          .update(jobs)
          .set({ status: "canceled", lease: null, leaseUntil: null })
          .where(eq(jobs.id, job.id));
        return;
      }
      if (job.kind === "grant") {
        const [revocation] = await unsettledCourseRevocations(tx, order.id);
        if (revocation) return;
        const [actor] = await tx
          .select({ status: customerUsers.status })
          .from(customerUsers)
          .where(eq(customerUsers.id, order.customerId));
        if (actor?.status !== "active") {
          await tx
            .update(jobs)
            .set({
              status: "dead",
              lease: null,
              leaseUntil: null,
              lastFailure: "customer_inactive",
            })
            .where(eq(jobs.id, job.id));
          return;
        }
      }
      if (job.kind === "revoke") {
        const [grant] = await tx
          .select()
          .from(jobs)
          .where(
            eq(
              jobs.id,
              purchaseJobKey("grant", order.id, {
                accessGeneration: job.accessGeneration,
              }),
            ),
          );
        if (
          grant?.status === "processing" &&
          (grant.leaseUntil?.getTime() ?? 0) > now.getTime()
        )
          return;
      }
      if (job.kind === "tax_refund") {
        if (!order.taxTransactionId) return;
        const [firstRefund] = await firstUnsettledTaxRefund(tx, order.id);
        if (firstRefund?.id !== job.id) return;
      }
      const [claimed] = await tx
        .update(jobs)
        .set({
          status: "processing",
          attempts: job.attempts + 1,
          lease: randomUUID(),
          leaseUntil: new Date(now.getTime() + 60_000),
        })
        .where(eq(jobs.id, job.id))
        .returning();
      return { order, job: claimed };
    });
    if (claim) return claim;
  }
}

// A full refund and the send of a resolution grant share the order lock.
// A claim by itself does not authorize sending a superseded grant.
export async function withCurrentCourseRegrant<T>(
  customerId: string,
  job: CourseJob,
  send: (order: CourseOrder, job: CourseJob) => Promise<T>,
): Promise<T | undefined> {
  if (!job.lease) return;
  const lease = job.lease;
  return getPrivateDb().transaction(async (tx) => {
    const [actor] = await tx
      .select({ status: customerUsers.status })
      .from(customerUsers)
      .where(eq(customerUsers.id, customerId))
      .for("share");
    const order = await lockOrder(tx, job.orderId);
    if (!order || !isCurrentGrant(order, job)) return;
    const [held] = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.id, job.id), eq(jobs.lease, lease)));
    if (!held) return;
    if (actor?.status !== "active") throw new PurchaseDependencyError(403);
    return send(order, job);
  });
}

async function rateTableRefundReceipt(
  tx: Transaction,
  order: CourseOrder,
  job: CourseJob,
) {
  if (!job.refundId) throw new PurchaseDependencyError(409);
  const [refund] = await tx
    .select({ amount: refunds.amountCents })
    .from(refunds)
    .where(and(eq(refunds.id, job.refundId), eq(refunds.orderId, order.id)));
  if (!refund) throw new PurchaseDependencyError(409);

  // The order lock serializes allocations, so cumulative rounding reverses
  // exactly the original tax when all verified refunds have been settled.
  const [previous] = await tx
    .select({ amount: sql<number>`coalesce(sum(${refunds.amountCents}), 0)::int` })
    .from(jobs)
    .innerJoin(
      refunds,
      and(eq(refunds.id, jobs.refundId), eq(refunds.orderId, jobs.orderId)),
    )
    .where(
      and(
        eq(jobs.orderId, order.id),
        eq(jobs.kind, "tax_refund"),
        eq(jobs.status, "done"),
      ),
    );
  const taxCents = rateTableRefundTax(
    order.taxCents,
    order.totalCents,
    previous.amount,
    refund.amount,
  );
  return `${rateTableTaxReference(order.id)}:refund:${job.refundId}:${taxCents}`;
}

export async function finishCourseJob(
  job: CourseJob,
  result: {
    receipt?: string;
    access?: CourseOrder["access"];
    failure?: string;
    retry?: boolean;
  },
) {
  if (!job.lease) return;
  await getPrivateDb().transaction(async (tx) => {
    const order = await lockOrder(tx, job.orderId);
    if (!order) return;
    const canceled = job.kind === "grant" && !isCurrentGrant(order, job);
    let receipt = result.receipt;
    if (
      !result.failure &&
      job.kind === "tax_refund" &&
      order.taxTransactionId === rateTableTaxReference(order.id)
    ) {
      const [leased] = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(and(eq(jobs.id, job.id), eq(jobs.lease, job.lease!)));
      if (!leased) return;
      receipt = await rateTableRefundReceipt(tx, order, job);
    }
    const [updated] = await tx
      .update(jobs)
      .set({
        status: canceled
          ? "canceled"
          : !result.failure
            ? "done"
            : result.retry && job.attempts < 8
              ? "pending"
              : "dead",
        lastFailure: result.failure ?? null,
        destinationReceipt: receipt,
        availableAt: result.failure
          ? new Date(Date.now() + Math.min(3_600_000, 5000 * 2 ** job.attempts))
          : new Date(),
        lease: null,
        leaseUntil: null,
      })
      .where(and(eq(jobs.id, job.id), eq(jobs.lease, job.lease!)))
      .returning();
    if (!updated || result.failure || canceled) return;
    if (job.kind === "tax_sale" && receipt)
      await tx
        .update(orders)
        .set({ taxTransactionId: receipt })
        .where(eq(orders.id, job.orderId));
    if (
      result.access &&
      entitledKinds.some((kind) => kind === job.kind) &&
      (job.kind === "grant" ||
        order.disputeBlocked ||
        order.status === "refunded")
    )
      await tx
        .update(orders)
        .set({ access: result.access })
        .where(eq(orders.id, job.orderId));
  });
}

export async function readCourseRefund(id: string) {
  const [refund] = await getPrivateDb()
    .select()
    .from(refunds)
    .where(eq(refunds.id, id));
  return refund;
}

export async function replayCourseJob(
  jobId: string,
  adminId: string,
  reason: string,
) {
  return getPrivateDb().transaction(async (tx) => {
    const [job] = await tx.select().from(jobs).where(eq(jobs.id, jobId));
    if (!job) return false;
    await lockOrder(tx, job.orderId);
    const [updated] = await tx
      .update(jobs)
      .set({ status: "pending", attempts: 0, availableAt: new Date() })
      .where(and(eq(jobs.id, jobId), eq(jobs.status, "dead")))
      .returning();
    if (!updated) return false;
    await tx.insert(replays).values({ adminId, jobId, reason });
    return true;
  });
}
