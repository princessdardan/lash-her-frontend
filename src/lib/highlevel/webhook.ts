import "server-only";
import { createHash, verify } from "node:crypto";
import { sql } from "drizzle-orm";
import { getPrivateDb } from "@/lib/private-db/client";
import { readBoundedTextBody } from "@/lib/security/bounded-text-body";
import { locationId } from "./config";
import { normalizeEmail } from "./contract";
import { providerBlocked, type ProviderContact } from "./identity";
import { enqueueCrmEvent } from "./store";

// HighLevel's published Ed25519 key. https://marketplace.gohighlevel.com/docs/webhook/WebhookIntegrationGuide/
export const HIGHLEVEL_WEBHOOK_PUBLIC_KEY =
  "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg=\n-----END PUBLIC KEY-----";
export interface HighLevelWebhook extends ProviderContact {
  type: string;
  webhookId?: string;
  dateUpdated?: string;
  timestamp?: string;
}
export function verifyHighLevelSignature(
  raw: string,
  signature: string | null,
  key = HIGHLEVEL_WEBHOOK_PUBLIC_KEY,
): boolean {
  if (!signature || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) return false;
  try {
    const bytes = Buffer.from(signature, "base64");
    return (
      bytes.length === 64 && verify(null, Buffer.from(raw, "utf8"), key, bytes)
    );
  } catch {
    return false;
  }
}

export async function persistHighLevelWebhook(
  event: HighLevelWebhook,
  receiptKey: string,
): Promise<void> {
  const location = locationId();
  await getPrivateDb().transaction(async (tx) => {
    const receipt = await tx.execute(
      sql`insert into highlevel_webhook_receipts (key, location_id, event_type, provider_contact_id) values (${receiptKey}, ${location}, ${event.type}, ${event.id ?? null}) on conflict do nothing returning key`,
    );
    if (!receipt.rows.length) return;
    if (["UNINSTALL", "AppUninstall"].includes(event.type)) {
      await tx.execute(
        sql`update highlevel_connections set refresh_state = 'revoked', credentials_ciphertext = '[revoked]', updated_at = now() where location_id = ${location}`,
      );
      return;
    }
    if (!["ContactDndUpdate", "ContactDelete"].includes(event.type)) return;
    const row = (
      await tx.execute<{
        id: string;
        email_normalized: string;
        phone: string | null;
        deleted_at: Date | null;
        provider_updated_at: Date | null;
        provider_email_blocked: boolean;
        provider_sms_blocked: boolean;
      }>(
        sql`select id, email_normalized, phone, deleted_at, provider_updated_at, provider_email_blocked, provider_sms_blocked from highlevel_contacts where location_id = ${location} and provider_id = ${event.id} for update`,
      )
    ).rows[0];
    if (!row || row.deleted_at) return; // Do not import unrelated CRM contacts through a webhook.
    const rawTime = event.dateUpdated ?? event.timestamp;
    const occurredAt = rawTime ? new Date(rawTime) : new Date();
    if (
      !Number.isFinite(occurredAt.getTime()) ||
      occurredAt.getTime() > Date.now() + 5 * 60_000
    )
      throw new Error("invalid_event_time");
    if (
      row.provider_updated_at &&
      new Date(row.provider_updated_at).getTime() > occurredAt.getTime()
    )
      return;
    if (event.type === "ContactDelete") {
      await tx.execute(
        sql`update highlevel_contacts set deleted_at = now(), provider_updated_at = ${occurredAt}, provider_email_blocked = true, provider_sms_blocked = true where id = ${row.id}::uuid`,
      );
    } else {
      const tiedOrUnknown =
        !rawTime ||
        (row.provider_updated_at &&
          new Date(row.provider_updated_at).getTime() === occurredAt.getTime());
      const emailBlocked =
        providerBlocked(event, "email") ||
        Boolean(tiedOrUnknown && row.provider_email_blocked);
      const smsBlocked =
        providerBlocked(event, "sms") ||
        Boolean(tiedOrUnknown && row.provider_sms_blocked);
      await tx.execute(
        sql`update highlevel_contacts set provider_email_blocked = ${emailBlocked}, provider_sms_blocked = ${smsBlocked}, provider_updated_at = ${occurredAt}, updated_at = now() where id = ${row.id}::uuid`,
      );
      for (const [channel, blocked, destination] of [
        ["email", emailBlocked, row.email_normalized],
        ["sms", smsBlocked, row.phone],
      ] as const) {
        if (!blocked || !destination) continue;
        const setting = Object.entries(event.dndSettings ?? {}).find(
          ([key]) => key.toLowerCase() === channel,
        )?.[1];
        if (setting?.message === "lh:website-withdrawal") continue; // Our own suppression acknowledgement is not a new withdrawal.
        await tx.execute(
          sql`insert into highlevel_consent_events (origin_key, email_normalized, channel, destination, choice, source, occurred_at) values (${`webhook:${receiptKey}:${channel}`}, ${row.email_normalized}, ${channel}, ${destination}, 'unsubscribed', 'highlevel', ${occurredAt}) on conflict do nothing`,
        );
      }
      if (emailBlocked) {
        const email = normalizeEmail(row.email_normalized);
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${email}, 0))`,
        );
        await tx.execute(
          sql`update marketing_contacts set unsubscribed_at = coalesce(unsubscribed_at, ${occurredAt}), updated_at = greatest(updated_at, ${occurredAt}) where email_normalized = ${email}`,
        );
        await tx.execute(
          sql`update marketing_contact_sync_jobs set status = 'skipped_unconfigured', locked_by = null, locked_until = null, skipped_at = now(), last_error = 'HighLevel email suppression', updated_at = now() where email_normalized = ${email} and kind = 'opt_in_sync' and status in ('queued','processing','retryable_failed')`,
        );
        await tx.execute(
          sql`update customer_email_outbox set status = 'dead_letter', recipient_ciphertext = '[redacted]', recipient_email_normalized = null, template_data_ciphertext = '[redacted]', redacted_at = now(), lease_owner = null, lease_expires_at = null, last_error = null, updated_at = now() where kind = 'contact_popup_offer' and recipient_email_normalized = ${email} and status in ('queued','sending','failed','dead_letter')`,
        );
        await tx.execute(
          sql`insert into marketing_contact_sync_jobs (idempotency_key, email, email_normalized, source, kind, payload) values (${`ghl-unsubscribe:${receiptKey}`}, ${email}, ${email}, 'highlevel', 'unsubscribe_sync', ${JSON.stringify({ email, consentedAt: occurredAt.toISOString(), source: "highlevel" })}::jsonb) on conflict do nothing`,
        );
      }
    }
    await enqueueCrmEvent(tx, {
      entityType: "contact",
      entityId: row.id,
      eventKey: `webhook:${receiptKey}`,
      eventType: "provider_suppression_changed",
    });
  });
}

export function createHighLevelWebhookHandler(
  dependencies = {
    location: locationId,
    verify: verifyHighLevelSignature,
    persist: persistHighLevelWebhook,
  },
) {
  return async function POST(request: Request): Promise<Response> {
    // Independent of outbound sync/marketing switches: withdrawals still arrive when paused.
    if (!process.env.HIGHLEVEL_LOCATION_ID)
      return new Response(null, { status: 404 });
    const body = await readBoundedTextBody(request, 64_000);
    if (!body.ok) return new Response(null, { status: 413 });
    if (
      !dependencies.verify(body.value, request.headers.get("x-ghl-signature"))
    )
      return new Response(null, { status: 401 });
    let event: HighLevelWebhook;
    try {
      event = JSON.parse(body.value);
      if (
        !event ||
        typeof event.type !== "string" ||
        typeof event.locationId !== "string" ||
        event.locationId !== dependencies.location()
      )
        return new Response(null, { status: 403 });
      if (
        ["ContactDndUpdate", "ContactDelete"].includes(event.type) &&
        (typeof event.id !== "string" || !event.id)
      )
        return new Response(null, { status: 400 });
    } catch {
      return new Response(null, { status: 400 });
    }
    const key = createHash("sha256")
      .update(`${event.locationId}:${event.webhookId ?? body.value}`)
      .digest("hex");
    try {
      await dependencies.persist(event, key);
      return new Response(null, { status: 200 });
    } catch {
      return Response.json(
        { error: "webhook_persistence_failed" },
        { status: 503 },
      );
    }
  };
}
