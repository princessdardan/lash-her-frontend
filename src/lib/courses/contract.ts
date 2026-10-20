import { EMAIL_CONSENT_TEXT } from "@/lib/highlevel/contract";
import type { CampaignAttribution } from "@/lib/highlevel/attribution";
export const COURSE_CONSENT_TEXT = EMAIL_CONSENT_TEXT;

export const COURSE_ACCESS_SECONDS = 365 * 24 * 60 * 60;

export interface CourseAccessGrant {
  version: 1;
  courseId: string;
  grantId: string;
  expiresAt: number;
}

export interface CourseSignupInput {
  courseId: string;
  name: string;
  email: string;
  phone: string;
  instagram?: string;
  marketingConsent: boolean;
  smsMarketingConsent?: boolean;
  attribution?: CampaignAttribution;
  company?: string;
}
