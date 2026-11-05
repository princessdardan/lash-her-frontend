// Read-only, complete operational binding/effect inventory for the affected
// frontend database. This never decrypts credentials, executes arbitrary SQL,
// settles a job, replays a provider request, or treats source flags as evidence.
import { frontendCoordinationHash as hash } from "./frontend-release-inventory.mjs";

const demand = ok => { if (!ok) throw new Error("FRONTEND_OPERATIONAL_PROVIDER_INVENTORY_REFUSED"); };
const scopes = [
  { provider: "google-calendar", table: "booking_calendar_connections", sql: `SELECT id::text,provider::text,status::text,
      credential_ciphertext IS NOT NULL AS encrypted_credential_present,
      credential_secret_ref IS NOT NULL AS credential_reference_present FROM public.booking_calendar_connections ORDER BY id` },
  { provider: "google-calendar", table: "appointment_calendar_events", sql: `SELECT id::text,provider_event_id,provider_event_etag,
      sync_status::text,deleted_at IS NOT NULL AS deleted FROM public.appointment_calendar_events ORDER BY id` },
  { provider: "google-calendar", table: "appointment_holds", sql: `SELECT id::text,status::text,google_event_id,
      finalization_status::text FROM public.appointment_holds WHERE google_event_id IS NOT NULL ORDER BY id` },
  { provider: "google-calendar", table: "checkout_orders", sql: `SELECT id::text,status::text,calendar_event_id,
      calendar_finalization_status::text FROM public.checkout_orders WHERE calendar_event_id IS NOT NULL ORDER BY id` },
  { provider: "highlevel", table: "highlevel_connections", sql: `SELECT location_id,refresh_state,
      credentials_ciphertext IS NOT NULL AS encrypted_credential_present FROM public.highlevel_connections ORDER BY location_id` },
  { provider: "highlevel", table: "highlevel_oauth_states", sql: `SELECT hash,expires_at > now() AS continuation_live
      FROM public.highlevel_oauth_states ORDER BY hash` },
  { provider: "highlevel", table: "highlevel_outbox", sql: `SELECT id::text,status,attempts,
      locked_by IS NOT NULL AS lease_present,locked_until > now() AS lease_live FROM public.highlevel_outbox ORDER BY id` },
  { provider: "highlevel", table: "highlevel_effects", sql: `SELECT key,kind,provider_id,state FROM public.highlevel_effects ORDER BY key` },
  { provider: "chitchats", table: "product_shipments", sql: `SELECT id::text,provider,provider_shipment_id,provider_status,
      status::text,state_version FROM public.product_shipments ORDER BY id` },
  { provider: "chitchats", table: "product_shipment_jobs", sql: `SELECT id::text,shipment_id::text,type::text,status::text,
      attempt_count,outcome_unknown,lease_expires_at > now() AS lease_live FROM public.product_shipment_jobs ORDER BY id` },
  { provider: "resend", table: "customer_email_outbox", sql: `SELECT id::text,delivery_provider,status,attempt_count,
      provider_message_id,lease_expires_at > now() AS lease_live FROM public.customer_email_outbox ORDER BY id` },
  { provider: "square", table: "booking_payment_attempts", sql: `SELECT id::text,payment_provider::text,operation,status::text,
      provider_payment_id,provider_order_id FROM public.booking_payment_attempts WHERE payment_provider='square' ORDER BY id` },
  { provider: "square", table: "product_order_refunds", sql: `SELECT r.id::text,r.status::text,r.provider_refund_id
      FROM public.product_order_refunds r JOIN public.checkout_orders o ON o.id=r.order_id WHERE o.payment_provider='square' ORDER BY r.id` },
];

export const frontendOperationalProviderTables = Object.freeze(scopes.map(({ provider, table }) => Object.freeze({ provider, table })));

export async function observeFrontendOperationalProviderInventory(client, verifySession) {
  demand(client && typeof client.query === "function" && typeof verifySession === "function");
  await verifySession();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const tables = [];
    for (const scope of scopes) {
      await verifySession();
      const present = (await client.query("SELECT to_regclass($1)::text AS relation", [`public.${scope.table}`])).rows;
      demand(present.length === 1 && (present[0].relation === null || typeof present[0].relation === "string"));
      if (present[0].relation === null) {
        // Absent historical tables are observable; they are not fabricated
        // empty inventories and cannot establish no provider effects.
        tables.push({ provider: scope.provider, table: scope.table, present: false, rowCount: null, rowsSha256: null });
        continue;
      }
      const rows = (await client.query(`${scope.sql} LIMIT 4097`)).rows;
      demand(Array.isArray(rows) && rows.length <= 4096);
      // Opaque idempotency keys or provider metadata can encode PII. Only the
      // aggregate digest/count and credential presence are retained here.
      tables.push({ provider: scope.provider, table: scope.table, present: true, rowCount: rows.length, rowsSha256: hash(rows),
        ...(scope.table.endsWith("_connections") ? {
          credentialRecords: rows.filter(row => row.encrypted_credential_present || row.credential_reference_present).length,
        } : {}) });
    }
    await verifySession(); await client.query("COMMIT"); await verifySession();
    return { version: 1, scope: "frontend-operational-database-only", tables,
      historicalDeploymentBindingsVerified: false, providerRetirementVerified: false, providerEffectsReconciled: false };
  } catch {
    try { await client.query("ROLLBACK"); } catch { /* original failed observation remains unverified */ }
    throw new Error("FRONTEND_OPERATIONAL_PROVIDER_INVENTORY_REFUSED");
  }
}
