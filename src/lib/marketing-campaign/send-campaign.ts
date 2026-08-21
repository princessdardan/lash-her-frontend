import "server-only";

import {
  createResendBroadcast,
  getResendBroadcast,
  sendResendBroadcast,
} from "@/lib/resend-platform";
import {
  CUSTOMER_REPLY_TO_EMAIL,
  getEmailConfig,
  sendTransactionalEmail,
} from "@/lib/transactional-email";

import { wrapCampaignEmailHtml } from "./campaign-email-html";
import {
  claimCampaignForSending,
  countOptedInMarketingContacts,
  getCampaignById,
  markCampaignFailed,
  markCampaignSent,
  recordCampaignBroadcast,
  type MarketingCampaign,
} from "./marketing-campaign-store";

const MARKETING_SEGMENT_ENV = "RESEND_SEGMENT_MARKETING_ID";

export type CampaignSendErrorCode =
  | "not_found"
  | "invalid_status"
  | "segment_not_configured"
  | "already_sending"
  | "broadcast_failed";

export class CampaignSendError extends Error {
  readonly code: CampaignSendErrorCode;

  constructor(code: CampaignSendErrorCode, message: string) {
    super(message);
    this.name = "CampaignSendError";
    this.code = code;
  }
}

export interface SendCampaignResult {
  broadcastId: string;
  recipientCountEstimate: number;
  status: "sent" | "scheduled";
}

function getMarketingSegmentId(): string | undefined {
  return process.env[MARKETING_SEGMENT_ENV]?.trim() || undefined;
}

function buildCampaignHtml(campaign: MarketingCampaign): string {
  return wrapCampaignEmailHtml({
    subject: campaign.subject,
    previewText: campaign.previewText ?? undefined,
    bodyHtml: campaign.bodyHtml,
  });
}

/**
 * Sends a single test copy of the campaign to one recipient (the requesting
 * admin). Uses the transactional path — it does NOT touch the audience, create a
 * broadcast, or change campaign status. Safe to call repeatedly.
 */
export async function sendCampaignTestEmail(input: {
  campaign: MarketingCampaign;
  to: string;
}): Promise<void> {
  await sendTransactionalEmail({
    to: input.to,
    replyTo: CUSTOMER_REPLY_TO_EMAIL,
    subject: `[Test] ${input.campaign.subject}`,
    html: buildCampaignHtml(input.campaign),
    tags: [{ name: "type", value: "marketing_campaign_test" }],
  });
}

/**
 * Sends (or schedules) a campaign as a Resend broadcast to the marketing segment.
 * Claims the campaign first (draft|failed -> sending) so a concurrent send can't
 * double-fire, then creates and sends the broadcast, then finalizes status. On
 * any Resend failure the campaign is moved to "failed" and a CampaignSendError is
 * thrown for the caller to surface.
 */
export async function sendCampaign(input: {
  campaignId: string;
  scheduledAt?: Date;
}): Promise<SendCampaignResult> {
  const segmentId = getMarketingSegmentId();

  if (segmentId === undefined) {
    throw new CampaignSendError(
      "segment_not_configured",
      `Marketing audience is not configured (${MARKETING_SEGMENT_ENV} is unset).`,
    );
  }

  const existing = await getCampaignById(input.campaignId);

  if (existing === null) {
    throw new CampaignSendError("not_found", "Campaign not found.");
  }

  if (existing.status !== "draft" && existing.status !== "failed") {
    throw new CampaignSendError(
      "invalid_status",
      `Campaign cannot be sent from status "${existing.status}".`,
    );
  }

  // Claim BEFORE creating any broadcast so a lost race produces no orphan.
  const campaign = await claimCampaignForSending(input.campaignId);

  if (campaign === null) {
    throw new CampaignSendError(
      "already_sending",
      "This campaign is already being sent.",
    );
  }

  const recipientCountEstimate = await countOptedInMarketingContacts();

  try {
    let broadcastId: string;

    if (campaign.resendBroadcastId) {
      // A prior attempt already created a broadcast for this campaign (e.g. a
      // send whose HTTP response was lost, then retried after "failed"). Inspect
      // it rather than creating a second broadcast — creating a new one would
      // email the entire audience twice.
      const existing = await getResendBroadcast(campaign.resendBroadcastId);
      broadcastId = campaign.resendBroadcastId;

      if (existing.status !== "draft") {
        // Already dispatched (sent/queued/scheduled). Finalize as success
        // without re-sending.
        await markCampaignSent(campaign.id, {
          scheduledAt: input.scheduledAt,
          sentAt: new Date(),
        });

        return {
          broadcastId,
          recipientCountEstimate:
            campaign.recipientCountEstimate ?? recipientCountEstimate,
          status: input.scheduledAt ? "scheduled" : "sent",
        };
      }
      // Broadcast exists but was never sent — fall through and send it.
    } else {
      const broadcast = await createResendBroadcast({
        segmentId,
        from: getEmailConfig().fromEmail,
        replyTo: CUSTOMER_REPLY_TO_EMAIL,
        subject: campaign.subject,
        ...(campaign.previewText ? { previewText: campaign.previewText } : {}),
        html: buildCampaignHtml(campaign),
        name: `campaign:${campaign.id}`,
      });

      broadcastId = broadcast.id;

      await recordCampaignBroadcast(campaign.id, {
        resendBroadcastId: broadcastId,
        resendSegmentId: segmentId,
        recipientCountEstimate,
        scheduledAt: input.scheduledAt,
      });
    }

    await sendResendBroadcast(
      broadcastId,
      input.scheduledAt
        ? { scheduledAt: input.scheduledAt.toISOString() }
        : undefined,
    );

    await markCampaignSent(campaign.id, {
      scheduledAt: input.scheduledAt,
      sentAt: new Date(),
    });

    return {
      broadcastId,
      recipientCountEstimate,
      status: input.scheduledAt ? "scheduled" : "sent",
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown broadcast error";

    await markCampaignFailed(campaign.id, {
      error: message,
      errorContext: { segmentId },
    });

    throw new CampaignSendError(
      "broadcast_failed",
      `Resend broadcast failed: ${message}`,
    );
  }
}
