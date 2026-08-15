import "server-only";

import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";

import { getPrivateDb } from "@/lib/private-db/client";
import {
  productOrderCustomerDecisions,
  productOrderRefunds,
  productShipmentJobs,
  productShipmentReturnObservations,
  productShipments,
} from "@/lib/private-db/schema";

import { assertConfiguredFulfillmentOwnerInTransaction } from "./configured-owner";

export type FulfillmentOperationReviewKind =
  | "provider_job"
  | "shipment_generation"
  | "customer_decision"
  | "refund";

export type ReturnObservationResolutionAction =
  | "record_inspection"
  | "escalate_unmatched_return"
  | "confirm_linked_case";

interface ReviewedActionInput {
  actorAdminUserId: string;
  evidenceReference: string;
  expectedStateVersion: number;
  id: string;
  rationale: string;
  stepUpAuthenticatedAt: Date;
  now?: Date;
}

export async function recordFulfillmentOperationReview(
  input: ReviewedActionInput & { kind: FulfillmentOperationReviewKind },
): Promise<{ id: string; stateVersion: number; status: string }> {
  const normalized = normalizeReviewedAction(input);
  const now = input.now ?? new Date();

  return getPrivateDb().transaction(async (tx) => {
    await assertConfiguredFulfillmentOwnerInTransaction(
      tx,
      input.actorAdminUserId,
    );

    if (input.kind === "provider_job") {
      const [updated] = await tx
        .update(productShipmentJobs)
        .set({
          status: "queued",
          availableAt: now,
          nextAttemptAt: null,
          outcomeUnknown: true,
          completedAt: null,
          outcomeCode: "manual_reconciliation_requested",
          reconciliationEvidenceReference: normalized.evidenceReference,
          reconciliationRationale: normalized.rationale,
          reconciliationRequestedByAdminUserId: input.actorAdminUserId,
          reconciliationStepUpAuthenticatedAt: input.stepUpAuthenticatedAt,
          reconciliationRequestedAt: now,
          stateVersion: sql`${productShipmentJobs.stateVersion} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(productShipmentJobs.id, input.id),
            eq(productShipmentJobs.status, "dead_letter"),
            eq(productShipmentJobs.stateVersion, input.expectedStateVersion),
            isNull(productShipmentJobs.redactedAt),
          ),
        )
        .returning({
          id: productShipmentJobs.id,
          stateVersion: productShipmentJobs.stateVersion,
          status: productShipmentJobs.status,
        });
      if (!updated) throw conflict("Provider job");
      return updated;
    }

    if (input.kind === "shipment_generation") {
      const [updated] = await tx
        .update(productShipments)
        .set({
          manualReviewAcknowledgedAt: now,
          manualReviewEvidenceReference: normalized.evidenceReference,
          manualReviewRationale: normalized.rationale,
          manualReviewByAdminUserId: input.actorAdminUserId,
          manualReviewStepUpAuthenticatedAt: input.stepUpAuthenticatedAt,
          stateVersion: sql`${productShipments.stateVersion} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(productShipments.id, input.id),
            eq(productShipments.status, "manual_review"),
            eq(productShipments.stateVersion, input.expectedStateVersion),
            isNull(productShipments.manualReviewAcknowledgedAt),
            isNull(productShipments.redactedAt),
          ),
        )
        .returning({
          id: productShipments.id,
          stateVersion: productShipments.stateVersion,
          status: productShipments.status,
        });
      if (!updated) throw conflict("Shipment generation");
      return updated;
    }

    if (input.kind === "customer_decision") {
      const [updated] = await tx
        .update(productOrderCustomerDecisions)
        .set({
          legalFollowUpEvidenceReference: normalized.evidenceReference,
          legalFollowUpRationale: normalized.rationale,
          legalFollowUpByAdminUserId: input.actorAdminUserId,
          legalFollowUpStepUpAuthenticatedAt: input.stepUpAuthenticatedAt,
          legalFollowUpRecordedAt: now,
          stateVersion: sql`${productOrderCustomerDecisions.stateVersion} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(productOrderCustomerDecisions.id, input.id),
            inArray(productOrderCustomerDecisions.status, [
              "pending",
              "selected",
            ]),
            eq(
              productOrderCustomerDecisions.stateVersion,
              input.expectedStateVersion,
            ),
            isNull(productOrderCustomerDecisions.legalFollowUpRecordedAt),
            isNull(productOrderCustomerDecisions.redactedAt),
          ),
        )
        .returning({
          id: productOrderCustomerDecisions.id,
          stateVersion: productOrderCustomerDecisions.stateVersion,
          status: productOrderCustomerDecisions.status,
        });
      if (!updated) throw conflict("Customer decision");
      return updated;
    }

    const [updated] = await tx
      .update(productOrderRefunds)
      .set({
        manualReviewEvidenceReference: normalized.evidenceReference,
        manualReviewRationale: normalized.rationale,
        manualReviewByAdminUserId: input.actorAdminUserId,
        manualReviewStepUpAuthenticatedAt: input.stepUpAuthenticatedAt,
        manualReviewRecordedAt: now,
        stateVersion: sql`${productOrderRefunds.stateVersion} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(productOrderRefunds.id, input.id),
          inArray(productOrderRefunds.status, [
            "outcome_unknown",
            "manual_review",
          ]),
          eq(productOrderRefunds.stateVersion, input.expectedStateVersion),
          isNull(productOrderRefunds.manualReviewRecordedAt),
          isNull(productOrderRefunds.fulfillmentQuarantinedAt),
          isNull(productOrderRefunds.redactedAt),
        ),
      )
      .returning({
        id: productOrderRefunds.id,
        stateVersion: productOrderRefunds.stateVersion,
        status: productOrderRefunds.status,
      });
    if (!updated) throw conflict("Refund");
    return { ...updated, status: "manual_review_acknowledged" };
  });
}

export async function resolveReturnObservation(
  input: ReviewedActionInput & { action: ReturnObservationResolutionAction },
): Promise<{ id: string; stateVersion: number }> {
  const normalized = normalizeReviewedAction(input);
  const now = input.now ?? new Date();

  return getPrivateDb().transaction(async (tx) => {
    await assertConfiguredFulfillmentOwnerInTransaction(
      tx,
      input.actorAdminUserId,
    );
    const [current] = await tx
      .select({
        caseId: productShipmentReturnObservations.caseId,
        matchStatus: productShipmentReturnObservations.matchStatus,
        shipmentId: productShipmentReturnObservations.shipmentId,
      })
      .from(productShipmentReturnObservations)
      .where(
        and(
          eq(productShipmentReturnObservations.id, input.id),
          eq(
            productShipmentReturnObservations.stateVersion,
            input.expectedStateVersion,
          ),
          or(
            isNull(productShipmentReturnObservations.resolvedAt),
            sql`${productShipmentReturnObservations.resolvedStateVersion} is distinct from ${productShipmentReturnObservations.stateVersion}`,
          ),
          isNull(productShipmentReturnObservations.redactedAt),
        ),
      )
      .for("update")
      .limit(1);
    if (!current) throw conflict("Return observation");
    if (input.action === "confirm_linked_case" && !current.caseId) {
      throw new Error("The return observation has no linked shipping case");
    }
    if (input.action === "record_inspection" && !current.shipmentId) {
      throw new Error("A matched shipment is required to record inspection");
    }
    if (
      input.action === "escalate_unmatched_return" &&
      !["unmatched", "manual_review"].includes(current.matchStatus)
    ) {
      throw new Error("Only an unmatched return can be escalated");
    }

    const [updated] = await tx
      .update(productShipmentReturnObservations)
      .set({
        adminResolutionAction: input.action,
        adminResolutionEvidenceReference: normalized.evidenceReference,
        adminResolutionRationale: normalized.rationale,
        resolvedByAdminUserId: input.actorAdminUserId,
        resolutionStepUpAuthenticatedAt: input.stepUpAuthenticatedAt,
        resolvedAt: now,
        resolvedStateVersion: sql`${productShipmentReturnObservations.stateVersion} + 1`,
        stateVersion: sql`${productShipmentReturnObservations.stateVersion} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(productShipmentReturnObservations.id, input.id),
          eq(
            productShipmentReturnObservations.stateVersion,
            input.expectedStateVersion,
          ),
          or(
            isNull(productShipmentReturnObservations.resolvedAt),
            sql`${productShipmentReturnObservations.resolvedStateVersion} is distinct from ${productShipmentReturnObservations.stateVersion}`,
          ),
        ),
      )
      .returning({
        id: productShipmentReturnObservations.id,
        stateVersion: productShipmentReturnObservations.stateVersion,
      });
    if (!updated) throw conflict("Return observation");
    return updated;
  });
}

function normalizeReviewedAction(input: ReviewedActionInput): {
  evidenceReference: string;
  rationale: string;
} {
  const evidenceReference = input.evidenceReference.trim();
  const rationale = input.rationale.trim();
  if (
    !Number.isInteger(input.expectedStateVersion) ||
    input.expectedStateVersion < 1
  ) {
    throw new Error("A valid expected state version is required");
  }
  if (evidenceReference.length < 6 || evidenceReference.length > 500) {
    throw new Error(
      "An evidence reference between 6 and 500 characters is required",
    );
  }
  if (rationale.length < 10 || rationale.length > 1_000) {
    throw new Error("A rationale between 10 and 1000 characters is required");
  }
  return { evidenceReference, rationale };
}

function conflict(subject: string): Error {
  return new Error(
    `${subject} changed or is no longer eligible; refresh the queue`,
  );
}
