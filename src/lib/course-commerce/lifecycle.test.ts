import assert from "node:assert/strict";
import test from "node:test";

import {
  CourseLifecycleConflictError,
  CourseLifecycleValidationError,
  assertCourseOrderHasItems,
  createCourseLifecycleService,
  type ClaimGuestCourseOrderInput,
  type CourseLifecycleRepository,
  type FinalizeCoursePaymentInput,
} from "./lifecycle";

interface FakeItem {
  financialStatus: "pending" | "paid" | "refunded";
  grantEnqueued: boolean;
  id: string;
  userId: string | null;
}

function createFakeRepository(input: {
  orderEmail?: string;
  orderUserId?: string | null;
  verified?: boolean;
} = {}): CourseLifecycleRepository & { items: FakeItem[] } {
  let status: "pending" | "paid" = "pending";
  let transactionId: string | null = null;
  let event: { id: string; hash: string } | null = null;
  let orderUserId = input.orderUserId ?? null;
  let claimed = false;
  const items: FakeItem[] = [
    {
      financialStatus: "pending",
      grantEnqueued: false,
      id: "item-1",
      userId: orderUserId,
    },
  ];

  return {
    items,
    async finalizeCoursePayment(values: FinalizeCoursePaymentInput) {
      if (
        event !== null &&
        values.event?.providerEventId === event.id &&
        values.event.payloadHash !== event.hash
      ) {
        throw new CourseLifecycleConflictError(
          "Provider event payload changed",
          "EVENT_PAYLOAD_COLLISION",
        );
      }
      if (
        transactionId !== null &&
        transactionId !== values.providerTransactionId
      ) {
        throw new CourseLifecycleConflictError(
          "Transaction changed",
          "PAYMENT_TRANSACTION_COLLISION",
        );
      }

      const duplicate = status === "paid";
      transactionId = values.providerTransactionId;
      if (values.event && event === null) {
        event = { id: values.event.providerEventId, hash: values.event.payloadHash };
      }
      status = "paid";
      let grantsEnqueued = 0;
      let itemsMarkedPaid = 0;
      for (const item of items) {
        if (item.financialStatus === "pending") {
          item.financialStatus = "paid";
          itemsMarkedPaid += 1;
        }
        if (item.userId !== null && !item.grantEnqueued) {
          item.grantEnqueued = true;
          grantsEnqueued += 1;
        }
      }

      return {
        duplicate,
        grantsEnqueued,
        itemsMarkedPaid,
        orderMarkedPaid: !duplicate,
      };
    },
    async claimGuestCourseOrder(values: ClaimGuestCourseOrderInput) {
      if (
        input.verified === false ||
        values.normalizedEmail !== (input.orderEmail ?? "buyer@example.com")
      ) {
        throw new CourseLifecycleValidationError(
          "Email ownership is not verified",
          "EMAIL_NOT_VERIFIED_FOR_USER",
        );
      }
      if (orderUserId !== null && orderUserId !== values.userId) {
        throw new CourseLifecycleConflictError(
          "Order has another owner",
          "SPLIT_ORDER_OWNERSHIP",
        );
      }

      const alreadyClaimed = claimed;
      claimed = true;
      orderUserId = values.userId;
      let grantsEnqueued = 0;
      let itemsClaimed = 0;
      for (const item of items) {
        if (item.userId === null) {
          item.userId = values.userId;
          itemsClaimed += 1;
        }
        if (
          item.financialStatus === "paid" &&
          !item.grantEnqueued
        ) {
          item.grantEnqueued = true;
          grantsEnqueued += 1;
        }
      }
      return { alreadyClaimed, grantsEnqueued, itemsClaimed };
    },
  };
}

const paidInput: FinalizeCoursePaymentInput = {
  event: {
    eventType: "cardTransaction",
    payloadHash: "payload-hash",
    providerEventId: "event-1",
  },
  orderId: "order-1",
  paidAt: new Date("2026-08-07T10:00:00.000Z"),
  provider: "helcim",
  providerTransactionId: "transaction-1",
};

test("duplicate paid finalization converges on one grant", async () => {
  const repository = createFakeRepository({ orderUserId: "user-1" });
  const service = createCourseLifecycleService(repository);

  const first = await service.finalizeCoursePayment(paidInput);
  const second = await service.finalizeCoursePayment(paidInput);

  assert.equal(first.grantsEnqueued, 1);
  assert.equal(second.grantsEnqueued, 0);
  assert.equal(second.duplicate, true);
  assert.equal(repository.items[0].grantEnqueued, true);
});

test("paid guest items do not enqueue a grant before claim", async () => {
  const repository = createFakeRepository();
  const service = createCourseLifecycleService(repository);

  const result = await service.finalizeCoursePayment(paidInput);

  assert.equal(result.grantsEnqueued, 0);
  assert.equal(repository.items[0].financialStatus, "paid");
});

test("verified guest claim enqueues a grant for an already-paid item", async () => {
  const repository = createFakeRepository({
    orderEmail: "buyer@example.com",
    verified: true,
  });
  const service = createCourseLifecycleService(repository);
  await service.finalizeCoursePayment(paidInput);

  const result = await service.claimGuestCourseOrder({
    claimedAt: new Date("2026-08-07T10:05:00.000Z"),
    normalizedEmail: "buyer@example.com",
    orderId: "order-1",
    userId: "user-1",
  });

  assert.equal(result.grantsEnqueued, 1);
  assert.equal(result.itemsClaimed, 1);
  assert.equal(repository.items[0].userId, "user-1");
});

test("paid event payload collisions are rejected", async () => {
  const repository = createFakeRepository({ orderUserId: "user-1" });
  const service = createCourseLifecycleService(repository);
  await service.finalizeCoursePayment(paidInput);

  await assert.rejects(
    service.finalizeCoursePayment({
      ...paidInput,
      event: { ...paidInput.event!, payloadHash: "changed-hash" },
    }),
    (error: unknown) =>
      error instanceof CourseLifecycleConflictError &&
      error.code === "EVENT_PAYLOAD_COLLISION",
  );
});

test("course payment finalization rejects an order without course items", () => {
  assert.throws(
    () => assertCourseOrderHasItems([]),
    (error: unknown) =>
      error instanceof CourseLifecycleValidationError &&
      error.code === "COURSE_ORDER_ITEMS_MISSING",
  );
});
