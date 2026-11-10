import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import test, { after, type TestContext } from "node:test";
import { sql } from "drizzle-orm";
import { getPrivateDb, closePrivateDbPool } from "@/lib/private-db/client";
import {
  recordGeneralInquirySubmission,
  recordContactPopupSubmission,
  recordCourseSignupSubmission,
  recordInternalUnsubscribe,
} from "@/lib/marketing-contact/marketing-contact-store";
import { claimCustomerEmailById } from "@/lib/commerce/customer-email-outbox";
import { recordCheckoutConsent } from "./checkout-consent";
import {
  channelConsent,
  claimJobs,
  enqueueCrmEvent,
  finishJob,
  loadSource,
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
import type { ProviderContact } from "./identity";

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
    await db.execute(
      sql`delete from product_shipments where order_id in (select id from checkout_orders where lower(customer_email) like ${`hl-${runId}-%`})`,
    );
    await db.execute(
      sql`delete from checkout_orders where lower(customer_email) like ${`hl-${runId}-%`}`,
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

for (const marketingConsent of [false, true]) {
  test(
    `course signup reaches CRM with profile and Instagram, marketing consent ${marketingConsent}`,
    { skip },
    async (t) => {
      const previous = process.env.HIGHLEVEL_MARKETING_ENABLED;
      process.env.HIGHLEVEL_MARKETING_ENABLED = "false";
      t.after(() => {
        if (previous === undefined)
          delete process.env.HIGHLEVEL_MARKETING_ENABLED;
        else process.env.HIGHLEVEL_MARKETING_ENABLED = previous;
      });
      const address = email(`course-${marketingConsent}`);
      const input = {
        name: "Course Learner",
        email: address,
        phone: marketingConsent ? "+14165550131" : "+14165550130",
        instagram: "@course.learner",
        courseId: "free-mini-course",
        courseTitle: "Free Mini Course",
        sourcePath: "/courses/free-mini-course",
        marketingConsent,
        smsMarketingConsent: false,
      };
      const saved = await recordCourseSignupSubmission(input);
      const job = await submissionJob(saved.submissionId);
      assert.ok(
        job,
        "the submission trigger must enqueue without marketing consent",
      );
      assert.equal((await loadSource(job))?.instagram, input.instagram);
      let remote: ProviderContact | undefined;
      let creates = 0;
      const notes: string[] = [];
      const tags: string[] = [];
      const api: CrmRequest = async <T>(
        path: string,
        options?: Parameters<CrmRequest>[1],
      ) => {
        if (path.startsWith("/contacts/lookup?"))
          return { contacts: remote ? [remote] : [] } as T;
        if (path === "/contacts/upsert") {
          creates++;
          remote = {
            id: randomUUID(),
            locationId: location,
            ...(options?.body as object),
          } as ProviderContact;
          return { contact: remote } as T;
        }
        if (path === `/contacts/${remote?.id}/notes`) {
          notes.push((options?.body as { body: string }).body);
          return { note: { id: randomUUID() } } as T;
        }
        if (path === `/contacts/${remote?.id}/tags`) {
          tags.push(...(options?.body as { tags: string[] }).tags);
          return {} as T;
        }
        if (path === `/contacts/${remote?.id}`) {
          if (options?.method === "PUT") Object.assign(remote!, options.body);
          return { contact: remote } as T;
        }
        throw new Error(`Unexpected CRM operation: ${path}`);
      };
      await syncJob(job, api);
      await syncJob(job, api);
      assert.equal(creates, 1);
      assert.equal(remote?.name, input.name);
      assert.equal(remote?.email, address);
      assert.equal(remote?.phone, input.phone);
      assert.ok(tags.includes("lh:source:course_signup"));
      assert.equal(notes.length, 1);
      assert.ok(notes[0].includes(input.courseTitle));
      assert.ok(notes[0].includes(input.sourcePath));
      assert.ok(notes[0].includes(`Instagram: ${input.instagram}`));
      const fields = remote?.customFields as unknown as {
        id: string;
        fieldValue: string;
      }[];
      assert.equal(
        fields.find((f) => f.id === "email_eligible")?.fieldValue,
        marketingConsent ? "yes" : "no",
      );
      assert.equal(
        fields.find((f) => f.id === "sms_eligible")?.fieldValue,
        "no",
      );
    },
  );
}

test(
  "course-only recovery is idempotent, preserves withdrawals and checks conflicts across sources",
  { skip },
  async () => {
    const courseInput = {
      name: "Historical Learner",
      email: email("course-backfill"),
      phone: "+14165550132",
      courseId: "free-mini-course",
      courseTitle: "Free Mini Course",
      sourcePath: "/courses/free-mini-course",
      marketingConsent: true,
    };
    const course = await recordCourseSignupSubmission(courseInput);
    const other = await recordGeneralInquirySubmission({
      name: "Other Person",
      email: email("non-course-backfill"),
      message: "Question",
      marketingConsent: true,
    });
    await recordInternalUnsubscribe({
      email: courseInput.email,
      reason: "test-withdrawal",
    });
    const conflict = await recordCourseSignupSubmission({
      ...courseInput,
      email: email("course-conflict"),
      phone: "+14165550133",
    });
    await recordGeneralInquirySubmission({
      name: "Different Person",
      email: email("non-course-conflict"),
      phone: "+14165550133",
      message: "Question",
      marketingConsent: false,
    });
    const db = getPrivateDb();
    const key = `backfill:v1:submission:${course.submissionId}`;
    await db.execute(
      sql`delete from highlevel_consent_events where email_normalized = ${courseInput.email}`,
    );
    await backfillHighLevel(false, "course_signup");
    assert.equal(
      (
        await db.execute(
          sql`select id from highlevel_outbox where event_key = ${key}`,
        )
      ).rows.length,
      0,
    );
    await backfillHighLevel(true, "course_signup");
    await backfillHighLevel(true, "course_signup");
    const jobs = await db.execute<{ entity_id: string; historical: boolean }>(
      sql`select entity_id, historical from highlevel_outbox where event_key in (${key}, ${`backfill:v1:submission:${other.submissionId}`}, ${`backfill:v1:submission:${conflict.submissionId}`})`,
    );
    assert.deepEqual(jobs.rows, [
      { entity_id: course.submissionId, historical: true },
    ]);
    assert.equal(
      await channelConsent(courseInput.email, "email", courseInput.email),
      "unsubscribed",
    );
    assert.equal(
      await channelConsent(courseInput.email, "sms", courseInput.phone),
      "unknown",
    );
  },
);
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

async function consentJob(
  address: string,
  channel: "email" | "sms",
  choice: "opted_in" | "unsubscribed",
): Promise<CrmJob> {
  const db = getPrivateDb();
  const event = (
    await db.execute<{ id: string }>(sql`
    insert into highlevel_consent_events (origin_key,email_normalized,channel,destination,choice,source,occurred_at)
    values (${randomUUID()},${address},${channel},${channel === "email" ? address : "+14165550123"},${choice},'test',now())
    returning id`)
  ).rows[0];
  return (
    await db.execute<CrmJob>(
      sql`select * from highlevel_outbox where entity_type = 'consent' and entity_id = ${event.id}`,
    )
  ).rows[0];
}

test(
  "mapped email-only contacts cannot acquire another CRM contact's phone",
  { skip },
  async () => {
    for (const otherEmail of [undefined, email("phone-owner")]) {
      const address = email(`mapped-phone-${otherEmail ? "named" : "unnamed"}`);
      const saved = await recordCourseSignupSubmission({
        email: address,
        name: "Course Learner",
        phone: "+14165550123",
        courseId: "free-mini-course",
        courseTitle: "Free Mini Course",
        sourcePath: "/courses/free-mini-course",
        marketingConsent: false,
        smsMarketingConsent: false,
      });
      const mapped = await contactFor(address);
      let lookups = 0;
      let writes = 0;
      const api: CrmRequest = async <T>(
        path: string,
        options?: Parameters<CrmRequest>[1],
      ) => {
        if (options?.method) writes++;
        if (path === `/contacts/${mapped.provider_id}`)
          return {
            contact: {
              id: mapped.provider_id,
              locationId: location,
              email: address,
            },
          } as T;
        if (path.startsWith("/contacts/lookup?")) {
          assert.equal(
            new URL(`https://crm.test${path}`).searchParams.get("phone"),
            "+14165550123",
          );
          lookups++;
          return {
            contacts: [
              {
                id: "different-contact",
                locationId: location,
                phone: "+14165550123",
                email: otherEmail,
              },
            ],
          } as T;
        }
        throw new Error("Unexpected CRM operation");
      };
      await assert.rejects(
        syncJob(await submissionJob(saved.submissionId), api),
        /identity_conflict/,
      );
      assert.equal(lookups, 1);
      assert.equal(writes, 0);
    }
  },
);

test(
  "email withdrawal survives a mapped contact's missing-phone ownership conflict",
  { skip },
  async () => {
    const address = email("missing-phone-withdrawal");
    const mapped = await contactFor(address);
    const job = await consentJob(address, "email", "unsubscribed");
    const writes: unknown[] = [];
    const api: CrmRequest = async <T>(
      path: string,
      options?: Parameters<CrmRequest>[1],
    ) => {
      if (options?.method) writes.push(options.body);
      if (path.startsWith("/contacts/lookup?"))
        return {
          contacts: [
            {
              id: "other-contact",
              locationId: location,
              phone: mapped.phone,
              email: email("other-owner"),
            },
          ],
        } as T;
      return {
        contact: {
          id: mapped.provider_id,
          locationId: location,
          email: address,
        },
      } as T;
    };
    await assert.rejects(syncJob(job, api), /identity_conflict/);
    assert.deepEqual(writes, [
      {
        customFields: [{ id: "email_eligible", fieldValue: "no" }],
        dndSettings: {
          email: { status: "active", message: "lh:website-withdrawal" },
        },
      },
    ]);
  },
);

test(
  "email withdrawal survives a phone conflict without relaxing identity review",
  { skip },
  async () => {
    for (const mismatch of [
      "phone",
      "email",
      "location",
      "missing-email",
      "provider-id",
    ] as const) {
      const address = email(`withdrawal-${mismatch}`);
      const contact = await contactFor(address);
      const job = await consentJob(address, "email", "unsubscribed");
      const remote: ProviderContact = {
        id: mismatch === "provider-id" ? randomUUID() : contact.provider_id!,
        locationId: mismatch === "location" ? "wrong-location" : location,
        email:
          mismatch === "missing-email"
            ? undefined
            : mismatch === "email"
              ? email("other")
              : address,
        phone: "+16475550124",
      };
      const writes: unknown[] = [];
      const api: CrmRequest = async <T>(
        _path: string,
        options?: Parameters<CrmRequest>[1],
      ) => {
        if (options?.method) writes.push(options.body);
        return { contact: remote } as T;
      };
      await assert.rejects(
        syncJob(job, api),
        /phone_changed_in_crm|identity_changed_in_crm|provider_tenant_mismatch/,
      );
      assert.deepEqual(
        writes,
        mismatch === "phone"
          ? [
              {
                customFields: [{ id: "email_eligible", fieldValue: "no" }],
                dndSettings: {
                  email: { status: "active", message: "lh:website-withdrawal" },
                },
              },
            ]
          : [],
      );
      assert.equal(
        (
          await getPrivateDb().execute<{ phone: string }>(
            sql`select phone from highlevel_contacts where id = ${contact.id}::uuid`,
          )
        ).rows[0].phone,
        contact.phone,
      );
    }
  },
);

test(
  "a failed conflict-path suppression remains retryable",
  { skip },
  async () => {
    const address = email("withdrawal-retry");
    const contact = await contactFor(address);
    const job = await consentJob(address, "email", "unsubscribed");
    const api: CrmRequest = async <T>(
      _path: string,
      options?: Parameters<CrmRequest>[1],
    ) => {
      if (options?.method) throw new HighLevelError("highlevel_http_429", true);
      return {
        contact: {
          id: contact.provider_id,
          locationId: location,
          email: address,
          phone: "+16475550124",
        },
      } as T;
    };
    await assert.rejects(
      syncJob(job, api),
      (error: unknown) => error instanceof HighLevelError && error.retryable,
    );
  },
);

for (const channel of ["email", "sms"] as const) {
  test(
    `${channel} withdrawal preserves a concurrent block on another channel`,
    { skip },
    async () => {
      const address = email(`channel-race-${channel}`);
      const contact = await contactFor(address);
      const other = channel === "email" ? "sms" : "email";
      await consentJob(address, other, "opted_in");
      const job = await consentJob(address, channel, "unsubscribed");
      const providerState: Record<string, { status: string }> = {};
      let patch: unknown;
      const api: CrmRequest = async <T>(
        _path: string,
        options?: Parameters<CrmRequest>[1],
      ) => {
        if (!options?.method) {
          const snapshot = {
            id: contact.provider_id,
            locationId: location,
            email: address,
            phone: contact.phone,
            dndSettings: {
              email: { status: "inactive" },
              sms: { status: "inactive" },
              call: { status: "inactive" },
            },
          };
          providerState[other] = { status: "permanent" }; // STOP after GET, before PUT.
          return { contact: snapshot } as T;
        }
        if (options.method === "PUT") {
          patch = (options.body as { dndSettings?: unknown }).dndSettings;
          Object.assign(providerState, patch);
        }
        return { succeeded: true } as T;
      };
      await syncJob(job, api);
      assert.deepEqual(patch, {
        [channel]: { status: "active", message: "lh:website-withdrawal" },
      });
      assert.equal(providerState[other].status, "permanent");
    },
  );
}

for (const retainedPurpose of [
  "submission",
  "consent",
  "order",
  "enrollment",
  "none",
] as const) {
  test(
    `source retention preserves the remaining ${retainedPurpose} purpose`,
    { skip },
    async () => {
      const db = getPrivateDb();
      const address = email(`retention-${retainedPurpose}`);
      const contact = await contactFor(address);
      const old = await recordGeneralInquirySubmission({
        email: address,
        name: "Old Person",
        message: "Expired",
        sourcePath: "/expired",
        marketingConsent: false,
      });
      await db.execute(
        sql`update marketing_contact_submissions set submitted_at = now() - interval '400 days' where id = ${old.submissionId}::uuid`,
      );
      let currentId: string | undefined;
      if (retainedPurpose === "submission") {
        const current = await recordGeneralInquirySubmission({
          email: address,
          name: "Current Person",
          message: "Retained",
          sourcePath: "/current",
          marketingConsent: true,
        });
        currentId = current.submissionId;
      } else if (retainedPurpose !== "none")
        await consentJob(address, "email", "opted_in");
      if (retainedPurpose === "order" || retainedPurpose === "enrollment") {
        const purpose = retainedPurpose === "order" ? "product" : "training";
        const order = (
          await db.execute<{ id: string }>(sql`
          insert into checkout_orders (order_id,purpose,status,customer_name,customer_email,amount_cents,line_items,manual_fulfillment_status)
          values (${randomUUID()},${purpose},'paid','Retained Buyer',${address},1000,${JSON.stringify([{ description: "Retained product" }])}::jsonb,${retainedPurpose === "order" ? "dispatched" : null})
          returning id`)
        ).rows[0];
        if (retainedPurpose === "enrollment")
          await db.execute(sql`insert into training_enrollments (checkout_order_id,program_snapshot,product_snapshot,checkout_email)
            values (${order.id}::uuid,'{"slug":"retained-program"}'::jsonb,'{}'::jsonb,${address})`);
      }
      await db.execute(sql`insert into highlevel_effects (key,contact_id,kind,state,provider_id) values
      (${`entity:submission:${old.submissionId}`},${contact.id}::uuid,'entity','recorded',null),
      (${`note:${old.submissionId}`},${contact.id}::uuid,'note','succeeded','expired-note')`);
      const oldJourney = `journey:inquiry:submission:${old.submissionId}`;
      const currentJourney = `journey:course:submission:${currentId ?? randomUUID()}`;
      await durableEffect(
        oldJourney,
        contact,
        "workflow",
        async () => "expired-workflow",
        { journey: "inquiry", workflow: "expired-workflow" },
      );
      await durableEffect(
        currentJourney,
        contact,
        "workflow",
        async () => "current-workflow",
        { journey: "course", workflow: "current-workflow" },
      );
      await db.execute(
        sql`update marketing_contact_submissions set email = '[redacted]', name = null, phone = null, source_path = null, payload = '{}'::jsonb where id = ${old.submissionId}::uuid`,
      );
      const job = await submissionJob(old.submissionId);
      const fields: Record<string, unknown> = {
        original_source: "expired-source",
        original_path: "/expired",
        journey_key: currentJourney,
      };
      const deleted: string[] = [];
      const api: CrmRequest = async <T>(
        path: string,
        options?: Parameters<CrmRequest>[1],
      ) => {
        if (!options?.method)
          return {
            contact: {
              id: contact.provider_id,
              locationId: location,
              email: address,
              phone: contact.phone,
              customFields: Object.entries(fields).map(([id, value]) => ({
                id,
                value,
              })),
            },
          } as T;
        if (options.method === "DELETE") deleted.push(path);
        if (options.method === "PUT")
          for (const field of (
            options.body as {
              customFields: { id: string; fieldValue: unknown }[];
            }
          ).customFields)
            fields[field.id] = field.fieldValue;
        assert.ok(
          !(
            options.method === "POST" && /\/(notes|tasks|workflow)\b/.test(path)
          ),
          "retention must not replay admissions or notes",
        );
        return { succeeded: true } as T;
      };
      if (retainedPurpose === "none")
        await assert.rejects(
          syncJob(job, api),
          /crm_retention_review_required/,
        );
      else assert.equal(await syncJob(job, api), "skipped");
      assert.ok(
        deleted.includes(`/contacts/${contact.provider_id}/notes/expired-note`),
      );
      assert.ok(
        deleted.includes(
          `/contacts/${contact.provider_id}/workflow/expired-workflow`,
        ),
      );
      assert.equal(
        deleted.includes(
          `/contacts/${contact.provider_id}/workflow/current-workflow`,
        ),
        retainedPurpose === "none",
      );
      assert.equal(
        fields.email_eligible,
        retainedPurpose === "none" ? "no" : "yes",
      );
      assert.equal(
        fields.original_path,
        retainedPurpose === "submission" ? "/current" : "",
      );
      assert.equal(
        fields.source_path,
        retainedPurpose === "submission" ? "/current" : "",
      );
      assert.equal(
        fields.source,
        retainedPurpose === "submission"
          ? "general_inquiry"
          : retainedPurpose === "order"
            ? "product"
            : retainedPurpose === "enrollment"
              ? "training"
              : retainedPurpose === "consent"
                ? "consent"
                : "",
      );
      if (retainedPurpose === "order" || retainedPurpose === "enrollment")
        assert.match(String(fields.lifecycle), /:paid/);
      if (retainedPurpose !== "none")
        assert.equal(fields.journey_key, currentJourney);
    },
  );
}

test("the historical backfill CLI runs a read-only inventory", { skip }, () => {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "./scripts/register-server-only-test.mjs",
      "--import",
      "tsx",
      "scripts/highlevel-backfill.ts",
      "--dry-run",
    ],
    { encoding: "utf8", env: { ...process.env, DATABASE_URL: databaseUrl! } },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).mode, "dry-run");
});

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

function enableLifecycleMarketing(t: TestContext) {
  const values = {
    MARKETING_DELIVERY_PROVIDER: "highlevel",
    HIGHLEVEL_SYNC_ENABLED: "true",
    HIGHLEVEL_MARKETING_ENABLED: "true",
    HIGHLEVEL_WORKFLOWS_REVIEWED: "true",
    HIGHLEVEL_WORKFLOW_PURCHASE_ID: "purchase-workflow",
    HIGHLEVEL_TRAINING_PIPELINE_ID: "training-pipeline",
    HIGHLEVEL_TRAINING_STAGE_ID: "new",
  };
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function lifecycleApi(contact: CrmContact) {
  const calls: { path: string; options: Parameters<CrmRequest>[1] }[] = [];
  const api: CrmRequest = async <T>(
    path: string,
    options: Parameters<CrmRequest>[1],
  ) => {
    calls.push({ path, options });
    let response: unknown = { succeeded: true };
    if (path.startsWith("/opportunities/search"))
      response = { opportunities: [] };
    else if (path === "/opportunities/")
      response = { opportunity: { id: "new-opportunity" } };
    else if (path.startsWith("/opportunities/"))
      response = {
        opportunity: {
          status: "open",
          contactId: contact.provider_id,
          pipelineId: "training-pipeline",
          pipelineStageId: "new",
        },
      };
    else if (path.endsWith("/notes")) response = { note: { id: "note" } };
    else if (path.endsWith("/tasks")) response = { task: { id: "task" } };
    else if (!options?.method)
      response = {
        contact: {
          id: contact.provider_id,
          locationId: location,
          email: contact.email_normalized,
          phone: contact.phone,
          customFields: [],
        },
      };
    return response as T;
  };
  return { api, calls };
}

test(
  "delayed sales admissions respect payment time and allow genuinely new inquiries",
  { skip },
  async (t) => {
    enableLifecycleMarketing(t);
    const db = getPrivateDb();
    const now = Date.now();
    const hoursAgo = (hours: number) => new Date(now - hours * 3_600_000);
    for (const scenario of [
      {
        label: "later-payment",
        status: "paid",
        inquiryHours: 48,
        paidAt: hoursAgo(24),
        createdAt: hoursAgo(72),
        admit: false,
      },
      {
        label: "same-time-payment",
        status: "paid",
        inquiryHours: 24,
        paidAt: hoursAgo(24),
        createdAt: hoursAgo(72),
        admit: false,
      },
      {
        label: "new-inquiry",
        status: "paid",
        inquiryHours: 12,
        paidAt: hoursAgo(24),
        createdAt: hoursAgo(72),
        admit: true,
      },
      {
        label: "pending",
        status: "pending",
        inquiryHours: 48,
        paidAt: null,
        createdAt: hoursAgo(24),
        admit: true,
      },
      {
        label: "failed",
        status: "verification_failed",
        inquiryHours: 48,
        paidAt: null,
        createdAt: hoursAgo(24),
        admit: true,
      },
      {
        label: "refunded",
        status: "refunded",
        inquiryHours: 48,
        paidAt: hoursAgo(24),
        createdAt: hoursAgo(72),
        admit: false,
      },
      {
        label: "legacy-paid",
        status: "paid",
        inquiryHours: 48,
        paidAt: null,
        createdAt: hoursAgo(24),
        admit: false,
      },
    ]) {
      const address = email(scenario.label);
      const record = await recordGeneralInquirySubmission({
        email: address,
        name: "Test Person",
        message: "Question",
        marketingConsent: true,
        submittedAt: hoursAgo(scenario.inquiryHours),
      });
      const contact = await contactFor(address);
      const { api, calls } = lifecycleApi(contact);
      const order = (
        await db.execute<{ id: string }>(sql`
      insert into checkout_orders (order_id,purpose,status,customer_name,customer_email,amount_cents,line_items,manual_fulfillment_status,paid_at,created_at,updated_at,pii_redaction_due_at)
      values (${randomUUID()},'product',${scenario.status},'Buyer',${address.toUpperCase()},1000,'[]'::jsonb,'paid_pending_dispatch',${scenario.paidAt},${scenario.createdAt},now(),${new Date(scenario.createdAt.getTime() + 364 * 86_400_000)}) returning id
    `)
      ).rows[0];
      const orderJob = (
        await db.execute<CrmJob>(
          sql`select * from highlevel_outbox where entity_type = 'order' and entity_id = ${order.id}`,
        )
      ).rows[0];
      await syncJob(orderJob, api);
      calls.length = 0;
      const job = await submissionJob(record.submissionId);
      await syncJob(job, api);
      await syncJob(job, api);
      assert.equal(
        calls.filter(
          (call) =>
            call.path.includes("/workflow/") && call.options?.method === "POST",
        ).length,
        scenario.admit ? 1 : 0,
        scenario.label,
      );
      assert.equal(
        calls.filter(
          (call) =>
            call.path.endsWith("/notes") && call.options?.method === "POST",
        ).length,
        1,
        "inquiry history is preserved",
      );
      assert.equal(
        calls.filter(
          (call) =>
            call.path.endsWith("/tasks") && call.options?.method === "POST",
        ).length,
        1,
        "staff follow-up remains independent of nurture",
      );
    }
  },
);

test(
  "historical commerce cannot stop newer journeys or close opportunities but still applies current withdrawal",
  { skip },
  async (t) => {
    enableLifecycleMarketing(t);
    const db = getPrivateDb();
    for (const scenario of [
      { status: "paid", withdrawal: false },
      { status: "refunded", withdrawal: false },
      { status: "cancelled", withdrawal: false },
      { status: "paid", withdrawal: true },
    ]) {
      const address = email(
        `historical-${scenario.status}-${scenario.withdrawal}`,
      );
      const contact = await contactFor(address);
      await consentJob(
        address,
        "email",
        scenario.withdrawal ? "unsubscribed" : "opted_in",
      );
      const key = `journey:inquiry:${contact.id}:current`;
      await durableEffect(
        key,
        contact,
        "workflow",
        async () => "inquiry-workflow",
        { journey: "inquiry", workflow: "inquiry-workflow" },
      );
      await durableEffect(
        `opportunity:${contact.id}:current`,
        contact,
        "opportunity",
        async () => "current-opportunity",
        { interest: "test-program", pipeline: "training-pipeline" },
      );
      const order = (
        await db.execute<{ id: string }>(sql`
      insert into checkout_orders (order_id,purpose,status,customer_name,customer_email,amount_cents,line_items,paid_at,created_at,updated_at,pii_redaction_due_at)
      values (${randomUUID()},'training',${scenario.status},'Buyer',${address},1000,'[{"description":"test-program"}]'::jsonb,now()-interval '20 days',now()-interval '20 days',now()-interval '20 days',now()+interval '344 days') returning id
    `)
      ).rows[0];
      const job = (
        await db.execute<CrmJob>(
          sql`select * from highlevel_outbox where entity_type = 'order' and entity_id = ${order.id}`,
        )
      ).rows[0];
      const { api, calls } = lifecycleApi(contact);
      await syncJob({ ...job, historical: true }, api);
      assert.equal(
        calls.some(
          (call) =>
            call.path.includes("/workflow/") &&
            call.options?.method === "DELETE",
        ),
        scenario.withdrawal,
        scenario.status,
      );
      assert.equal(
        calls.some((call) => call.path.startsWith("/opportunities/")),
        false,
        "historical purchases cannot close current deals",
      );
      assert.equal(
        calls.some(
          (call) =>
            call.path.includes("/workflow/") && call.options?.method === "POST",
        ),
        false,
      );
      const fields = calls.flatMap(
        (call) =>
          (
            call.options?.body as
              | { customFields?: { id: string; fieldValue: string }[] }
              | undefined
          )?.customFields ?? [],
      );
      assert.equal(
        fields.find((field) => field.id === "email_eligible")?.fieldValue,
        scenario.withdrawal ? "no" : "yes",
      );
      if (!scenario.withdrawal) {
        calls.length = 0;
        await syncJob({ ...job, historical: false }, api);
        assert.ok(
          calls.some(
            (call) =>
              call.path.includes("/workflow/") &&
              call.options?.method === "DELETE",
          ),
          "live lifecycle stops remain operational",
        );
        assert.equal(
          calls.some(
            (call) =>
              call.path === "/opportunities/current-opportunity" &&
              call.options?.method === "PUT",
          ),
          scenario.status === "paid",
          "live matching training conversion still closes the deal",
        );
      }
    }
  },
);

test(
  "carrier handoff starts post-purchase once while labels and unpaid orders remain ineligible",
  { skip },
  async (t) => {
    enableLifecycleMarketing(t);
    const db = getPrivateDb();
    const address = email("carrier-handoff");
    const contact = await contactFor(address);
    await consentJob(address, "email", "opted_in");
    const order = (
      await db.execute<{ id: string }>(sql`
    insert into checkout_orders (order_id,purpose,status,customer_name,customer_email,amount_cents,line_items)
    values (${randomUUID()},'product','paid','Buyer',${address},1000,'[]'::jsonb) returning id
  `)
    ).rows[0];
    const shipment = (
      await db.execute<{ id: string }>(sql`
    insert into product_shipments (order_id,public_reference,quote_token_hash,quote_fingerprint,status,destination,package_snapshot,customs_lines,rates,quote_expires_at)
    values (${order.id}::uuid,${randomUUID()},${randomUUID()},${randomUUID()},'label_ready','{}'::jsonb,'{}'::jsonb,'[]'::jsonb,'[]'::jsonb,now()+interval '1 day') returning id
  `)
    ).rows[0];
    await db.execute(
      sql`update checkout_orders set active_fulfillment_shipment_id = ${shipment.id}::uuid where id = ${order.id}::uuid`,
    );
    const { api, calls } = lifecycleApi(contact);
    for (const status of [
      "label_ready",
      "accepted",
      "in_transit",
      "delivered",
    ]) {
      await db.execute(
        sql`update product_shipments set status = ${status}, accepted_at = ${status === "label_ready" ? null : new Date()} where id = ${shipment.id}::uuid`,
      );
      const job = (
        await db.execute<CrmJob>(
          sql`select * from highlevel_outbox where entity_type = 'order' and entity_id = ${order.id} order by created_at limit 1`,
        )
      ).rows[0];
      assert.equal(
        (await loadSource(job))?.fulfilled,
        status !== "label_ready",
        status,
      );
      await syncJob(job, api);
      assert.equal(
        calls.filter(
          (call) =>
            call.path.includes("/workflow/") && call.options?.method === "POST",
        ).length,
        status === "label_ready" ? 0 : 1,
        "shipment progression must not duplicate purchase admission",
      );
    }
    await db.execute(
      sql`update checkout_orders set status = 'pending' where id = ${order.id}::uuid`,
    );
    assert.equal(
      (await loadSource({ entity_type: "order", entity_id: order.id }))
        ?.fulfilled,
      false,
      "carrier status cannot substitute for payment",
    );
    await db.execute(
      sql`update checkout_orders set status = 'paid', active_fulfillment_shipment_id = null, manual_fulfillment_status = 'dispatched' where id = ${order.id}::uuid`,
    );
    assert.equal(
      (await loadSource({ entity_type: "order", entity_id: order.id }))
        ?.fulfilled,
      true,
      "manual dispatch remains eligible",
    );
  },
);
