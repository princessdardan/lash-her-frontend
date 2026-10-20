import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { sql } from "drizzle-orm";
import { getPrivateDb, closePrivateDbPool } from "@/lib/private-db/client";
import {
  recordGeneralInquirySubmission,
  recordContactPopupSubmission,
} from "@/lib/marketing-contact/marketing-contact-store";
import { claimCustomerEmailById } from "@/lib/commerce/customer-email-outbox";
import { recordCheckoutConsent } from "./checkout-consent";
import {
  channelConsent,
  claimJobs,
  enqueueCrmEvent,
  finishJob,
  type CrmJob,
  type CrmContact,
} from "./store";
import { durableEffect, stopJourneys, syncEffects, syncJob } from "./sync";
import { persistHighLevelWebhook } from "./webhook";
import { encryptCredential } from "./crypto";
import { accessToken, type TokenResponse } from "./oauth";
import { HIGHLEVEL_SCOPES } from "./config";
import { HighLevelError } from "./contract";
import { backfillHighLevel } from "./backfill";
import type { CrmRequest } from "./client";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
const skip = databaseUrl ? undefined : "TEST_DATABASE_URL required";
const runId = randomUUID();
const location = `test-${runId}`;
const email = (label: string) => `hl-${runId}-${label}@example.test`;
process.env.HIGHLEVEL_LOCATION_ID = location;
process.env.HIGHLEVEL_CREDENTIAL_ENCRYPTION_KEY = "ab".repeat(32);
process.env.CHECKOUT_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 39).toString(
  "base64",
);
process.env.HIGHLEVEL_FIELD_IDS = JSON.stringify(
  Object.fromEntries(
    [
      "website_id",
      "email_eligible",
      "sms_eligible",
      "email_destination",
      "sms_destination",
      "original_source",
      "original_path",
      "attribution",
      "source",
      "source_path",
      "historical",
      "lifecycle",
      "interest",
      "last_activity",
      "offer",
      "offer_code",
      "offer_label",
      "offer_terms",
      "offer_url",
      "journey_key",
    ].map((k) => [k, k]),
  ),
);
process.env.HIGHLEVEL_MARKETING_PIPELINE_ID = "pipeline";
process.env.HIGHLEVEL_MARKETING_STAGE_ID = "new";
process.env.HIGHLEVEL_WORKFLOW_INQUIRY_ID = "inquiry-workflow";
process.env.HIGHLEVEL_ACCOUNT_AUDITED = "true";

after(async () => {
  if (databaseUrl) {
    const db = getPrivateDb();
    await db.execute(
      sql`delete from highlevel_effects where contact_id in (select id from highlevel_contacts where location_id = ${location})`,
    );
    await db.execute(
      sql`delete from highlevel_contacts where location_id = ${location}`,
    );
    await db.execute(
      sql`delete from highlevel_connections where location_id = ${location}`,
    );
    await db.execute(
      sql`delete from highlevel_webhook_receipts where location_id = ${location}`,
    );
    await db.execute(
      sql`delete from customer_email_outbox where recipient_email_normalized like ${`hl-${runId}-%`}`,
    );
    await db.execute(
      sql`delete from marketing_contact_sync_jobs where email_normalized like ${`hl-${runId}-%`}`,
    );
    await db.execute(
      sql`delete from marketing_consent_events where email_normalized like ${`hl-${runId}-%`}`,
    );
    await db.execute(
      sql`delete from marketing_contact_submissions where email_normalized like ${`hl-${runId}-%`}`,
    );
    await db.execute(
      sql`delete from marketing_contacts where email_normalized like ${`hl-${runId}-%`}`,
    );
    await db.execute(
      sql`delete from highlevel_consent_events where email_normalized like ${`hl-${runId}-%`}`,
    );
  }
  await closePrivateDbPool();
});

async function submissionJob(id: string): Promise<CrmJob> {
  return (
    await getPrivateDb().execute<CrmJob>(
      sql`select * from highlevel_outbox where entity_type = 'submission' and entity_id = ${id} order by created_at limit 1`,
    )
  ).rows[0];
}
async function contactFor(
  address: string,
  providerId = randomUUID(),
): Promise<CrmContact> {
  return (
    await getPrivateDb().execute<CrmContact>(
      sql`insert into highlevel_contacts (location_id,email_normalized,provider_id,phone) values (${location},${address},${providerId},'+14165550123') returning *`,
    )
  ).rows[0];
}

test(
  "checkout consent and CRM jobs roll back with the order transaction; retries preserve one evidence record",
  { skip },
  async () => {
    const db = getPrivateDb();
    const id = randomUUID();
    const address = email("atomic");
    const input = {
      orderId: id,
      email: address,
      source: "product_checkout",
      marketing: { marketingConsent: true, smsMarketingConsent: false },
    };
    await assert.rejects(
      db.transaction(async (tx) => {
        await recordCheckoutConsent(tx, input);
        throw new Error("order failure");
      }),
      /order failure/,
    );
    assert.equal(
      (
        await db.execute(
          sql`select id from highlevel_consent_events where email_normalized = ${address}`,
        )
      ).rows.length,
      0,
    );
    await db.transaction((tx) => recordCheckoutConsent(tx, input));
    await db.transaction((tx) => recordCheckoutConsent(tx, input));
    const evidence = (
      await db.execute<{ id: string }>(
        sql`select id from highlevel_consent_events where email_normalized = ${address}`,
      )
    ).rows;
    assert.equal(evidence.length, 1);
    assert.equal(
      (
        await db.execute(
          sql`select id from highlevel_outbox where entity_type = 'consent' and entity_id = ${evidence[0].id}`,
        )
      ).rows.length,
      1,
    );
    assert.equal(
      await channelConsent(address, "sms", "+14165550123"),
      "unknown",
    );
  },
);

test(
  "repeated inquiry synchronization deduplicates CRM effects and historical sync never admits marketing",
  { skip },
  async () => {
    process.env.MARKETING_DELIVERY_PROVIDER = "highlevel";
    process.env.HIGHLEVEL_SYNC_ENABLED = "true";
    process.env.HIGHLEVEL_MARKETING_ENABLED = "false";
    const address = email("inquiry");
    const record = await recordGeneralInquirySubmission({
      name: "Test Person",
      email: address,
      message: "A question",
      marketingConsent: false,
    });
    const job = await submissionJob(record.submissionId);
    assert.ok(job);
    const remote = {
      id: randomUUID(),
      locationId: location,
      email: address,
      customFields: [] as { id: string; value: string }[],
    };
    const calls = {
      create: 0,
      notes: 0,
      tasks: 0,
      opportunities: 0,
      workflows: 0,
    };
    const api: CrmRequest = async <T>(
      path: string,
      options: Parameters<CrmRequest>[1],
    ) => {
      let value: unknown = {};
      if (path.startsWith("/contacts/lookup"))
        value = { contacts: calls.create ? [remote] : [] };
      else if (path === "/contacts/upsert") {
        calls.create++;
        value = { contact: remote };
      } else if (path.endsWith("/notes")) {
        calls.notes++;
        value = { note: { id: "note" } };
      } else if (path.endsWith("/tasks")) {
        calls.tasks++;
        value = { task: { id: "task" } };
      } else if (path.includes("/workflow/")) {
        calls.workflows++;
        value = { succeeded: true };
      } else if (path.startsWith("/opportunities/search"))
        value = {
          opportunities: calls.opportunities
            ? [{ id: "opp", name: "Website inquiry" }]
            : [],
        };
      else if (path === "/opportunities/") {
        calls.opportunities++;
        value = { opportunity: { id: "opp" } };
      } else if (!options?.method || options.method === "GET")
        value = { contact: remote };
      return value as T;
    };
    await syncJob(job, api);
    await syncJob(job, api);
    assert.deepEqual(calls, {
      create: 1,
      notes: 1,
      tasks: 1,
      opportunities: 1,
      workflows: 0,
    });
    const history = await recordGeneralInquirySubmission({
      name: "Test Person",
      email: address,
      message: "Earlier question",
      marketingConsent: true,
    });
    process.env.HIGHLEVEL_MARKETING_ENABLED = "true";
    process.env.HIGHLEVEL_WORKFLOWS_REVIEWED = "true";
    await syncJob(
      { ...(await submissionJob(history.submissionId)), historical: true },
      api,
    );
    assert.equal(calls.workflows, 0);
    assert.equal(calls.tasks, 1);
    process.env.HIGHLEVEL_MARKETING_ENABLED = "false";
  },
);

test(
  "lost acknowledgements remain reviewable and are never blindly repeated",
  { skip },
  async () => {
    const contact = await contactFor(email("ambiguous"));
    let calls = 0;
    const key = `test-effect:${runId}`;
    const run = async () => {
      calls++;
      throw new HighLevelError("lost_ack", false, 60, true);
    };
    await assert.rejects(
      durableEffect(key, contact, "workflow", run),
      /lost_ack/,
    );
    await assert.rejects(
      durableEffect(key, contact, "workflow", run),
      /ambiguous_effect_requires_review/,
    );
    assert.equal(calls, 1);
    const rateLimited = `test-rate:${runId}`;
    await assert.rejects(
      durableEffect(rateLimited, contact, "task", async () => {
        throw new HighLevelError("rate_limited", true);
      }),
    );
    await durableEffect(rateLimited, contact, "task", async () => "success");
  },
);

test(
  "DND deliveries deduplicate and reordered clearing cannot create consent or remove a later STOP",
  { skip },
  async () => {
    const contact = await contactFor(email("dnd"));
    const base = Date.now() - 60_000;
    const blocked = {
      type: "ContactDndUpdate",
      id: contact.provider_id!,
      locationId: location,
      dateUpdated: new Date(base + 20_000).toISOString(),
      dndSettings: {
        SMS: { status: "permanent" },
        Email: { status: "active" },
      },
    };
    await persistHighLevelWebhook(blocked, `${runId}-dnd`);
    await persistHighLevelWebhook(blocked, `${runId}-dnd`);
    await persistHighLevelWebhook(
      {
        ...blocked,
        dateUpdated: new Date(base).toISOString(),
        dndSettings: {
          SMS: { status: "inactive" },
          Email: { status: "inactive" },
        },
      },
      `${runId}-stale`,
    );
    assert.equal(
      await channelConsent(contact.email_normalized, "sms", contact.phone),
      "unsubscribed",
    );
    assert.equal(
      (
        await getPrivateDb().execute(
          sql`select id from highlevel_consent_events where email_normalized = ${contact.email_normalized}`,
        )
      ).rows.length,
      2,
    );
    await persistHighLevelWebhook(
      {
        ...blocked,
        dateUpdated: new Date(base + 30_000).toISOString(),
        dndSettings: {},
      },
      `${runId}-clear`,
    );
    assert.equal(
      await channelConsent(
        contact.email_normalized,
        "email",
        contact.email_normalized,
      ),
      "unsubscribed",
    );
    await getPrivateDb().transaction((tx) =>
      recordCheckoutConsent(tx, {
        orderId: randomUUID(),
        email: contact.email_normalized,
        source: "product_checkout",
        marketing: { marketingConsent: false },
      }),
    );
    assert.equal(
      await channelConsent(
        contact.email_normalized,
        "email",
        contact.email_normalized,
      ),
      "unsubscribed",
    );
  },
);

test(
  "OAuth refresh is single-writer and a lost rotation requires reconnect",
  { skip },
  async () => {
    const db = getPrivateDb();
    await db.execute(
      sql`insert into highlevel_connections (location_id,credentials_ciphertext,expires_at,installed_by) values (${location},${encryptCredential({ access_token: "old", refresh_token: "rotate-once" }, location)},now()-interval '1 hour',${randomUUID()}::uuid)`,
    );
    let release!: (value: TokenResponse) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const response = new Promise<TokenResponse>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const refresh = async () => {
      calls++;
      started();
      return response;
    };
    const first = accessToken(refresh);
    await ready;
    await assert.rejects(accessToken(refresh), /oauth_refresh_in_progress/);
    release({
      access_token: "new",
      refresh_token: "next",
      expires_in: 3600,
      locationId: location,
      userType: "Location",
      scope: HIGHLEVEL_SCOPES.join(" "),
    });
    assert.equal(await first, "new");
    assert.equal(calls, 1);
    assert.equal(await accessToken(refresh), "new");
    await db.execute(
      sql`update highlevel_connections set expires_at = now() where location_id = ${location}`,
    );
    await assert.rejects(
      accessToken(async () => {
        throw new Error("lost rotation");
      }),
      /oauth_reinstallation_required/,
    );
    await assert.rejects(accessToken(refresh), /oauth_reinstallation_required/);
    assert.equal(calls, 1);
  },
);

test(
  "backfill dry-run writes nothing and reruns use stable historical keys",
  { skip },
  async () => {
    const db = getPrivateDb();
    const before = (await db.execute(sql`select id from highlevel_outbox`)).rows
      .length;
    await backfillHighLevel();
    assert.equal(
      (await db.execute(sql`select id from highlevel_outbox`)).rows.length,
      before,
    );
    await backfillHighLevel(true);
    const once = (
      await db.execute(
        sql`select id from highlevel_outbox where event_key like 'backfill:v1:%'`,
      )
    ).rows.length;
    await backfillHighLevel(true);
    assert.equal(
      (
        await db.execute(
          sql`select id from highlevel_outbox where event_key like 'backfill:v1:%'`,
        )
      ).rows.length,
      once,
    );
    assert.equal(
      (
        await db.execute(
          sql`select id from highlevel_outbox where event_key like 'backfill:v1:%' and historical = false`,
        )
      ).rows.length,
      0,
    );
  },
);

test(
  "popup provider ownership is immutable across cutover and uses the existing promotion dedupe",
  { skip },
  async () => {
    const address = email("offer");
    const signupOffer = {
      promotionId: "promotion",
      promotionRevision: "revision",
      promotionCode: "CODE",
      discountType: "percentage" as const,
      discountAmount: 10,
      appliesTo: "all" as const,
      offerLabel: "Test offer",
      offerTerms: "Test terms",
      ctaLabel: "Shop",
      ctaUrl: "https://example.test/products",
      resolvedAt: new Date().toISOString(),
    };
    process.env.MARKETING_DELIVERY_PROVIDER = "resend";
    const old = await recordContactPopupSubmission({
      email: address,
      variant: "emailOnly",
      marketingConsent: true,
      signupOffer,
    });
    process.env.MARKETING_DELIVERY_PROVIDER = "highlevel";
    const repeated = await recordContactPopupSubmission({
      email: address,
      variant: "emailOnly",
      marketingConsent: true,
      signupOffer,
    });
    assert.equal(repeated.offerEmailEnqueued, false);
    assert.equal(
      (
        await getPrivateDb().execute<{ delivery_provider: string }>(
          sql`select delivery_provider from customer_email_outbox where id = ${old.offerEmailJobId}::uuid`,
        )
      ).rows[0].delivery_provider,
      "resend",
    );
    const fresh = await recordContactPopupSubmission({
      email: email("offer-new"),
      variant: "emailOnly",
      marketingConsent: true,
      signupOffer,
    });
    assert.equal(
      await claimCustomerEmailById({
        id: fresh.offerEmailJobId!,
        leaseOwner: "test",
      }),
      null,
    );
    assert.equal(
      (
        await getPrivateDb().execute(
          sql`select id from highlevel_outbox where entity_type = 'delivery' and entity_id = ${fresh.offerEmailJobId}`,
        )
      ).rows.length,
      1,
    );
  },
);

test(
  "lease expiry is fenced and expected journey deferral does not exhaust retries",
  { skip },
  async () => {
    const db = getPrivateDb();
    const entityId = randomUUID();
    await enqueueCrmEvent(db, {
      entityType: "consent",
      entityId,
      eventKey: `test-lease:${runId}`,
    });
    await db.execute(
      sql`update highlevel_outbox set occurred_at = '1800-01-01' where event_key = ${`test-lease:${runId}`}`,
    );
    const [first] = await claimJobs(1);
    assert.equal(first.entity_id, entityId);
    await db.execute(
      sql`update highlevel_outbox set locked_until = now() - interval '1 minute' where id = ${first.id}::uuid`,
    );
    const [second] = await claimJobs(1);
    assert.equal(second.id, first.id);
    assert.notEqual(first.locked_by, second.locked_by);
    await finishJob(first, "succeeded");
    const state = () =>
      db.execute<{ status: string; attempts: number }>(
        sql`select status, attempts from highlevel_outbox where id = ${first.id}::uuid`,
      );
    assert.equal((await state()).rows[0].status, "processing");
    await finishJob(second, "retry", "marketing_journey_busy", 86400);
    assert.equal((await state()).rows[0].status, "retry");
    assert.equal((await state()).rows[0].attempts, 1);
    await db.execute(
      sql`delete from highlevel_outbox where id = ${first.id}::uuid`,
    );
  },
);

test(
  "a HighLevel-owned generic welcome remains durable during a marketing pause",
  { skip },
  async () => {
    process.env.MARKETING_DELIVERY_PROVIDER = "highlevel";
    process.env.HIGHLEVEL_MARKETING_ENABLED = "false";
    const address = email("paused-welcome");
    const record = await recordContactPopupSubmission({
      email: address,
      variant: "emailOnly",
      marketingConsent: true,
    });
    const job = await submissionJob(record.submissionId);
    const contact = await contactFor(address);
    const source = {
      email: address,
      source: "contact_popup",
      activityAt: new Date().toISOString(),
      marketingProvider: "highlevel",
    };
    const api: CrmRequest = async () => {
      throw new Error("paused marketing must not call workflow APIs");
    };
    await syncEffects(job, source, contact, api);
    await syncEffects(job, source, contact, api);
    const queued = await getPrivateDb().execute<CrmJob & { status: string }>(
      sql`select * from highlevel_outbox where event_key = ${`welcome:${job.entity_id}`}`,
    );
    assert.equal(queued.rows.length, 1);
    assert.equal(queued.rows[0].status, "queued");
    await assert.rejects(
      syncEffects(queued.rows[0], source, contact, api),
      /marketing_paused/,
    );
  },
);

test(
  "workflow cancellation is recorded only after the provider confirms removal",
  { skip },
  async () => {
    const contact = await contactFor(email("cancel"));
    const key = `cancel:${runId}`;
    await durableEffect(key, contact, "workflow", async () => "workflow", {
      journey: "inquiry",
      workflow: "workflow",
    });
    const result = () =>
      getPrivateDb().execute<{ state: string }>(
        sql`select state from highlevel_effects where key = ${key}`,
      );
    const unconfirmed: CrmRequest = async <T>() => ({ succeeded: false }) as T;
    await assert.rejects(
      stopJourneys(contact, unconfirmed),
      /workflow_removal_unconfirmed/,
    );
    assert.equal((await result()).rows[0].state, "succeeded");
    const confirmed: CrmRequest = async <T>() => ({ succeeded: true }) as T;
    await stopJourneys(contact, confirmed);
    assert.equal((await result()).rows[0].state, "cancelled");
  },
);
