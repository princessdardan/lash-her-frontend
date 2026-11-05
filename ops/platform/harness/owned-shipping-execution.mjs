// Source predecessor: unmerged 56d64fe. Requalified on the integrated whole-route source; no historical receipt is reused.
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { seedReconciliationRows } from './owned-reconciliation-rows.mjs';

export async function exerciseShippingExecution({ operator, target, password, connections, change, operations, since,
  reconcile, request, drain, checks, setPhase }) {
  const { buildConfiguredQuoteContext } = await import('../../../src/lib/shipping/configured-quote-context.ts');
  const { getChitChatsConfig } = await import('../../../src/lib/shipping/config.ts');
  const { hashOperationPayload } = await import('../../../src/lib/shipping/shipment-store.ts');
  const originalFetch = globalThis.fetch;
  const env = {
    CHITCHATS_CHECKOUT_ENABLED: 'true', CHITCHATS_WORKER_CRON_SECRET: 'abcdefghijklmnopqrstuvwxyz0123456789-owned',
    NEXT_PUBLIC_SITE_URL: 'https://owned.invalid', CRON_SECRET: 'abcdefghijklmnopqrstuvwxyz0123456789-owned',
    AUTH_SECRET: 'abcdefghijklmnopqrstuvwxyz0123456789-owned',
    CHITCHATS_QUOTE_SIGNING_SECRET: 'abcdefghijklmnopqrstuvwxyz0123456789-owned',
    SHIPPING_DECISION_TOKEN_SECRET: 'abcdefghijklmnopqrstuvwxyz0123456789-owned',
    ADDRESS_CHANGE_TOKEN_SECRET: 'abcdefghijklmnopqrstuvwxyz0123456789-owned',
    CHECKOUT_PII_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
    ADMIN_OWNER_EMAILS: 'owned@example.invalid', CHITCHATS_TRACKED_POSTAGE_TYPES: 'chit_chats_select',
  };
  const prior = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  Object.assign(process.env, env);
  const base = new URL(getChitChatsConfig().baseUrl);
  let selected, seen = [], unexpected = false, providerHold, expectedActive = 1;
  const endpoint = suffix => base.pathname + '/shipments' + suffix;
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init), url = new URL(req.url);
    if (url.origin !== base.origin) return originalFetch(input, init);
    if (process.env.FRONTEND_WRITER_ADMISSION_MODE==='enforce') {
      const active=(await operations()).filter(r=>r.state==='active');
      assert.equal(active.length,expectedActive); assert.ok(active.every(row=>row.kind==='recovery'));
    }
    const expected = selected?.steps[seen.length];
    if (!expected || req.method !== expected.method || url.pathname + url.search !== expected.path) {
      unexpected = true; throw new Error('OWNED_UNEXPECTED_SHIPPING_FETCH');
    }
    if (req.method === 'POST') assert.equal((await req.clone().json()).order_id, selected.reference);
    if (url.pathname.endsWith('/buy')) assert.deepEqual(await req.clone().json(), { postage_type: 'chit_chats_select' });
    seen.push({ method: req.method, path: url.pathname + url.search });
    await providerHold?.wait();
    if (expected.error) return Response.json({ error: 'owned-private-provider-detail' }, { status: expected.error });
    if (expected.method === 'DELETE') return new Response(null, { status: 204 });
    const body = typeof expected.body === 'function' ? expected.body() : expected.body;
    return Response.json(body);
  };
  const get = (path) => request(path);
  const until = async fn => { for (let n = 0; n < 250; n++) { if (await fn()) return; await delay(20); } throw new Error('OWNED_SHIPPING_OBSERVATION_TIMEOUT'); };
  const hold = () => {
    let enter, release; const entered = new Promise(r => { enter = r; }), held = new Promise(r => { release = r; });
    return { entered, release, wait: async () => { enter(); await held; } };
  };
  const connect = async () => {
    const client = new Client({ host: target.host, port: target.port, database: target.database, user: 'frontend_test_admin',
      password, ssl: { rejectUnauthorized: true, ca: readFileSync(process.env.NODE_EXTRA_CA_CERTS, 'utf8') } });
    connections.push(client); await client.connect(); return client;
  };
  const seed = async (type = 'tracking', mode = 'normal') => {
    await seedReconciliationRows(operator, []);
    await operator.query('TRUNCATE product_shipments, customer_email_outbox CASCADE');
    seen = []; unexpected = false;
    const reference = 'owned-execution-' + type, providerId = 'owned-provider-' + type;
    const now = new Date(), shipDate = now.toISOString().slice(0, 10), eventAt = new Date(now.getTime() - 1000).toISOString();
    const context = buildConfiguredQuoteContext({ destinationCountryCode: 'CA', region: 'ontario_manitoba', now });
    const order = (await operator.query(`INSERT INTO checkout_orders(order_id,purpose,status,payment_provider,provider_payment_id,
      customer_name,customer_email,amount_cents,merchandise_amount_cents,line_items,paid_at,payment_risk_status)
      VALUES('owned-execution-order','product','paid','square','owned-execution-payment','Owned fixture','owned@example.invalid',1500,500,'[]',now(),'cleared') RETURNING id`)).rows[0].id;
    const obligation = (await operator.query(`INSERT INTO order_payment_obligations(order_id,purpose,status,merchandise_amount_cents,
      shipping_amount_cents,tax_amount_cents,total_amount_cents,currency,source_workflow,tax_policy_version,policy_version,
      payment_provider,initialization_status,idempotency_key,paid_at)
      VALUES($1,'primary','paid',500,1000,0,1500,'CAD','automated_product_checkout','owned','owned','square','ready','owned-execution-obligation',now()) RETURNING id`, [order])).rows[0].id;
    await operator.query(`INSERT INTO order_payment_transactions(obligation_id,provider,provider_transaction_id,amount_cents,currency,
      provider_type,provider_status,risk_status,risk_reason_codes,captured_at)
      VALUES($1,'square','owned-execution-payment',1500,'CAD','PAYMENT','COMPLETED','cleared','[]',now())`, [obligation]);
    const status = type === 'create' ? 'quote_pending' : type === 'quote_refresh' ? 'quoted' : type === 'purchase' ? 'purchase_pending' :
      type === 'refund' ? 'refund_pending' : ['cleanup','delete'].includes(type) ? 'abandoned' : 'label_ready';
    const noProvider = type === 'create' || mode === 'flat' || mode === 'not-found' || mode === 'find-truncated' || mode === 'find-malformed';
    const destination = { name: 'Owned fixture', email: 'owned@example.invalid', phone: '0000000000',
      line1: '1 Fixture Road', city: 'Toronto', province: 'ON', postalCode: 'A1A1A1', country: 'CA', countryCode: 'CA' };
    const pkg = { profileId: 'owned', profileSlug: 'owned', packageType: 'parcel', lengthCm: 20, widthCm: 15, heightCm: 4,
      tareWeightGrams: 20, totalWeightGrams: 250 };
    const shipment = (await operator.query(`INSERT INTO product_shipments(order_id,public_reference,quote_token_hash,quote_fingerprint,
      status,destination,package_snapshot,customs_lines,rates,quote_expires_at,provider_shipment_id,deadline_policy_snapshot,
      selected_postage_type,quoted_shipping_cents,flat_rate,last_polled_at,pii_redaction_due_at)
      VALUES($1,$2,$2,$2,$3,$4,$5,'[]','[]',now()+interval '1 day',$6,$7,'chit_chats_select',1000,$8,now(),now()+interval '364 days') RETURNING id`,
      [['create','cleanup','delete'].includes(type) ? null : order,reference,status,destination,pkg,noProvider ? null : providerId,context,mode === 'flat'])).rows[0].id;
    await operator.query('UPDATE checkout_orders SET active_fulfillment_shipment_id=$1 WHERE id=$2', [shipment, order]);
    const payload = { expectedShipmentStateVersion: 1, measuredWeightGrams: 250, shipDate, merchandiseValueCents: 1000, atRiskValueCents: 1000 };
    const job = (await operator.query(`INSERT INTO product_shipment_jobs(shipment_id,type,status,idempotency_key,operation_payload_hash,payload,outcome_unknown)
      VALUES($1,$2,'queued',$3,$4,$5,$6) RETURNING id`, [shipment,type,'owned-execution/'+type,hashOperationPayload(payload),payload,['reconcile','pending'].includes(mode)])).rows[0].id;
    // A separate eligible row makes accidental redaction observable on failures.
    const canary = (await operator.query(`INSERT INTO product_shipments(public_reference,quote_token_hash,quote_fingerprint,status,
      destination,package_snapshot,customs_lines,rates,quote_expires_at,updated_at)
      VALUES('owned-redaction-canary','owned-redaction-canary','owned-redaction-canary','abandoned','{}','{}','[]','[]',now()-interval '31 days',now()-interval '31 days') RETURNING id`)).rows[0].id;
    const rate = { postage_type: 'chit_chats_select', payment_amount: '10.00', insurance_fee: '0.00', is_insured: true,
      tracking_type_description: 'Full Tracking', delivery_time_description: '2-5 business days' };
    const provider = { id: providerId, order_id: mode==='wrong-reference'?'unrelated-reference':reference, status: mode==='accepted' ? 'received' : 'ready', purchase_amount: mode === 'cost-decrease' ? '8.00' : '10.00',
      package_type: 'parcel', weight_unit: 'g', weight: 250, size_unit: 'cm', size_x: 20, size_y: 15, size_z: 4,
      signature_requested: false, ship_date: shipDate, rates: mode === 'no-rates' ? [] : [rate], updated_at: eventAt,
      tracking_events: [{ type: 'owned-observation', title: 'Owned observation', status: mode==='accepted' ? 'received' : 'ready', created_at: eventAt }] };
    if(mode==='missing-event-time') delete provider.tracking_events[0].created_at;
    if(mode==='future-event-time') provider.tracking_events[0].created_at=new Date(Date.now()+60000).toISOString();
    if(mode==='missing-settlement') delete provider.purchase_amount;
    const unpaid = { ...provider, status: 'unpaid' }, steps = [];
    if(mode==='pending') provider.status='postage_requested';
    const step = (method, suffix, body, error) => steps.push({ method, path: endpoint(suffix), body, error });
    if (type==='create' && mode==='reconcile') step('GET','?limit=100&page=1&q='+reference,{shipments:[unpaid]});
    if ((type === 'create' && mode!=='reconcile') || (type === 'purchase' && mode === 'flat')) step('POST','',{ shipment: unpaid });
    if (type === 'quote_refresh' || type === 'purchase') {
      step(['reconcile','pending'].includes(mode) ? 'GET' : 'PATCH', '/'+providerId+(['reconcile','pending'].includes(mode) ? '' : '/refresh'),
        { shipment: type === 'purchase' && ['reconcile','pending'].includes(mode) ? provider : unpaid });
      if (type === 'purchase' && !['reconcile','pending'].includes(mode)) step('PATCH','/'+providerId+'/buy',{ shipment: provider });
    }
    if (type === 'tracking') {
      const value = { ...provider, ...(mode === 'wrong-provider' ? { id: 'owned-unrelated-provider' } : {}),
        ...(mode === 'alert' || mode === 'alert-sibling' ? { purchase_amount: '11.00' } : {}) };
      step('GET','/'+providerId,{ shipment: value },mode === 'provider-error' ? 503 : undefined);
    }
    if (type === 'refund') step(mode === 'reconcile' ? 'GET' : 'PATCH','/'+providerId+(mode === 'reconcile' ? '' : '/refund'),
      { shipment: { ...provider, status: mode === 'refund-requested' ? 'ready' : 'voided' } });
    if (type === 'cleanup' || type === 'delete') {
      if (noProvider) step('GET','?limit=100&page=1&q='+reference,
        mode === 'find-malformed' ? {} : { shipments: mode === 'find-truncated' ? Array.from({length:100},(_,i)=>({id:'other-'+i,order_id:'other-'+i})) : [] });
      else {
        step('GET','/'+providerId,{ shipment: unpaid },mode === 'reconcile' ? 404 : undefined);
        if (mode !== 'reconcile') step('DELETE','/'+providerId);
      }
    }
    selected = { type, reference, shipment, job, canary, providerId, steps };
    return selected;
  };
  const receipts = async row => ({
    job: (await operator.query('SELECT status,outcome_code,state_version,lease_owner,outcome_unknown FROM product_shipment_jobs WHERE id=$1',[row.job])).rows[0],
    shipment: (await operator.query('SELECT status,state_version,provider_shipment_id,actual_purchase_total_cents FROM product_shipments WHERE id=$1',[row.shipment])).rows[0],
    redacted: (await operator.query('SELECT redacted_at FROM product_shipments WHERE id=$1',[row.canary])).rows[0].redacted_at,
  });
  const assertCalls = () => { assert.equal(unexpected,false); assert.deepEqual(seen,selected.steps.map(({method,path})=>({method,path}))); };
  try {
    for (const [type, mode] of [['create','normal'],['create','reconcile'],['quote_refresh','normal'],['quote_refresh','reconcile'],['purchase','normal'],['purchase','flat'],['purchase','reconcile'],
      ['tracking','normal'],['tracking','accepted'],['tracking','cost-decrease'],['refund','normal'],['refund','reconcile'],['cleanup','normal'],['delete','normal'],
      ['cleanup','reconcile'],['cleanup','not-found'],['create','no-rates']]) {
      setPhase('shipping-execution-'+type+'-'+mode);
      const row = await seed(type,mode); await change(true); const before = await operations();
      const result = await get(); assert.equal(result.status,200,JSON.stringify({type,mode,receipts:await receipts(row),seen,unexpected})); assertCalls();
      assert.deepEqual((await since(before)).map(r=>r.state),['completed','completed','completed','completed']);
      const actual = await receipts(row); assert.equal(actual.job.status,'succeeded'); assert.equal(actual.job.lease_owner,null);
      assert.ok(actual.redacted); assert.deepEqual(JSON.parse(result.text).operations,{claimed:1,succeeded:1,retried:0,deadLettered:0,fenced:0});
      if (type==='tracking' || type==='purchase') {
        assert.equal(actual.shipment.status,mode==='accepted'?'accepted':'label_ready'); assert.equal(actual.shipment.actual_purchase_total_cents,mode==='cost-decrease'?800:1000);
        assert.equal((await operator.query('SELECT 1 FROM product_shipment_events WHERE shipment_id=$1',[row.shipment])).rows.length,1);
      }
      if (mode==='cost-decrease') assert.deepEqual((await operator.query('SELECT amount_cents,status FROM product_order_refunds')).rows,[{amount_cents:200,status:'queued'}]);
      if (mode==='no-rates') {
        const cleanup=(await operator.query("SELECT type,status,payload FROM product_shipment_jobs WHERE id<>$1",[row.job])).rows;
        assert.deepEqual(cleanup,[{type:'cleanup',status:'queued',payload:{expectedShipmentStateVersion:3}}]);
      }
      await reconcile(); checks.push('shipping-execution-'+type+'-'+mode+'-exact-provider-and-durable-receipts');
    }
    for (const [type, mode] of [['tracking','missing-event-time'],['tracking','future-event-time'],['tracking','missing-settlement'],['create','wrong-reference'],['quote_refresh','wrong-reference'],['purchase','wrong-reference'],['purchase','pending'],['refund','wrong-reference'],['delete','wrong-reference'],['tracking','wrong-provider'],['tracking','provider-error'],['refund','refund-requested'],
      ['cleanup','find-truncated'],['cleanup','find-malformed'],['notification','normal'],['replacement_prepare','normal'],['address_replace','normal']]) {
      setPhase('shipping-execution-uncertain-'+type+'-'+mode);
      const row = await seed(type,mode); await change(true); const before = await operations();
      assert.equal((await get()).status,503);
      if (mode==='wrong-reference' && ['purchase','delete'].includes(type)) {
        assert.equal(unexpected,false); assert.equal(seen.length,1);
        assert.deepEqual(seen,selected.steps.slice(0,1).map(({method,path})=>({method,path})));
      } else assertCalls();
      assert.deepEqual((await since(before)).map(r=>r.state),['uncertain','completed','completed']);
      assert.equal((await receipts(row)).redacted,null);
      await reconcile(); checks.push('shipping-execution-uncertain-'+type+'-'+mode+'-blocks-redaction');
    }
    const faults = [
      ['missing-claim','tracking','normal','product_shipment_jobs','UPDATE',"NEW.status='processing' AND OLD.status='queued'",'RETURN NULL',0],
      ['changed-claim-payload','tracking','normal','product_shipment_jobs','UPDATE',"NEW.status='processing' AND OLD.status='queued'", "NEW.payload='{}'::jsonb; RETURN NEW",0],
      ...[
        ['type',"NEW.type='notification'"],['key',"NEW.idempotency_key=NEW.idempotency_key||'/changed'"],
        ['hash',"NEW.operation_payload_hash=repeat('f',64)"],['owner',"NEW.lease_owner='unrelated-worker'"],
        ['version','NEW.state_version=OLD.state_version'],['attempts','NEW.attempt_count=OLD.attempt_count'],
      ].map(([name,body])=>['changed-claim-'+name,'tracking','normal','product_shipment_jobs','UPDATE',"NEW.status='processing' AND OLD.status='queued'",body+'; RETURN NEW',0]),
      ['missing-draft','create','normal','product_shipments','UPDATE',"NEW.provider_shipment_id IS NOT NULL AND OLD.provider_shipment_id IS NULL",'RETURN NULL',1],
      ['missing-quote','quote_refresh','normal','product_shipments','UPDATE',"NEW.state_version>OLD.state_version",'RETURN NULL',1],
      ['missing-purchase-intent','purchase','normal','product_shipment_jobs','UPDATE',"NEW.outcome_code='purchase_provider_call_intent_recorded'",'RETURN NULL',1],
      ['missing-intent','create','normal','product_shipment_jobs','UPDATE',"NEW.outcome_code='provider_mutation_intent_recorded'",'RETURN NULL',0],
      ['changed-intent','create','normal','product_shipment_jobs','UPDATE',"NEW.outcome_code='provider_mutation_intent_recorded'", "NEW.outcome_code='owned-changed'; RETURN NEW",0],
      ['missing-shipment','tracking','normal','product_shipments','UPDATE',"NEW.public_reference='owned-execution-tracking' AND NEW.state_version>OLD.state_version",'RETURN NULL',1],
      ['changed-shipment-cost','tracking','normal','product_shipments','UPDATE',"NEW.public_reference='owned-execution-tracking' AND NEW.state_version>OLD.state_version",'NEW.actual_purchase_total_cents=1; RETURN NEW',1],
      ['changed-shipment-version','tracking','normal','product_shipments','UPDATE',"NEW.public_reference='owned-execution-tracking' AND NEW.state_version>OLD.state_version",'NEW.state_version=OLD.state_version; RETURN NEW',1],
      ['changed-shipment-payload','tracking','normal','product_shipments','UPDATE',"NEW.public_reference='owned-execution-tracking' AND NEW.state_version>OLD.state_version", "NEW.raw_shipment='{}'::jsonb; RETURN NEW",1],
      ['missing-completion','tracking','normal','product_shipment_jobs','UPDATE',"NEW.status='succeeded'",'RETURN NULL',1],
      ['changed-completion-code','tracking','normal','product_shipment_jobs','UPDATE',"NEW.status='succeeded'", "NEW.outcome_code='owned-changed'; RETURN NEW",1],
      ['changed-completion-payload','tracking','normal','product_shipment_jobs','UPDATE',"NEW.status='succeeded'", "NEW.payload='{}'::jsonb; RETURN NEW",1],
      ['missing-event','tracking','normal','product_shipment_events','INSERT','true','RETURN NULL',1],
      ['changed-event','tracking','normal','product_shipment_events','INSERT','true', "NEW.payload='{}'::jsonb; RETURN NEW",1],
      ['missing-movement','tracking','normal','product_shipments','UPDATE',"NEW.state_version=OLD.state_version AND NEW.last_carrier_movement_at IS DISTINCT FROM OLD.last_carrier_movement_at",'RETURN NULL',1],
      ['missing-notification','tracking','accepted','customer_email_outbox','INSERT','true','RETURN NULL',1],
      ['changed-alert','tracking','alert','customer_email_outbox','INSERT','true',"NEW.template_data_ciphertext='owned-invalid'; RETURN NEW",1],
      ['missing-alert','tracking','alert','customer_email_outbox','INSERT','true','RETURN NULL',1],
      ['changed-refund','tracking','cost-decrease','product_order_refunds','INSERT','true','NEW.amount_cents=9999; RETURN NEW',1],
      ['missing-refund','tracking','cost-decrease','product_order_refunds','INSERT','true','RETURN NULL',1],
      ['changed-adjustment','tracking','cost-decrease','product_order_adjustments','INSERT','true',"NEW.component='tax'; RETURN NEW",1],
      ['missing-cleanup-handoff','create','no-rates','product_shipment_jobs','INSERT',"NEW.type='cleanup'",'RETURN NULL',1],
      ['missing-retry','tracking','provider-error','product_shipment_jobs','UPDATE',"NEW.status='retryable_failed'",'RETURN NULL',1],
      ['changed-retry-identity','tracking','provider-error','product_shipment_jobs','UPDATE',"NEW.status='retryable_failed'", "NEW.payload='{}'::jsonb; RETURN NEW",1],
    ];
    for (const [name,type,mode,table,event,condition,body,callCount] of faults) {
      setPhase('shipping-execution-'+name);
      const row = await seed(type,mode); await change(true); const before = await operations();
      await operator.query(`CREATE OR REPLACE FUNCTION pg_temp.owned_execution_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body}; END $$`);
      await operator.query(`CREATE TRIGGER owned_execution_fault BEFORE ${event} ON ${table} FOR EACH ROW WHEN (${condition}) EXECUTE FUNCTION pg_temp.owned_execution_fault()`);
      let result;
      try { result = await get(); } finally { await operator.query(`DROP TRIGGER owned_execution_fault ON ${table}`); }
      assert.equal(result.status,503,name); assert.equal(unexpected,false); assert.equal(seen.length,callCount,name);
      assert.deepEqual(seen,selected.steps.slice(0,callCount).map(({method,path})=>({method,path})));
      assert.deepEqual((await since(before)).map(r=>r.state),['uncertain','completed','completed']);
      assert.equal((await receipts(row)).redacted,null);
      await reconcile(); checks.push('shipping-execution-'+name+'-real-database-receipt-retains-uncertainty');
    }
    setPhase('shipping-execution-batch-failure-keeps-later-job');
    {
      const row=await seed('tracking','provider-error');
      const second=(await operator.query(`INSERT INTO product_shipments(public_reference,quote_token_hash,quote_fingerprint,status,
        destination,package_snapshot,customs_lines,rates,quote_expires_at,provider_shipment_id,last_polled_at,pii_redaction_due_at)
        SELECT 'owned-execution-second','owned-execution-second','owned-execution-second',status,destination,package_snapshot,
        customs_lines,rates,quote_expires_at,'owned-provider-second',now(),pii_redaction_due_at FROM product_shipments WHERE id=$1 RETURNING id`,[row.shipment])).rows[0].id;
      const secondJob=(await operator.query(`INSERT INTO product_shipment_jobs(shipment_id,type,status,idempotency_key,operation_payload_hash,payload,created_at)
        SELECT $1,type,status,'owned-execution/second',operation_payload_hash,payload,created_at+interval '1 second'
        FROM product_shipment_jobs WHERE id=$2 RETURNING id`,[second,row.job])).rows[0].id;
      const now=new Date(Date.now()-1000).toISOString();
      selected.steps.push({method:'GET',path:endpoint('/owned-provider-second'),body:{shipment:{id:'owned-provider-second',order_id:'owned-execution-second',status:'ready',purchase_amount:'10.00',updated_at:now}}});
      await change(true); const before=await operations(); const result=await get();
      assert.equal(result.status,503); assertCalls();
      assert.deepEqual((await since(before)).map(r=>r.state),['uncertain','completed','completed']);
      assert.equal((await operator.query('SELECT status FROM product_shipment_jobs WHERE id=$1',[secondJob])).rows[0].status,'succeeded');
      assert.equal((await receipts(row)).redacted,null); await reconcile();
      checks.push('shipping-execution-first-job-failure-awaits-later-claimed-job-before-uncertain-settlement');
    }
    // Admission covers a provider call even after its business lease expires.
    for (const terminate of [false, true]) {
      setPhase(terminate ? 'shipping-execution-ledger-termination' : 'shipping-execution-provider-closure-lease-expiry');
      const row = await seed(); await change(true); const before = await operations();
      providerHold = hold(); const pending = get(); await providerHold.entered;
      await operator.query("UPDATE product_shipment_jobs SET lease_expires_at=now()-interval '1 hour' WHERE id=$1",[row.job]);
      await change(false); assert.equal((await drain()).ledgerDrained,false);
      assert.deepEqual((await since(before)).map(r=>r.state),['active','completed','completed']);
      assert.equal((await get()).status,503); assert.equal(seen.length,1);
      if (terminate) {
        const sessions=(await operator.query("SELECT pid FROM pg_stat_activity WHERE usename=$1 AND application_name='lash-her-frontend-writer-admission'",[target.user])).rows;
        assert.equal(sessions.length,1); await operator.query('SELECT pg_terminate_backend($1,1000)',[sessions[0].pid]); await delay(25);
      }
      providerHold.release(); assert.equal((await pending).status,terminate?503:200); providerHold=undefined; assertCalls();
      assert.deepEqual((await since(before)).map(r=>r.state),[terminate?'active':'completed','completed','completed']);
      assert.equal((await receipts(row)).job.status,'succeeded');
      assert.equal((await receipts(row)).redacted,null);
      assert.equal((await get()).status,503); assertCalls(); await reconcile();
      checks.push(terminate?'shipping-execution-ledger-death-keeps-unresolved-entry-and-never-replays-prior-batches':
        'shipping-execution-closure-and-expired-business-lease-hold-admission-through-provider-and-receipts');
    }
    for (const stage of ['claim','persistence']) {
      setPhase('shipping-execution-'+stage+'-closure');
      const table=stage==='claim'?'product_shipment_jobs':'product_shipments';
      const condition=stage==='claim'?"NEW.status='processing' AND OLD.status='queued'":"NEW.public_reference='owned-execution-tracking' AND NEW.state_version>OLD.state_version";
      const row=await seed(); await change(true); const before=await operations(), blocker=await connect();
      await blocker.query('SELECT pg_advisory_lock(90191)');
      await operator.query(`CREATE OR REPLACE FUNCTION pg_temp.owned_execution_claim_hold() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_advisory_xact_lock(90191); RETURN NEW; END $$`);
      await operator.query(`CREATE TRIGGER owned_execution_claim_hold BEFORE UPDATE ON ${table} FOR EACH ROW
        WHEN (${condition}) EXECUTE FUNCTION pg_temp.owned_execution_claim_hold()`);
      const pending=get();
      try {
        await until(async()=>Number((await operator.query("SELECT count(*) FROM pg_stat_activity WHERE usename=$1 AND cardinality(pg_blocking_pids(pid))>0",[target.user])).rows[0].count)>0);
        await change(false); assert.equal((await drain()).ledgerDrained,false); assert.equal(seen.length,stage==='claim'?0:1);
        assert.deepEqual((await since(before)).map(r=>r.state),['active','completed','completed']);
        assert.equal((await get()).status,503);
      } finally { await blocker.query('SELECT pg_advisory_unlock(90191)'); }
      assert.equal((await pending).status,200); assertCalls(); assert.equal((await receipts(row)).job.status,'succeeded');
      await operator.query(`DROP TRIGGER owned_execution_claim_hold ON ${table}`);
      await reconcile(); checks.push('shipping-execution-closure-during-'+stage+'-preserves-active-ledger-until-batch-finishes');
    }
    setPhase('shipping-execution-alert-sibling-failure');
    {
      process.env.ADMIN_OWNER_EMAILS='first@example.invalid,second@example.invalid';
      const row=await seed('tracking','alert-sibling'); await change(true); const before=await operations(), blocker=await connect();
      const {createHash}=await import('node:crypto');
      const first=createHash('sha256').update('first@example.invalid').digest('hex').slice(0,16);
      await blocker.query('SELECT pg_advisory_lock(90192)');
      await operator.query(`CREATE FUNCTION pg_temp.owned_execution_alert_hold() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.provider_idempotency_key LIKE '%/${first}' THEN RAISE EXCEPTION 'owned-alert-failure'; END IF;
        PERFORM pg_advisory_xact_lock(90192); RETURN NEW; END $$`);
      await operator.query(`CREATE TRIGGER owned_execution_alert_hold BEFORE INSERT ON customer_email_outbox FOR EACH ROW EXECUTE FUNCTION pg_temp.owned_execution_alert_hold()`);
      const pending=get();
      try {
        await until(async()=>Number((await operator.query("SELECT count(*) FROM pg_stat_activity WHERE usename=$1 AND cardinality(pg_blocking_pids(pid))>0",[target.user])).rows[0].count)>0);
        await change(false); assert.equal((await drain()).ledgerDrained,false);
        assert.deepEqual((await since(before)).map(r=>r.state),['active','completed','completed']);
        assert.equal((await receipts(row)).redacted,null); assert.equal((await get()).status,503);
      } finally { await blocker.query('SELECT pg_advisory_unlock(90192)'); }
      assert.equal((await pending).status,503); assertCalls();
      assert.deepEqual((await since(before)).map(r=>r.state),['uncertain','completed','completed']);
      assert.equal((await receipts(row)).redacted,null);
      assert.equal((await operator.query('SELECT count(*) FROM customer_email_outbox')).rows[0].count,'1');
      await operator.query('DROP TRIGGER owned_execution_alert_hold ON customer_email_outbox');
      process.env.ADMIN_OWNER_EMAILS=env.ADMIN_OWNER_EMAILS; await reconcile();
      checks.push('shipping-execution-alert-failure-awaits-blocked-sibling-before-uncertain-settlement');
    }
    for (const path of ['/direct-worker','/manual-worker','/direct-claimed']) {
      setPhase('shipping-execution-'+path.slice(1));
      const row=await seed(); await change(true); const before=await operations();
      let endpoint=path;
      if(path==='/direct-claimed') {
        await operator.query("UPDATE product_shipment_jobs SET status='processing',lease_owner='owned-direct',lease_expires_at=now()+interval '5 minutes',state_version=state_version+1,attempt_count=attempt_count+1 WHERE id=$1",[row.job]);
        endpoint+='?id='+row.job;
      }
      expectedActive=path==='/manual-worker'?2:1;
      try {
        const result=await get(endpoint); assert.equal(result.status,200); assertCalls();
        assert.deepEqual((await since(before)).map(r=>r.state),Array(expectedActive).fill('completed'));
        assert.equal((await receipts(row)).job.status,'succeeded');
        assert.equal((await receipts(row)).redacted,null);
      } finally { expectedActive=1; }
      await reconcile(); checks.push('shipping-execution-'+path.slice(1)+'-has-independent-whole-operation-admission');
    }
    setPhase('shipping-recovery-with-new-work-closed');
    {
      const row=await seed(); await change(true,false); const before=await operations();
      const result=await get(); assert.equal(result.status,200); assertCalls();
      const body=JSON.parse(result.text); assert.equal(body.redactionSkipped,true); assert.equal(Object.hasOwn(body,'redacted'),false);
      assert.equal((await receipts(row)).redacted,null);
      assert.deepEqual((await since(before)).map(r=>r.state),['completed','completed','completed']);
      await reconcile(); checks.push('shipping-whole-recovery-finishes-when-maintenance-is-closed-with-explicit-skip-and-no-fabricated-zero');
    }
    setPhase('shipping-pii-eligibility-and-receipts');
    {
      const row=await seed();
      const order=(await operator.query('SELECT order_id FROM product_shipments WHERE id=$1',[row.shipment])).rows[0].order_id;
      await operator.query('UPDATE checkout_orders SET redacted_at=now() WHERE id=$1',[order]);
      const ids=[];
      for(const status of ['delivered','voided','accepted']) {
        ids.push((await operator.query(`INSERT INTO product_shipments(order_id,public_reference,quote_token_hash,quote_fingerprint,status,destination,package_snapshot,customs_lines,rates,raw_shipment,tracking_url,quote_expires_at,sequence)
          VALUES($1,$2,$2,$2,$3,'{"line1":"synthetic-private-address"}','{}','[{"fixture":true}]','[{"fixture":true}]','{"fixture":true}','https://owned.invalid/private',now(),$4) RETURNING id`,[order,'owned-pii-'+status,status,ids.length+1])).rows[0].id);
      }
      const recent=(await operator.query(`INSERT INTO product_shipments(public_reference,quote_token_hash,quote_fingerprint,status,destination,package_snapshot,customs_lines,rates,quote_expires_at,updated_at)
        VALUES('owned-pii-recent','owned-pii-recent','owned-pii-recent','abandoned','{}','{}','[]','[]',now(),now()-interval '29 days') RETURNING id`)).rows[0].id;
      await change(true); const before=await operations();
      const result=await get('/direct-redaction'); assert.equal(result.status,200); assert.equal(JSON.parse(result.text).redacted,3);
      assert.deepEqual((await since(before)).map(r=>[r.kind,r.state]),[['new-work','completed']]);
      const rows=(await operator.query('SELECT id,destination,customs_lines,rates,raw_shipment,tracking_url,quote_token_hash,redacted_at FROM product_shipments WHERE id=ANY($1::uuid[])',[ids])).rows;
      for(const id of ids.slice(0,2)) {
        const actual=rows.find(r=>r.id===id); assert.ok(actual.redacted_at);
        assert.deepEqual(actual.destination,{line1:'[redacted]',city:'[redacted]',province:'--',postalCode:'[redacted]',country:'[redacted]'});
        assert.deepEqual(actual.customs_lines,[]); assert.deepEqual(actual.rates,[]); assert.equal(actual.raw_shipment,null);
        assert.equal(actual.tracking_url,null); assert.equal(actual.quote_token_hash,'redacted:'+id);
      }
      assert.equal(rows.find(r=>r.id===ids[2]).redacted_at,null);
      assert.equal((await operator.query('SELECT redacted_at FROM product_shipments WHERE id=$1',[recent])).rows[0].redacted_at,null);
      assert.equal((await receipts(row)).job.status,'queued'); assert.equal(seen.length,0);
      await reconcile(); checks.push('shipping-pii-preserves-retention-eligibility-and-validates-complete-private-field-redaction-without-processing-jobs');
    }
    for(const [name,event,body] of [
      ['missing','BEFORE','RETURN NULL'],
      ['destination','BEFORE',"NEW.destination='{}'::jsonb; RETURN NEW"],
      ['customs','BEFORE',"NEW.customs_lines='[{\"retained\":true}]'::jsonb; RETURN NEW"],
      ['rates','BEFORE',"NEW.rates='[{\"retained\":true}]'::jsonb; RETURN NEW"],
      ['raw','BEFORE',"NEW.raw_shipment='{\"retained\":true}'::jsonb; RETURN NEW"],
      ['tracking','BEFORE',"NEW.tracking_url='https://owned.invalid/retained'; RETURN NEW"],
      ['token','BEFORE','NEW.quote_token_hash=OLD.quote_token_hash; RETURN NEW'],
      ['timestamp','BEFORE','NEW.redacted_at=NULL; RETURN NEW'],
      ['after-trigger','AFTER',"IF NEW.destination->>'line1'='[redacted]' THEN UPDATE product_shipments SET destination='{\"retained\":true}'::jsonb WHERE id=NEW.id; END IF; RETURN NULL"],
    ]) {
      setPhase('shipping-pii-'+name);
      const row=await seed(); await change(true); const before=await operations();
      await operator.query(`CREATE OR REPLACE FUNCTION pg_temp.owned_pii_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body}; END $$`);
      await operator.query(`CREATE TRIGGER owned_pii_fault ${event} UPDATE ON product_shipments FOR EACH ROW WHEN (NEW.redacted_at IS NOT NULL) EXECUTE FUNCTION pg_temp.owned_pii_fault()`);
      let result;
      try { result=await get(name==='missing'?undefined:'/direct-redaction'); } finally { await operator.query('DROP TRIGGER owned_pii_fault ON product_shipments'); }
      assert.equal(result.status,503);
      assert.deepEqual((await since(before)).map(r=>[r.kind,r.state]),name==='missing'?
        [['recovery','uncertain'],['recovery','completed'],['recovery','completed'],['new-work','uncertain']]:[['new-work','uncertain']]);
      assert.equal((await receipts(row)).job.status,name==='missing'?'succeeded':'queued'); assert.equal(seen.length,name==='missing'?1:0);
      await reconcile(); checks.push('shipping-pii-'+name+'-database-fault-keeps-unknown-maintenance-outcome');
    }
    for(const terminate of [false,true]) {
      setPhase('shipping-pii-'+(terminate?'ledger-death':'closure'));
      const row=await seed(); await change(true); const before=await operations(), blocker=await connect();
      await blocker.query('BEGIN'); await blocker.query('SELECT id FROM product_shipments WHERE id=$1 FOR UPDATE',[row.canary]);
      const pending=get('/direct-redaction');
      try {
        await until(async()=>Number((await operator.query("SELECT count(*) FROM pg_stat_activity WHERE usename=$1 AND cardinality(pg_blocking_pids(pid))>0",[target.user])).rows[0].count)>0);
        await change(false); assert.equal((await drain()).ledgerDrained,false);
        assert.deepEqual((await since(before)).map(r=>[r.kind,r.state]),[['new-work','active']]);
        assert.equal((await get('/direct-redaction')).status,503);
        if(terminate) {
          const sessions=(await operator.query("SELECT pid FROM pg_stat_activity WHERE usename=$1 AND application_name='lash-her-frontend-writer-admission'",[target.user])).rows;
          assert.equal(sessions.length,1); await operator.query('SELECT pg_terminate_backend($1,1000)',[sessions[0].pid]); await delay(25);
        }
      } finally { await blocker.query('ROLLBACK'); }
      assert.equal((await pending).status,terminate?503:200);
      assert.ok((await receipts(row)).redacted);
      assert.deepEqual((await since(before)).map(r=>r.state),[terminate?'active':'completed']);
      assert.equal(seen.length,0); await reconcile();
      checks.push('shipping-pii-'+(terminate?'ledger-death':'closure')+'-retains-whole-transaction-and-committed-redaction-without-replay');
    }
    for(const point of ['admission','completion']) {
      setPhase('shipping-whole-'+point+'-acknowledgement-loss');
      const row=await seed(); await change(true); const before=await operations();
      const originalQuery=Client.prototype.query; let intercepted=false, victim;
      Client.prototype.query=function(...args) {
        const result=originalQuery.apply(this,args);
        const sql=args[0], values=args[1];
        if(!intercepted && typeof sql==='string' && this.connectionParameters.user===target.user &&
          (point==='admission'?sql.includes('begin_operation'):sql.includes('finish_operation') && values?.[0]===victim)) {
          intercepted=true; return result.then(()=>{throw new Error('owned-lost-shipping-acknowledgement');});
        }
        return result;
      };
      try {
        let pending;
        if(point==='completion') {
          providerHold=hold(); pending=get(); await providerHold.entered;
          victim=(await since(before)).find(r=>r.state==='active').id;
          providerHold.release(); providerHold=undefined;
        } else pending=get();
        assert.equal((await pending).status,503); assert.equal(intercepted,true);
      } finally { Client.prototype.query=originalQuery; }
      assert.equal(seen.length,point==='admission'?0:1);
      assert.equal((await receipts(row)).job.status,point==='admission'?'queued':'succeeded');
      assert.deepEqual((await since(before)).map(r=>r.state),point==='admission'?['active']:Array(4).fill('completed'));
      await reconcile(); checks.push('shipping-whole-'+point+'-lost-acknowledgement-refuses-without-replaying-effects-or-fabricating-a-receipt');
    }
    setPhase('shipping-execution-off-compatibility');
    {
      const row=await seed('notification'); await change(true); const before=await operations();
      process.env.FRONTEND_WRITER_ADMISSION_MODE='off';
      try { const result=await get(); assert.equal(result.status,200); assert.equal(JSON.parse(result.text).operations.succeeded,1); }
      finally { process.env.FRONTEND_WRITER_ADMISSION_MODE='enforce'; }
      assert.deepEqual(await since(before),[]); assertCalls(); assert.ok((await receipts(row)).redacted);
      await reconcile(); checks.push('shipping-execution-off-preserves-legacy-notification-counters-without-ledger-entry');
    }
  } finally {
    providerHold?.release(); globalThis.fetch = originalFetch;
    for (const [key,value] of Object.entries(prior)) { if (value===undefined) delete process.env[key]; else process.env[key]=value; }
  }
}
