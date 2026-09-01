import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import {
    buildContactPopupOfferProviderIdempotencyKey,
    CONTACT_POPUP_CONSENT_TEXT,
    createMarketingContactStore,
    GENERAL_INQUIRY_CONSENT_TEXT,
  } from "./src/lib/marketing-contact/marketing-contact-store.ts";
  import { buildContactPopupOfferDedupeKeys } from "./src/lib/marketing-contact/contact-popup-offer-dedupe.ts";

  class FakeMarketingContactRepository {
    records = [];
    unsubscribes = [];
    syncJobs = [];

    async recordMarketingContact(input) {
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

  function createFakeStore(dependencies = {}) {
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

test("marketing contact store passes an immutable popup offer snapshot to persistence", () => {
  runMarketingContactStoreScenario(`
    const { repository, store } = createFakeStore();
    const signupOffer = {
      promotionId: "promotion-1",
      promotionRevision: "revision-1",
      promotionCode: "WELCOME20",
      discountType: "percentage",
      discountAmount: 20,
      appliesTo: "all",
      offerLabel: "Welcome offer",
      offerTerms: "Valid on products and training programs.",
      ctaLabel: "Shop now",
      ctaUrl: "https://lashher.com/products",
      resolvedAt: "2026-08-31T12:00:00.000Z",
    };

    await store.recordContactPopup({
      email: "subscriber@example.com",
      signupOffer,
      variant: "emailOnly",
    });

    assert.deepEqual(repository.records[0].contactPopupOffer, {
      snapshot: signupOffer,
      variant: "emailOnly",
    });
  `);
});

test("popup offer suppression keys are normalized, deterministic keyed digests", () => {
  runMarketingContactStoreScenario(`
    delete process.env.CONTACT_POPUP_OFFER_DEDUPE_CURRENT_KEY;
    delete process.env.CONTACT_POPUP_OFFER_DEDUPE_PREVIOUS_KEYS;
    delete process.env.CONTACT_POPUP_OFFER_DEDUPE_LEGACY_CHECKOUT_KEYS;
    process.env.CHECKOUT_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString("base64");
    process.env.NEXT_PUBLIC_SANITY_DATASET = "staging-2026-05-10";
    process.env.VERCEL_ENV = "preview";

    const first = buildContactPopupOfferProviderIdempotencyKey({
      emailNormalized: " Subscriber@Example.COM ",
      promotionId: " promotion-1 ",
    });
    const normalized = buildContactPopupOfferProviderIdempotencyKey({
      emailNormalized: "subscriber@example.com",
      promotionId: "promotion-1",
    });
    const otherPromotion = buildContactPopupOfferProviderIdempotencyKey({
      emailNormalized: "subscriber@example.com",
      promotionId: "promotion-2",
    });
    process.env.VERCEL_ENV = "production";
    process.env.NEXT_PUBLIC_SANITY_DATASET = "production";
    const production = buildContactPopupOfferProviderIdempotencyKey({
      emailNormalized: "subscriber@example.com",
      promotionId: "promotion-1",
    });

    assert.equal(first, normalized);
    assert.equal(
      first,
      "contact-popup-offer:0eff866832c7384725ef1aa09d532967cb593dd1ac8d50d9c3eb5e8086cd6597",
    );
    assert.notEqual(first, otherPromotion);
    assert.notEqual(first, production);
    assert.match(first, /^contact-popup-offer:[0-9a-f]{64}$/);
    assert.equal(first.includes("subscriber@example.com"), false);
  `);
});

test("popup offer dedupe recognizes retained dedicated and legacy keys across rotations", () => {
  runMarketingContactStoreScenario(`
    const legacyCheckoutKey = Buffer.alloc(32, 11).toString("base64");
    const rotatedCheckoutKey = Buffer.alloc(32, 12).toString("base64");
    const dedicatedV1Key = Buffer.alloc(32, 21).toString("base64");
    const dedicatedV2Key = Buffer.alloc(32, 22).toString("base64");
    const identity = {
      emailNormalized: " Subscriber@Example.COM ",
      promotionId: " promotion-1 ",
    };
    process.env.NEXT_PUBLIC_SANITY_DATASET = "production";
    process.env.VERCEL_ENV = "production";
    delete process.env.CONTACT_POPUP_OFFER_DEDUPE_CURRENT_KEY;
    delete process.env.CONTACT_POPUP_OFFER_DEDUPE_PREVIOUS_KEYS;
    delete process.env.CONTACT_POPUP_OFFER_DEDUPE_LEGACY_CHECKOUT_KEYS;

    process.env.CHECKOUT_SECRET_ENCRYPTION_KEY = legacyCheckoutKey;
    const legacyGrant = buildContactPopupOfferDedupeKeys(identity);

    process.env.CHECKOUT_SECRET_ENCRYPTION_KEY = rotatedCheckoutKey;
    process.env.CONTACT_POPUP_OFFER_DEDUPE_LEGACY_CHECKOUT_KEYS = legacyCheckoutKey;
    const checkoutRotation = buildContactPopupOfferDedupeKeys(identity);
    assert.notEqual(
      checkoutRotation.primaryProviderIdempotencyKey,
      legacyGrant.primaryProviderIdempotencyKey,
    );
    assert.ok(
      checkoutRotation.candidateProviderIdempotencyKeys.includes(
        legacyGrant.primaryProviderIdempotencyKey,
      ),
    );

    process.env.CONTACT_POPUP_OFFER_DEDUPE_PREVIOUS_KEYS = "v1:" + dedicatedV1Key;
    const stagedDedicatedKey = buildContactPopupOfferDedupeKeys(identity);
    process.env.CONTACT_POPUP_OFFER_DEDUPE_CURRENT_KEY = "v1:" + dedicatedV1Key;
    delete process.env.CONTACT_POPUP_OFFER_DEDUPE_PREVIOUS_KEYS;
    const dedicatedV1Grant = buildContactPopupOfferDedupeKeys(identity);
    assert.ok(
      stagedDedicatedKey.candidateProviderIdempotencyKeys.includes(
        dedicatedV1Grant.primaryProviderIdempotencyKey,
      ),
    );
    process.env.CONTACT_POPUP_OFFER_DEDUPE_CURRENT_KEY = "v2:" + dedicatedV2Key;
    process.env.CONTACT_POPUP_OFFER_DEDUPE_PREVIOUS_KEYS = "v1:" + dedicatedV1Key;
    const dedicatedRotation = buildContactPopupOfferDedupeKeys(identity);
    assert.ok(
      dedicatedRotation.candidateProviderIdempotencyKeys.includes(
        dedicatedV1Grant.primaryProviderIdempotencyKey,
      ),
    );

    const stablePrimary = dedicatedRotation.primaryProviderIdempotencyKey;
    process.env.CHECKOUT_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 13).toString("base64");
    assert.equal(
      buildContactPopupOfferDedupeKeys(identity).primaryProviderIdempotencyKey,
      stablePrimary,
    );
    assert.equal(stablePrimary.includes("subscriber@example.com"), false);
  `);
});

test("popup offer dedupe keyring rejects duplicate versions", () => {
  runMarketingContactStoreScenario(`
    const key = Buffer.alloc(32, 31).toString("base64");
    process.env.CONTACT_POPUP_OFFER_DEDUPE_CURRENT_KEY = "v2:" + key;
    process.env.CONTACT_POPUP_OFFER_DEDUPE_PREVIOUS_KEYS = "v2:" + key;

    assert.throws(
      () => buildContactPopupOfferDedupeKeys({
        emailNormalized: "subscriber@example.com",
        promotionId: "promotion-1",
      }),
      /duplicate key version: v2/,
    );
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
      origin: "resend",
      resendContactId: "contact-123",
    });
  `);
});

test("marketing contact store records internal unsubscribes with origin internal", () => {
  runMarketingContactStoreScenario(`
    const { repository, store } = createFakeStore();
    const occurredAt = new Date("2026-05-11T12:00:00.000Z");

    const result = await store.recordInternalUnsubscribe({
      email: " Owner@Example.COM ",
      occurredAt,
      reason: "Requested by phone",
    });

    assert.deepEqual(result, { eventId: "marketing-unsubscribe-1" });
    assert.deepEqual(repository.unsubscribes[0], {
      email: "Owner@Example.COM",
      emailNormalized: "owner@example.com",
      metadata: undefined,
      occurredAt,
      origin: "internal",
      reason: "Requested by phone",
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
    process.execPath,
    [
      "--conditions=react-server",
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      scenario,
    ],
    {
      cwd: process.cwd(),
      env,
      stdio: "pipe",
    },
  );
}
