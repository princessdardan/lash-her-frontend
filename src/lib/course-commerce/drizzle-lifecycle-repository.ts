import "server-only";

import { and, eq, inArray, ne, sql } from "drizzle-orm";

import { getPrivateDb } from "@/lib/private-db/client";
import {
  checkoutOrders,
  checkoutPaymentEvents,
  courseOrderItems,
  customerUsers,
  customerVerifiedEmails,
  entitlementOutbox,
  guestOrderClaims,
} from "@/lib/private-db/schema";

import {
  createGrantEntitlementCommand,
  hashEntitlementPayload,
  type CoursePaymentProvider,
} from "./entitlement-commands";
import {
  CourseLifecycleConflictError,
  CourseLifecycleValidationError,
  assertCourseOrderHasItems,
  type CourseLifecycleRepository,
} from "./lifecycle";
import { getHelcimPaymentTransactionLockQuery } from "./transaction-lock";

const CLAIM_METHOD = "verified_email";

export function createDrizzleCourseLifecycleRepository(
  db: ReturnType<typeof getPrivateDb> = getPrivateDb(),
): CourseLifecycleRepository {
  return {
    async finalizeCoursePayment(input) {
      return db.transaction(async (tx) => {
        const [order] = await tx
          .select()
          .from(checkoutOrders)
          .where(eq(checkoutOrders.orderId, input.orderId))
          .limit(1)
          .for("update");

        if (!order) {
          throw new CourseLifecycleValidationError(
            "Course checkout order was not found",
            "ORDER_NOT_FOUND",
          );
        }
        if (order.purpose !== "course") {
          throw new CourseLifecycleValidationError(
            "Checkout order is not a course order",
            "NOT_COURSE_ORDER",
          );
        }
        if (order.paymentProvider !== input.provider) {
          throw new CourseLifecycleConflictError(
            "Payment provider does not match the course order",
            "PAYMENT_TRANSACTION_COLLISION",
          );
        }

        const currentTransactionId = order.helcimTransactionId;
        if (
          currentTransactionId !== null &&
          currentTransactionId !== input.providerTransactionId
        ) {
          throw new CourseLifecycleConflictError(
            "Course order is already associated with another transaction",
            "PAYMENT_TRANSACTION_COLLISION",
          );
        }

        // The schema intentionally has no global transaction-ID unique index.
        // Serialize this identity before checking other orders to close the race.
        await tx.execute(
          getHelcimPaymentTransactionLockQuery(input.providerTransactionId),
        );

        const [transactionCollision] = await tx
          .select({ id: checkoutOrders.id })
          .from(checkoutOrders)
          .where(
            and(
              ne(checkoutOrders.id, order.id),
              eq(checkoutOrders.paymentProvider, input.provider),
              eq(
                checkoutOrders.helcimTransactionId,
                input.providerTransactionId,
              ),
            ),
          )
          .limit(1);
        if (transactionCollision) {
          throw new CourseLifecycleConflictError(
            "Payment transaction belongs to another order",
            "PAYMENT_TRANSACTION_COLLISION",
          );
        }

        const items = await tx
          .select()
          .from(courseOrderItems)
          .where(eq(courseOrderItems.checkoutOrderId, order.id))
          .for("update");
        assertCourseOrderHasItems(items);

        let duplicateEvent = false;
        let claimedEventId: string | null = null;
        if (input.event) {
          const [inserted] = await tx
            .insert(checkoutPaymentEvents)
            .values({
              orderId: order.id,
              eventType: input.event.eventType,
              helcimTransactionId: input.providerTransactionId,
              paymentProvider: input.provider,
              providerEventId: input.event.providerEventId,
              idempotencyKey: `${input.provider}:${input.event.providerEventId}`,
              payloadHash: input.event.payloadHash,
              payloadSanitized: input.event.payloadSanitized
                ? { ...input.event.payloadSanitized }
                : undefined,
              processingStatus: "received",
              status: "paid",
            })
            .onConflictDoNothing({
              target: [
                checkoutPaymentEvents.paymentProvider,
                checkoutPaymentEvents.providerEventId,
              ],
            })
            .returning({ id: checkoutPaymentEvents.id });

          if (inserted) {
            claimedEventId = inserted.id;
          } else {
            const [existing] = await tx
              .select({
                id: checkoutPaymentEvents.id,
                orderId: checkoutPaymentEvents.orderId,
                payloadHash: checkoutPaymentEvents.payloadHash,
                helcimTransactionId: checkoutPaymentEvents.helcimTransactionId,
              })
              .from(checkoutPaymentEvents)
              .where(
                and(
                  eq(checkoutPaymentEvents.paymentProvider, input.provider),
                  eq(
                    checkoutPaymentEvents.providerEventId,
                    input.event.providerEventId,
                  ),
                ),
              )
              .limit(1)
              .for("update");

            const existingTransactionId = existing?.helcimTransactionId;
            if (
              !existing ||
              existing.orderId !== order.id ||
              existing.payloadHash !== input.event.payloadHash ||
              existingTransactionId !== input.providerTransactionId
            ) {
              throw new CourseLifecycleConflictError(
                "Payment provider event identity collided with different data",
                "EVENT_PAYLOAD_COLLISION",
              );
            }

            duplicateEvent = true;
            claimedEventId = existing.id;
          }
        }

        const [updatedOrder] = await tx
          .update(checkoutOrders)
          .set({
            status: "paid",
            failedAt: null,
            paidAt: sql`coalesce(${checkoutOrders.paidAt}, ${input.paidAt})`,
            updatedAt: input.paidAt,
            helcimTransactionId: input.providerTransactionId,
          })
          .where(
            and(
              eq(checkoutOrders.id, order.id),
              inArray(checkoutOrders.status, [
                "pending",
                "paid",
                "verification_failed",
              ]),
            ),
          )
          .returning({ id: checkoutOrders.id });

        if (!updatedOrder) {
          throw new CourseLifecycleConflictError(
            "Course order cannot transition to paid",
            "PAYMENT_TRANSACTION_COLLISION",
          );
        }

        const paidItemIds = items
          .filter((item) => item.financialStatus === "pending")
          .map((item) => item.id);

        let itemsMarkedPaid = 0;
        if (paidItemIds.length > 0) {
          const updatedItems = await tx
            .update(courseOrderItems)
            .set({
              financialStatus: "paid",
              paidAt: input.paidAt,
              updatedAt: input.paidAt,
            })
            .where(inArray(courseOrderItems.id, paidItemIds))
            .returning({ id: courseOrderItems.id });
          itemsMarkedPaid = updatedItems.length;
        }

        let grantsEnqueued = 0;
        for (const item of items) {
          if (
            item.ownershipStatus !== "claimed" ||
            item.customerUserId === null ||
            !["pending", "paid", "partially_refunded"].includes(
              item.financialStatus,
            )
          ) {
            continue;
          }

          const grantedAt = item.paidAt ?? input.paidAt;
          grantsEnqueued += await insertGrantOutboxCommand(tx, {
            courseId: item.courseId,
            courseOrderItemId: item.id,
            externalPaymentId: input.providerTransactionId,
            grantedAt,
            orderId: order.orderId,
            provider: input.provider,
            userId: item.customerUserId,
          });
        }

        if (claimedEventId !== null) {
          await tx
            .update(checkoutPaymentEvents)
            .set({
              processedAt: input.paidAt,
              processingStatus: duplicateEvent ? "duplicate" : "processed",
            })
            .where(eq(checkoutPaymentEvents.id, claimedEventId));
        }

        return {
          duplicate: duplicateEvent || order.status === "paid",
          grantsEnqueued,
          itemsMarkedPaid,
          orderMarkedPaid: order.status !== "paid",
        };
      });
    },

    async claimGuestCourseOrder(input) {
      return db.transaction(async (tx) => {
        const [order] = await tx
          .select()
          .from(checkoutOrders)
          .where(eq(checkoutOrders.orderId, input.orderId))
          .limit(1)
          .for("update");

        if (!order) {
          throw new CourseLifecycleValidationError(
            "Course checkout order was not found",
            "ORDER_NOT_FOUND",
          );
        }
        if (order.purpose !== "course") {
          throw new CourseLifecycleValidationError(
            "Checkout order is not a course order",
            "NOT_COURSE_ORDER",
          );
        }
        if (normalizeEmail(order.customerEmail) !== input.normalizedEmail) {
          throw new CourseLifecycleValidationError(
            "Claim email does not match the order email",
            "ORDER_EMAIL_MISMATCH",
          );
        }

        const [verifiedEmail] = await tx
          .select({ id: customerVerifiedEmails.id })
          .from(customerVerifiedEmails)
          .innerJoin(
            customerUsers,
            eq(customerUsers.id, customerVerifiedEmails.customerUserId),
          )
          .where(
            and(
              eq(customerVerifiedEmails.customerUserId, input.userId),
              eq(customerVerifiedEmails.emailNormalized, input.normalizedEmail),
              eq(customerUsers.status, "active"),
            ),
          )
          .limit(1);
        if (!verifiedEmail) {
          throw new CourseLifecycleValidationError(
            "Email is not verified for the customer",
            "EMAIL_NOT_VERIFIED_FOR_USER",
          );
        }
        if (
          order.customerUserId !== null &&
          order.customerUserId !== input.userId
        ) {
          throw new CourseLifecycleConflictError(
            "Course order belongs to another customer",
            "SPLIT_ORDER_OWNERSHIP",
          );
        }

        const items = await tx
          .select()
          .from(courseOrderItems)
          .where(eq(courseOrderItems.checkoutOrderId, order.id))
          .for("update");
        if (
          items.some(
            (item) =>
              item.customerUserId !== null &&
              item.customerUserId !== input.userId,
          )
        ) {
          throw new CourseLifecycleConflictError(
            "Course order items have split ownership",
            "SPLIT_ORDER_OWNERSHIP",
          );
        }

        const [insertedClaim] = await tx
          .insert(guestOrderClaims)
          .values({
            checkoutOrderId: order.id,
            customerUserId: input.userId,
            verifiedEmailId: verifiedEmail.id,
            claimMethod: CLAIM_METHOD,
            claimedAt: input.claimedAt,
            createdAt: input.claimedAt,
          })
          .onConflictDoNothing({ target: guestOrderClaims.checkoutOrderId })
          .returning({ id: guestOrderClaims.id });
        if (!insertedClaim) {
          const [existingClaim] = await tx
            .select({ customerUserId: guestOrderClaims.customerUserId })
            .from(guestOrderClaims)
            .where(eq(guestOrderClaims.checkoutOrderId, order.id))
            .limit(1)
            .for("update");
          if (existingClaim?.customerUserId !== input.userId) {
            throw new CourseLifecycleConflictError(
              "Course order was claimed by another customer",
              "SPLIT_ORDER_OWNERSHIP",
            );
          }
        }

        await tx
          .update(checkoutOrders)
          .set({ customerUserId: input.userId, updatedAt: input.claimedAt })
          .where(eq(checkoutOrders.id, order.id));

        const unclaimedItemIds = items
          .filter((item) => item.customerUserId === null)
          .map((item) => item.id);
        let itemsClaimed = 0;
        if (unclaimedItemIds.length > 0) {
          const claimedItems = await tx
            .update(courseOrderItems)
            .set({
              customerUserId: input.userId,
              ownershipStatus: "claimed",
              updatedAt: input.claimedAt,
            })
            .where(inArray(courseOrderItems.id, unclaimedItemIds))
            .returning({ id: courseOrderItems.id });
          itemsClaimed = claimedItems.length;
        }

        let grantsEnqueued = 0;
        if (order.paymentProvider !== "helcim") {
          throw new CourseLifecycleConflictError(
            "Course orders must use Helcim",
            "PAYMENT_TRANSACTION_COLLISION",
          );
        }
        const externalPaymentId = order.helcimTransactionId;
        for (const item of items) {
          if (
            !["paid", "partially_refunded"].includes(item.financialStatus) ||
            item.refundedCents >= item.priceCents ||
            item.paidAt === null
          ) {
            continue;
          }

          grantsEnqueued += await insertGrantOutboxCommand(tx, {
            courseId: item.courseId,
            courseOrderItemId: item.id,
            ...(externalPaymentId ? { externalPaymentId } : {}),
            grantedAt: item.paidAt,
            orderId: order.orderId,
            provider: "helcim",
            userId: input.userId,
          });
        }

        return {
          alreadyClaimed: !insertedClaim,
          grantsEnqueued,
          itemsClaimed,
        };
      });
    },
  };
}

type CourseTransaction = Parameters<
  Parameters<ReturnType<typeof getPrivateDb>["transaction"]>[0]
>[0];

async function insertGrantOutboxCommand(
  tx: CourseTransaction,
  input: {
    courseId: string;
    courseOrderItemId: string;
    externalPaymentId?: string;
    grantedAt: Date;
    orderId: string;
    provider: CoursePaymentProvider;
    userId: string;
  },
): Promise<number> {
  const payload = createGrantEntitlementCommand(input);
  const payloadHash = hashEntitlementPayload(payload);
  const [inserted] = await tx
    .insert(entitlementOutbox)
    .values({
      courseOrderItemId: input.courseOrderItemId,
      commandType: "grant",
      sequence: 1,
      idempotencyKey: payload.idempotencyKey,
      payload,
      payloadHash,
      status: "pending",
      nextAttemptAt: input.grantedAt,
      createdAt: input.grantedAt,
      updatedAt: input.grantedAt,
    })
    .onConflictDoNothing({ target: entitlementOutbox.idempotencyKey })
    .returning({ id: entitlementOutbox.id });

  if (inserted) {
    return 1;
  }

  const [existing] = await tx
    .select({
      commandType: entitlementOutbox.commandType,
      courseOrderItemId: entitlementOutbox.courseOrderItemId,
      payloadHash: entitlementOutbox.payloadHash,
    })
    .from(entitlementOutbox)
    .where(eq(entitlementOutbox.idempotencyKey, payload.idempotencyKey))
    .limit(1);
  if (
    !existing ||
    existing.commandType !== "grant" ||
    existing.courseOrderItemId !== input.courseOrderItemId ||
    existing.payloadHash !== payloadHash
  ) {
    throw new CourseLifecycleConflictError(
      "Entitlement idempotency key collided with different data",
      "EVENT_PAYLOAD_COLLISION",
    );
  }

  return 0;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
