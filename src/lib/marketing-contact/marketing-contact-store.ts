import "server-only";

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import {
  enqueueCustomerEmailWithResult,
  type ContactPopupOfferEmailPayload,
} from "@/lib/commerce/customer-email-outbox";
import { getPrivateDb } from "@/lib/private-db/client";
import {
  customerEmailOutbox,
  marketingConsentEvents,
  marketingContacts,
  marketingContactSubmissions,
  marketingContactSyncJobs,
  type MarketingConsentEventType,
  type MarketingContactSubmissionType,
  type MarketingContactSyncJobPayload,
} from "@/lib/private-db/schema";
import { type ResendMarketingContactInput } from "@/lib/resend-platform";
import { buildContactPopupOfferDedupeKeys } from "@/lib/marketing-contact/contact-popup-offer-dedupe";

export const GENERAL_INQUIRY_CONSENT_TEXT =
  "I agree to receive lash care tips, service updates, and offers from Lash Her by Nataliea.";
export const TRAINING_CONTACT_CONSENT_TEXT =
  "I agree to receive training updates, program news, and offers from Lash Her by Nataliea.";
export const CONTACT_POPUP_CONSENT_TEXT =
  "I agree to receive updates and offers from Lash Her by Nataliea.";
export const BOOKING_MARKETING_CONSENT_TEXT =
  "I would like to receive updates and offers from Lash Her by Nataliea.";

export type MarketingConsentChoice =
  | "opted_in"
  | "not_opted_in"
  | "unsubscribed";
export type MarketingSubmissionSource =
  | "general_inquiry"
  | "training_contact"
  | "contact_popup"
  | "booking"
  | "sanity_backfill";

export interface BookingAnswerSnapshot {
  questionId: string;
  questionLabel?: string;
  answer: string;
}

export interface SourceDocumentReference {
  sourceSystem: string;
  sourceDocumentType: string;
  sourceDocumentId: string;
}

export interface MarketingContactIdentity {
  email: string;
  instagram?: string;
  name?: string;
  phone?: string;
}

export interface RecordGeneralInquiryInput extends MarketingContactIdentity {
  consentText?: string;
  marketingConsent: boolean;
  message: string;
  sourceDocument?: SourceDocumentReference;
  sourcePath?: string;
  submittedAt?: Date;
}

export interface RecordTrainingContactInput extends MarketingContactIdentity {
  consentText?: string;
  location?: string;
  marketingConsent: boolean;
  phone: string;
  privacyPolicyConsent?: boolean;
  programSlug: string;
  programTitle: string;
  sourceDocument?: SourceDocumentReference;
  sourcePath?: string;
  submittedAt?: Date;
}

export interface RecordContactPopupInput extends MarketingContactIdentity {
  consentText?: string;
  signupOffer?: ContactPopupSignupOfferSnapshot;
  sourceDocument?: SourceDocumentReference;
  sourcePath?: string;
  submittedAt?: Date;
  variant: "fullContact" | "emailOnly";
}

export type ContactPopupSignupOfferSnapshot = Omit<
  ContactPopupOfferEmailPayload,
  "customerName" | "recipientEmail" | "submissionId" | "variant"
>;

export interface RecordBookingMarketingChoiceInput extends MarketingContactIdentity {
  answers: BookingAnswerSnapshot[];
  bookingType: string;
  consentText?: string;
  marketingOptIn: boolean;
  sourcePath?: string;
  submittedAt?: Date;
}

export interface RecordSanityBackfillSubmissionInput extends MarketingContactIdentity {
  consentText?: string;
  marketingConsent: boolean;
  originalDocumentType: string;
  originalDocumentId: string;
  payload: Record<string, unknown>;
  source: MarketingSubmissionSource;
  submittedAt: Date;
  submissionType: MarketingContactSubmissionType;
}

export interface RecordResendUnsubscribeInput {
  email: string;
  metadata?: Record<string, unknown>;
  occurredAt?: Date;
  resendContactId?: string;
}

// An unsubscribe initiated inside our system (admin action, app link, retention)
// rather than received from Resend. Suppresses the contact in the DB and pushes
// the suppression to Resend via the durable sync outbox.
export interface RecordInternalUnsubscribeInput {
  email: string;
  metadata?: Record<string, unknown>;
  occurredAt?: Date;
  reason?: string;
}

export interface MarketingContactUpsertValues extends MarketingContactIdentity {
  consentText?: string;
  emailNormalized: string;
  firstConsentedAt: Date;
  lastConsentedAt: Date;
  source: MarketingSubmissionSource;
  updatedAt: Date;
}

export interface MarketingContactSubmissionValues extends MarketingContactIdentity {
  consentChoice: MarketingConsentChoice;
  consentText?: string;
  emailNormalized: string;
  payload: Record<string, unknown>;
  source: MarketingSubmissionSource;
  sourceDocument?: SourceDocumentReference;
  sourcePath?: string;
  sourceSystem: string;
  submittedAt: Date;
  submissionType: MarketingContactSubmissionType;
}

export interface MarketingConsentEventValues extends MarketingContactIdentity {
  consentText?: string;
  emailNormalized: string;
  eventType: MarketingConsentEventType;
  metadata?: Record<string, unknown>;
  occurredAt: Date;
  source: MarketingSubmissionSource;
}

export interface MarketingContactUnsubscribeValues {
  email: string;
  emailNormalized: string;
  metadata?: Record<string, unknown>;
  occurredAt: Date;
  // Where the unsubscribe originated. "resend" (default) is the webhook echo of
  // Resend's own hosted unsubscribe — the DB is updated but we must NOT push back
  // to Resend. "internal" is an unsubscribe initiated in our system (admin action,
  // app link, retention) — the DB is updated AND a durable job is enqueued to push
  // the suppression to Resend so hosted broadcasts skip the contact.
  origin?: "resend" | "internal";
  reason?: string;
  resendContactId?: string;
}

export interface MarketingContactPersistenceInput {
  contact: MarketingContactUpsertValues | null;
  contactPopupOffer?: {
    snapshot: ContactPopupSignupOfferSnapshot;
    variant: "fullContact" | "emailOnly";
  };
  event: MarketingConsentEventValues;
  submission: MarketingContactSubmissionValues;
}

export interface MarketingContactRecordResult {
  offerEmailEnqueued?: boolean;
  offerEmailJobId?: string;
  submissionId: string;
  syncJobId?: string;
}

export interface MarketingContactRepository {
  recordMarketingContact(
    input: MarketingContactPersistenceInput,
  ): Promise<MarketingContactRecordResult>;
  recordMarketingUnsubscribe(
    input: MarketingContactUnsubscribeValues,
  ): Promise<{ eventId: string }>;
}

export interface MarketingContactStoreDependencies {
  logError?: typeof console.error;
  // Deprecated: Resend sync is now handled by the durable outbox worker.
  syncMarketingContact?: (input: ResendMarketingContactInput) => Promise<void>;
}

export interface MarketingContactStore {
  recordBookingMarketingChoice(
    input: RecordBookingMarketingChoiceInput,
  ): Promise<{ submissionId: string; syncJobId?: string }>;
  recordContactPopup(
    input: RecordContactPopupInput,
  ): Promise<MarketingContactRecordResult>;
  recordGeneralInquiry(
    input: RecordGeneralInquiryInput,
  ): Promise<{ submissionId: string; syncJobId?: string }>;
  recordInternalUnsubscribe(
    input: RecordInternalUnsubscribeInput,
  ): Promise<{ eventId: string }>;
  recordResendUnsubscribe(
    input: RecordResendUnsubscribeInput,
  ): Promise<{ eventId: string }>;
  recordSanityBackfillSubmission(
    input: RecordSanityBackfillSubmissionInput,
  ): Promise<{ submissionId: string; syncJobId?: string }>;
  recordTrainingContact(
    input: RecordTrainingContactInput,
  ): Promise<{ submissionId: string; syncJobId?: string }>;
}

export function createMarketingContactStore(
  repository: MarketingContactRepository,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _dependencies: MarketingContactStoreDependencies = {},
): MarketingContactStore {
  async function recordContact(
    input: MarketingContactPersistenceInput,
  ): Promise<{ submissionId: string; syncJobId?: string }> {
    // The durable outbox worker handles Resend sync; do not call it directly
    // from the request path. Failures during repository persistence are thrown
    // so the caller can retry.
    return repository.recordMarketingContact(input);
  }

  return {
    async recordGeneralInquiry(input) {
      return recordContact(
        buildPersistenceInput({
          consentText: input.consentText ?? GENERAL_INQUIRY_CONSENT_TEXT,
          identity: input,
          marketingConsent: input.marketingConsent,
          payload: {
            message: input.message,
            phone: cleanOptionalText(input.phone),
            instagram: cleanOptionalText(input.instagram),
          },
          source: "general_inquiry",
          sourceDocument: input.sourceDocument,
          sourcePath: input.sourcePath,
          submittedAt: input.submittedAt,
          submissionType: "general_inquiry",
        }),
      );
    },

    async recordTrainingContact(input) {
      return recordContact(
        buildPersistenceInput({
          consentText: input.consentText ?? TRAINING_CONTACT_CONSENT_TEXT,
          identity: input,
          marketingConsent: input.marketingConsent,
          payload: {
            instagram: cleanOptionalText(input.instagram),
            location: cleanOptionalText(input.location),
            phone: input.phone,
            privacyPolicyConsent: input.privacyPolicyConsent ?? false,
            programSlug: input.programSlug,
            programTitle: input.programTitle,
            sourcePath: cleanOptionalText(input.sourcePath),
          },
          source: "training_contact",
          sourceDocument: input.sourceDocument,
          sourcePath: input.sourcePath,
          submittedAt: input.submittedAt,
          submissionType: "training_contact",
        }),
      );
    },

    async recordContactPopup(input) {
      const persistenceInput = buildPersistenceInput({
        consentText: input.consentText ?? CONTACT_POPUP_CONSENT_TEXT,
        identity: input,
        marketingConsent: true,
        payload: {
          instagram: cleanOptionalText(input.instagram),
          sourcePath: cleanOptionalText(input.sourcePath),
          variant: input.variant,
        },
        source: "contact_popup",
        sourceDocument: input.sourceDocument,
        sourcePath: input.sourcePath,
        submittedAt: input.submittedAt,
        submissionType: "contact_popup",
      });

      return recordContact({
        ...persistenceInput,
        ...(input.signupOffer
          ? {
              contactPopupOffer: {
                snapshot: input.signupOffer,
                variant: input.variant,
              },
            }
          : {}),
      });
    },

    async recordBookingMarketingChoice(input) {
      return recordContact(
        buildPersistenceInput({
          consentText: input.consentText ?? BOOKING_MARKETING_CONSENT_TEXT,
          identity: input,
          marketingConsent: input.marketingOptIn,
          payload: {
            answers: input.answers,
            bookingType: input.bookingType,
            marketingOptIn: input.marketingOptIn,
            phone: input.phone,
          },
          source: "booking",
          sourcePath: input.sourcePath,
          submittedAt: input.submittedAt,
          submissionType: "booking_marketing_choice",
        }),
      );
    },

    async recordSanityBackfillSubmission(input) {
      return recordContact(
        buildPersistenceInput({
          consentText: input.consentText,
          identity: input,
          marketingConsent: input.marketingConsent,
          payload: input.payload,
          source: input.source,
          sourceDocument: {
            sourceDocumentId: input.originalDocumentId,
            sourceDocumentType: input.originalDocumentType,
            sourceSystem: "sanity",
          },
          submittedAt: input.submittedAt,
          submissionType: input.submissionType,
        }),
      );
    },

    async recordResendUnsubscribe(input) {
      return repository.recordMarketingUnsubscribe(
        buildResendUnsubscribeInput(input),
      );
    },

    async recordInternalUnsubscribe(input) {
      return repository.recordMarketingUnsubscribe(
        buildInternalUnsubscribeInput(input),
      );
    },
  };
}

const defaultMarketingContactStore = createMarketingContactStore(
  createDrizzleMarketingContactRepository(),
);

export async function recordGeneralInquirySubmission(
  input: RecordGeneralInquiryInput,
): Promise<{ submissionId: string; syncJobId?: string }> {
  return defaultMarketingContactStore.recordGeneralInquiry(input);
}

export async function recordTrainingContactSubmission(
  input: RecordTrainingContactInput,
): Promise<{ submissionId: string; syncJobId?: string }> {
  return defaultMarketingContactStore.recordTrainingContact(input);
}

export async function recordContactPopupSubmission(
  input: RecordContactPopupInput,
): Promise<MarketingContactRecordResult> {
  return defaultMarketingContactStore.recordContactPopup(input);
}

export async function recordBookingMarketingChoice(
  input: RecordBookingMarketingChoiceInput,
): Promise<{ submissionId: string; syncJobId?: string }> {
  return defaultMarketingContactStore.recordBookingMarketingChoice(input);
}

export async function recordSanityBackfillSubmission(
  input: RecordSanityBackfillSubmissionInput,
): Promise<{ submissionId: string; syncJobId?: string }> {
  return defaultMarketingContactStore.recordSanityBackfillSubmission(input);
}

export async function recordResendUnsubscribe(
  input: RecordResendUnsubscribeInput,
): Promise<{ eventId: string }> {
  return defaultMarketingContactStore.recordResendUnsubscribe(input);
}

export async function recordInternalUnsubscribe(
  input: RecordInternalUnsubscribeInput,
): Promise<{ eventId: string }> {
  return defaultMarketingContactStore.recordInternalUnsubscribe(input);
}

function createDrizzleMarketingContactRepository(): MarketingContactRepository {
  return {
    async recordMarketingContact(input) {
      return getPrivateDb().transaction(async (tx) => {
        // Serialize consent transitions for one address. Unsubscribe uses the
        // same transaction-scoped lock, so a replay cannot race a re-consent
        // and incorrectly reuse or create an unsubscribe generation.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.submission.emailNormalized}, 0))`,
        );

        let contactId: string | null = null;

        if (input.contact !== null) {
          const [contact] = await tx
            .insert(marketingContacts)
            .values(input.contact)
            .onConflictDoUpdate({
              target: marketingContacts.emailNormalized,
              set: {
                consentText: input.contact.consentText,
                email: input.contact.email,
                instagram: input.contact.instagram,
                lastConsentedAt: input.contact.lastConsentedAt,
                name: input.contact.name,
                phone: input.contact.phone,
                source: input.contact.source,
                unsubscribedAt: null,
                updatedAt: input.contact.updatedAt,
              },
            })
            .returning({ id: marketingContacts.id });
          contactId = contact.id;
        }

        const [submission] = await tx
          .insert(marketingContactSubmissions)
          .values(toSubmissionInsert(input.submission))
          .onConflictDoNothing()
          .returning({ id: marketingContactSubmissions.id });

        if (!submission) {
          const sourceDocument = input.submission.sourceDocument;

          if (sourceDocument === undefined) {
            throw new Error("Marketing contact submission was not created");
          }

          const [existingSubmission] = await tx
            .select({ id: marketingContactSubmissions.id })
            .from(marketingContactSubmissions)
            .where(
              and(
                eq(
                  marketingContactSubmissions.sourceSystem,
                  sourceDocument.sourceSystem,
                ),
                eq(
                  marketingContactSubmissions.sourceDocumentType,
                  sourceDocument.sourceDocumentType,
                ),
                eq(
                  marketingContactSubmissions.sourceDocumentId,
                  sourceDocument.sourceDocumentId,
                ),
              ),
            )
            .limit(1);

          if (!existingSubmission) {
            throw new Error("Marketing contact submission was not created");
          }

          return { submissionId: existingSubmission.id };
        }

        const [event] = await tx
          .insert(marketingConsentEvents)
          .values({
            ...input.event,
            contactId,
            submissionId: submission.id,
          })
          .returning({ id: marketingConsentEvents.id });

        let offerEmailResult:
          | Awaited<ReturnType<typeof enqueueCustomerEmailWithResult>>
          | undefined;
        if (input.contactPopupOffer !== undefined) {
          const { snapshot, variant } = input.contactPopupOffer;
          const offerPayload: ContactPopupOfferEmailPayload = {
            ...snapshot,
            customerName: input.submission.name,
            recipientEmail: input.submission.email,
            submissionId: submission.id,
            variant,
          };
          const dedupeKeys = buildContactPopupOfferDedupeKeys({
            emailNormalized: input.submission.emailNormalized,
            promotionId: snapshot.promotionId,
          });
          const [existingOffer] = await tx
            .select({ id: customerEmailOutbox.id })
            .from(customerEmailOutbox)
            .where(
              and(
                eq(customerEmailOutbox.kind, "contact_popup_offer"),
                inArray(
                  customerEmailOutbox.providerIdempotencyKey,
                  dedupeKeys.candidateProviderIdempotencyKeys,
                ),
              ),
            )
            .limit(1);

          offerEmailResult = existingOffer
            ? { id: existingOffer.id, inserted: false }
            : await enqueueCustomerEmailWithResult(
                {
                  kind: "contact_popup_offer",
                  payload: offerPayload,
                  providerIdempotencyKey:
                    dedupeKeys.primaryProviderIdempotencyKey,
                  recipient: input.submission.email,
                  submissionDatabaseId: submission.id,
                  now: input.submission.submittedAt,
                },
                tx,
              );
        }

        if (input.contact !== null) {
          const idempotencyKey = `mc-sync:${submission.id}`;
          const payload = buildMarketingContactSyncJobPayload(
            input,
            contactId,
            submission.id,
            event.id,
          );

          const [job] = await tx
            .insert(marketingContactSyncJobs)
            .values({
              idempotencyKey,
              contactId,
              submissionId: submission.id,
              consentEventId: event.id,
              email: input.contact.email,
              emailNormalized: input.contact.emailNormalized,
              source: input.contact.source,
              payload,
              status: "queued",
              attempts: 0,
              maxAttempts: 5,
              nextRunAt: new Date(),
            })
            .onConflictDoUpdate({
              target: marketingContactSyncJobs.idempotencyKey,
              set: {
                updatedAt: new Date(),
              },
            })
            .returning({ id: marketingContactSyncJobs.id });

          return {
            submissionId: submission.id,
            syncJobId: job?.id,
            ...(offerEmailResult === undefined
              ? {}
              : {
                  offerEmailEnqueued: offerEmailResult.inserted,
                  ...(offerEmailResult.id
                    ? { offerEmailJobId: offerEmailResult.id }
                    : {}),
                }),
          };
        }

        return {
          submissionId: submission.id,
          ...(offerEmailResult === undefined
            ? {}
            : {
                offerEmailEnqueued: offerEmailResult.inserted,
                ...(offerEmailResult.id
                  ? { offerEmailJobId: offerEmailResult.id }
                  : {}),
              }),
        };
      });
    },

    async recordMarketingUnsubscribe(input) {
      const origin = input.origin ?? "resend";

      return getPrivateDb().transaction(async (tx) => {
        // The advisory lock covers both an existing contact row and the
        // no-contact case. recordMarketingContact takes the same lock before
        // writing an opt-in, making the current consent generation stable for
        // the remainder of this transaction.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.emailNormalized}, 0))`,
        );

        const [currentContact] = await tx
          .select({
            id: marketingContacts.id,
            unsubscribedAt: marketingContacts.unsubscribedAt,
          })
          .from(marketingContacts)
          .where(eq(marketingContacts.emailNormalized, input.emailNormalized))
          .limit(1)
          .for("update");

        // A non-null unsubscribed_at belongs to the current consent
        // generation because every explicit opt-in clears it. For an address
        // without a current contact, an existing unsubscribe event is likewise
        // the only known generation. Reuse that event on replay so its unique
        // consent-event job remains the single Resend suppression job.
        const shouldFindExistingEvent =
          currentContact === undefined ||
          currentContact.unsubscribedAt !== null;
        const [existingEvent] = shouldFindExistingEvent
          ? await tx
              .select({ id: marketingConsentEvents.id })
              .from(marketingConsentEvents)
              .where(
                and(
                  eq(
                    marketingConsentEvents.emailNormalized,
                    input.emailNormalized,
                  ),
                  eq(marketingConsentEvents.eventType, "unsubscribe"),
                ),
              )
              .orderBy(
                desc(marketingConsentEvents.occurredAt),
                desc(marketingConsentEvents.createdAt),
              )
              .limit(1)
          : [];

        const [contact] = await tx
          .update(marketingContacts)
          .set({
            unsubscribedAt: currentContact?.unsubscribedAt ?? input.occurredAt,
            updatedAt: sql`GREATEST(${marketingContacts.updatedAt}, ${input.occurredAt})`,
          })
          .where(eq(marketingContacts.emailNormalized, input.emailNormalized))
          .returning({ id: marketingContacts.id });

        const [createdEvent] = existingEvent
          ? []
          : await tx
              .insert(marketingConsentEvents)
              .values({
                contactId: contact?.id ?? null,
                email: input.email,
                emailNormalized: input.emailNormalized,
                eventType: "unsubscribe",
                metadata: cleanPayload({
                  ...(input.metadata ?? {}),
                  reason: input.reason,
                  resendContactId: input.resendContactId,
                }),
                occurredAt: input.occurredAt,
                source: origin,
              })
              .returning({ id: marketingConsentEvents.id });
        const event = existingEvent ?? createdEvent;

        if (!event) {
          throw new Error("Marketing unsubscribe event was not created");
        }

        // Prevent any queued or in-flight opt-in sync jobs for this contact from
        // re-opting the contact in after they have unsubscribed. Scoped to
        // opt_in_sync so a pending unsubscribe push is never cancelled here.
        await tx
          .update(marketingContactSyncJobs)
          .set({
            lockedBy: null,
            lockedUntil: null,
            status: "skipped_unconfigured",
            skippedAt: input.occurredAt,
            lastAttemptedAt: input.occurredAt,
            lastError: "Contact unsubscribed before marketing sync",
            updatedAt: input.occurredAt,
          })
          .where(
            and(
              eq(
                marketingContactSyncJobs.emailNormalized,
                input.emailNormalized,
              ),
              eq(marketingContactSyncJobs.kind, "opt_in_sync"),
              inArray(marketingContactSyncJobs.status, [
                "queued",
                "processing",
                "retryable_failed",
              ]),
            ),
          );

        // A welcome offer is marketing content. Revoke any unsent durable copy
        // as part of the same unsubscribe transaction so it cannot be retried
        // after consent has been withdrawn.
        await tx
          .update(customerEmailOutbox)
          .set({
            status: "dead_letter",
            recipientCiphertext: "[redacted]",
            recipientEmailNormalized: null,
            templateDataCiphertext: "[redacted]",
            providerMessageId: null,
            leaseOwner: null,
            leaseExpiresAt: null,
            lastError: null,
            redactedAt: input.occurredAt,
            updatedAt: input.occurredAt,
          })
          .where(
            and(
              eq(customerEmailOutbox.kind, "contact_popup_offer"),
              eq(
                customerEmailOutbox.recipientEmailNormalized,
                input.emailNormalized,
              ),
              isNull(customerEmailOutbox.redactedAt),
              inArray(customerEmailOutbox.status, [
                "queued",
                "sending",
                "failed",
                "dead_letter",
              ]),
            ),
          );

        // For unsubscribes that originated in our system, enqueue a durable job
        // to push the suppression to Resend so hosted broadcasts skip the
        // contact. Resend-originated unsubscribes (the webhook echo) skip this to
        // avoid a Resend -> DB -> Resend loop. Enqueued AFTER the sweep above so
        // this job is never caught by it.
        if (origin === "internal" && !existingEvent) {
          await tx
            .insert(marketingContactSyncJobs)
            .values({
              idempotencyKey: `mc-unsub:${event.id}`,
              contactId: contact?.id ?? null,
              consentEventId: event.id,
              email: input.email,
              emailNormalized: input.emailNormalized,
              source: origin,
              kind: "unsubscribe_sync",
              payload: {
                email: input.email,
                consentedAt: input.occurredAt.toISOString(),
                source: origin,
              },
              status: "queued",
              attempts: 0,
              maxAttempts: 5,
              nextRunAt: input.occurredAt,
            })
            .onConflictDoNothing({
              target: marketingContactSyncJobs.idempotencyKey,
            });
        }

        return { eventId: event.id };
      });
    },
  };
}

interface BuildPersistenceInputOptions {
  consentText?: string;
  identity: MarketingContactIdentity;
  marketingConsent: boolean;
  payload: Record<string, unknown>;
  source: MarketingSubmissionSource;
  sourceDocument?: SourceDocumentReference;
  sourcePath?: string;
  submittedAt?: Date;
  submissionType: MarketingContactSubmissionType;
}

function buildPersistenceInput(
  options: BuildPersistenceInputOptions,
): MarketingContactPersistenceInput {
  const now = options.submittedAt ?? new Date();
  const identity = normalizeIdentity(options.identity);
  const consentChoice: MarketingConsentChoice = options.marketingConsent
    ? "opted_in"
    : "not_opted_in";
  const eventType: MarketingConsentEventType = options.marketingConsent
    ? options.sourceDocument?.sourceSystem === "sanity"
      ? "backfill_consent"
      : "opt_in"
    : "no_opt_in";
  const consentText = cleanOptionalText(options.consentText);
  const submission: MarketingContactSubmissionValues = {
    ...identity,
    consentChoice,
    consentText,
    payload: cleanPayload(options.payload),
    source: options.source,
    sourceDocument: options.sourceDocument,
    sourcePath: cleanOptionalText(options.sourcePath),
    sourceSystem: options.sourceDocument?.sourceSystem ?? "website",
    submittedAt: now,
    submissionType: options.submissionType,
  };
  const event: MarketingConsentEventValues = {
    ...identity,
    consentText,
    eventType,
    metadata: {
      consentChoice,
      sourceDocumentType: options.sourceDocument?.sourceDocumentType,
    },
    occurredAt: now,
    source: options.source,
  };

  return {
    contact: options.marketingConsent
      ? {
          ...identity,
          consentText,
          firstConsentedAt: now,
          lastConsentedAt: now,
          source: options.source,
          updatedAt: now,
        }
      : null,
    event,
    submission,
  };
}

function toSubmissionInsert(
  values: MarketingContactSubmissionValues,
): typeof marketingContactSubmissions.$inferInsert {
  return {
    consentChoice: values.consentChoice,
    consentText: values.consentText,
    email: values.email,
    emailNormalized: values.emailNormalized,
    instagram: values.instagram,
    name: values.name,
    payload: values.payload,
    phone: values.phone,
    source: values.source,
    sourceDocumentId: values.sourceDocument?.sourceDocumentId,
    sourceDocumentType: values.sourceDocument?.sourceDocumentType,
    sourcePath: values.sourcePath,
    sourceSystem: values.sourceSystem,
    submittedAt: values.submittedAt,
    submissionType: values.submissionType,
  };
}

function buildMarketingContactSyncJobPayload(
  input: MarketingContactPersistenceInput,
  contactId: string | null,
  submissionId: string,
  consentEventId: string,
): MarketingContactSyncJobPayload {
  if (input.contact === null) {
    throw new Error(
      "Cannot build sync job payload for a non-consenting marketing contact",
    );
  }

  return {
    consentText: input.contact.consentText,
    consentedAt: input.contact.lastConsentedAt.toISOString(),
    email: input.contact.email,
    instagram: input.contact.instagram,
    name: input.contact.name,
    phone: input.contact.phone,
    source: input.contact.source,
    sourcePath: input.submission.sourcePath,
    ...(contactId !== null ? { contactId } : {}),
    submissionId,
    consentEventId,
  };
}

function buildResendUnsubscribeInput(
  input: RecordResendUnsubscribeInput,
): MarketingContactUnsubscribeValues {
  const email = input.email.trim();

  if (email.length === 0) {
    throw new Error("Email is required for a Resend unsubscribe event");
  }

  return {
    email,
    emailNormalized: normalizeEmail(email),
    metadata: input.metadata,
    occurredAt: input.occurredAt ?? new Date(),
    origin: "resend",
    resendContactId: input.resendContactId,
  };
}

function buildInternalUnsubscribeInput(
  input: RecordInternalUnsubscribeInput,
): MarketingContactUnsubscribeValues {
  const email = input.email.trim();

  if (email.length === 0) {
    throw new Error("Email is required for an internal unsubscribe event");
  }

  return {
    email,
    emailNormalized: normalizeEmail(email),
    metadata: input.metadata,
    occurredAt: input.occurredAt ?? new Date(),
    origin: "internal",
    reason: input.reason,
  };
}

function normalizeIdentity(
  identity: MarketingContactIdentity,
): MarketingContactIdentity & { emailNormalized: string } {
  const email = identity.email.trim();
  return {
    email,
    emailNormalized: normalizeEmail(email),
    instagram: cleanOptionalText(identity.instagram),
    name: cleanOptionalText(identity.name),
    phone: cleanOptionalText(identity.phone),
  };
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function buildContactPopupOfferProviderIdempotencyKey(input: {
  emailNormalized: string;
  promotionId: string;
}): string {
  return buildContactPopupOfferDedupeKeys(input).primaryProviderIdempotencyKey;
}

function cleanOptionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function cleanPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(payload).filter(([, value]) => value !== undefined),
  );
}
