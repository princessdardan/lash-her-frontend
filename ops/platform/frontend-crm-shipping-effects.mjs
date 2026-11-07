// Fixed projections mirrored from frontend_crm_shipping_retirement.py.
// A parity test binds every literal query; no caller SQL or PII payload fields.
import { createHash } from "node:crypto";
const demand = ok => { if (!ok) throw new Error("FRONTEND_CRM_SHIPPING_DATABASE_REFUSED"); };
const plans = {
  "highlevel": [
    {
      "name": "contacts",
      "sql": "SELECT id::text, location_id, provider_id, encode(sha256(convert_to(email_normalized,'UTF8')),'hex') AS email_sha256, deleted_at::text, last_synced_at::text FROM highlevel_contacts WHERE location_id=$1 ORDER BY id",
      "locationParameter": true
    },
    {
      "name": "effects",
      "sql": "SELECT e.key, e.contact_id::text, e.kind, e.provider_id, e.state, jsonb_build_object('workflow',e.data->>'workflow','journey',e.data->>'journey') AS data FROM highlevel_effects e JOIN highlevel_contacts c ON c.id=e.contact_id WHERE c.location_id=$1 ORDER BY e.key",
      "locationParameter": true
    },
    {
      "name": "outbox",
      "sql": "SELECT id::text, encode(sha256(convert_to(event_key,'UTF8')),'hex') AS idempotency_sha256, entity_type, entity_id, status, (locked_by IS NOT NULL OR locked_until IS NOT NULL) AS lease_held, completed_at::text FROM highlevel_outbox ORDER BY id",
      "locationParameter": false
    },
    {
      "name": "connections",
      "sql": "SELECT location_id, installed_by::text, refresh_state, (credentials_ciphertext='[revoked]') AS credentials_revoked, expires_at::text, updated_at::text FROM highlevel_connections WHERE location_id=$1 ORDER BY location_id",
      "locationParameter": true
    },
    {
      "name": "webhookReceipts",
      "sql": "SELECT encode(sha256(convert_to(key,'UTF8')),'hex') AS receipt_sha256, location_id, event_type, provider_contact_id, received_at::text FROM highlevel_webhook_receipts WHERE location_id=$1 ORDER BY key",
      "locationParameter": true
    },
    {
      "name": "marketingDeliveries",
      "sql": "SELECT id::text, status, provider_message_id, sent_at::text FROM customer_email_outbox WHERE delivery_provider='highlevel' ORDER BY id",
      "locationParameter": false
    }
  ],
  "chitchats": [
    {
      "name": "shipments",
      "sql": "SELECT id::text, public_reference, provider_shipment_id, provider_status, status::text, state_version, selected_postage_type, actual_purchase_total_cents, provider_cost_currency, purchased_at::text, delivered_at::text FROM product_shipments WHERE provider='chitchats' ORDER BY id",
      "locationParameter": false
    },
    {
      "name": "jobs",
      "sql": "SELECT j.id::text, j.shipment_id::text, j.type::text, j.status::text, j.state_version, encode(sha256(convert_to(j.idempotency_key,'UTF8')),'hex') AS idempotency_sha256, j.operation_payload_hash, j.outcome_unknown, (j.lease_owner IS NOT NULL OR j.lease_expires_at IS NOT NULL) AS lease_held, j.completed_at::text FROM product_shipment_jobs j JOIN product_shipments s ON s.id=j.shipment_id WHERE s.provider='chitchats' ORDER BY j.id",
      "locationParameter": false
    }
  ]
};
const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === "object" ?
  Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
export const frontendCrmShippingSnapshotSha256 = value => createHash("sha256").update(JSON.stringify(ordered(value))
  .replace(/[\u007f-\uffff]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)).digest("hex");

export function frontendCrmShippingQueries(provider, reviewed) {
  demand(["highlevel", "chitchats"].includes(provider) && reviewed?.environment === "staging");
  if (provider === "highlevel") demand(typeof reviewed.locationId === "string" && /^[A-Za-z0-9_-]{1,192}$/u.test(reviewed.locationId) && reviewed.locationId !== "vd09FLBpPLXuHb5Tnhn4");
  return plans[provider].map(row => [row.name, row.sql, row.locationParameter ? [reviewed.locationId] : []]);
}

export async function observeFrontendCrmShippingDatabase(client, provider, reviewed, verifySession, requireInitialSnapshot = true) {
  demand(client && typeof client.query === "function" && typeof verifySession === "function");
  const queries = frontendCrmShippingQueries(provider, reviewed);
  await verifySession();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const actual = {};
    for (const [name, sql, parameters] of queries) {
      await verifySession();
      const rows = (await client.query(`${sql} LIMIT 4097`, parameters)).rows;
      demand(Array.isArray(rows) && rows.length <= 4096); actual[name] = rows;
    }
    const snapshotSha256 = frontendCrmShippingSnapshotSha256(actual);
    demand(!requireInitialSnapshot || snapshotSha256 === reviewed.databaseSnapshotSha256);
    await verifySession(); await client.query("COMMIT"); await verifySession();
    return actual;
  } catch {
    try { await client.query("ROLLBACK"); } catch { /* parent retains unqualified observation */ }
    throw new Error("FRONTEND_CRM_SHIPPING_DATABASE_REFUSED");
  }
}
