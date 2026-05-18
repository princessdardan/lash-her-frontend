import "server-only";

import { and, eq } from "drizzle-orm";

import { getPrivateDb } from "@/lib/private-db/client";
import {
  marketingConsentEvents,
  marketingContacts,
  marketingContactSubmissions,
  type MarketingConsentEventType,
  type MarketingContactSubmissionType,
} from "@/lib/private-db/schema";

export const GENERAL_INQUIRY_CONSENT_TEXT = "I agree to receive lash care tips, service updates, and offers from Lash Her by Nataliea.";
export const TRAINING_CONTACT_CONSENT_TEXT = "I agree to receive training updates, program news, and offers from Lash Her by Nataliea.";
export const CONTACT_POPUP_CONSENT_TEXT = "I agree to receive updates and offers from Lash Her by Nataliea.";
export const BOOKING_MARKETING_CONSENT_TEXT = "I would like to receive updates and offers from Lash Her by Nataliea.";

export type MarketingConsentChoice = "opted_in" | "not_opted_in" | "unsubscribed";
export type MarketingSubmissionSource =
  | "general_inquiry"
  | "training_contact"
  | "contact_popup"
  | "booking"
  | "sanity_backfill";

export interface BookingAnswerSnapshot {
  questionId: string;
  questionLabel: string;
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
  clients?: number;
  consentText?: string;
  experience: string;
  info?: string;
  interest: string;
  location: string;
  marketingConsent: boolean;
  phone: string;
  sourceDocument?: SourceDocumentReference;
  sourcePath?: string;
  submittedAt?: Date;
}

export interface RecordContactPopupInput extends MarketingContactIdentity {
  consentText?: string;
  sourceDocument?: SourceDocumentReference;
  sourcePath?: string;
  submittedAt?: Date;
  variant: "fullContact" | "emailOnly";
}

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

export interface MarketingContactPersistenceInput {
  contact: MarketingContactUpsertValues | null;
  event: MarketingConsentEventValues;
  submission: MarketingContactSubmissionValues;
}

export interface MarketingContactRepository {
  recordMarketingContact(input: MarketingContactPersistenceInput): Promise<{ submissionId: string }>;
}

export interface MarketingContactStore {
  recordBookingMarketingChoice(input: RecordBookingMarketingChoiceInput): Promise<{ submissionId: string }>;
  recordContactPopup(input: RecordContactPopupInput): Promise<{ submissionId: string }>;
  recordGeneralInquiry(input: RecordGeneralInquiryInput): Promise<{ submissionId: string }>;
  recordSanityBackfillSubmission(input: RecordSanityBackfillSubmissionInput): Promise<{ submissionId: string }>;
  recordTrainingContact(input: RecordTrainingContactInput): Promise<{ submissionId: string }>;
}

export function createMarketingContactStore(
  repository: MarketingContactRepository,
): MarketingContactStore {
  return {
    async recordGeneralInquiry(input) {
      return repository.recordMarketingContact(buildPersistenceInput({
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
      }));
    },

    async recordTrainingContact(input) {
      return repository.recordMarketingContact(buildPersistenceInput({
        consentText: input.consentText ?? TRAINING_CONTACT_CONSENT_TEXT,
        identity: input,
        marketingConsent: input.marketingConsent,
        payload: {
          clients: input.clients,
          experience: input.experience,
          info: cleanOptionalText(input.info),
          instagram: cleanOptionalText(input.instagram),
          interest: input.interest,
          location: input.location,
          phone: input.phone,
        },
        source: "training_contact",
        sourceDocument: input.sourceDocument,
        sourcePath: input.sourcePath,
        submittedAt: input.submittedAt,
        submissionType: "training_contact",
      }));
    },

    async recordContactPopup(input) {
      return repository.recordMarketingContact(buildPersistenceInput({
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
      }));
    },

    async recordBookingMarketingChoice(input) {
      return repository.recordMarketingContact(buildPersistenceInput({
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
      }));
    },

    async recordSanityBackfillSubmission(input) {
      return repository.recordMarketingContact(buildPersistenceInput({
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
      }));
    },
  };
}

const defaultMarketingContactStore = createMarketingContactStore(
  createDrizzleMarketingContactRepository(),
);

export async function recordGeneralInquirySubmission(
  input: RecordGeneralInquiryInput,
): Promise<{ submissionId: string }> {
  return defaultMarketingContactStore.recordGeneralInquiry(input);
}

export async function recordTrainingContactSubmission(
  input: RecordTrainingContactInput,
): Promise<{ submissionId: string }> {
  return defaultMarketingContactStore.recordTrainingContact(input);
}

export async function recordContactPopupSubmission(
  input: RecordContactPopupInput,
): Promise<{ submissionId: string }> {
  return defaultMarketingContactStore.recordContactPopup(input);
}

export async function recordBookingMarketingChoice(
  input: RecordBookingMarketingChoiceInput,
): Promise<{ submissionId: string }> {
  return defaultMarketingContactStore.recordBookingMarketingChoice(input);
}

export async function recordSanityBackfillSubmission(
  input: RecordSanityBackfillSubmissionInput,
): Promise<{ submissionId: string }> {
  return defaultMarketingContactStore.recordSanityBackfillSubmission(input);
}

function createDrizzleMarketingContactRepository(): MarketingContactRepository {
  return {
    async recordMarketingContact(input) {
      return getPrivateDb().transaction(async (tx) => {
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
                eq(marketingContactSubmissions.sourceSystem, sourceDocument.sourceSystem),
                eq(marketingContactSubmissions.sourceDocumentType, sourceDocument.sourceDocumentType),
                eq(marketingContactSubmissions.sourceDocumentId, sourceDocument.sourceDocumentId),
              ),
            )
            .limit(1);

          if (!existingSubmission) {
            throw new Error("Marketing contact submission was not created");
          }

          return { submissionId: existingSubmission.id };
        }

        await tx.insert(marketingConsentEvents).values({
          ...input.event,
          contactId,
          submissionId: submission.id,
        });

        return { submissionId: submission.id };
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

function buildPersistenceInput(options: BuildPersistenceInputOptions): MarketingContactPersistenceInput {
  const now = options.submittedAt ?? new Date();
  const identity = normalizeIdentity(options.identity);
  const consentChoice: MarketingConsentChoice = options.marketingConsent ? "opted_in" : "not_opted_in";
  const eventType: MarketingConsentEventType = options.marketingConsent
    ? options.sourceDocument?.sourceSystem === "sanity" ? "backfill_consent" : "opt_in"
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

function toSubmissionInsert(values: MarketingContactSubmissionValues): typeof marketingContactSubmissions.$inferInsert {
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

function normalizeIdentity(identity: MarketingContactIdentity): MarketingContactIdentity & { emailNormalized: string } {
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

function cleanOptionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function cleanPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(payload).filter(([, value]) => value !== undefined),
  );
}
