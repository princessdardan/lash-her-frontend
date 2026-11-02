import "server-only";

import { loaders } from "@/data/loaders";
import {
  sendAdminNotification,
  sendUserConfirmation,
  type ContactPopupData,
} from "@/lib/email";
import { validateForm } from "@/lib/form-validation";
import { sanitizeAttribution } from "@/lib/highlevel/attribution";
import { highLevelOwnsMarketing } from "@/lib/highlevel/config";
import { EMAIL_CONSENT_TEXT } from "@/lib/highlevel/contract";
import {
  recordContactPopupSubmission,
  type RecordContactPopupInput,
} from "@/lib/marketing-contact/marketing-contact-store";
import type { TLandingPage } from "@/types";
import {
  validateLandingPageSlug,
  type LandingPageSignupResult,
} from "@/lib/landing-pages/contract";

interface SignupDependencies {
  getPage: (
    slug: string,
  ) => Promise<Pick<TLandingPage, "_id" | "title" | "slug"> | null>;
  record: (input: RecordContactPopupInput) => Promise<unknown>;
  isRateLimited: (email: string) => boolean;
  notifyAdmin: (data: ContactPopupData) => Promise<void>;
  sendWelcome: (data: ContactPopupData) => Promise<void>;
  logError: (message: string) => void;
}

// Same per-address limit as the existing contact popup; bound memory usage.
const submissions = new Map<string, number[]>();
function isRateLimited(email: string): boolean {
  const now = Date.now();
  for (const [key, times] of submissions) {
    if (times.every((time) => now - time >= 3_600_000)) submissions.delete(key);
  }
  const recent = (submissions.get(email) ?? []).filter(
    (time) => now - time < 3_600_000,
  );
  if (
    recent.length >= 3 ||
    (!submissions.has(email) && submissions.size >= 10_000)
  )
    return true;
  submissions.set(email, [...recent, now]);
  return false;
}

const defaults: SignupDependencies = {
  getPage: loaders.getLandingPageSignupDetails,
  record: recordContactPopupSubmission,
  isRateLimited,
  notifyAdmin: (data) => sendAdminNotification("contact-popup", data),
  sendWelcome: async (data) => {
    if (!highLevelOwnsMarketing())
      await sendUserConfirmation("contact-popup", data);
  },
  logError: (message) => console.error(message),
};

export async function processLandingPageSignup(
  input: unknown,
  dependencies: SignupDependencies = defaults,
): Promise<LandingPageSignupResult> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { success: false, error: "Please check the form and try again." };
  }
  const data = input as Record<string, unknown>;
  if (typeof data.company === "string" && data.company)
    return { success: true };
  if (validateLandingPageSlug(data.slug) !== true) {
    return { success: false, error: "This signup page is unavailable." };
  }
  const email =
    typeof data.email === "string" ? data.email.trim().toLowerCase() : "";
  const { errors } = validateForm(
    { email },
    {
      email: [
        { type: "required", message: "Email is required." },
        { type: "maxLength", value: 254, message: "Email is too long." },
        { type: "email", message: "Please enter a valid email address." },
      ],
    },
  );
  if (data.marketingConsent !== true)
    errors.marketingConsent =
      "Please agree to receive emails to join this list.";
  if (Object.keys(errors).length)
    return { success: false, fieldErrors: errors };

  try {
    if (dependencies.isRateLimited(email))
      return {
        success: false,
        error: "Too many submissions. Please try again later.",
      };
    // Resolve the published page on the server. Never trust client-supplied
    // titles, IDs, consent text, campaign metadata, or source paths.
    const page = await dependencies.getPage(data.slug as string);
    if (!page || page.slug !== data.slug)
      return { success: false, error: "This signup page is unavailable." };
    const signup = {
      email,
      variant: "emailOnly" as const,
      marketingConsent: true,
      smsMarketingConsent: false,
      consentText: EMAIL_CONSENT_TEXT,
      sourcePath: `/${page.slug}`,
      attribution: sanitizeAttribution(data.attribution),
    };
    await dependencies.record({
      ...signup,
      // sourceDocument is reserved for legacy imports and deduplicates by
      // document ID. Campaign identity belongs in the submission payload.
      landingPage: { id: page._id, title: page.title },
    });
    // The private write is authoritative. Notification failures must not ask
    // subscribers to repeat an already-saved signup.
    const notifications = await Promise.allSettled([
      dependencies.notifyAdmin(signup),
      dependencies.sendWelcome(signup),
    ]);
    if (notifications.some((result) => result.status === "rejected")) {
      dependencies.logError(
        "[landing-page] Signup saved; notification delivery failed",
      );
    }
    return { success: true };
  } catch {
    dependencies.logError("[landing-page] Signup could not be saved");
    return {
      success: false,
      error: "We couldn't save your signup. Please try again.",
    };
  }
}
