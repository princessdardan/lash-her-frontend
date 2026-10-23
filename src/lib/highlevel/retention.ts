import "server-only";
import { sql } from "drizzle-orm";
import { getPrivateDb } from "@/lib/private-db/client";
import { erasedIdentityKey } from "./crypto";
import { highlevel } from "./client";
import { HighLevelError } from "./contract";
import { locationId } from "./config";
import { stopJourneys } from "./sync";
import type { CrmContact } from "./store";

export async function retainHighLevelRecords(
  now = new Date(),
): Promise<number> {
  return getPrivateDb().transaction(async (tx) => {
    const expired = await tx.execute(
      sql`delete from highlevel_oauth_states where expires_at < ${now} returning hash`,
    );
    const receipts = await tx.execute(
      sql`delete from highlevel_webhook_receipts where received_at < ${now}::timestamptz - interval '90 days' returning key`,
    );
    const jobs = await tx.execute(
      sql`delete from highlevel_outbox where status in ('succeeded','skipped') and completed_at < ${now}::timestamptz - interval '395 days' returning id`,
    );
    // Keep consent evidence for the existing seven-year policy. Queue affected
    // contacts before deleting so an expired grant cannot remain eligible in CRM.
    await tx.execute(sql`insert into highlevel_outbox (event_key,entity_type,entity_id,event_type)
      select 'consent-expiry:' || c.id::text || ':' || ${now.toISOString().slice(0, 10)}, 'contact', c.id::text, 'consent_retention_expired'
      from highlevel_contacts c where c.deleted_at is null and exists(select 1 from highlevel_consent_events e where e.email_normalized = c.email_normalized and e.occurred_at < ${now}::timestamptz - interval '2555 days') on conflict do nothing`);
    const consent = await tx.execute(
      sql`delete from highlevel_consent_events where occurred_at < ${now}::timestamptz - interval '2555 days' returning id`,
    );
    return (
      expired.rows.length +
      receipts.rows.length +
      jobs.rows.length +
      consent.rows.length
    );
  });
}

/** Explicit administrator privacy resolution, after reviewing staff-owned CRM data. */
export async function deleteReviewedCrmCopy(id: string): Promise<void> {
  const db = getPrivateDb();
  const contact = (
    await db.execute<CrmContact>(
      sql`select * from highlevel_contacts where id = ${id}::uuid and location_id = ${locationId()}`,
    )
  ).rows[0];
  if (!contact) throw new HighLevelError("contact_mapping_missing");
  if (contact.deleted_at && contact.email_normalized.startsWith("deleted:"))
    return;
  if (contact.provider_id) {
    await stopJourneys(contact);
    try {
      await highlevel(`/contacts/${encodeURIComponent(contact.provider_id)}`, {
        method: "DELETE",
      });
    } catch (error) {
      if (
        !(
          error instanceof HighLevelError && error.code === "highlevel_http_404"
        )
      )
        throw error;
    }
  }
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`delete from highlevel_consent_events where email_normalized = ${contact.email_normalized}`,
    );
    await tx.execute(
      sql`update highlevel_effects set state = 'cancelled', provider_id = null, data = '{}'::jsonb where contact_id = ${id}::uuid`,
    );
    // Keep a keyed, irreversible suppression tombstone after CRM deletion; otherwise
    // queued source events could recreate the erased CRM contact on the next run.
    await tx.execute(
      sql`update highlevel_contacts set email_normalized = ${erasedIdentityKey(contact.email_normalized, locationId())}, deleted_at = now(), phone = null, provider_email_blocked = true, provider_sms_blocked = true, updated_at = now() where id = ${id}::uuid`,
    );
  });
}
