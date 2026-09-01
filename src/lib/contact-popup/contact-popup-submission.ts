import "server-only";

import {
  sendAdminNotification,
  sendUserConfirmation,
  type ContactPopupData,
} from "@/lib/email";
import { processCustomerEmailOutboxJob } from "@/lib/commerce/customer-email-outbox-worker";
import {
  recordContactPopupSubmission,
  type MarketingContactRecordResult,
  type RecordContactPopupInput,
} from "@/lib/marketing-contact/marketing-contact-store";
import {
  resolveContactPopupSignupOffer,
  type ContactPopupSignupOfferInvalidReason,
  type ContactPopupSignupOfferResolution,
} from "./signup-offer";

export type ContactPopupImmediateOfferDelivery = "deferred" | "failed" | "sent";

export type ContactPopupSubmissionOutcome =
  | {
      status: "generic_welcome_sent";
      submissionId: string;
      offerResolution: "disabled" | "invalid";
      invalidReason?: ContactPopupSignupOfferInvalidReason;
    }
  | {
      status: "offer_email_enqueued";
      submissionId: string;
      offerEmailJobId?: string;
      immediateDelivery: ContactPopupImmediateOfferDelivery;
    }
  | {
      // The offer itself was not enqueued a second time. The existing generic
      // welcome email was sent instead.
      status: "offer_email_duplicate";
      submissionId: string;
    };

export class ContactPopupWelcomeEmailError extends Error {
  constructor(options?: ErrorOptions) {
    super("Contact popup welcome email delivery failed", options);
    this.name = "ContactPopupWelcomeEmailError";
  }
}

export interface ContactPopupSubmissionDependencies {
  processOfferEmailJob: typeof processCustomerEmailOutboxJob;
  recordSubmission: (
    input: RecordContactPopupInput,
  ) => Promise<MarketingContactRecordResult>;
  resolveOffer: () => Promise<ContactPopupSignupOfferResolution>;
  sendAdminEmail: (
    formType: "contact-popup",
    data: ContactPopupData,
  ) => Promise<void>;
  sendGenericWelcomeEmail: (
    formType: "contact-popup",
    data: ContactPopupData,
  ) => Promise<void>;
  logError: typeof console.error;
  logWarn: typeof console.warn;
}

const defaultDependencies: ContactPopupSubmissionDependencies = {
  processOfferEmailJob: processCustomerEmailOutboxJob,
  recordSubmission: recordContactPopupSubmission,
  resolveOffer: resolveContactPopupSignupOffer,
  sendAdminEmail: sendAdminNotification,
  sendGenericWelcomeEmail: sendUserConfirmation,
  logError: console.error,
  logWarn: console.warn,
};

export async function processContactPopupSubmission(
  data: ContactPopupData,
  dependencies: ContactPopupSubmissionDependencies = defaultDependencies,
): Promise<ContactPopupSubmissionOutcome> {
  const offerResolution = await dependencies.resolveOffer();
  const recordResult = await dependencies.recordSubmission({
    variant: data.variant ?? "emailOnly",
    name: data.name || undefined,
    email: data.email,
    instagram: data.instagram || undefined,
    sourcePath: data.sourcePath || undefined,
    consentText: data.consentText,
    ...(offerResolution.status === "available"
      ? { signupOffer: offerResolution.offer }
      : {}),
  });

  const adminEmailPromise = sendAdminEmailNonBlocking(data, dependencies);

  if (offerResolution.status !== "available") {
    if (offerResolution.status === "invalid") {
      dependencies.logWarn(
        "[contact-popup] Signup offer configuration is invalid; sending generic welcome email",
        { reason: offerResolution.reason },
      );
    }

    const [customerEmailResult] = await Promise.allSettled([
      dependencies.sendGenericWelcomeEmail("contact-popup", data),
      adminEmailPromise,
    ]);
    if (customerEmailResult.status === "rejected") {
      dependencies.logError(
        "[contact-popup] Generic welcome email delivery failed",
        getErrorMessage(customerEmailResult.reason),
      );
      throw new ContactPopupWelcomeEmailError({
        cause: customerEmailResult.reason,
      });
    }

    return {
      status: "generic_welcome_sent",
      submissionId: recordResult.submissionId,
      offerResolution: offerResolution.status,
      ...(offerResolution.status === "invalid"
        ? { invalidReason: offerResolution.reason }
        : {}),
    };
  }

  if (recordResult.offerEmailEnqueued === false) {
    const [customerEmailResult] = await Promise.allSettled([
      dependencies.sendGenericWelcomeEmail("contact-popup", data),
      adminEmailPromise,
    ]);
    if (customerEmailResult.status === "rejected") {
      dependencies.logError(
        "[contact-popup] Generic welcome email delivery failed for a repeated offer signup",
        getErrorMessage(customerEmailResult.reason),
      );
      throw new ContactPopupWelcomeEmailError({
        cause: customerEmailResult.reason,
      });
    }

    return {
      status: "offer_email_duplicate",
      submissionId: recordResult.submissionId,
    };
  }

  if (recordResult.offerEmailEnqueued !== true) {
    await adminEmailPromise;
    throw new Error(
      "Contact popup offer email was not durably enqueued with the submission",
    );
  }

  const immediateDelivery = recordResult.offerEmailJobId
    ? attemptImmediateOfferDelivery(recordResult.offerEmailJobId, dependencies)
    : Promise.resolve<ContactPopupImmediateOfferDelivery>("deferred");
  const [delivery] = await Promise.all([immediateDelivery, adminEmailPromise]);

  if (!recordResult.offerEmailJobId) {
    dependencies.logError(
      "[contact-popup] Offer email was enqueued without a returned job id; delivery is deferred",
    );
  }

  return {
    status: "offer_email_enqueued",
    submissionId: recordResult.submissionId,
    ...(recordResult.offerEmailJobId
      ? { offerEmailJobId: recordResult.offerEmailJobId }
      : {}),
    immediateDelivery: delivery,
  };
}

async function attemptImmediateOfferDelivery(
  jobId: string,
  dependencies: ContactPopupSubmissionDependencies,
): Promise<ContactPopupImmediateOfferDelivery> {
  try {
    const result = await dependencies.processOfferEmailJob({ jobId });
    if (result.sent > 0) return "sent";

    if (result.failed > 0) {
      dependencies.logError(
        "[contact-popup] Immediate offer email delivery failed; the durable outbox will retry",
        { jobId },
      );
      return "failed";
    }

    dependencies.logWarn(
      "[contact-popup] Immediate offer email job was not claimable; the durable outbox will retry",
      { jobId },
    );
    return "deferred";
  } catch (error) {
    dependencies.logError(
      "[contact-popup] Immediate offer email processing failed; the durable outbox will retry",
      { error: getErrorMessage(error), jobId },
    );
    return "failed";
  }
}

async function sendAdminEmailNonBlocking(
  data: ContactPopupData,
  dependencies: ContactPopupSubmissionDependencies,
): Promise<void> {
  try {
    await dependencies.sendAdminEmail("contact-popup", data);
  } catch (error) {
    dependencies.logError(
      "[contact-popup] Admin notification delivery failed",
      getErrorMessage(error),
    );
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
