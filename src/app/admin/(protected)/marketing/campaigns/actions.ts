"use server";

import { runActionWriterAdmission } from "@/lib/writer-admission/action";
import { markWriterOperationUncertain } from "@/lib/writer-admission/context";
import { ADMIN_WRITER_UNAVAILABLE } from "@/lib/admin/action-admission";
import { highLevelOwnsMarketing } from "@/lib/highlevel/config";
import { revalidatePath } from "next/cache";

import { requirePermission } from "@/lib/admin/auth";
import { AdminAuthError } from "@/lib/admin/types";
import { sanitizeCampaignBodyHtml } from "@/lib/marketing-campaign/campaign-email-html";
import {
  createCampaignDraft,
  getCampaignById,
  updateCampaignDraft,
} from "@/lib/marketing-campaign/marketing-campaign-store";
import {
  CampaignSendError,
  sendCampaign,
  sendCampaignTestEmail,
} from "@/lib/marketing-campaign/send-campaign";

const MARKETING_PATH = "/admin/marketing";
const SUBJECT_MAX = 200;
const PREVIEW_MAX = 200;
const BODY_MAX = 100_000;
// Upper bound on the raw HTML before sanitizing, so an oversized payload can't
// burn CPU/memory in the sanitizer parse. Generous vs. the post-sanitize cap.
const RAW_BODY_MAX = 500_000;

export interface SaveCampaignDraftInput {
  campaignId?: string;
  subject: string;
  previewText?: string;
  bodyHtml: string;
}

export interface SaveCampaignDraftResult {
  ok: boolean;
  campaignId?: string;
  error?: string;
}

export interface SendCampaignTestResult {
  ok: boolean;
  sentTo?: string;
  error?: string;
}

export interface SendCampaignResult {
  ok: boolean;
  status?: "sent" | "scheduled";
  recipientCountEstimate?: number;
  error?: string;
}

async function saveCampaignDraftActionImpl(
  input: SaveCampaignDraftInput,
): Promise<SaveCampaignDraftResult> {
  let actorId: string;

  try {
    const actor = await requirePermission("marketing:send");
    actorId = actor.user.id;
  } catch (error) {
    markWriterOperationUncertain();
    return { ok: false, error: permissionError(error) };
  }

  if (highLevelOwnsMarketing())
    return {
      ok: false,
      error: "Marketing campaigns are managed in HighLevel.",
    };
  const subject = input.subject?.trim() ?? "";

  if (subject.length === 0) {
    return { ok: false, error: "Subject is required." };
  }

  if (subject.length > SUBJECT_MAX) {
    return {
      ok: false,
      error: `Subject must be ${SUBJECT_MAX} characters or fewer.`,
    };
  }

  const previewText = input.previewText?.trim() || undefined;

  if (previewText && previewText.length > PREVIEW_MAX) {
    return {
      ok: false,
      error: `Preview text must be ${PREVIEW_MAX} characters or fewer.`,
    };
  }

  if ((input.bodyHtml ?? "").length > RAW_BODY_MAX) {
    return { ok: false, error: "Email content is too long." };
  }

  const bodyHtml = sanitizeCampaignBodyHtml(input.bodyHtml ?? "");

  if (isEffectivelyEmpty(bodyHtml)) {
    return { ok: false, error: "Email content is required." };
  }

  if (bodyHtml.length > BODY_MAX) {
    return { ok: false, error: "Email content is too long." };
  }

  try {
    if (input.campaignId) {
      const updated = await updateCampaignDraft(input.campaignId, {
        subject,
        previewText,
        bodyHtml,
      });

      if (!updated) {
        return {
          ok: false,
          error: "This campaign can no longer be edited.",
        };
      }

      revalidatePath(MARKETING_PATH);
      return { ok: true, campaignId: updated.id };
    }

    const created = await createCampaignDraft({
      subject,
      previewText,
      bodyHtml,
      createdByAdminUserId: actorId,
    });

    revalidatePath(MARKETING_PATH);
    return { ok: true, campaignId: created.id };
  } catch (error) {
    markWriterOperationUncertain();
    return { ok: false, error: friendlyError(error) };
  }
}

async function sendCampaignTestActionImpl(
  campaignId: string,
): Promise<SendCampaignTestResult> {
  let actorEmail: string;

  try {
    const actor = await requirePermission("marketing:send");
    actorEmail = actor.user.email;
  } catch (error) {
    markWriterOperationUncertain();
    return { ok: false, error: permissionError(error) };
  }

  const campaign = await getCampaignById(campaignId);

  if (!campaign) {
    return { ok: false, error: "Campaign not found." };
  }

  try {
    await sendCampaignTestEmail({ campaign, to: actorEmail });
    return { ok: true, sentTo: actorEmail };
  } catch {
    markWriterOperationUncertain();
    return {
      ok: false,
      error: "Could not send the test email. Please try again.",
    };
  }
}

async function sendCampaignActionImpl(input: {
  campaignId: string;
  scheduledAt?: string;
}): Promise<SendCampaignResult> {
  try {
    await requirePermission("marketing:send");
  } catch (error) {
    markWriterOperationUncertain();
    return { ok: false, error: permissionError(error) };
  }

  let scheduledAt: Date | undefined;

  if (input.scheduledAt) {
    scheduledAt = new Date(input.scheduledAt);

    if (Number.isNaN(scheduledAt.getTime())) {
      return { ok: false, error: "The schedule time is invalid." };
    }

    if (scheduledAt.getTime() <= Date.now()) {
      return { ok: false, error: "The schedule time must be in the future." };
    }
  }

  try {
    const result = await sendCampaign({
      campaignId: input.campaignId,
      scheduledAt,
    });

    revalidatePath(MARKETING_PATH);
    return {
      ok: true,
      status: result.status,
      recipientCountEstimate: result.recipientCountEstimate,
    };
  } catch (error) {
    markWriterOperationUncertain();
    if (error instanceof CampaignSendError) {
      return { ok: false, error: error.message };
    }

    return { ok: false, error: "The campaign could not be sent." };
  }
}

// Quill emits "<p><br></p>" for an empty editor; treat content with no text and
// no image as empty so blank campaigns can't be saved or sent.
function isEffectivelyEmpty(html: string): boolean {
  const text = html
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, "")
    .trim();

  return text.length === 0 && !/<img\b/i.test(html);
}

function permissionError(error: unknown): string {
  if (error instanceof AdminAuthError) {
    return "You do not have permission to send marketing emails.";
  }

  return "You do not have permission to send marketing emails.";
}

function friendlyError(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.trim();

    if (
      message.length > 0 &&
      message.length <= 240 &&
      !message.includes("\n") &&
      !/(?:constraint|database|drizzle|insert into|query|relation|sql)/i.test(
        message,
      )
    ) {
      return message;
    }
  }

  return "The campaign could not be saved.";
}

export async function saveCampaignDraftAction(
  input: SaveCampaignDraftInput,
): Promise<SaveCampaignDraftResult> {
  return runActionWriterAdmission(
    "new-work",
    () => saveCampaignDraftActionImpl(input),
    () => ({ ok: false, error: ADMIN_WRITER_UNAVAILABLE }),
  );
}
export async function sendCampaignTestAction(
  campaignId: string,
): Promise<SendCampaignTestResult> {
  return runActionWriterAdmission(
    "new-work",
    () => sendCampaignTestActionImpl(campaignId),
    () => ({ ok: false, error: ADMIN_WRITER_UNAVAILABLE }),
  );
}
export async function sendCampaignAction(input: {
  campaignId: string;
  scheduledAt?: string;
}): Promise<SendCampaignResult> {
  return runActionWriterAdmission(
    "new-work",
    () => sendCampaignActionImpl(input),
    () => ({ ok: false, error: ADMIN_WRITER_UNAVAILABLE }),
  );
}
