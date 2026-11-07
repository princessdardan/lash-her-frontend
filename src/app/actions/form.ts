"use server";

import { publicFormActions } from "@/lib/forms/public-actions";
import type {
  GeneralInquiryData,
  TrainingContactData,
  ContactPopupData,
} from "@/lib/email";
import type { FormActionResult } from "@/lib/forms/public-actions";

export type { FormActionResult } from "@/lib/forms/public-actions";

export async function submitContactPopup(
  data: ContactPopupData,
): Promise<FormActionResult> {
  return publicFormActions.submitContactPopup(data);
}

export async function submitGeneralInquiry(
  data: GeneralInquiryData,
): Promise<FormActionResult> {
  return publicFormActions.submitGeneralInquiry(data);
}

export async function submitTrainingContact(
  data: TrainingContactData,
): Promise<FormActionResult> {
  return publicFormActions.submitTrainingContact(data);
}
