// Synthetic rows only, in the disposable database owned by the migration fixture.
export async function seedReconciliationRows(db, selected = ["service", "email", "split", "capture"]) {
  await db.query("TRUNCATE appointment_holds, checkout_orders, booking_services, booking_resources, booking_calendar_connections CASCADE");
  const ids = {};
  const hold = async (reference, version = 1) => (await db.query(`
    INSERT INTO appointment_holds(public_reference,payment_session_reference,offering_id,
      offering_snapshot,booking_type,customer_snapshot,selected_start,selected_end,timezone,
      status,expires_at,booking_model_version,provider_booking_email_sent_at)
    VALUES($1,$1,'owned-offering','{}','appointment',
      '{"name":"Owned fixture","email":"owned@example.invalid"}',
      now()+interval '1 day',now()+interval '1 day 1 hour','America/Toronto',
      'payment_pending',now()+interval '2 days',$2,now()) RETURNING id`, [reference, version])).rows[0].id;
  if (selected.includes("service") || selected.includes("invalid-intent")) {
    ids.service = await hold("owned-service");
    await db.query(`INSERT INTO booking_payment_attempts(hold_id,operation,status,payment_provider,
      idempotency_key,provider_payment_id,amount_cents,provider_metadata)
      VALUES($1,'square_charge_and_store','authorized','square','owned-service-key','owned-service-payment',1000,$2)`,
    [ids.service, selected.includes("invalid-intent") ? {} : { squareRequestIntent: { squareCustomerId: "owned-customer" } }]);
  }
  if (selected.some(kind => ["service", "email", "invalid-intent"].includes(kind))) {
    const resource = (await db.query(`INSERT INTO booking_resources(resource_key,name,kind,timezone)
      VALUES('owned-resource','Owned resource','provider','America/Toronto') RETURNING id`)).rows[0].id;
    const provider = (await db.query(`INSERT INTO booking_providers(provider_key,display_name,primary_resource_id)
      VALUES('owned-provider','Owned provider',$1) RETURNING id`, [resource])).rows[0].id;
    const service = (await db.query(`INSERT INTO booking_services(service_key,display_title)
      VALUES('owned-service','Owned service') RETURNING id`)).rows[0].id;
    const offering = (await db.query(`INSERT INTO booking_service_offerings(offering_key,service_id,
      provider_id,primary_resource_id,duration_minutes,full_price_cents,deposit_amount_cents)
      VALUES('owned-offering',$1,$2,$3,60,2000,1000) RETURNING id`, [service, provider, resource])).rows[0].id;
    const connection = (await db.query("INSERT INTO booking_calendar_connections DEFAULT VALUES RETURNING id")).rows[0].id;
    const assignment = (await db.query(`INSERT INTO booking_resource_calendar_assignments(resource_id,calendar_connection_id,provider_calendar_id)
      VALUES($1,$2,'owned-calendar') RETURNING id`, [resource, connection])).rows[0].id;
    const upgradeHold = id => db.query(`UPDATE appointment_holds SET booking_model_version=2,service_offering_id=$2,
      provider_id=$3,primary_resource_id=$4,provider_snapshot='{}',occupied_start=selected_start,
      occupied_end=selected_end,calendar_assignment_id=$5,google_calendar_id='owned-calendar'
      WHERE id=$1`, [id, offering, provider, resource, assignment]);
    if (ids.service) await upgradeHold(ids.service);
    if (selected.includes("email")) {
    ids.email = await hold("owned-email"); await upgradeHold(ids.email);
    await db.query(`INSERT INTO appointments(public_reference,source_hold_id,service_offering_id,
      provider_id,primary_resource_id,offering_snapshot,provider_snapshot,customer_name,customer_email,
      customer_email_normalized,selected_start,selected_end,occupied_start,occupied_end,timezone,
      status,origin,payment_status,calendar_sync_status)
      VALUES('owned-appointment',$1,$2,$3,$4,'{}','{}','Owned fixture','owned@example.invalid',
      'owned@example.invalid',now()+interval '1 day',now()+interval '1 day 1 hour',
      now()+interval '1 day',now()+interval '1 day 1 hour','America/Toronto',
      'confirmed','admin','not_required','synced')`, [ids.email, offering, provider, resource]);
    }
  }
  for (const kind of ["split", "capture"].filter(kind => selected.includes(kind))) {
    ids[kind] = `owned-${kind}`;
    await db.query(`INSERT INTO checkout_orders(order_id,purpose,status,payment_provider,provider_status,
      provider_payment_id,customer_name,customer_email,amount_cents,line_items,paid_at,updated_at,provider_metadata)
      VALUES($1,$2,$3,'square','APPROVED',$4,'Owned fixture','owned@example.invalid',1000,'[]',
      now()-interval '1 hour',now()-interval '1 hour',$5)`, [
      `owned-${kind}`, kind === "split" ? "training" : "product", kind === "split" ? "pending" : "paid",
      kind === "split" ? null : "owned-capture-payment", kind === "split" ? {
        flow: "training_square_split", splitPayment: { stage: "canceling", cardAmountCents: 400,
          afterpayAmountCents: 600, cardPaymentId: "owned-split-card", afterpayPaymentId: "owned-split-afterpay",
          squareOrderId: "owned-split-order" },
      } : {},
    ]);
  }
  return ids;
}

export async function assertReconciliationReceipts(assert, db, ids, through = 4) {
  if (ids.service && through >= 1) {
    const row = (await db.query(`SELECT status,idempotency_key,provider_payment_id FROM booking_payment_attempts
      WHERE hold_id=$1`, [ids.service])).rows[0];
    assert.equal(row.status, "cancelled");
    assert.equal(row.idempotency_key, "owned-service-key");
    assert.equal(row.provider_payment_id, "owned-service-payment");
  }
  if (ids.email && through >= 2) {
    assert.ok((await db.query("SELECT booking_confirmation_email_sent_at FROM appointments WHERE source_hold_id=$1", [ids.email])).rows[0].booking_confirmation_email_sent_at);
    assert.equal((await db.query("SELECT booking_confirmation_email_claimed_until FROM appointments WHERE source_hold_id=$1", [ids.email])).rows[0].booking_confirmation_email_claimed_until, null);
  }
  if (ids.split && through >= 3) {
    const rows = (await db.query("SELECT status,provider_order_id,provider_metadata FROM checkout_orders WHERE order_id=$1", [ids.split])).rows;
    assert.equal(rows.length, 1, "split receipt must survive reconciliation");
    assert.equal(rows[0].status, "pending");
    assert.equal(rows[0].provider_order_id, "owned-split-order");
    assert.deepEqual(rows[0].provider_metadata.splitPayment, {
      stage: "canceled", cardAmountCents: 400, afterpayAmountCents: 600,
      cardPaymentId: "owned-split-card", afterpayPaymentId: "owned-split-afterpay",
      squareOrderId: "owned-split-order",
    });
  }
  if (ids.capture && through >= 4) {
    const rows = (await db.query("SELECT status,provider_status,provider_payment_id FROM checkout_orders WHERE order_id=$1", [ids.capture])).rows;
    assert.equal(rows.length, 1, "capture receipt must survive reconciliation");
    assert.deepEqual(rows[0], { status: "paid", provider_status: "COMPLETED", provider_payment_id: "owned-capture-payment" });
  }
}
