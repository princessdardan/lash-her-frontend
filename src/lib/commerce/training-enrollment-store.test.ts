import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import {
    createTrainingEnrollmentStore,
    type TrainingCheckoutOrderRow,
    type TrainingEnrollmentWithCheckoutOrder,
    type TrainingEnrollmentRepository,
    type TrainingEnrollmentRow,
  } from "./src/lib/commerce/training-enrollment-store.ts";

  type TrainingEnrollmentInsert = Parameters<TrainingEnrollmentRepository["createTrainingEnrollment"]>[0];

  const now = new Date("2026-05-10T00:00:00.000Z");

  const checkoutOrder: TrainingCheckoutOrderRow = {
    amountCents: 149900,
    checkoutTokenHash: "checkout-token-hash",
    createdAt: now,
    currency: "CAD",
    customerEmail: "Client@Example.com",
    customerName: "Client Name",
    deletedAt: null,
    failedAt: null,
    helcimInvoiceId: 4242,
    helcimInvoiceNumber: "INV-4242",
    helcimTransactionId: "txn-paid-123",
    id: "checkout-order-1",
    lineItems: [
      {
        description: "Lash Training Full Program",
        productId: "lash-training",
        quantity: 1,
        sku: "TRAINING-FULL",
        totalCents: 149900,
        unitPriceCents: 149900,
      },
    ],
    orderId: "lh-training-123",
    paidAt: new Date("2026-05-10T00:10:00.000Z"),
    paymentProvider: "helcim",
    redactedAt: null,
    secretTokenCiphertext: "v1:encrypted",
    status: "paid",
    updatedAt: now,
  };

  const createEnrollmentInput = {
    checkoutEmail: " Client@Example.com ",
    checkoutOrderId: checkoutOrder.id,
    productSnapshot: {
      currency: "CAD",
      id: "product-training-full",
      priceCents: 149900,
      sku: "TRAINING-FULL",
      title: "Lash Training Full Payment",
    },
    programSnapshot: {
      id: "program-lash-training",
      slug: "lash-training",
      title: "Lash Training Program",
    },
  };

  class FakeTrainingEnrollmentRepository implements TrainingEnrollmentRepository {
    readonly enrollments: TrainingEnrollmentRow[] = [];
    checkoutOrder: TrainingCheckoutOrderRow = { ...checkoutOrder };

    async createTrainingEnrollment(values: TrainingEnrollmentInsert): Promise<TrainingEnrollmentRow> {
      const enrollment: TrainingEnrollmentRow = {
        ...values,
        createdAt: now,
        id: "training-enrollment-" + (this.enrollments.length + 1),
        scheduledAt: null,
        schedulingTokenHash: null,
        staffAlertedAt: null,
        tokenExpiresAt: null,
        tokenUsedAt: null,
        updatedAt: now,
      };

      this.enrollments.push(enrollment);
      return enrollment;
    }

    async findPaidPendingEnrollmentByHelcimInvoice(input): Promise<TrainingEnrollmentWithCheckoutOrder | null> {
      const invoiceIdMatches = input.helcimInvoiceId === undefined || this.checkoutOrder.helcimInvoiceId === input.helcimInvoiceId;
      const invoiceNumberMatches = input.helcimInvoiceNumber === undefined || this.checkoutOrder.helcimInvoiceNumber === input.helcimInvoiceNumber;
      const enrollment = this.enrollments.find((candidate) => (
        (input.helcimInvoiceId !== undefined || input.helcimInvoiceNumber !== undefined)
        && invoiceIdMatches
        && invoiceNumberMatches
        && this.checkoutOrder.paymentProvider === "helcim"
        && this.checkoutOrder.status === "paid"
        && candidate.checkoutOrderId === this.checkoutOrder.id
        && candidate.schedulingStatus === "pending"
        && candidate.tokenUsedAt === null
      ));

      return enrollment ? { checkoutOrder: this.checkoutOrder, enrollment } : null;
    }

    async findPaidPendingEnrollmentByPublicOrderId(orderId: string): Promise<TrainingEnrollmentWithCheckoutOrder | null> {
      const enrollment = this.enrollments.find((candidate) => (
        this.checkoutOrder.orderId === orderId
        && this.checkoutOrder.status === "paid"
        && candidate.checkoutOrderId === this.checkoutOrder.id
        && candidate.schedulingStatus === "pending"
        && candidate.tokenUsedAt === null
      ));

      return enrollment ? { checkoutOrder: this.checkoutOrder, enrollment } : null;
    }

    async assignSchedulingToken(
      enrollmentId: string,
      schedulingTokenHash: string,
      tokenExpiresAt: Date,
      updateTime: Date,
    ): Promise<boolean> {
      const enrollment = this.findEnrollment(enrollmentId);

      if (
        enrollment.schedulingStatus !== "pending"
        || enrollment.schedulingTokenHash !== null
        || enrollment.tokenUsedAt !== null
      ) {
        return false;
      }

      enrollment.scheduledAt = null;
      enrollment.schedulingStatus = "pending";
      enrollment.schedulingTokenHash = schedulingTokenHash;
      enrollment.tokenExpiresAt = tokenExpiresAt;
      enrollment.tokenUsedAt = null;
      enrollment.updatedAt = updateTime;

      return true;
    }

    async findPendingEnrollmentBySchedulingTokenHash(
      schedulingTokenHash: string,
      lookupTime: Date,
    ): Promise<TrainingEnrollmentWithCheckoutOrder | null> {
      const enrollment = this.enrollments.find((candidate) => (
        candidate.schedulingTokenHash === schedulingTokenHash
        && candidate.schedulingStatus === "pending"
        && candidate.tokenExpiresAt !== null
        && candidate.tokenUsedAt === null
        && candidate.tokenExpiresAt > lookupTime
        && this.checkoutOrder.status === "paid"
        && candidate.checkoutOrderId === this.checkoutOrder.id
      ));

      return enrollment ? { checkoutOrder: this.checkoutOrder, enrollment } : null;
    }

    async markSchedulingPending(enrollmentId: string, updateTime: Date): Promise<void> {
      const enrollment = this.findEnrollment(enrollmentId);
      enrollment.scheduledAt = null;
      enrollment.schedulingStatus = "pending";
      enrollment.updatedAt = updateTime;
    }

    async markScheduled(enrollmentId: string, scheduledAt: Date, updateTime: Date): Promise<boolean> {
      const enrollment = this.findEnrollment(enrollmentId);
      if (enrollment.schedulingStatus !== "pending" || enrollment.tokenUsedAt !== null) {
        return false;
      }
      enrollment.scheduledAt = scheduledAt;
      enrollment.schedulingStatus = "scheduled";
      enrollment.tokenUsedAt = updateTime;
      enrollment.updatedAt = updateTime;
      return true;
    }

    async markScheduledByTokenHash(
      enrollmentId: string,
      schedulingTokenHash: string,
      scheduledAt: Date,
      updateTime: Date,
    ): Promise<boolean> {
      const enrollment = this.findEnrollment(enrollmentId);
      if (
        enrollment.schedulingStatus !== "pending"
        || enrollment.schedulingTokenHash !== schedulingTokenHash
        || enrollment.tokenExpiresAt === null
        || enrollment.tokenExpiresAt <= updateTime
        || enrollment.tokenUsedAt !== null
      ) {
        return false;
      }

      enrollment.scheduledAt = scheduledAt;
      enrollment.schedulingStatus = "scheduled";
      enrollment.tokenUsedAt = updateTime;
      enrollment.updatedAt = updateTime;
      return true;
    }

    async markStaffAlerted(enrollmentId: string, updateTime: Date): Promise<boolean> {
      const enrollment = this.findEnrollment(enrollmentId);
      if (enrollment.staffAlertedAt !== null) {
        return false;
      }
      enrollment.staffAlertedAt = updateTime;
      enrollment.updatedAt = updateTime;
      return true;
    }

    private findEnrollment(enrollmentId: string): TrainingEnrollmentRow {
      const enrollment = this.enrollments.find((candidate) => candidate.id === enrollmentId);
      assert.ok(enrollment, "Expected enrollment " + enrollmentId + " to exist");
      return enrollment;
    }
  }

  function createFakeStore(): {
    repository: FakeTrainingEnrollmentRepository;
    store: ReturnType<typeof createTrainingEnrollmentStore>;
  } {
    const repository = new FakeTrainingEnrollmentRepository();
    return {
      repository,
      store: createTrainingEnrollmentStore(repository),
    };
  }
`;

test("training enrollment store creates pending enrollments without scheduling tokens", () => {
  runTrainingEnrollmentStoreScenario(`
    const { repository, store } = createFakeStore();
    const created = await store.createEnrollment(createEnrollmentInput);
    const row = repository.enrollments[0];

    assert.equal(created.id, "training-enrollment-1");
    assert.equal(row.checkoutOrderId, checkoutOrder.id);
    assert.equal(row.checkoutEmail, "client@example.com");
    assert.equal(row.purchaseKind, "full");
    assert.equal(row.schedulingStatus, "pending");
    assert.equal(row.tokenExpiresAt, null);
    assert.equal(row.schedulingTokenHash, null);
    assert.equal(row.tokenUsedAt, null);
    assert.deepEqual(row.programSnapshot, createEnrollmentInput.programSnapshot);
    assert.deepEqual(row.productSnapshot, createEnrollmentInput.productSnapshot);
  `);
});

test("training enrollment store issues scheduling tokens after payment and stores only hashes", () => {
  runTrainingEnrollmentStoreScenario(`
    const { repository, store } = createFakeStore();
    await store.createEnrollment(createEnrollmentInput);

    const issued = await store.issueSchedulingTokenForPaidOrder(checkoutOrder.orderId, now);
    assert.ok(issued);
    assert.match(issued.schedulingToken, /^[A-Za-z0-9_-]+$/);
    assert.equal(issued.tokenExpiresAt.toISOString(), "2026-05-24T00:00:00.000Z");
    assert.equal(issued.schedulingToken.includes("training-enrollment-1"), false);
    assert.equal(issued.schedulingToken.includes("2026-05-24T00:00:00.000Z"), false);
    assert.equal(issued.schedulingToken.includes(Buffer.from("training-enrollment-1", "utf8").toString("base64url")), false);
    assert.equal(issued.schedulingToken.includes(Buffer.from("2026-05-24T00:00:00.000Z", "utf8").toString("base64url")), false);

    const row = repository.enrollments[0];
    assert.match(row.schedulingTokenHash ?? "", /^[a-f0-9]{64}$/);
    assert.notEqual(row.schedulingTokenHash, issued.schedulingToken);
    assert.equal(row.tokenExpiresAt?.toISOString(), "2026-05-24T00:00:00.000Z");
    assert.equal(row.tokenUsedAt, null);
    assert.equal(JSON.stringify(repository.enrollments).includes(issued.schedulingToken), false);
  `);
});

test("training enrollment store issues scheduling tokens only when missing", () => {
  runTrainingEnrollmentStoreScenario(`
    const { repository, store } = createFakeStore();
    await store.createEnrollment(createEnrollmentInput);

    const issued = await store.issueSchedulingTokenForPaidOrderIfMissing(checkoutOrder.orderId, now);
    assert.ok(issued);
    const originalHash = repository.enrollments[0].schedulingTokenHash;

    const duplicate = await store.issueSchedulingTokenForPaidOrderIfMissing(checkoutOrder.orderId, new Date("2026-05-10T01:00:00.000Z"));
    assert.equal(duplicate, null);
    assert.equal(repository.enrollments[0].schedulingTokenHash, originalHash);
    assert.equal(JSON.stringify(repository.enrollments).includes(issued.schedulingToken), false);
  `);
});

test("training enrollment store reuses active unused scheduling tokens for paid orders", () => {
  runTrainingEnrollmentStoreScenario(`
    const { repository, store } = createFakeStore();
    await store.createEnrollment(createEnrollmentInput);

    const issued = await store.issueSchedulingTokenForPaidOrderIfMissing(checkoutOrder.orderId, now);
    assert.ok(issued);
    const originalHash = repository.enrollments[0].schedulingTokenHash;
    const originalExpiry = repository.enrollments[0].tokenExpiresAt;

    const reused = await store.getOrIssueSchedulingTokenForPaidOrder(checkoutOrder.orderId, new Date("2026-05-10T01:00:00.000Z"));
    assert.ok(reused);
    assert.equal(reused.schedulingToken, issued.schedulingToken);
    assert.equal(reused.schedulingToken.includes("training-enrollment-1"), false);
    assert.equal(reused.schedulingToken.includes("2026-05-24T00:00:00.000Z"), false);
    assert.equal(reused.schedulingToken.includes(Buffer.from("training-enrollment-1", "utf8").toString("base64url")), false);
    assert.equal(reused.schedulingToken.includes(Buffer.from("2026-05-24T00:00:00.000Z", "utf8").toString("base64url")), false);
    assert.equal(reused.tokenExpiresAt, originalExpiry);
    assert.equal(repository.enrollments[0].schedulingTokenHash, originalHash);
    assert.equal(JSON.stringify(repository.enrollments).includes(reused.schedulingToken), false);
  `);
});

test("training enrollment store does not reuse expired, used, unpaid, or scheduled tokens", () => {
  runTrainingEnrollmentStoreScenario(`
    const { repository, store } = createFakeStore();
    await store.createEnrollment(createEnrollmentInput);
    const issued = await store.issueSchedulingTokenForPaidOrderIfMissing(checkoutOrder.orderId, now);
    assert.ok(issued);

    assert.equal(await store.getOrIssueSchedulingTokenForPaidOrder(checkoutOrder.orderId, new Date("2026-05-25T00:00:00.000Z")), null);

    repository.enrollments[0].tokenUsedAt = new Date("2026-05-10T02:00:00.000Z");
    assert.equal(await store.getOrIssueSchedulingTokenForPaidOrder(checkoutOrder.orderId, now), null);

    repository.enrollments[0].tokenUsedAt = null;
    repository.checkoutOrder.status = "pending";
    assert.equal(await store.getOrIssueSchedulingTokenForPaidOrder(checkoutOrder.orderId, now), null);

    repository.checkoutOrder.status = "paid";
    repository.enrollments[0].schedulingStatus = "scheduled";
    repository.enrollments[0].scheduledAt = new Date("2026-05-11T15:00:00.000Z");
    assert.equal(await store.getOrIssueSchedulingTokenForPaidOrder(checkoutOrder.orderId, now), null);

    repository.enrollments[0].schedulingStatus = "pending";
    repository.enrollments[0].scheduledAt = null;
    assert.equal(await store.getOrIssueSchedulingTokenForPaidOrder("lh-missing", now), null);
  `);
});

test("training enrollment store does not overwrite existing scheduling token hashes", () => {
  runTrainingEnrollmentStoreScenario(`
    const { repository, store } = createFakeStore();
    await store.createEnrollment(createEnrollmentInput);

    const issued = await store.issueSchedulingTokenForPaidOrderIfMissing(checkoutOrder.orderId, now);
    assert.ok(issued);
    const originalHash = repository.enrollments[0].schedulingTokenHash;
    const originalExpiry = repository.enrollments[0].tokenExpiresAt;

    const forcedSecond = await store.issueSchedulingTokenForPaidOrder(checkoutOrder.orderId, new Date("2026-05-10T01:00:00.000Z"));

    assert.equal(forcedSecond, null);
    assert.equal(repository.enrollments[0].schedulingTokenHash, originalHash);
    assert.equal(repository.enrollments[0].tokenExpiresAt, originalExpiry);
  `);
});

test("training enrollment store never persists raw scheduling tokens", () => {
  runTrainingEnrollmentStoreScenario(`
    const { repository, store } = createFakeStore();
    await store.createEnrollment(createEnrollmentInput);
    const issued = await store.issueSchedulingTokenForPaidOrder(checkoutOrder.orderId, now);
    assert.ok(issued);

    assert.equal(JSON.stringify(repository.enrollments).includes(issued.schedulingToken), false);
  `);
});

test("training enrollment store finds pending eligibility by raw token with strict email normalization", () => {
  runTrainingEnrollmentStoreScenario(`
    const { store } = createFakeStore();
    await store.createEnrollment(createEnrollmentInput);
    const issued = await store.issueSchedulingTokenForPaidOrder(checkoutOrder.orderId, now);
    assert.ok(issued);

    const found = await store.findPendingEnrollmentByToken({
      checkoutEmail: " client@example.com ",
      now,
      schedulingToken: issued.schedulingToken,
    });
    assert.ok(found);
    assert.equal(found.enrollmentId, "training-enrollment-1");
    assert.equal(found.checkoutOrder.orderId, checkoutOrder.orderId);

    const wrongToken = await store.findPendingEnrollmentByToken({
      now,
      schedulingToken: "wrong-token",
    });
    assert.equal(wrongToken, null);
  `);
});

test("training enrollment store enforces pending token eligibility", () => {
  runTrainingEnrollmentStoreScenario(`
    const { repository, store } = createFakeStore();
    await store.createEnrollment(createEnrollmentInput);
    const issued = await store.issueSchedulingTokenForPaidOrder(checkoutOrder.orderId, now);
    assert.ok(issued);

    assert.equal(await store.findPendingEnrollmentByToken({
      now: new Date("2026-05-25T00:00:00.000Z"),
      schedulingToken: issued.schedulingToken,
    }), null);

    repository.checkoutOrder.status = "pending";
    assert.equal(await store.findPendingEnrollmentByToken({
      now,
      schedulingToken: issued.schedulingToken,
    }), null);
  `);
});

test("training enrollment store marks scheduling pending, scheduled, and staff alerted", () => {
  runTrainingEnrollmentStoreScenario(`
    const { repository, store } = createFakeStore();
    const created = await store.createEnrollment(createEnrollmentInput);
    const issued = await store.issueSchedulingTokenForPaidOrder(checkoutOrder.orderId, now);
    assert.ok(issued);
    const scheduledAt = new Date("2026-05-11T15:00:00.000Z");
    const updateTime = new Date("2026-05-10T02:00:00.000Z");

    assert.equal(await store.markScheduled({
      enrollmentId: created.id,
      now: updateTime,
      scheduledAt,
    }), true);
    assert.equal(repository.enrollments[0].schedulingStatus, "scheduled");
    assert.equal(repository.enrollments[0].scheduledAt, scheduledAt);
    assert.equal(repository.enrollments[0].tokenUsedAt, updateTime);
    assert.equal(await store.markScheduled({
      enrollmentId: created.id,
      now: new Date("2026-05-10T02:30:00.000Z"),
      scheduledAt,
    }), false);
    assert.equal(await store.findPendingEnrollmentByToken({
      now,
      schedulingToken: issued.schedulingToken,
    }), null);

    const pendingTime = new Date("2026-05-10T03:00:00.000Z");
    await store.markSchedulingPending(created.id, pendingTime);
    assert.equal(repository.enrollments[0].schedulingStatus, "pending");
    assert.equal(repository.enrollments[0].scheduledAt, null);
    assert.equal(repository.enrollments[0].updatedAt, pendingTime);

    const alertedAt = new Date("2026-05-10T04:00:00.000Z");
    assert.equal(await store.markStaffAlerted({ enrollmentId: created.id, now: alertedAt }), true);
    assert.equal(repository.enrollments[0].staffAlertedAt, alertedAt);
    assert.equal(await store.markStaffAlerted({
      enrollmentId: created.id,
      now: new Date("2026-05-10T05:00:00.000Z"),
    }), false);
    assert.equal(repository.enrollments[0].staffAlertedAt, alertedAt);
  `);
});

test("training enrollment store atomically consumes scheduling tokens when marking scheduled", () => {
  runTrainingEnrollmentStoreScenario(`
    const { repository, store } = createFakeStore();
    const created = await store.createEnrollment(createEnrollmentInput);
    const issued = await store.issueSchedulingTokenForPaidOrder(checkoutOrder.orderId, now);
    assert.ok(issued);
    const scheduledAt = new Date("2026-05-11T15:00:00.000Z");
    const updateTime = new Date("2026-05-10T02:00:00.000Z");

    assert.equal(await store.markScheduled({
      enrollmentId: created.id,
      now: updateTime,
      scheduledAt,
      schedulingToken: issued.schedulingToken,
    }), true);
    assert.equal(repository.enrollments[0].schedulingStatus, "scheduled");
    assert.equal(repository.enrollments[0].scheduledAt, scheduledAt);
    assert.equal(repository.enrollments[0].tokenUsedAt, updateTime);

    await store.markSchedulingPending(created.id, new Date("2026-05-10T03:00:00.000Z"));
    assert.equal(await store.markScheduled({
      enrollmentId: created.id,
      now: new Date("2026-05-10T04:00:00.000Z"),
      scheduledAt,
      schedulingToken: "wrong-token",
    }), false);
    assert.equal(repository.enrollments[0].schedulingStatus, "pending");
  `);
});

test("training enrollment store refuses token consumption after expiry or prior use", () => {
  runTrainingEnrollmentStoreScenario(`
    const { repository, store } = createFakeStore();
    const created = await store.createEnrollment(createEnrollmentInput);
    const issued = await store.issueSchedulingTokenForPaidOrder(checkoutOrder.orderId, now);
    assert.ok(issued);
    const scheduledAt = new Date("2026-05-25T15:00:00.000Z");

    assert.equal(await store.markScheduled({
      enrollmentId: created.id,
      now: new Date("2026-05-25T00:00:00.000Z"),
      scheduledAt,
      schedulingToken: issued.schedulingToken,
    }), false);

    repository.enrollments[0].tokenUsedAt = new Date("2026-05-10T02:00:00.000Z");
    assert.equal(await store.markScheduled({
      enrollmentId: created.id,
      now: new Date("2026-05-10T03:00:00.000Z"),
      scheduledAt,
      schedulingToken: issued.schedulingToken,
    }), false);
  `);
});

test("training enrollment store gets paid pending confirmations by public order id without scheduling tokens", () => {
  runTrainingEnrollmentStoreScenario(`
    const { repository, store } = createFakeStore();
    await store.createEnrollment(createEnrollmentInput);

    const found = await store.getPaidPendingConfirmationByPublicOrderId(checkoutOrder.orderId);
    assert.ok(found);
    assert.equal(found.checkoutOrder.id, checkoutOrder.id);
    assert.equal(found.enrollmentId, "training-enrollment-1");
    assert.equal(found.staffAlertedAt, null);
    assert.equal(found.tokenExpiresAt, null);

    repository.checkoutOrder.status = "pending";
    assert.equal(await store.getPaidPendingConfirmationByPublicOrderId(checkoutOrder.orderId), null);
    repository.checkoutOrder.status = "paid";
    assert.equal(await store.getPaidPendingConfirmationByPublicOrderId("lh-missing"), null);
  `);
});

test("training enrollment store does not issue Helcim invoice tokens for Square orders", () => {
  runTrainingEnrollmentStoreScenario(`
    const { repository, store } = createFakeStore();
    await store.createEnrollment(createEnrollmentInput);
    repository.checkoutOrder.paymentProvider = "square";

    const found = await store.getPaidPendingNotificationByHelcimInvoiceIfMissing({
      helcimInvoiceId: 4242,
      helcimInvoiceNumber: "INV-4242",
    });
    const issued = await store.issueSchedulingTokenForPaidHelcimInvoiceIfMissing({
      helcimInvoiceId: 4242,
      helcimInvoiceNumber: "INV-4242",
    }, now);

    assert.equal(found, null);
    assert.equal(issued, null);
    assert.equal(repository.enrollments[0].schedulingTokenHash, null);
  `);
});

function runTrainingEnrollmentStoreScenario(assertions: string): void {
  const scenario = `${helperScript}\nvoid (async () => {\n${assertions}\n})()`;
  const env = { ...process.env };

  env.NEXT_PUBLIC_SANITY_DATASET = "test";
  env.NEXT_PUBLIC_SANITY_PROJECT_ID = "test-project";
  env.CHECKOUT_SECRET_ENCRYPTION_KEY = randomBytes(32).toString("base64");

  execFileSync(
    "./node_modules/.bin/tsx",
    ["--conditions=react-server", "--eval", scenario],
    {
      cwd: process.cwd(),
      env,
      stdio: "pipe",
    },
  );
}
