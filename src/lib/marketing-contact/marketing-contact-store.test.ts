import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import {
    CONTACT_POPUP_CONSENT_TEXT,
    createMarketingContactStore,
    GENERAL_INQUIRY_CONSENT_TEXT,
    type MarketingContactPersistenceInput,
    type MarketingContactRepository,
  } from "./src/lib/marketing-contact/marketing-contact-store.ts";

  class FakeMarketingContactRepository implements MarketingContactRepository {
    readonly records = [];
    readonly unsubscribes = [];
    readonly syncJobs = [];

    async recordMarketingContact(input: MarketingContactPersistenceInput): Promise<{ submissionId: string; syncJobId?: string }> {
      const submissionId = "marketing-submission-" + (this.records.length + 1);
      this.records.push(input);

      if (input.contact !== null) {
        const syncJobId = "marketing-sync-" + (this.syncJobs.length + 1);
        this.syncJobs.push({ id: syncJobId, input, status: "queued" });
        return { submissionId, syncJobId };
      }

      return { submissionId };
    }

    async recordMarketingUnsubscribe(input) {
      const eventId = "marketing-unsubscribe-" + (this.unsubscribes.length + 1);
      this.unsubscribes.push(input);

      for (const job of this.syncJobs) {
        if (
          job.input.contact?.emailNormalized === input.emailNormalized &&
          ["queued", "processing", "retryable_failed"].includes(job.status)
        ) {
          job.status = "skipped_unconfigured";
          job.lastError = "Contact unsubscribed before marketing sync";
          job.skippedAt = input.occurredAt;
        }
      }

      return { eventId };
    }
  }

  function createFakeStore(dependencies = {}): {
    repository: FakeMarketingContactRepository;
    store: ReturnType<typeof createMarketingContactStore>;
  } {
    const repository = new FakeMarketingContactRepository();
    return {
      repository,
      store: createMarketingContactStore(repository, {
        syncMarketingContact: async () => {},
        ...dependencies,
      }),
    };
  }
`;

test("marketing contact store normalizes general inquiry submissions and records affirmative consent", () => {
  runMarketingContactStoreScenario(`
    const { repository, store } = createFakeStore();
    const submittedAt = new Date("2026-05-10T12:00:00.000Z");

    const result = await store.recordGeneralInquiry({
      email: " Client@Example.COM ",
      instagram: " @client ",
      marketingConsent: true,
      message: "I would like a refill appointment.",
      name: " Client Name ",
      phone: " 555-0100 ",
      sourcePath: " /contact ",
      submittedAt,
    });
    const record = repository.records[0];

    assert.deepEqual(result, { submissionId: "marketing-submission-1", syncJobId: "marketing-sync-1" });
    assert.equal(record.submission.submissionType, "general_inquiry");
    assert.equal(record.submission.consentChoice, "opted_in");
    assert.equal(record.submission.email, "Client@Example.COM");
    assert.equal(record.submission.emailNormalized, "client@example.com");
    assert.equal(record.submission.name, "Client Name");
    assert.equal(record.submission.phone, "555-0100");
    assert.equal(record.submission.instagram, "@client");
    assert.equal(record.submission.sourcePath, "/contact");
    assert.equal(record.submission.consentText, GENERAL_INQUIRY_CONSENT_TEXT);
    assert.deepEqual(record.submission.payload, {
      instagram: "@client",
      message: "I would like a refill appointment.",
      phone: "555-0100",
    });
    assert.ok(record.contact);
    assert.equal(record.contact.emailNormalized, "client@example.com");
    assert.equal(record.contact.lastConsentedAt, submittedAt);
    assert.equal(record.event.eventType, "opt_in");
    assert.equal(record.event.occurredAt, submittedAt);
  `);
});

test("marketing contact store audits no-opt-in inquiry without adding audience contact", () => {
  runMarketingContactStoreScenario(`
    const { repository, store } = createFakeStore();

    await store.recordGeneralInquiry({
      email: "client@example.com",
      marketingConsent: false,
      message: "Question about pricing.",
      name: "Client Name",
    });
    const record = repository.records[0];

    assert.equal(record.contact, null);
    assert.equal(record.submission.consentChoice, "not_opted_in");
    assert.equal(record.event.eventType, "no_opt_in");
  `);
});

test("marketing contact store treats popup submissions as affirmative marketing consent", () => {
  runMarketingContactStoreScenario(`
    const { repository, store } = createFakeStore();

    await store.recordContactPopup({
      email: "subscriber@example.com",
      instagram: "lavlash",
      name: "Subscriber",
      sourcePath: "/",
      variant: "fullContact",
    });
    const record = repository.records[0];

    assert.equal(record.submission.submissionType, "contact_popup");
    assert.equal(record.submission.consentChoice, "opted_in");
    assert.equal(record.submission.consentText, CONTACT_POPUP_CONSENT_TEXT);
    assert.ok(record.contact);
    assert.equal(record.contact.emailNormalized, "subscriber@example.com");
    assert.equal(record.event.eventType, "opt_in");
  `);
});

test("marketing contact store audits false booking choices without adding audience contact", () => {
  runMarketingContactStoreScenario(`
    const { repository, store } = createFakeStore();

    await store.recordBookingMarketingChoice({
      answers: [{ questionId: "goal", questionLabel: "Goal", answer: "Classic lashes" }],
      bookingType: "training-call",
      email: "booking@example.com",
      marketingOptIn: false,
      name: "Booking Client",
      phone: "555-0101",
      sourcePath: "/booking",
    });
    const record = repository.records[0];

    assert.equal(record.contact, null);
    assert.equal(record.submission.submissionType, "booking_marketing_choice");
    assert.equal(record.submission.consentChoice, "not_opted_in");
    assert.equal(record.submission.payload.marketingOptIn, false);
    assert.equal(record.event.eventType, "no_opt_in");
  `);
});

test("marketing contact store records Sanity backfill consent with source document identity", () => {
  runMarketingContactStoreScenario(`
    const { repository, store } = createFakeStore();

    await store.recordSanityBackfillSubmission({
      email: "lead@example.com",
      marketingConsent: true,
      name: "Backfilled Lead",
      originalDocumentId: "sanity-doc-1",
      originalDocumentType: "contactPopupSubmission",
      payload: { variant: "emailOnly" },
      source: "sanity_backfill",
      submittedAt: new Date("2026-04-01T00:00:00.000Z"),
      submissionType: "sanity_backfill",
    });
    const record = repository.records[0];

    assert.equal(record.submission.sourceSystem, "sanity");
    assert.deepEqual(record.submission.sourceDocument, {
      sourceDocumentId: "sanity-doc-1",
      sourceDocumentType: "contactPopupSubmission",
      sourceSystem: "sanity",
    });
    assert.equal(record.event.eventType, "backfill_consent");
    assert.ok(record.contact);
  `);
});

test("marketing contact store enqueues a sync job for opted-in contacts and does not call Resend directly", () => {
  runMarketingContactStoreScenario(`
    const syncedContacts = [];
    const submittedAt = new Date("2026-05-10T12:00:00.000Z");
    const { repository, store } = createFakeStore({
      syncMarketingContact: async (input) => syncedContacts.push(input),
    });

    const result = await store.recordGeneralInquiry({
      email: "subscriber@example.com",
      marketingConsent: true,
      message: "Please send updates.",
      name: "Subscriber Name",
      phone: "555-0100",
      sourcePath: "/contact",
      submittedAt,
    });

    assert.deepEqual(result, { submissionId: "marketing-submission-1", syncJobId: "marketing-sync-1" });
    assert.equal(repository.syncJobs.length, 1);
    assert.equal(repository.syncJobs[0].input.contact.emailNormalized, "subscriber@example.com");
    assert.deepEqual(syncedContacts, []);
  `);
});

test("marketing contact store does not enqueue a sync job for non-consenting submissions", () => {
  runMarketingContactStoreScenario(`
    const { repository, store } = createFakeStore();

    const result = await store.recordGeneralInquiry({
      email: "client@example.com",
      marketingConsent: false,
      message: "Question about pricing.",
      name: "Client Name",
    });

    assert.deepEqual(result, { submissionId: "marketing-submission-1" });
    assert.equal(repository.syncJobs.length, 0);
  `);
});

test("marketing contact store records Resend unsubscribe events", () => {
  runMarketingContactStoreScenario(`
    const { repository, store } = createFakeStore();
    const occurredAt = new Date("2026-05-11T12:00:00.000Z");

    const result = await store.recordResendUnsubscribe({
      email: " Client@Example.COM ",
      metadata: { resendSegmentIds: ["segment-newsletter"] },
      occurredAt,
      resendContactId: "contact-123",
    });

    assert.deepEqual(result, { eventId: "marketing-unsubscribe-1" });
    assert.deepEqual(repository.unsubscribes[0], {
      email: "Client@Example.COM",
      emailNormalized: "client@example.com",
      metadata: { resendSegmentIds: ["segment-newsletter"] },
      occurredAt,
      resendContactId: "contact-123",
    });
  `);
});

test("marketing contact store skips pending sync jobs when recording unsubscribe", () => {
  runMarketingContactStoreScenario(`
    const { repository, store } = createFakeStore();
    const occurredAt = new Date("2026-05-11T12:00:00.000Z");

    await store.recordGeneralInquiry({
      email: "Client@Example.COM",
      marketingConsent: true,
      message: "Please send updates.",
      name: "Client Name",
    });
    assert.equal(repository.syncJobs.length, 1);
    assert.equal(repository.syncJobs[0].status, "queued");

    const result = await store.recordResendUnsubscribe({
      email: "Client@Example.COM",
      occurredAt,
    });

    assert.deepEqual(result, { eventId: "marketing-unsubscribe-1" });
    assert.equal(repository.syncJobs[0].status, "skipped_unconfigured");
    assert.equal(repository.syncJobs[0].lastError, "Contact unsubscribed before marketing sync");
    assert.equal(repository.syncJobs[0].skippedAt, occurredAt);
  `);
});

test("marketing contact store does not skip already-succeeded sync jobs on unsubscribe", () => {
  runMarketingContactStoreScenario(`
    const { repository, store } = createFakeStore();
    const occurredAt = new Date("2026-05-11T12:00:00.000Z");

    await store.recordGeneralInquiry({
      email: "Client@Example.COM",
      marketingConsent: true,
      message: "Please send updates.",
      name: "Client Name",
    });
    repository.syncJobs[0].status = "succeeded";

    const result = await store.recordResendUnsubscribe({
      email: "Client@Example.COM",
      occurredAt,
    });

    assert.deepEqual(result, { eventId: "marketing-unsubscribe-1" });
    assert.equal(repository.syncJobs[0].status, "succeeded");
    assert.equal(repository.syncJobs[0].lastError, undefined);
  `);
});

function runMarketingContactStoreScenario(assertions: string): void {
  const scenario = `${helperScript}\nvoid (async () => {\n${assertions}\n})()`;
  const env = { ...process.env };

  env.NEXT_PUBLIC_SANITY_DATASET = "test";
  env.NEXT_PUBLIC_SANITY_PROJECT_ID = "test-project";

  execFileSync(
    "./node_modules/.bin/tsx",
    ["--conditions=react-server", "--eval", scenario],
    {
      cwd: process.cwd(),
      env,
      stdio: "pipe",
    },
  );
}
