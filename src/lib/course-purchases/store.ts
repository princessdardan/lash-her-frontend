import "server-only";

import { createHash, randomUUID } from "node:crypto";
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getPrivateDb } from "@/lib/private-db/client";
import { customerUsers } from "@/lib/customer-auth/schema";
import type {
  SquarePayment,
  SquareRefund,
} from "@/lib/payments/square/payments-client";
import { PurchaseDependencyError } from "./course-api";
import {
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

export async function saveCourseQuote(input: typeof orders.$inferInsert) {
  const [order] = await getPrivateDb().insert(orders).values(input).returning();
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

function purchaseJobKey(
  kind: CourseJob["kind"],
  orderId: string,
  refundId?: string,
) {
  return `course-${kind}-${orderId}${refundId ? `-${createHash("sha256").update(refundId).digest("hex").slice(0, 32)}` : ""}`;
}

async function queueJob(
  tx: Transaction,
  orderId: string,
  kind: CourseJob["kind"],
  effectiveAt: Date,
  refundId?: string,
) {
  await tx
    .insert(jobs)
    .values({
      id: purchaseJobKey(kind, orderId, refundId),
      orderId,
      kind,
      effectiveAt,
      refundId,
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

export async function observeCoursePayment(
  id: string,
  payment: SquarePayment,
  refund?: SquareRefund,
) {
  return getPrivateDb().transaction(async (tx) => {
    const order = await lockOrder(tx, id);
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

    if (payment.status !== "COMPLETED") {
      if (order.status !== "charging") return order;
      const failed =
        payment.status === "CANCELED" || payment.status === "FAILED";
      const [updated] = await tx
        .update(orders)
        .set({
          squarePaymentId: payment.id,
          status: failed ? "failed" : "charging",
          ...(failed ? { sourceFingerprint: null } : {}),
        })
        .where(eq(orders.id, id))
        .returning();
      return updated;
    }
    if (payment.source_type !== "CARD") throw new PurchaseDependencyError(502);

    const chargedAt = order.chargedAt ?? verifiedAt(payment.updated_at);
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
      await queueJob(tx, id, "tax_refund", record.confirmedAt, record.id);
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
      payment.refunded_money
        ? checkMoney(
            payment.refunded_money.amount,
            payment.refunded_money.currency,
            order.totalCents,
          )
        : 0,
    );
    if (refunded > order.totalCents) throw new PurchaseDependencyError(502);
    const fullRefund = refunded === order.totalCents;
    let access = order.access;
    // A refund before the first attempt must never create an access grant.
    if (fullRefund && order.status !== "refunded") {
      const [grant] = await tx
        .select()
        .from(jobs)
        .where(eq(jobs.id, purchaseJobKey("grant", id)))
        .for("update");
      if (grant && grant.status !== "processing" && grant.status !== "done")
        await tx
          .update(jobs)
          .set({ status: "canceled" })
          .where(eq(jobs.id, grant.id));
      const replayed =
        grant && grant.attempts === 0
          ? await tx
              .select({ id: replays.id })
              .from(replays)
              .where(eq(replays.jobId, grant.id))
              .limit(1)
          : [];
      access =
        grant && (grant.attempts > 0 || replayed.length > 0)
          ? "revocation_pending"
          : "revoked";
      if (access === "revocation_pending")
        await queueJob(
          tx,
          id,
          "revoke",
          verifiedAt(refund?.updated_at ?? payment.updated_at),
        );
    } else if (!fullRefund && !order.chargedAt) {
      access = "pending";
      await queueJob(tx, id, "grant", chargedAt);
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
      if (job.kind === "grant" && order.status === "refunded") {
        await tx
          .update(jobs)
          .set({ status: "canceled", lease: null, leaseUntil: null })
          .where(eq(jobs.id, job.id));
        return;
      }
      if (job.kind === "grant") {
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
          .where(eq(jobs.id, purchaseJobKey("grant", order.id)));
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
    const canceled = job.kind === "grant" && order.status === "refunded";
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
        destinationReceipt: result.receipt,
        availableAt: result.failure
          ? new Date(Date.now() + Math.min(3_600_000, 5000 * 2 ** job.attempts))
          : new Date(),
        lease: null,
        leaseUntil: null,
      })
      .where(and(eq(jobs.id, job.id), eq(jobs.lease, job.lease!)))
      .returning();
    if (!updated || result.failure || canceled) return;
    if (job.kind === "tax_sale" && result.receipt)
      await tx
        .update(orders)
        .set({ taxTransactionId: result.receipt })
        .where(eq(orders.id, job.orderId));
    if (entitledKinds.some((kind) => kind === job.kind) && result.access)
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
