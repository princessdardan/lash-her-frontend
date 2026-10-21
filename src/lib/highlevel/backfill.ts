import "server-only";
import { sql } from "drizzle-orm";
import { getPrivateDb } from "@/lib/private-db/client";
import {
  normalizeEmail,
  normalizePhone,
  validIdentity,
  type CrmEntityType,
} from "./contract";
import { enqueueCrmEvent } from "./store";

/** Inventory is read-only by default; output contains aggregate counts only. */
export async function backfillHighLevel(apply = false) {
  const db = getPrivateDb();
  const rows = await db.execute<{
    id: string;
    entity: CrmEntityType;
    email: string;
    phone: string | null;
  }>(sql`
    select id::text, 'submission' as entity, email, phone from marketing_contact_submissions where email <> '[redacted]'
    union all select id::text, 'order', customer_email, null from checkout_orders where redacted_at is null
    union all select id::text, 'enrollment', checkout_email, null from training_enrollments where checkout_email <> '[redacted]'`);
  const phones = new Map<string, Set<string>>();
  for (const row of rows.rows) {
    const phone = normalizePhone(row.phone);
    if (!phone || !validIdentity(row.email)) continue;
    const identities = phones.get(phone) ?? new Set<string>();
    identities.add(normalizeEmail(row.email));
    phones.set(phone, identities);
  }
  const conflicted = new Set(
    [...phones.values()]
      .filter((emails) => emails.size > 1)
      .flatMap((emails) => [...emails]),
  );
  const eligible = rows.rows.filter(
    (row) =>
      validIdentity(row.email) && !conflicted.has(normalizeEmail(row.email)),
  );
  const summary = {
    mode: apply ? "enqueue" : "dry-run",
    retained: rows.rows.length,
    eligible: eligible.length,
    identities: new Set(eligible.map((row) => normalizeEmail(row.email))).size,
    conflictingIdentities: conflicted.size,
    skipped: rows.rows.length - eligible.length,
    byEntity: Object.fromEntries(
      ["submission", "order", "enrollment"].map((type) => [
        type,
        eligible.filter((row) => row.entity === type).length,
      ]),
    ),
  };
  if (!apply) return summary;
  // Consent evidence is imported first. No phone number is treated as SMS consent.
  // Preserve current legacy suppression even when its original evidence has expired.
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('highlevel.historical','true',true)`,
    );
    await tx.execute(sql`insert into highlevel_consent_events (origin_key, email_normalized, channel, destination, choice, consent_text, consent_version, source, occurred_at)
      select 'email:' || id::text, email_normalized, 'email', email_normalized,
      case when event_type = 'unsubscribe' then 'unsubscribed' else 'opted_in' end,
      consent_text, 'legacy-email', source, occurred_at from marketing_consent_events
      where email <> '[redacted]' and email_normalized not like 'redacted:%' and (event_type = 'unsubscribe' or (event_type in ('opt_in','backfill_consent') and nullif(trim(consent_text),'') is not null)) on conflict do nothing`);
    await tx.execute(sql`insert into highlevel_consent_events (origin_key, email_normalized, channel, destination, choice, source, occurred_at)
      select 'legacy-suppression:' || id::text || ':' || unsubscribed_at::text, email_normalized, 'email', email_normalized, 'unsubscribed', 'legacy-suppression', unsubscribed_at from marketing_contacts where unsubscribed_at is not null and email_normalized not like 'redacted:%' on conflict do nothing`);
  });
  for (let offset = 0; offset < eligible.length; offset += 200) {
    await db.transaction(async (tx) => {
      for (const row of eligible.slice(offset, offset + 200))
        await enqueueCrmEvent(tx, {
          entityType: row.entity,
          entityId: row.id,
          historical: true,
          eventKey: `backfill:v1:${row.entity}:${row.id}`,
          eventType: "historical_import",
        });
    });
  }
  return summary;
}
