import "server-only";

import { and, count, desc, eq, inArray, isNull } from "drizzle-orm";

import { getPrivateDb } from "@/lib/private-db/client";
import {
  marketingCampaigns,
  marketingContacts,
  type MarketingCampaignStatus,
} from "@/lib/private-db/schema";

export type MarketingCampaign = typeof marketingCampaigns.$inferSelect;

export interface CreateCampaignDraftInput {
  subject: string;
  previewText?: string;
  bodyHtml: string;
  audienceKey?: string;
  createdByAdminUserId?: string;
}

export interface UpdateCampaignDraftInput {
  subject: string;
  previewText?: string;
  bodyHtml: string;
  audienceKey?: string;
}

export interface RecordCampaignBroadcastInput {
  resendBroadcastId: string;
  resendSegmentId: string;
  recipientCountEstimate: number;
  scheduledAt?: Date;
}

// Statuses from which a campaign may still be edited or (re)sent. A campaign that
// is already sending/sent/scheduled is locked to avoid double-sends.
const EDITABLE_STATUSES: MarketingCampaignStatus[] = ["draft", "failed"];

function db() {
  return getPrivateDb();
}

/**
 * Counts marketing contacts eligible to receive a broadcast right now: opted in
 * and not unsubscribed. Used for the recipient estimate shown before sending.
 */
export async function countOptedInMarketingContacts(): Promise<number> {
  const [row] = await db()
    .select({ value: count() })
    .from(marketingContacts)
    .where(isNull(marketingContacts.unsubscribedAt));

  return row?.value ?? 0;
}

export async function createCampaignDraft(
  input: CreateCampaignDraftInput,
): Promise<MarketingCampaign> {
  const [campaign] = await db()
    .insert(marketingCampaigns)
    .values({
      subject: input.subject,
      previewText: input.previewText ?? null,
      bodyHtml: input.bodyHtml,
      audienceKey: input.audienceKey ?? "all_marketing",
      createdByAdminUserId: input.createdByAdminUserId ?? null,
      status: "draft",
    })
    .returning();

  if (!campaign) {
    throw new Error("Marketing campaign draft was not created");
  }

  return campaign;
}

export async function updateCampaignDraft(
  id: string,
  input: UpdateCampaignDraftInput,
): Promise<MarketingCampaign | null> {
  // Editable while draft or failed (so a failed send can be fixed and retried);
  // sending/scheduled/sent rows are locked.
  const [campaign] = await db()
    .update(marketingCampaigns)
    .set({
      subject: input.subject,
      previewText: input.previewText ?? null,
      bodyHtml: input.bodyHtml,
      ...(input.audienceKey ? { audienceKey: input.audienceKey } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(marketingCampaigns.id, id),
        inArray(marketingCampaigns.status, EDITABLE_STATUSES),
      ),
    )
    .returning();

  return campaign ?? null;
}

export async function getCampaignById(
  id: string,
): Promise<MarketingCampaign | null> {
  const [campaign] = await db()
    .select()
    .from(marketingCampaigns)
    .where(eq(marketingCampaigns.id, id))
    .limit(1);

  return campaign ?? null;
}

export async function listCampaigns(
  input: { limit?: number } = {},
): Promise<MarketingCampaign[]> {
  return db()
    .select()
    .from(marketingCampaigns)
    .orderBy(desc(marketingCampaigns.createdAt))
    .limit(input.limit ?? 50);
}

export function isCampaignEditable(campaign: MarketingCampaign): boolean {
  return EDITABLE_STATUSES.includes(campaign.status);
}

/**
 * Atomically claims an editable campaign for sending (draft|failed -> sending).
 * Returns the claimed row, or null if it was not in an editable status — the
 * caller must treat null as "another send is already in flight" and abort
 * WITHOUT creating a Resend broadcast, so no orphan broadcast is produced.
 */
export async function claimCampaignForSending(
  id: string,
): Promise<MarketingCampaign | null> {
  const [campaign] = await db()
    .update(marketingCampaigns)
    .set({
      status: "sending",
      lastError: null,
      lastErrorContext: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(marketingCampaigns.id, id),
        inArray(marketingCampaigns.status, EDITABLE_STATUSES),
      ),
    )
    .returning();

  return campaign ?? null;
}

/**
 * Records the Resend broadcast a claimed (status = "sending") campaign was handed
 * to. Kept separate from the claim so the claim can happen before the broadcast
 * exists.
 */
export async function recordCampaignBroadcast(
  id: string,
  input: RecordCampaignBroadcastInput,
): Promise<void> {
  await db()
    .update(marketingCampaigns)
    .set({
      resendBroadcastId: input.resendBroadcastId,
      resendSegmentId: input.resendSegmentId,
      recipientCountEstimate: input.recipientCountEstimate,
      scheduledAt: input.scheduledAt ?? null,
      updatedAt: new Date(),
    })
    .where(eq(marketingCampaigns.id, id));
}

export async function markCampaignSent(
  id: string,
  input: { scheduledAt?: Date; sentAt: Date },
): Promise<void> {
  await db()
    .update(marketingCampaigns)
    .set({
      status: input.scheduledAt ? "scheduled" : "sent",
      sentAt: input.scheduledAt ? null : input.sentAt,
      updatedAt: new Date(),
    })
    .where(eq(marketingCampaigns.id, id));
}

export async function markCampaignFailed(
  id: string,
  input: { error: string; errorContext?: Record<string, unknown> },
): Promise<void> {
  await db()
    .update(marketingCampaigns)
    .set({
      status: "failed",
      lastError: input.error,
      lastErrorContext: input.errorContext ?? null,
      updatedAt: new Date(),
    })
    .where(eq(marketingCampaigns.id, id));
}
