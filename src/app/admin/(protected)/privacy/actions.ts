"use server";

import { revalidatePath } from "next/cache";

import { getAdminAuth } from "@/lib/admin/auth";
import { getPrivacyRequestService } from "@/lib/admin/privacy-requests";
import type { PrivacyRequestType } from "@/lib/admin/types";

const emailRegex = /^[^\s@<>'"]+@[^\s@<>'"]+\.[^\s@<>'"]+$/;

export async function createPrivacyRequestAction(formData: FormData): Promise<void> {
  const actor = await getAdminAuth().requireAdmin();
  const requestType = parsePrivacyRequestType(formData.get("requestType"));
  const subjectEmail = String(formData.get("subjectEmail") ?? "").trim();
  const requesterName = String(formData.get("requesterName") ?? "").trim();
  const requesterNotes = String(formData.get("requesterNotes") ?? "").trim();

  if (!emailRegex.test(subjectEmail)) {
    throw new Error("A valid subject email is required");
  }

  await getPrivacyRequestService().createRequest({
    actor,
    requestType,
    requesterName,
    requesterNotes,
    subjectEmail,
  });

  revalidatePath("/admin/privacy");
}

export async function addPrivacyRequestEventAction(formData: FormData): Promise<void> {
  const actor = await getAdminAuth().requireAdmin();
  const privacyRequestId = String(formData.get("privacyRequestId") ?? "").trim();
  const message = String(formData.get("message") ?? "").trim();

  if (privacyRequestId.length === 0 || message.length === 0) {
    throw new Error("Privacy request id and message are required");
  }

  await getPrivacyRequestService().addEvent({
    actor,
    eventType: "note_added",
    message,
    privacyRequestId,
  });

  revalidatePath(`/admin/privacy/${privacyRequestId}`);
}

function parsePrivacyRequestType(value: FormDataEntryValue | null): PrivacyRequestType {
  if (
    value === "access_export"
    || value === "correction"
    || value === "deletion"
    || value === "redaction"
    || value === "privacy_inquiry"
  ) {
    return value;
  }

  return "access_export";
}
