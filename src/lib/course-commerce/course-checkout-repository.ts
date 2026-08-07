import "server-only";

import { nanoid } from "nanoid";

import { encryptCheckoutSecret } from "@/lib/commerce/checkout-secret";
import { hashCheckoutToken } from "@/lib/commerce/order-store";
import { getPrivateDb } from "@/lib/private-db/client";
import {
  checkoutOrders,
  courseOrderItems,
  type CheckoutOrderLineItemSnapshot,
} from "@/lib/private-db/schema";

import type { CourseCheckoutRepository } from "./course-checkout";

interface PendingCourseOrderInsert {
  amountCents: number;
  checkoutTokenHash: string;
  currency: "CAD";
  customerEmail: string;
  customerName: string;
  customerUserId: string | null;
  helcimInvoiceId: number;
  helcimInvoiceNumber: string;
  lineItems: CheckoutOrderLineItemSnapshot[];
  orderId: string;
  paymentProvider: "helcim";
  purpose: "course";
  secretTokenCiphertext: string;
  status: "pending";
}

interface PendingCourseItemInsert {
  checkoutOrderId: string;
  courseId: string;
  courseSlug: string;
  courseTitle: string;
  currency: "CAD";
  customerUserId: string | null;
  financialStatus: "pending";
  ownershipStatus: "claimed" | "guest_unclaimed";
  priceCents: number;
}

export interface CourseCheckoutWriteTransaction {
  insertCheckoutOrder(
    values: PendingCourseOrderInsert,
  ): Promise<{ id: string } | null>;
  insertCourseOrderItem(values: PendingCourseItemInsert): Promise<void>;
}

export interface CourseCheckoutTransactionRunner {
  run<T>(
    operation: (transaction: CourseCheckoutWriteTransaction) => Promise<T>,
  ): Promise<T>;
}

export interface CourseCheckoutRepositoryRuntime {
  createOrderId: () => string;
  encryptSecret: (secret: string) => string;
  hashCheckoutToken: (token: string) => string;
}

export function createCourseCheckoutRepository(
  transactionRunner: CourseCheckoutTransactionRunner,
  runtime: CourseCheckoutRepositoryRuntime = defaultRepositoryRuntime,
): CourseCheckoutRepository {
  return {
    async persistPendingCheckout(input) {
      const orderId = runtime.createOrderId();
      const checkoutTokenHash = runtime.hashCheckoutToken(input.checkoutToken);
      const secretTokenCiphertext = runtime.encryptSecret(input.secretToken);
      const lineItems: CheckoutOrderLineItemSnapshot[] = [
        {
          description: input.course.title,
          productId: input.course.id,
          quantity: 1,
          sku: input.course.slug,
          totalCents: input.course.priceCents,
          unitPriceCents: input.course.priceCents,
        },
      ];

      return transactionRunner.run(async (transaction) => {
        const order = await transaction.insertCheckoutOrder({
          amountCents: input.course.priceCents,
          checkoutTokenHash,
          currency: "CAD",
          customerEmail: input.customerEmail,
          customerName: input.customerName,
          customerUserId: input.customerUserId,
          helcimInvoiceId: input.helcimInvoiceId,
          helcimInvoiceNumber: input.helcimInvoiceNumber,
          lineItems,
          orderId,
          paymentProvider: "helcim",
          purpose: "course",
          secretTokenCiphertext,
          status: "pending",
        });

        if (order === null) {
          throw new Error("Course checkout order insert did not return an id");
        }

        await transaction.insertCourseOrderItem({
          checkoutOrderId: order.id,
          courseId: input.course.id,
          courseSlug: input.course.slug,
          courseTitle: input.course.title,
          currency: "CAD",
          customerUserId: input.customerUserId,
          financialStatus: "pending",
          ownershipStatus:
            input.customerUserId === null ? "guest_unclaimed" : "claimed",
          priceCents: input.course.priceCents,
        });

        return { orderId };
      });
    },
  };
}

export function createDrizzleCourseCheckoutRepository(
  db: ReturnType<typeof getPrivateDb> = getPrivateDb(),
): CourseCheckoutRepository {
  return createCourseCheckoutRepository({
    run(operation) {
      return db.transaction((transaction) =>
        operation({
          async insertCheckoutOrder(values) {
            const [row] = await transaction
              .insert(checkoutOrders)
              .values(values)
              .returning({ id: checkoutOrders.id });
            return row ?? null;
          },
          async insertCourseOrderItem(values) {
            await transaction.insert(courseOrderItems).values(values);
          },
        }),
      );
    },
  });
}

const defaultRepositoryRuntime: CourseCheckoutRepositoryRuntime = {
  createOrderId: () => `lh-${nanoid(12)}`,
  encryptSecret: encryptCheckoutSecret,
  hashCheckoutToken,
};
