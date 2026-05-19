import "server-only";

import { createHmac, randomBytes } from "node:crypto";

import { and, eq, gt, isNotNull, isNull } from "drizzle-orm";

import { getPrivateDb } from "@/lib/private-db/client";
import {
  checkoutOrders,
  trainingEnrollments,
  type TrainingEnrollmentProductSnapshot,
  type TrainingEnrollmentProgramSnapshot,
} from "@/lib/private-db/schema";
import { getCheckoutSecretEncryptionKey } from "@/sanity/env";

const SCHEDULING_TOKEN_TTL_DAYS = 14;

export type TrainingEnrollmentRow = typeof trainingEnrollments.$inferSelect;
export type TrainingCheckoutOrderRow = typeof checkoutOrders.$inferSelect;

type TrainingEnrollmentInsert = {
  checkoutEmail: string;
  checkoutOrderId: string;
  productSnapshot: TrainingEnrollmentProductSnapshot;
  programSnapshot: TrainingEnrollmentProgramSnapshot;
  purchaseKind: "full";
  schedulingStatus: "pending";
};

export interface TrainingEnrollmentWithCheckoutOrder {
  checkoutOrder: TrainingCheckoutOrderRow;
  enrollment: TrainingEnrollmentRow;
}

export interface FindTrainingEnrollmentByHelcimInvoiceInput {
  helcimInvoiceId?: number;
  helcimInvoiceNumber?: string;
}

export interface CreateTrainingEnrollmentInput {
  checkoutEmail: string;
  checkoutOrderId: string;
  productSnapshot: TrainingEnrollmentProductSnapshot;
  programSnapshot: TrainingEnrollmentProgramSnapshot;
}

export interface FindPendingTrainingEnrollmentByTokenInput {
  checkoutEmail?: string;
  now?: Date;
  schedulingToken: string;
}

export interface PendingTrainingEnrollmentRecord {
  checkoutEmail: string;
  checkoutOrder: TrainingCheckoutOrderRow;
  enrollmentId: string;
  productSnapshot: TrainingEnrollmentProductSnapshot;
  programSnapshot: TrainingEnrollmentProgramSnapshot;
  staffAlertedAt: Date | null;
  tokenExpiresAt: Date | null;
}

export interface IssuedTrainingSchedulingTokenRecord extends PendingTrainingEnrollmentRecord {
  schedulingToken: string;
}

export interface MarkTrainingEnrollmentScheduledInput {
  enrollmentId: string;
  now?: Date;
  scheduledAt?: Date;
}

export interface MarkTrainingEnrollmentStaffAlertedInput {
  enrollmentId: string;
  now?: Date;
}

export interface TrainingEnrollmentRepository {
  assignSchedulingToken(
    enrollmentId: string,
    schedulingTokenHash: string,
    tokenExpiresAt: Date,
    now: Date,
  ): Promise<boolean>;
  createTrainingEnrollment(values: TrainingEnrollmentInsert): Promise<TrainingEnrollmentRow>;
  findPaidPendingEnrollmentByHelcimInvoice(
    input: FindTrainingEnrollmentByHelcimInvoiceInput,
  ): Promise<TrainingEnrollmentWithCheckoutOrder | null>;
  findPaidPendingEnrollmentByPublicOrderId(orderId: string): Promise<TrainingEnrollmentWithCheckoutOrder | null>;
  findPendingEnrollmentBySchedulingTokenHash(
    schedulingTokenHash: string,
    now: Date,
  ): Promise<TrainingEnrollmentWithCheckoutOrder | null>;
  markSchedulingPending(enrollmentId: string, now: Date): Promise<void>;
  markScheduled(enrollmentId: string, scheduledAt: Date, now: Date): Promise<boolean>;
  markStaffAlerted(enrollmentId: string, now: Date): Promise<boolean>;
}

export interface TrainingEnrollmentStore {
  createEnrollment(input: CreateTrainingEnrollmentInput): Promise<TrainingEnrollmentRow>;
  findPendingEnrollmentByToken(
    input: FindPendingTrainingEnrollmentByTokenInput,
  ): Promise<PendingTrainingEnrollmentRecord | null>;
  getPaidPendingConfirmationByPublicOrderId(orderId: string): Promise<PendingTrainingEnrollmentRecord | null>;
  getPaidPendingNotificationByHelcimInvoiceIfMissing(
    input: FindTrainingEnrollmentByHelcimInvoiceInput,
  ): Promise<PendingTrainingEnrollmentRecord | null>;
  issueSchedulingTokenForPaidHelcimInvoiceIfMissing(
    input: FindTrainingEnrollmentByHelcimInvoiceInput,
    now?: Date,
  ): Promise<IssuedTrainingSchedulingTokenRecord | null>;
  issueSchedulingTokenForPaidOrder(orderId: string, now?: Date): Promise<IssuedTrainingSchedulingTokenRecord | null>;
  issueSchedulingTokenForPaidOrderIfMissing(orderId: string, now?: Date): Promise<IssuedTrainingSchedulingTokenRecord | null>;
  markSchedulingPending(enrollmentId: string, now?: Date): Promise<void>;
  markScheduled(input: MarkTrainingEnrollmentScheduledInput): Promise<boolean>;
  markStaffAlerted(input: MarkTrainingEnrollmentStaffAlertedInput): Promise<boolean>;
}

export function createTrainingEnrollmentStore(
  repository: TrainingEnrollmentRepository,
): TrainingEnrollmentStore {
  return {
    async createEnrollment(input) {
      return repository.createTrainingEnrollment({
        checkoutEmail: normalizeEmail(input.checkoutEmail),
        checkoutOrderId: input.checkoutOrderId,
        productSnapshot: input.productSnapshot,
        programSnapshot: input.programSnapshot,
        purchaseKind: "full",
        schedulingStatus: "pending",
      });
    },

    async findPendingEnrollmentByToken(input) {
      const found = await repository.findPendingEnrollmentBySchedulingTokenHash(
        hashSchedulingToken(input.schedulingToken),
        input.now ?? new Date(),
      );

      if (!found) {
        return null;
      }

      if (input.checkoutEmail !== undefined && normalizeEmail(input.checkoutEmail) !== found.enrollment.checkoutEmail) {
        return null;
      }

      return toPendingTrainingEnrollmentRecord(found);
    },

    async getPaidPendingConfirmationByPublicOrderId(orderId) {
      const found = await repository.findPaidPendingEnrollmentByPublicOrderId(orderId);

      if (!found) {
        return null;
      }

      return toPendingTrainingEnrollmentRecord(found);
    },

    async getPaidPendingNotificationByHelcimInvoiceIfMissing(input) {
      const found = await repository.findPaidPendingEnrollmentByHelcimInvoice(input);

      if (!found || found.enrollment.staffAlertedAt !== null) {
        return null;
      }

      return toPendingTrainingEnrollmentRecord(found);
    },

    async issueSchedulingTokenForPaidOrder(orderId, now = new Date()) {
      const found = await repository.findPaidPendingEnrollmentByPublicOrderId(orderId);

      if (!found) {
        return null;
      }

      return issueSchedulingToken(found, repository, now, { requireMissingToken: false });
    },

    async issueSchedulingTokenForPaidOrderIfMissing(orderId, now = new Date()) {
      const found = await repository.findPaidPendingEnrollmentByPublicOrderId(orderId);

      if (!found || found.enrollment.schedulingTokenHash !== null) {
        return null;
      }

      return issueSchedulingToken(found, repository, now, { requireMissingToken: true });
    },

    async issueSchedulingTokenForPaidHelcimInvoiceIfMissing(input, now = new Date()) {
      const found = await repository.findPaidPendingEnrollmentByHelcimInvoice(input);

      if (!found || found.enrollment.schedulingTokenHash !== null) {
        return null;
      }

      return issueSchedulingToken(found, repository, now, { requireMissingToken: true });
    },

    async markSchedulingPending(enrollmentId, now = new Date()) {
      await repository.markSchedulingPending(enrollmentId, now);
    },

    async markScheduled(input) {
      const now = input.now ?? new Date();
      return repository.markScheduled(input.enrollmentId, input.scheduledAt ?? now, now);
    },

    async markStaffAlerted(input) {
      return repository.markStaffAlerted(input.enrollmentId, input.now ?? new Date());
    },
  };
}

const defaultTrainingEnrollmentStore = createTrainingEnrollmentStore(
  createDrizzleTrainingEnrollmentRepository(),
);

export async function createTrainingEnrollment(
  input: CreateTrainingEnrollmentInput,
): Promise<TrainingEnrollmentRow> {
  return defaultTrainingEnrollmentStore.createEnrollment(input);
}

export async function findPendingTrainingEnrollmentByToken(
  input: FindPendingTrainingEnrollmentByTokenInput,
): Promise<PendingTrainingEnrollmentRecord | null> {
  return defaultTrainingEnrollmentStore.findPendingEnrollmentByToken(input);
}

export async function getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId(
  orderId: string,
): Promise<PendingTrainingEnrollmentRecord | null> {
  return defaultTrainingEnrollmentStore.getPaidPendingConfirmationByPublicOrderId(orderId);
}

export async function getPaidPendingTrainingEnrollmentNotificationByHelcimInvoiceIfMissing(
  input: FindTrainingEnrollmentByHelcimInvoiceInput,
): Promise<PendingTrainingEnrollmentRecord | null> {
  return defaultTrainingEnrollmentStore.getPaidPendingNotificationByHelcimInvoiceIfMissing(input);
}

export async function issueTrainingSchedulingTokenForPaidOrder(
  orderId: string,
  now?: Date,
): Promise<IssuedTrainingSchedulingTokenRecord | null> {
  return defaultTrainingEnrollmentStore.issueSchedulingTokenForPaidOrder(orderId, now);
}

export async function issueTrainingSchedulingTokenForPaidOrderIfMissing(
  orderId: string,
  now?: Date,
): Promise<IssuedTrainingSchedulingTokenRecord | null> {
  return defaultTrainingEnrollmentStore.issueSchedulingTokenForPaidOrderIfMissing(orderId, now);
}

export async function issueTrainingSchedulingTokenForPaidHelcimInvoiceIfMissing(
  input: FindTrainingEnrollmentByHelcimInvoiceInput,
  now?: Date,
): Promise<IssuedTrainingSchedulingTokenRecord | null> {
  return defaultTrainingEnrollmentStore.issueSchedulingTokenForPaidHelcimInvoiceIfMissing(input, now);
}

export async function markTrainingEnrollmentSchedulingPending(
  enrollmentId: string,
  now?: Date,
): Promise<void> {
  await defaultTrainingEnrollmentStore.markSchedulingPending(enrollmentId, now);
}

export async function markTrainingEnrollmentScheduled(
  input: MarkTrainingEnrollmentScheduledInput,
): Promise<boolean> {
  return defaultTrainingEnrollmentStore.markScheduled(input);
}

export async function markTrainingEnrollmentStaffAlerted(
  input: MarkTrainingEnrollmentStaffAlertedInput,
): Promise<boolean> {
  return defaultTrainingEnrollmentStore.markStaffAlerted(input);
}

export function generateTrainingSchedulingToken(): string {
  return randomBytes(32).toString("base64url");
}

function createDrizzleTrainingEnrollmentRepository(): TrainingEnrollmentRepository {
  return {
    async assignSchedulingToken(enrollmentId, schedulingTokenHash, tokenExpiresAt, now) {
      const updated = await getPrivateDb()
        .update(trainingEnrollments)
        .set({
          scheduledAt: null,
          schedulingStatus: "pending",
          schedulingTokenHash,
          tokenExpiresAt,
          tokenUsedAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(trainingEnrollments.id, enrollmentId),
            eq(trainingEnrollments.schedulingStatus, "pending"),
            isNull(trainingEnrollments.schedulingTokenHash),
            isNull(trainingEnrollments.tokenUsedAt),
          ),
        )
        .returning({ id: trainingEnrollments.id });

      return updated.length === 1;
    },

    async createTrainingEnrollment(values) {
      const [createdEnrollment] = await getPrivateDb()
        .insert(trainingEnrollments)
        .values(values)
        .returning();

      return createdEnrollment;
    },

    async findPaidPendingEnrollmentByHelcimInvoice(input) {
      return findPaidPendingEnrollmentByHelcimInvoice(input);
    },

    async findPaidPendingEnrollmentByPublicOrderId(orderId) {
      const [found] = await getPrivateDb()
        .select({ checkoutOrder: checkoutOrders, enrollment: trainingEnrollments })
        .from(trainingEnrollments)
        .innerJoin(checkoutOrders, eq(trainingEnrollments.checkoutOrderId, checkoutOrders.id))
        .where(
          and(
            eq(checkoutOrders.orderId, orderId),
            eq(checkoutOrders.status, "paid"),
            eq(trainingEnrollments.schedulingStatus, "pending"),
            isNull(trainingEnrollments.tokenUsedAt),
          ),
        )
        .limit(1);

      return found ?? null;
    },

    async findPendingEnrollmentBySchedulingTokenHash(schedulingTokenHash, now) {
      const [found] = await getPrivateDb()
        .select({ checkoutOrder: checkoutOrders, enrollment: trainingEnrollments })
        .from(trainingEnrollments)
        .innerJoin(checkoutOrders, eq(trainingEnrollments.checkoutOrderId, checkoutOrders.id))
        .where(
          and(
            eq(trainingEnrollments.schedulingTokenHash, schedulingTokenHash),
            eq(trainingEnrollments.schedulingStatus, "pending"),
            isNotNull(trainingEnrollments.schedulingTokenHash),
            isNotNull(trainingEnrollments.tokenExpiresAt),
            isNull(trainingEnrollments.tokenUsedAt),
            gt(trainingEnrollments.tokenExpiresAt, now),
            eq(checkoutOrders.status, "paid"),
          ),
        )
        .limit(1);

      return found ?? null;
    },

    async markSchedulingPending(enrollmentId, now) {
      await getPrivateDb()
        .update(trainingEnrollments)
        .set({
          scheduledAt: null,
          schedulingStatus: "pending",
          updatedAt: now,
        })
        .where(eq(trainingEnrollments.id, enrollmentId));
    },

    async markScheduled(enrollmentId, scheduledAt, now) {
      const updated = await getPrivateDb()
        .update(trainingEnrollments)
        .set({
          scheduledAt,
          schedulingStatus: "scheduled",
          tokenUsedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(trainingEnrollments.id, enrollmentId),
            eq(trainingEnrollments.schedulingStatus, "pending"),
            isNull(trainingEnrollments.tokenUsedAt),
          ),
        )
        .returning({ id: trainingEnrollments.id });

      return updated.length === 1;
    },

    async markStaffAlerted(enrollmentId, now) {
      const updated = await getPrivateDb()
        .update(trainingEnrollments)
        .set({
          staffAlertedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(trainingEnrollments.id, enrollmentId),
            isNull(trainingEnrollments.staffAlertedAt),
          ),
        )
        .returning({ id: trainingEnrollments.id });

      return updated.length === 1;
    },
  };
}

async function findPaidPendingEnrollmentByHelcimInvoice(
  input: FindTrainingEnrollmentByHelcimInvoiceInput,
): Promise<TrainingEnrollmentWithCheckoutOrder | null> {
  if (input.helcimInvoiceId === undefined && input.helcimInvoiceNumber === undefined) {
    return null;
  }

  const invoiceConditions = [
    input.helcimInvoiceId === undefined
      ? undefined
      : eq(checkoutOrders.helcimInvoiceId, input.helcimInvoiceId),
    input.helcimInvoiceNumber === undefined
      ? undefined
      : eq(checkoutOrders.helcimInvoiceNumber, input.helcimInvoiceNumber),
  ].filter((condition) => condition !== undefined);

  const [found] = await getPrivateDb()
    .select({ checkoutOrder: checkoutOrders, enrollment: trainingEnrollments })
    .from(trainingEnrollments)
    .innerJoin(checkoutOrders, eq(trainingEnrollments.checkoutOrderId, checkoutOrders.id))
    .where(
      and(
        ...invoiceConditions,
        eq(checkoutOrders.status, "paid"),
        eq(trainingEnrollments.schedulingStatus, "pending"),
        isNull(trainingEnrollments.tokenUsedAt),
      ),
    )
    .limit(1);

  return found ?? null;
}

async function issueSchedulingToken(
  found: TrainingEnrollmentWithCheckoutOrder,
  repository: Pick<TrainingEnrollmentRepository, "assignSchedulingToken">,
  now: Date,
  options: { requireMissingToken: boolean },
): Promise<IssuedTrainingSchedulingTokenRecord | null> {
  if (options.requireMissingToken && found.enrollment.schedulingTokenHash !== null) {
    return null;
  }

  const schedulingToken = generateTrainingSchedulingToken();
  const schedulingTokenHash = hashSchedulingToken(schedulingToken);
  const tokenExpiresAt = expiresInDaysFrom(now, SCHEDULING_TOKEN_TTL_DAYS);

  const assigned = await repository.assignSchedulingToken(
    found.enrollment.id,
    schedulingTokenHash,
    tokenExpiresAt,
    now,
  );

  if (!assigned) {
    return null;
  }

  return {
    ...toPendingTrainingEnrollmentRecord({
      checkoutOrder: found.checkoutOrder,
      enrollment: {
        ...found.enrollment,
        schedulingStatus: "pending",
        schedulingTokenHash,
        tokenExpiresAt,
        tokenUsedAt: null,
        updatedAt: now,
      },
    }),
    schedulingToken,
  };
}

function toPendingTrainingEnrollmentRecord(
  found: TrainingEnrollmentWithCheckoutOrder,
): PendingTrainingEnrollmentRecord {
  return {
    checkoutEmail: found.enrollment.checkoutEmail,
    checkoutOrder: found.checkoutOrder,
    enrollmentId: found.enrollment.id,
    productSnapshot: found.enrollment.productSnapshot,
    programSnapshot: found.enrollment.programSnapshot,
    staffAlertedAt: found.enrollment.staffAlertedAt,
    tokenExpiresAt: found.enrollment.tokenExpiresAt,
  };
}

function hashSchedulingToken(schedulingToken: string): string {
  return createHmac("sha256", getCheckoutSecretEncryptionKey())
    .update(schedulingToken, "utf8")
    .digest("hex");
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function expiresInDaysFrom(from: Date, days: number): Date {
  const expiresAt = new Date(from);
  expiresAt.setUTCDate(expiresAt.getUTCDate() + days);
  return expiresAt;
}
