import "server-only";
import { crmMarketingEnabled } from "./config";
import { erasedIdentityKey } from "./crypto";
import { HighLevelError } from "./contract";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { getPrivateDb } from "@/lib/private-db/client";
import {
  CONSENT_VERSION,
  normalizeEmail,
  normalizePhone,
  SMS_CONSENT_TEXT,
  type Channel,
  type CrmEntityType,
} from "./contract";

export type CrmDb =
  | ReturnType<typeof getPrivateDb>
  | Parameters<
      Parameters<ReturnType<typeof getPrivateDb>["transaction"]>[0]
    >[0];
export interface CrmJob extends Record<string, unknown> {
  id: string;
  entity_type: CrmEntityType;
  entity_id: string;
  event_type: string;
  historical: boolean;
  attempts: number;
  occurred_at: Date;
  locked_by: string;
}
export interface CrmSource {
  email: string;
  name?: string;
  phone?: string;
  source: string;
  sourcePath?: string;
  message?: string;
  interest?: string;
  lifecycle?: string;
  activityAt: string;
  offer?: string;
  marketingProvider?: string;
  orderId?: string;
  fulfilled?: boolean;
  refunded?: boolean;
}
export interface CrmContact extends Record<string, unknown> {
  id: string;
  provider_id: string | null;
  email_normalized: string;
  phone: string | null;
  deleted_at: Date | null;
  provider_email_blocked: boolean;
  provider_sms_blocked: boolean;
}

export async function recordSmsChoice(
  tx: CrmDb,
  input: {
    email: string;
    phone?: string;
    optedIn?: boolean;
    source: string;
    originKey: string;
    occurredAt: Date;
  },
): Promise<void> {
  const phone = normalizePhone(input.phone);
  if (!phone) return;
  await tx.execute(sql`insert into highlevel_consent_events (origin_key, email_normalized, channel, destination, choice, consent_text, consent_version, source, occurred_at)
    values (${input.originKey}, ${normalizeEmail(input.email)}, 'sms', ${phone}, ${input.optedIn === true ? "opted_in" : "not_opted_in"}, ${SMS_CONSENT_TEXT}, ${CONSENT_VERSION}, ${input.source}, ${input.occurredAt}) on conflict (origin_key) do nothing`);
}

export async function enqueueCrmEvent(
  tx: CrmDb,
  input: {
    entityType: CrmEntityType;
    entityId: string;
    eventKey: string;
    historical?: boolean;
    eventType?: string;
  },
): Promise<void> {
  await tx.execute(
    sql`insert into highlevel_outbox (event_key, entity_type, entity_id, event_type, historical) values (${input.eventKey}, ${input.entityType}, ${input.entityId}, ${input.eventType ?? `${input.entityType}_changed`}, ${input.historical ?? false}) on conflict (event_key) do nothing`,
  );
}

export async function claimJobs(limit = 10): Promise<CrmJob[]> {
  const owner = randomUUID();
  return (
    await getPrivateDb().execute<CrmJob>(sql`with due as (
    select id from highlevel_outbox where ((status in ('queued','retry') and next_run_at <= now()) or (status = 'processing' and locked_until < now())) and (${crmMarketingEnabled()} or (entity_type <> 'delivery' and event_type <> 'welcome_requested'))
    order by case when entity_type = 'consent' then 0 else 1 end, occurred_at, id for update skip locked limit ${limit}
  ) update highlevel_outbox j set status = 'processing', locked_by = ${owner}, locked_until = now() + interval '5 minutes', attempts = attempts + 1 from due where j.id = due.id returning j.*`)
  ).rows;
}

export async function finishJob(
  job: CrmJob,
  status: "succeeded" | "skipped" | "retry" | "review" | "dead_letter",
  error: string | null = null,
  delay = 60,
): Promise<void> {
  await getPrivateDb().execute(
    sql`update highlevel_outbox set attempts = case when ${error} in ('marketing_journey_busy', 'marketing_paused') then greatest(attempts - 1, 0) else attempts end, status = ${status}, last_error = ${error}, next_run_at = now() + (${delay} * interval '1 second'), completed_at = ${status === "succeeded" || status === "skipped" ? new Date() : null}, locked_by = null, locked_until = null where id = ${job.id}::uuid and status = 'processing' and locked_by = ${job.locked_by}`,
  );
}

export async function loadSource(
  job: Pick<CrmJob, "entity_type" | "entity_id">,
  db: CrmDb = getPrivateDb(),
): Promise<CrmSource | null> {
  const id = job.entity_id;
  if (job.entity_type === "submission") {
    const result = await db.execute<{
      email: string;
      name: string;
      phone: string;
      source: string;
      source_path: string;
      submitted_at: Date;
      payload: {
        message?: string;
        programSlug?: string;
        programTitle?: string;
        courseTitle?: string;
        marketingProvider?: string;
        offerPromotionId?: string;
      };
    }>(
      sql`select email, name, phone, source, source_path, submitted_at, payload from marketing_contact_submissions where id = ${id}::uuid`,
    );
    const row = result.rows[0];
    return row
      ? {
          email: row.email,
          name: row.name,
          phone: row.phone,
          source: row.source,
          sourcePath: row.source_path,
          message:
            row.source === "general_inquiry"
              ? row.payload.message?.slice(0, 4000)
              : undefined,
          interest:
            row.payload.programSlug ??
            row.payload.programTitle ??
            row.payload.courseTitle,
          activityAt: new Date(row.submitted_at).toISOString(),
          marketingProvider: row.payload.marketingProvider,
          offer: row.payload.offerPromotionId,
        }
      : null;
  }
  if (job.entity_type === "delivery") {
    const row = (
      await db.execute<{ submission_id: string }>(
        sql`select submission_id from customer_email_outbox where id = ${id}::uuid and delivery_provider = 'highlevel' and redacted_at is null and redaction_due_at > now() and status <> 'dead_letter'`,
      )
    ).rows[0];
    return row
      ? loadSource(
          { entity_type: "submission", entity_id: row.submission_id },
          db,
        )
      : null;
  }
  if (job.entity_type === "consent") {
    const result = await db.execute<{
      email_normalized: string;
      occurred_at: Date;
      destination: string;
      channel: Channel;
    }>(
      sql`select email_normalized, occurred_at, destination, channel from highlevel_consent_events where id = ${id}::uuid`,
    );
    const row = result.rows[0];
    return row
      ? {
          email: row.email_normalized,
          phone: row.channel === "sms" ? row.destination : undefined,
          source: "consent",
          activityAt: new Date(row.occurred_at).toISOString(),
        }
      : null;
  }
  if (job.entity_type === "contact") {
    const result = await db.execute<{
      email_normalized: string;
      phone: string;
      updated_at: Date;
    }>(
      sql`select email_normalized, phone, updated_at from highlevel_contacts where id = ${id}::uuid`,
    );
    const row = result.rows[0];
    return row
      ? {
          email: row.email_normalized,
          phone: row.phone,
          source: "contact",
          activityAt: new Date(row.updated_at).toISOString(),
        }
      : null;
  }
  const result = await db.execute<{
    email: string;
    name: string;
    purpose: string;
    status: string;
    updated_at: Date;
    interest: string;
    fulfillment: string;
    order_id: string;
    refunded: boolean;
    shipment_status: string;
  }>(sql`
    select case when ${job.entity_type === "enrollment"} then e.checkout_email else o.customer_email end as email, o.customer_name as name, o.purpose, o.status, o.updated_at, o.id as order_id,
      coalesce(e.program_snapshot->>'slug',o.line_items->0->>'description') as interest,
      coalesce(e.scheduling_status::text, o.manual_fulfillment_status) as fulfillment, s.status::text as shipment_status,
      exists(select 1 from product_order_refunds r where r.order_id = o.id and r.status = 'succeeded') as refunded
    from checkout_orders o left join training_enrollments e on e.checkout_order_id = o.id
    left join product_shipments s on s.id = o.active_fulfillment_shipment_id
    where ${job.entity_type === "order" ? sql`o.id = ${id}::uuid` : sql`e.id = ${id}::uuid`} and o.redacted_at is null`);
  const row = result.rows[0];
  return row
    ? {
        email: row.email,
        name: row.name,
        source: row.purpose,
        interest: row.interest,
        orderId: row.order_id,
        refunded: row.refunded || row.status === "refunded",
        fulfilled:
          row.status === "paid" &&
          (row.purpose === "training" ||
            ["dispatched", "delivered"].includes(row.fulfillment) ||
            row.shipment_status === "delivered"),
        lifecycle: `${row.purpose}:${row.status}:${row.fulfillment ?? row.shipment_status ?? "pending"}`,
        activityAt: new Date(row.updated_at).toISOString(),
      }
    : null;
}

export async function channelConsent(
  email: string,
  channel: Channel,
  destination: string | null,
  db: CrmDb = getPrivateDb(),
): Promise<"opted_in" | "unsubscribed" | "unknown"> {
  if (!destination) return "unknown";
  const result = await db.execute<{ choice: "opted_in" | "unsubscribed" }>(
    sql`select choice from highlevel_consent_events where email_normalized = ${normalizeEmail(email)} and channel = ${channel} and destination = ${destination} and choice <> 'not_opted_in' order by occurred_at desc, (choice = 'unsubscribed') desc, created_at desc limit 1`,
  );
  return result.rows[0]?.choice ?? "unknown";
}

export async function getContact(
  email: string,
  location: string,
  db: CrmDb = getPrivateDb(),
): Promise<CrmContact> {
  const erased = await db.execute(
    sql`select id from highlevel_contacts where location_id = ${location} and email_normalized = ${erasedIdentityKey(email, location)} and deleted_at is not null`,
  );
  if (erased.rows.length)
    throw new HighLevelError("contact_deleted_review_required");
  await db.execute(
    sql`insert into highlevel_contacts (location_id, email_normalized) values (${location}, ${normalizeEmail(email)}) on conflict do nothing`,
  );
  return (
    await db.execute<CrmContact>(
      sql`select * from highlevel_contacts where location_id = ${location} and email_normalized = ${normalizeEmail(email)} for update`,
    )
  ).rows[0];
}

export async function getCrmDiagnostics() {
  const db = getPrivateDb();
  const [queue, connection, recent, effects, retention] = await Promise.all([
    db.execute<{ status: string; count: string; oldest: Date }>(
      sql`select status, count(*)::text, min(occurred_at) as oldest from highlevel_outbox group by status`,
    ),
    db.execute<{
      location_id: string;
      refresh_state: string;
      expires_at: Date;
      last_sync: Date | null;
    }>(
      sql`select c.location_id, c.refresh_state, c.expires_at, (select max(last_synced_at) from highlevel_contacts h where h.location_id = c.location_id) as last_sync from highlevel_connections c`,
    ),
    db.execute<{
      id: string;
      entity_type: string;
      status: string;
      last_error: string;
      attempts: number;
    }>(
      sql`select id, entity_type, status, last_error, attempts from highlevel_outbox where status in ('review','dead_letter','retry') order by occurred_at desc limit 30`,
    ),
    db.execute<{ key: string; kind: string; contact_id: string }>(
      sql`select key, kind, contact_id from highlevel_effects where state = 'pending' order by created_at limit 30`,
    ),
    db.execute<{ id: string; provider_id: string; email_normalized: string }>(
      sql`select distinct c.id, c.provider_id, c.email_normalized from highlevel_contacts c join highlevel_effects e on e.contact_id = c.id join highlevel_outbox j on e.key = 'entity:' || j.entity_type || ':' || j.entity_id where j.status = 'review' and j.last_error = 'crm_retention_review_required' and c.deleted_at is null limit 30`,
    ),
  ]);
  return {
    queue: queue.rows,
    connections: connection.rows,
    issues: recent.rows,
    effects: effects.rows,
    retention: retention.rows,
  };
}
