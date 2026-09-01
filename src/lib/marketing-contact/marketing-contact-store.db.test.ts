import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, afterEach } from "node:test";

import { and, eq, inArray } from "drizzle-orm";

import { claimCustomerEmailById } from "@/lib/commerce/customer-email-outbox";
import { closePrivateDbPool, getPrivateDb } from "@/lib/private-db/client";
import {
  customerEmailOutbox,
  marketingConsentEvents,
  marketingContacts,
  marketingContactSubmissions,
  marketingContactSyncJobs,
} from "@/lib/private-db/schema";

import {
  recordContactPopupSubmission,
  recordGeneralInquirySubmission,
  recordInternalUnsubscribe,
} from "./marketing-contact-store";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const skipReason = testDatabaseUrl
  ? undefined
  : "set TEST_DATABASE_URL to run marketing contact store DB tests";
const emailNormalized = `unsubscribe-replay-${randomUUID()}@example.invalid`;
const offerEmailNormalized = `offer-key-rotation-${randomUUID()}@example.invalid`;
const suppressionEmailNormalized = `offer-suppression-${randomUUID()}@example.invalid`;
const createdOfferOutboxIds: string[] = [];
const originalCheckoutKey = process.env.CHECKOUT_SECRET_ENCRYPTION_KEY;
const originalCurrentDedupeKey =
  process.env.CONTACT_POPUP_OFFER_DEDUPE_CURRENT_KEY;
const originalPreviousDedupeKeys =
  process.env.CONTACT_POPUP_OFFER_DEDUPE_PREVIOUS_KEYS;

if (testDatabaseUrl) {
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.CHECKOUT_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 39).toString(
    "base64",
  );
}

afterEach(async () => {
  if (!testDatabaseUrl) {
    return;
  }

  const db = getPrivateDb();
  if (createdOfferOutboxIds.length > 0) {
    await db
      .delete(customerEmailOutbox)
      .where(inArray(customerEmailOutbox.id, createdOfferOutboxIds));
    createdOfferOutboxIds.length = 0;
  }
  await db
    .delete(customerEmailOutbox)
    .where(
      eq(customerEmailOutbox.recipientEmailNormalized, offerEmailNormalized),
    );
  await db
    .delete(marketingContactSyncJobs)
    .where(
      inArray(marketingContactSyncJobs.emailNormalized, [
        emailNormalized,
        offerEmailNormalized,
        suppressionEmailNormalized,
      ]),
    );
  await db
    .delete(marketingConsentEvents)
    .where(
      inArray(marketingConsentEvents.emailNormalized, [
        emailNormalized,
        offerEmailNormalized,
        suppressionEmailNormalized,
      ]),
    );
  await db
    .delete(marketingContactSubmissions)
    .where(
      inArray(marketingContactSubmissions.emailNormalized, [
        emailNormalized,
        offerEmailNormalized,
        suppressionEmailNormalized,
      ]),
    );
  await db
    .delete(marketingContacts)
    .where(
      inArray(marketingContacts.emailNormalized, [
        emailNormalized,
        offerEmailNormalized,
        suppressionEmailNormalized,
      ]),
    );

  restoreEnv(
    "CONTACT_POPUP_OFFER_DEDUPE_CURRENT_KEY",
    originalCurrentDedupeKey,
  );
  restoreEnv(
    "CONTACT_POPUP_OFFER_DEDUPE_PREVIOUS_KEYS",
    originalPreviousDedupeKeys,
  );
});

after(async () => {
  await closePrivateDbPool();
  restoreEnv("CHECKOUT_SECRET_ENCRYPTION_KEY", originalCheckoutKey);
});

test(
  "internal unsubscribe replay is idempotent per consent generation",
  { skip: skipReason },
  async () => {
    const db = getPrivateDb();
    await recordGeneralInquirySubmission({
      email: emailNormalized,
      marketingConsent: true,
      message: "Subscribe for updates.",
      submittedAt: new Date("2026-08-31T12:00:00.000Z"),
    });

    const [first, replay] = await Promise.all([
      recordInternalUnsubscribe({
        email: emailNormalized,
        occurredAt: new Date("2026-08-31T12:05:00.000Z"),
        reason: "signed_link",
      }),
      recordInternalUnsubscribe({
        email: emailNormalized,
        occurredAt: new Date("2026-08-31T12:06:00.000Z"),
        reason: "signed_link",
      }),
    ]);

    assert.equal(replay.eventId, first.eventId);
    assert.deepEqual(await listUnsubscribeEventIds(), [first.eventId]);
    assert.equal((await listUnsubscribeSyncJobIds()).length, 1);

    const [suppressedContact] = await db
      .select({ unsubscribedAt: marketingContacts.unsubscribedAt })
      .from(marketingContacts)
      .where(eq(marketingContacts.emailNormalized, emailNormalized));
    assert.ok(suppressedContact?.unsubscribedAt instanceof Date);

    await recordGeneralInquirySubmission({
      email: emailNormalized,
      marketingConsent: true,
      message: "Explicitly subscribe again.",
      submittedAt: new Date("2026-08-31T12:10:00.000Z"),
    });

    const [reconsentedContact] = await db
      .select({ unsubscribedAt: marketingContacts.unsubscribedAt })
      .from(marketingContacts)
      .where(eq(marketingContacts.emailNormalized, emailNormalized));
    assert.equal(reconsentedContact?.unsubscribedAt, null);

    const laterUnsubscribe = await recordInternalUnsubscribe({
      email: emailNormalized,
      occurredAt: new Date("2026-08-31T12:15:00.000Z"),
      reason: "signed_link",
    });

    assert.notEqual(laterUnsubscribe.eventId, first.eventId);
    assert.equal((await listUnsubscribeEventIds()).length, 2);
    assert.equal((await listUnsubscribeSyncJobIds()).length, 2);
  },
);

test(
  "popup offer dedupe remains once-only during key rotation and concurrent signup",
  { skip: skipReason },
  async () => {
    const firstKey = Buffer.alloc(32, 41).toString("base64");
    const secondKey = Buffer.alloc(32, 42).toString("base64");
    process.env.CONTACT_POPUP_OFFER_DEDUPE_CURRENT_KEY = `v1:${firstKey}`;
    delete process.env.CONTACT_POPUP_OFFER_DEDUPE_PREVIOUS_KEYS;

    const signupOffer = {
      appliesTo: "all" as const,
      ctaLabel: "Shop now",
      ctaUrl: "https://example.com/products",
      discountAmount: 20,
      discountType: "percentage" as const,
      offerLabel: "Welcome offer",
      offerTerms: "One use per customer.",
      promotionCode: "ROTATE20",
      promotionId: `promotion-${randomUUID()}`,
      promotionRevision: "revision-1",
      resolvedAt: "2026-08-31T12:00:00.000Z",
    };
    const firstWave = await Promise.all([
      recordContactPopupSubmission({
        email: offerEmailNormalized,
        signupOffer,
        submittedAt: new Date("2026-08-31T12:00:00.000Z"),
        variant: "emailOnly",
      }),
      recordContactPopupSubmission({
        email: offerEmailNormalized.toUpperCase(),
        signupOffer,
        submittedAt: new Date("2026-08-31T12:00:30.000Z"),
        variant: "emailOnly",
      }),
    ]);
    assert.deepEqual(
      firstWave.map((result) => result.offerEmailEnqueued).sort(),
      [false, true],
    );
    const first = firstWave.find(
      (result) => result.offerEmailEnqueued === true,
    );
    assert.ok(first?.offerEmailJobId);
    createdOfferOutboxIds.push(first.offerEmailJobId);

    process.env.CONTACT_POPUP_OFFER_DEDUPE_CURRENT_KEY = `v2:${secondKey}`;
    process.env.CONTACT_POPUP_OFFER_DEDUPE_PREVIOUS_KEYS = `v1:${firstKey}`;
    const replays = await Promise.all([
      recordContactPopupSubmission({
        email: offerEmailNormalized.toUpperCase(),
        signupOffer,
        submittedAt: new Date("2026-08-31T12:01:00.000Z"),
        variant: "emailOnly",
      }),
      recordContactPopupSubmission({
        email: ` ${offerEmailNormalized} `,
        signupOffer,
        submittedAt: new Date("2026-08-31T12:02:00.000Z"),
        variant: "emailOnly",
      }),
    ]);

    assert.deepEqual(
      replays.map((result) => result.offerEmailEnqueued),
      [false, false],
    );
    const rows = await getPrivateDb()
      .select({ id: customerEmailOutbox.id })
      .from(customerEmailOutbox)
      .where(
        and(
          eq(customerEmailOutbox.kind, "contact_popup_offer"),
          eq(
            customerEmailOutbox.recipientEmailNormalized,
            offerEmailNormalized,
          ),
        ),
      );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, first.offerEmailJobId);
  },
);

test(
  "internal unsubscribe redacts queued and sending popup offers and makes them unclaimable",
  { skip: skipReason },
  async () => {
    const key = Buffer.alloc(32, 43).toString("base64");
    process.env.CONTACT_POPUP_OFFER_DEDUPE_CURRENT_KEY = `suppression:${key}`;
    delete process.env.CONTACT_POPUP_OFFER_DEDUPE_PREVIOUS_KEYS;

    const buildOffer = (suffix: string) => ({
      appliesTo: "all" as const,
      ctaLabel: "Shop now",
      ctaUrl: "https://example.com/products",
      discountAmount: 10,
      discountType: "percentage" as const,
      offerLabel: "Welcome offer",
      offerTerms: "One use per customer.",
      promotionCode: `SAVE${suffix}`,
      promotionId: `promotion-${suffix}-${randomUUID()}`,
      promotionRevision: "revision-1",
      resolvedAt: "2026-08-31T13:00:00.000Z",
    });
    const queued = await recordContactPopupSubmission({
      email: suppressionEmailNormalized,
      signupOffer: buildOffer("10"),
      submittedAt: new Date("2026-08-31T13:00:00.000Z"),
      variant: "emailOnly",
    });
    const sending = await recordContactPopupSubmission({
      email: suppressionEmailNormalized,
      signupOffer: buildOffer("20"),
      submittedAt: new Date("2026-08-31T13:01:00.000Z"),
      variant: "emailOnly",
    });
    assert.ok(queued.offerEmailJobId);
    assert.ok(sending.offerEmailJobId);
    createdOfferOutboxIds.push(queued.offerEmailJobId, sending.offerEmailJobId);

    const claimed = await claimCustomerEmailById({
      id: sending.offerEmailJobId,
      leaseOwner: "unsubscribe-race-test",
      now: new Date("2026-08-31T13:02:00.000Z"),
    });
    assert.equal(claimed?.id, sending.offerEmailJobId);

    await recordInternalUnsubscribe({
      email: suppressionEmailNormalized,
      occurredAt: new Date("2026-08-31T13:03:00.000Z"),
      reason: "signed_link",
    });

    const rows = await getPrivateDb()
      .select({
        id: customerEmailOutbox.id,
        leaseOwner: customerEmailOutbox.leaseOwner,
        recipientCiphertext: customerEmailOutbox.recipientCiphertext,
        recipientEmailNormalized: customerEmailOutbox.recipientEmailNormalized,
        redactedAt: customerEmailOutbox.redactedAt,
        status: customerEmailOutbox.status,
        templateDataCiphertext: customerEmailOutbox.templateDataCiphertext,
      })
      .from(customerEmailOutbox)
      .where(
        inArray(customerEmailOutbox.id, [
          queued.offerEmailJobId,
          sending.offerEmailJobId,
        ]),
      );
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.status, "dead_letter");
      assert.equal(row.leaseOwner, null);
      assert.equal(row.recipientCiphertext, "[redacted]");
      assert.equal(row.recipientEmailNormalized, null);
      assert.ok(row.redactedAt instanceof Date);
      assert.equal(row.templateDataCiphertext, "[redacted]");
      assert.equal(
        await claimCustomerEmailById({
          id: row.id,
          leaseOwner: "post-unsubscribe-test",
          now: new Date("2026-08-31T13:04:00.000Z"),
        }),
        null,
      );
    }
  },
);

async function listUnsubscribeEventIds(): Promise<string[]> {
  return (
    await getPrivateDb()
      .select({ id: marketingConsentEvents.id })
      .from(marketingConsentEvents)
      .where(
        and(
          eq(marketingConsentEvents.emailNormalized, emailNormalized),
          eq(marketingConsentEvents.eventType, "unsubscribe"),
        ),
      )
  ).map(({ id }) => id);
}

async function listUnsubscribeSyncJobIds(): Promise<string[]> {
  return (
    await getPrivateDb()
      .select({ id: marketingContactSyncJobs.id })
      .from(marketingContactSyncJobs)
      .where(
        and(
          eq(marketingContactSyncJobs.emailNormalized, emailNormalized),
          eq(marketingContactSyncJobs.kind, "unsubscribe_sync"),
        ),
      )
  ).map(({ id }) => id);
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
