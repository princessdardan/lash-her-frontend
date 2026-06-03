import "server-only";

import { desc, eq } from "drizzle-orm";

import { normalizeAdminEmail } from "@/lib/env/admin";
import { getPrivateDb } from "@/lib/private-db/client";
import {
  privacyRequestEvents,
  privacyRequests,
  type PrivacyRequestEventMetadata,
  type PrivacyRequestEventType,
  type PrivacyRequestStatus,
  type PrivacyRequestType,
} from "@/lib/private-db/schema";

import type { AdminActor } from "./types";

type PrivacyRequestRow = typeof privacyRequests.$inferSelect;
type PrivacyRequestEventRow = typeof privacyRequestEvents.$inferSelect;

export interface CreatePrivacyRequestInput {
  actor: AdminActor;
  requestType: PrivacyRequestType;
  requesterName?: string;
  requesterNotes?: string;
  subjectEmail: string;
}

export interface ChangePrivacyRequestStatusInput {
  actor: AdminActor;
  privacyRequestId: string;
  status: PrivacyRequestStatus;
}

export interface AddPrivacyRequestEventInput {
  actor: AdminActor;
  eventType: PrivacyRequestEventType;
  message?: string;
  metadata?: PrivacyRequestEventMetadata;
  privacyRequestId: string;
}

export interface PrivacyRequestRepository {
  createPrivacyRequest(input: {
    createdByAdminUserId: string;
    requestType: PrivacyRequestType;
    requesterName?: string;
    requesterNotes?: string;
    subjectEmail: string;
    subjectEmailNormalized: string;
  }): Promise<PrivacyRequestRow>;
  createPrivacyRequestEvent(input: {
    actorAdminUserId: string;
    eventType: PrivacyRequestEventType;
    message?: string;
    metadata?: PrivacyRequestEventMetadata;
    privacyRequestId: string;
  }): Promise<{ id: string }>;
  findPrivacyRequestById(id: string): Promise<PrivacyRequestRow | null>;
  listPrivacyRequestEvents(privacyRequestId: string): Promise<PrivacyRequestEventRow[]>;
  updatePrivacyRequestStatus(
    id: string,
    status: PrivacyRequestStatus,
    completedAt: Date | null,
  ): Promise<PrivacyRequestRow>;
}

export function createPrivacyRequestService(repository: PrivacyRequestRepository) {
  return {
    async addEvent(input: AddPrivacyRequestEventInput): Promise<{ id: string }> {
      const request = await repository.findPrivacyRequestById(input.privacyRequestId);

      if (!request) {
        throw new Error("Privacy request not found");
      }

      return repository.createPrivacyRequestEvent({
        actorAdminUserId: input.actor.user.id,
        eventType: input.eventType,
        message: input.message,
        metadata: input.metadata,
        privacyRequestId: input.privacyRequestId,
      });
    },
    async changeStatus(input: ChangePrivacyRequestStatusInput): Promise<PrivacyRequestRow> {
      const existing = await repository.findPrivacyRequestById(input.privacyRequestId);

      if (!existing) {
        throw new Error("Privacy request not found");
      }

      const completedAt = input.status === "completed"
        ? existing.completedAt ?? new Date()
        : null;
      const request = await repository.updatePrivacyRequestStatus(input.privacyRequestId, input.status, completedAt);

      await repository.createPrivacyRequestEvent({
        actorAdminUserId: input.actor.user.id,
        eventType: "status_changed",
        message: `Status changed to ${input.status}`,
        metadata: { status: input.status },
        privacyRequestId: input.privacyRequestId,
      });

      return request;
    },
    async createRequest(input: CreatePrivacyRequestInput): Promise<PrivacyRequestRow> {
      const request = await repository.createPrivacyRequest({
        createdByAdminUserId: input.actor.user.id,
        requestType: input.requestType,
        requesterName: cleanOptionalText(input.requesterName),
        requesterNotes: cleanOptionalText(input.requesterNotes),
        subjectEmail: input.subjectEmail.trim(),
        subjectEmailNormalized: normalizeAdminEmail(input.subjectEmail),
      });

      await repository.createPrivacyRequestEvent({
        actorAdminUserId: input.actor.user.id,
        eventType: "created",
        message: "Privacy request created",
        metadata: { requestType: input.requestType },
        privacyRequestId: request.id,
      });

      return request;
    },
    async getRequestWithEvents(id: string): Promise<{ events: PrivacyRequestEventRow[]; request: PrivacyRequestRow } | null> {
      const request = await repository.findPrivacyRequestById(id);

      if (!request) {
        return null;
      }

      return {
        events: await repository.listPrivacyRequestEvents(id),
        request,
      };
    },
  };
}

export function createDrizzlePrivacyRequestRepository(): PrivacyRequestRepository {
  const db = getPrivateDb();

  return {
    async createPrivacyRequest(input) {
      const rows = await db.insert(privacyRequests).values(input).returning();

      return rows[0];
    },
    async createPrivacyRequestEvent(input) {
      const rows = await db.insert(privacyRequestEvents).values(input).returning({ id: privacyRequestEvents.id });

      return rows[0];
    },
    async findPrivacyRequestById(id) {
      const rows = await db.select().from(privacyRequests).where(eq(privacyRequests.id, id)).limit(1);

      return rows[0] ?? null;
    },
    async listPrivacyRequestEvents(privacyRequestId) {
      return db
        .select()
        .from(privacyRequestEvents)
        .where(eq(privacyRequestEvents.privacyRequestId, privacyRequestId))
        .orderBy(desc(privacyRequestEvents.createdAt));
    },
    async updatePrivacyRequestStatus(id, status, completedAt) {
      const rows = await db
        .update(privacyRequests)
        .set({ completedAt, status, updatedAt: new Date() })
        .where(eq(privacyRequests.id, id))
        .returning();

      return rows[0];
    },
  };
}

export function getPrivacyRequestService() {
  return createPrivacyRequestService(createDrizzlePrivacyRequestRepository());
}

function cleanOptionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";

  return trimmed.length > 0 ? trimmed : undefined;
}
