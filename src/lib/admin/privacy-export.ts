import "server-only";

import { eq, inArray, sql } from "drizzle-orm";

import { getPrivateDb } from "@/lib/private-db/client";
import {
  appointmentHolds,
  checkoutOrders,
  checkoutPaymentEvents,
  marketingConsentEvents,
  marketingContacts,
  marketingContactSubmissions,
  privacyRequests,
  trainingEnrollments,
} from "@/lib/private-db/schema";

import type { AuditLogEntryInput } from "./audit-log";
import { getAuditLogService } from "./audit-log";
import type { AdminActor } from "./types";

interface PrivacyExportRequestRow {
  id: string;
  status: string;
  subjectEmailNormalized: string;
}

export interface SubjectRecords {
  appointmentHolds: Record<string, unknown>[];
  consentEvents: Record<string, unknown>[];
  marketingContacts: Record<string, unknown>[];
  orders: Record<string, unknown>[];
  paymentEvents: Record<string, unknown>[];
  submissions: Record<string, unknown>[];
  trainingEnrollments: Record<string, unknown>[];
}

export interface PrivacyExportRepository {
  findPrivacyRequest(id: string): Promise<PrivacyExportRequestRow | null>;
  findSubjectRecords(emailNormalized: string): Promise<SubjectRecords>;
  recordAuditEvent(input: AuditLogEntryInput): Promise<void>;
}

export interface BuildPrivacyExportInput {
  actor: AdminActor;
  privacyRequestId: string;
  reason: string;
}

export function createPrivacyExportService(repository: PrivacyExportRepository) {
  return {
    async buildExport(input: BuildPrivacyExportInput) {
      const reason = input.reason.trim();

      if (reason.length < 5) {
        throw new Error("Export reason is required");
      }

      const request = await repository.findPrivacyRequest(input.privacyRequestId);

      if (!request) {
        throw new Error("Privacy request not found");
      }

      if (request.status === "completed" || request.status === "cancelled") {
        throw new Error("Privacy request is not active");
      }

      await repository.recordAuditEvent({
        action: "privacy_export_attempt",
        actor: input.actor,
        domain: "privacy",
        privacyRequestId: request.id,
        targetId: request.id,
        targetType: "privacy_request",
      });

      try {
        const records = await repository.findSubjectRecords(request.subjectEmailNormalized);
        const exportPackage = {
          generatedAt: new Date().toISOString(),
          generatedBy: input.actor.user.emailNormalized,
          privacyRequestId: request.id,
          reason,
          records: sanitizeSubjectRecords(records),
          subjectEmailNormalized: request.subjectEmailNormalized,
        };

        await repository.recordAuditEvent({
          action: "privacy_export_completed",
          actor: input.actor,
          domain: "privacy",
          metadata: { sectionCount: Object.keys(exportPackage.records).length },
          privacyRequestId: request.id,
          targetId: request.id,
          targetType: "privacy_request",
        });

        return exportPackage;
      } catch (error) {
        await repository.recordAuditEvent({
          action: "privacy_export_failed",
          actor: input.actor,
          domain: "privacy",
          metadata: { error: error instanceof Error ? error.message : "Unknown export error" },
          privacyRequestId: request.id,
          targetId: request.id,
          targetType: "privacy_request",
        });
        throw error;
      }
    },
  };
}

export function createDrizzlePrivacyExportRepository(): PrivacyExportRepository {
  const db = getPrivateDb();
  const audit = getAuditLogService();

  return {
    async findPrivacyRequest(id) {
      const rows = await db
        .select({
          id: privacyRequests.id,
          status: privacyRequests.status,
          subjectEmailNormalized: privacyRequests.subjectEmailNormalized,
        })
        .from(privacyRequests)
        .where(eq(privacyRequests.id, id))
        .limit(1);

      return rows[0] ?? null;
    },
    async findSubjectRecords(emailNormalized) {
      const [contacts, submissions, consentEvents, orders, holds, enrollments] = await Promise.all([
        db.select().from(marketingContacts).where(eq(marketingContacts.emailNormalized, emailNormalized)),
        db.select().from(marketingContactSubmissions).where(eq(marketingContactSubmissions.emailNormalized, emailNormalized)),
        db.select().from(marketingConsentEvents).where(eq(marketingConsentEvents.emailNormalized, emailNormalized)),
        db
          .select({
            amountCents: checkoutOrders.amountCents,
            calendarFinalizationStatus: checkoutOrders.calendarFinalizationStatus,
            createdAt: checkoutOrders.createdAt,
            currency: checkoutOrders.currency,
            customerEmail: checkoutOrders.customerEmail,
            customerName: checkoutOrders.customerName,
            finalizedAt: checkoutOrders.finalizedAt,
            id: checkoutOrders.id,
            lineItems: checkoutOrders.lineItems,
            orderId: checkoutOrders.orderId,
            paidAt: checkoutOrders.paidAt,
            paymentProvider: checkoutOrders.paymentProvider,
            purpose: checkoutOrders.purpose,
            shippingAddress: checkoutOrders.shippingAddress,
            status: checkoutOrders.status,
            updatedAt: checkoutOrders.updatedAt,
          })
          .from(checkoutOrders)
          .where(eq(sql<string>`lower(trim(${checkoutOrders.customerEmail}))`, emailNormalized)),
        db
          .select({
            bookingConfirmationEmailSentAt: appointmentHolds.bookingConfirmationEmailSentAt,
            bookingType: appointmentHolds.bookingType,
            bookedAt: appointmentHolds.bookedAt,
            createdAt: appointmentHolds.createdAt,
            customerSnapshot: appointmentHolds.customerSnapshot,
            finalizationReason: appointmentHolds.finalizationReason,
            finalizationStatus: appointmentHolds.finalizationStatus,
            id: appointmentHolds.id,
            offeringSnapshot: appointmentHolds.offeringSnapshot,
            paidAt: appointmentHolds.paidAt,
            publicReference: appointmentHolds.publicReference,
            selectedEnd: appointmentHolds.selectedEnd,
            selectedStart: appointmentHolds.selectedStart,
            status: appointmentHolds.status,
            timezone: appointmentHolds.timezone,
            updatedAt: appointmentHolds.updatedAt,
          })
          .from(appointmentHolds)
          .where(eq(sql<string>`lower(trim(${appointmentHolds.customerSnapshot}->>'email'))`, emailNormalized)),
        db.select().from(trainingEnrollments).where(eq(sql<string>`lower(trim(${trainingEnrollments.checkoutEmail}))`, emailNormalized)),
      ]);
      const orderIds = orders.map((order) => order.id);
      const paymentEvents = orderIds.length > 0
        ? await db
          .select({
            amountCents: checkoutPaymentEvents.amountCents,
            createdAt: checkoutPaymentEvents.createdAt,
            currency: checkoutPaymentEvents.currency,
            eventType: checkoutPaymentEvents.eventType,
            paymentProvider: checkoutPaymentEvents.paymentProvider,
            processedAt: checkoutPaymentEvents.processedAt,
            processingStatus: checkoutPaymentEvents.processingStatus,
            providerStatus: checkoutPaymentEvents.providerStatus,
          })
          .from(checkoutPaymentEvents)
          .where(inArray(checkoutPaymentEvents.orderId, orderIds))
        : [];

      return {
        appointmentHolds: holds,
        consentEvents,
        marketingContacts: contacts,
        orders,
        paymentEvents,
        submissions,
        trainingEnrollments: enrollments,
      };
    },
    async recordAuditEvent(input) {
      await audit.record(input);
    },
  };
}

export function getPrivacyExportService() {
  return createPrivacyExportService(createDrizzlePrivacyExportRepository());
}

function sanitizeSubjectRecords(records: SubjectRecords): SubjectRecords {
  return {
    ...records,
    paymentEvents: records.paymentEvents.map((event) => ({
      amountCents: event.amountCents,
      createdAt: event.createdAt,
      currency: event.currency,
      eventType: event.eventType,
      paymentProvider: event.paymentProvider,
      processedAt: event.processedAt,
      processingStatus: event.processingStatus,
      providerStatus: event.providerStatus,
    })),
  };
}
