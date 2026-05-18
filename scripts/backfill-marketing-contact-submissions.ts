import "dotenv/config";

import { createClient } from "@sanity/client";

import {
  CONTACT_POPUP_CONSENT_TEXT,
  recordSanityBackfillSubmission,
} from "../src/lib/marketing-contact/marketing-contact-store";
import type { MarketingContactSubmissionType } from "../src/lib/private-db/schema";
import { apiVersion, dataset, projectId } from "../src/sanity/env";

type BackfillDocument = {
  _createdAt: string;
  _id: string;
  _type: string;
  clients?: number;
  email?: string;
  experience?: string;
  info?: string;
  instagram?: string;
  interest?: string;
  location?: string;
  message?: string;
  name?: string;
  phone?: string;
  sourcePath?: string;
  variant?: "fullContact" | "emailOnly";
  bookingType?: string;
  answers?: Array<{ answer?: string; questionId?: string; questionLabel?: string }>;
};

type BackfillRecord = {
  consentText?: string;
  email: string;
  marketingConsent: boolean;
  name?: string;
  originalDocumentId: string;
  originalDocumentType: string;
  payload: Record<string, unknown>;
  phone?: string;
  instagram?: string;
  submittedAt: Date;
  submissionType: MarketingContactSubmissionType;
};

const SUBMISSION_QUERY = `*[_type in ["generalInquiry", "contactForm", "contactPopupSubmission", "bookingMarketingOptIn"]] | order(_createdAt asc) {
  _id,
  _type,
  _createdAt,
  name,
  email,
  phone,
  instagram,
  message,
  location,
  experience,
  interest,
  clients,
  info,
  variant,
  sourcePath,
  bookingType,
  answers[]{ questionId, questionLabel, answer }
}`;

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");
  const sanityToken = process.env.SANITY_WRITE_TOKEN;
  const sanityClient = createClient({
    apiVersion,
    dataset,
    projectId,
    token: sanityToken,
    useCdn: false,
  });
  const docs = await sanityClient.fetch<BackfillDocument[]>(SUBMISSION_QUERY);
  const records = docs.map(toBackfillRecord).filter((record) => record !== null);

  console.log(`[marketing-backfill] Found ${docs.length} Sanity submission docs`);
  console.log(`[marketing-backfill] Prepared ${records.length} rows`);
  console.table(countBy(records, (record) => record.originalDocumentType));

  if (!execute) {
    console.log("[marketing-backfill] Dry run only. Re-run with --execute to write to private Postgres.");
    return;
  }

  for (const record of records) {
    await recordSanityBackfillSubmission({
      ...record,
      source: "sanity_backfill",
    });
  }

  console.log(`[marketing-backfill] Backfilled ${records.length} marketing/contact submission rows`);
}

function toBackfillRecord(doc: BackfillDocument): BackfillRecord | null {
  const email = cleanOptionalText(doc.email);

  if (!email) {
    console.warn(`[marketing-backfill] Skipping ${doc._id}: missing email`);
    return null;
  }

  const base = {
    email,
    name: cleanOptionalText(doc.name),
    originalDocumentId: doc._id,
    originalDocumentType: doc._type,
    phone: cleanOptionalText(doc.phone),
    instagram: cleanOptionalText(doc.instagram),
    submittedAt: new Date(doc._createdAt),
  };

  if (doc._type === "contactPopupSubmission") {
    return {
      ...base,
      consentText: CONTACT_POPUP_CONSENT_TEXT,
      marketingConsent: true,
      payload: {
        sourcePath: cleanOptionalText(doc.sourcePath),
        variant: doc.variant ?? "emailOnly",
      },
      submissionType: "sanity_backfill",
    };
  }

  if (doc._type === "bookingMarketingOptIn") {
    return {
      ...base,
      marketingConsent: true,
      payload: {
        answers: doc.answers ?? [],
        bookingType: doc.bookingType,
        marketingOptIn: true,
      },
      submissionType: "sanity_backfill",
    };
  }

  if (doc._type === "generalInquiry") {
    return {
      ...base,
      marketingConsent: false,
      payload: {
        message: doc.message,
      },
      submissionType: "sanity_backfill",
    };
  }

  if (doc._type === "contactForm") {
    return {
      ...base,
      marketingConsent: false,
      payload: {
        clients: doc.clients,
        experience: doc.experience,
        info: doc.info,
        interest: doc.interest,
        location: doc.location,
      },
      submissionType: "sanity_backfill",
    };
  }

  return null;
}

function countBy<T>(records: T[], selectKey: (record: T) => string): Array<{ count: number; type: string }> {
  const counts = new Map<string, number>();

  for (const record of records) {
    const key = selectKey(record);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return Array.from(counts, ([type, count]) => ({ count, type }));
}

function cleanOptionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

main().catch((error: unknown) => {
  console.error("[marketing-backfill] Failed", error);
  process.exit(1);
});
