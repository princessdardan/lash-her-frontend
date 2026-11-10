// Actual operational rows only; no arbitrary SQL, PII fields, generic settlement
// writes, idempotency replay, or inference that selected IDs are exhaustive.
import { frontendCoordinationHash as hash } from "./frontend-release-inventory.mjs";
const demand = ok => { if (!ok) throw new Error("FRONTEND_SQUARE_DATABASE_EFFECTS_REFUSED"); };
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value);
const id = value => value === null || typeof value === "string" && /^[A-Za-z0-9_-]{1,192}$/u.test(value);
export async function observeFrontendSquareEffects(client, reviewed, verifySession) {
  demand(reviewed?.environment === "sandbox" && reviewed.locationId === "LE2H76M5V90AM" && Array.isArray(reviewed.effects) && typeof verifySession === "function");
  await verifySession();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const rows = [];
    for (const selected of reviewed.effects) {
      demand(uuid(selected.recordId));
      let record;
      if (selected.recordKind === "booking-payment-attempt") {
        const result = await client.query(`SELECT a.id::text,a.status::text,a.payment_provider::text,a.operation,a.idempotency_key,
          a.provider_payment_id,a.provider_order_id,a.amount_cents,a.currency,COALESCE(h.public_reference,o.order_id) AS reference_id
          FROM public.booking_payment_attempts a LEFT JOIN public.appointment_holds h ON h.id=a.hold_id
          LEFT JOIN public.checkout_orders o ON o.id=a.checkout_order_id WHERE a.id=$1::uuid`, [selected.recordId]);
        demand(result.rows.length === 1); record = result.rows[0];
        demand(record.payment_provider === "square" && record.operation === "square_charge_and_store");
      } else if (selected.recordKind === "product-refund") {
        const result = await client.query(`SELECT r.id::text,r.status::text,o.payment_provider::text,r.idempotency_key::text,
          r.provider_refund_id,r.original_transaction_id,r.amount_cents,o.currency,o.square_location_id
          FROM public.product_order_refunds r JOIN public.checkout_orders o ON o.id=r.order_id WHERE r.id=$1::uuid`, [selected.recordId]);
        demand(result.rows.length === 1); record = result.rows[0];
        demand(record.payment_provider === "square" && record.square_location_id === reviewed.locationId && id(record.original_transaction_id));
      } else demand(false);
      demand(record.id === selected.recordId && record.currency === "CAD" && Number.isSafeInteger(record.amount_cents) && record.amount_cents >= 0 &&
        typeof record.idempotency_key === "string" && record.idempotency_key.length > 0 && record.idempotency_key.length <= 192);
      const row = { recordKind: selected.recordKind, recordId: record.id, databaseStatus: record.status,
        idempotencySha256: hash(record.idempotency_key), providerKind: selected.recordKind === "product-refund" ? "refund" : "payment",
        providerId: selected.recordKind === "product-refund" ? record.provider_refund_id : record.provider_payment_id,
        amountCents: record.amount_cents, currency: "CAD",
        ...(selected.recordKind === "product-refund" ? { originalPaymentId: record.original_transaction_id } :
          { providerOrderId: record.provider_order_id, referenceId: record.reference_id }) };
      demand(id(row.providerId));
      row.databaseRowSha256 = hash(row);
      demand(row.databaseRowSha256 === selected.databaseRowSha256); rows.push(row);
    }
    await verifySession(); await client.query("COMMIT"); await verifySession();
    return rows;
  } catch { try { await client.query("ROLLBACK"); } catch { /* preserve unverified observation */ } throw new Error("FRONTEND_SQUARE_DATABASE_EFFECTS_REFUSED"); }
}
