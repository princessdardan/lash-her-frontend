// Loads the actual server-only route adapter under native Node24 type stripping.
// Resolution hooks and fixture drivers exist only inside this disposable test.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { changeFrontendAdmission, observeFrontendDrain, reconcileFrontendOperation } from "../frontend-admission.mjs";

export async function exerciseFrontendWriterRoutes(connect, makeClient, password, major) {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return nextResolve(pathToFileURL(join(root, "node_modules/server-only/empty.js")).href, context);
    if (specifier.startsWith("@/")) {
      const path = join(root, "src", specifier.slice(2));
      for (const candidate of [path, `${path}.ts`, `${path}.mjs`]) if (existsSync(candidate)) return nextResolve(pathToFileURL(candidate).href, context);
    }
    return nextResolve(specifier, context);
  } });
  let createWriterAdmissionRunner, withWriterAdmission, markWriterOperationUncertain;
  try {
    ({ createWriterAdmissionRunner } = await import(pathToFileURL(join(root, "src/lib/writer-admission/runtime.ts")).href));
    ({ withWriterAdmission } = await import(pathToFileURL(join(root, "src/lib/writer-admission/route.ts")).href));
    ({ markWriterOperationUncertain } = await import(pathToFileURL(join(root, "src/lib/writer-admission/context.ts")).href));
  } finally { hooks.deregister(); }
  const operator = await connect("frontend_admission_owned"), checks = [];
  const target = { environment: "staging", host: "127.0.0.1", port: operator.connectionParameters.port,
    database: "frontend_admission_owned", user: "frontend_admission_protocol", serverMajor: major, targetSha256: "a".repeat(64) };
  let epoch = (await operator.query("SELECT epoch::text FROM frontend_admission.control")).rows[0].epoch;
  const change = async (newWork, recovery) => { epoch = (await changeFrontendAdmission(operator, target, epoch, { newWork, recovery })).epoch; };
  const drain = () => observeFrontendDrain(operator, target, epoch);
  const configuration = { target, producerSha256: "b".repeat(64), sourceSha: "c".repeat(40), connection: {
    host: target.host, port: target.port, database: target.database, user: target.user, password,
    ssl: { rejectUnauthorized: true }, enableChannelBinding: true, connectionTimeoutMillis: 5000,
    statement_timeout: 10000, lock_timeout: 1000, application_name: "owned-frontend-writer-admission" } };
  let selectedClient;
  const clientFactory = options => { selectedClient = makeClient(options); return selectedClient; };
  const run = createWriterAdmissionRunner({ getConfiguration: () => configuration, createClient: clientFactory });
  const request = () => new Request("https://owned.invalid/webhook", { method: "POST", body: "signed-original-body" });
  let effects = 0;
  const recovery = withWriterAdmission("recovery", async req => {
    assert.equal(await req.text(), "signed-original-body"); effects++; return Response.json({ ok: true });
  }, run);
  assert.equal((await recovery(request())).status, 503); assert.equal(effects, 0);
  const reader = await connect(target.database, target.user), historical = await connect(target.database, "frontend_runtime");
  const policyArgs = [target.environment, target.targetSha256, configuration.producerSha256, configuration.sourceSha];
  await assert.rejects(reader.query("SELECT * FROM frontend_admission.current_policy($1,$2,$3,$4)", [...policyArgs.slice(0, 3), "e".repeat(40)]));
  await assert.rejects(historical.query("SELECT * FROM frontend_admission.current_policy($1,$2,$3,$4)", policyArgs));
  checks.push("closed-policy-and-unknown-source-or-legacy-login-refuse-before-route-effects");
  await change(true, true);
  let release, started;
  const held = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { started = resolve; });
  const checkout = withWriterAdmission("new-work", async () => {
    assert.equal((await drain()).active, 1); effects++; started(); await held; return Response.json({ ok: true });
  }, run);
  const pending = checkout(request()); await entered;
  await change(false, true);
  const oldEffects = effects;
  assert.equal((await withWriterAdmission("new-work", async () => { effects++; return Response.json({ ok: true }); }, run)(request())).status, 503);
  assert.equal(effects, oldEffects);
  assert.equal((await recovery(request())).status, 200);
  assert.equal((await drain()).active, 1);
  await change(false, false); assert.equal((await drain()).ledgerDrained, false);
  release(); assert.equal((await pending).status, 200); assert.equal((await drain()).ledgerDrained, true);
  checks.push("committed-admission-precedes-handler-and-closing-new-work-preserves-current-epoch-recovery");
  checks.push("admitted-request-remains-active-through-all-awaited-handler-work");
  await change(true, true);
  let intercepted = 0;
  const raceRun = createWriterAdmissionRunner({ getConfiguration: () => configuration, createClient: options => {
    const client = clientFactory(options), query = client.query.bind(client);
    client.query = async (sql, values) => { if (sql.includes("begin_operation")) { intercepted++; await change(false, false); } return query(sql, values); };
    return client;
  } });
  const beforeRace = effects;
  assert.equal((await withWriterAdmission("new-work", async () => { effects++; return Response.json({ ok: true }); }, raceRun)(request())).status, 503);
  assert.equal(effects, beforeRace); assert.equal(intercepted, 1); assert.equal((await drain()).ledgerDrained, true);
  checks.push("policy-close-between-observation-and-commit-refuses-without-starting-handler");
  await change(true, true);
  const failing = withWriterAdmission("recovery", async () => Response.json({ error: "ambiguous-provider-result" }, { status: 500 }), run);
  assert.equal((await failing(request())).status, 503);
  await change(false, false); assert.equal((await drain()).uncertain, 1); assert.equal((await drain()).ledgerDrained, false);
  const uncertain = (await operator.query("SELECT id FROM frontend_admission.operations WHERE state='uncertain'")).rows[0].id;
  await reconcileFrontendOperation(operator, target, epoch, uncertain, "d".repeat(64));
  checks.push("caught-handler-5xx-records-uncertainty-and-never-acknowledges-webhook-success");
  await change(true, true);
  assert.equal((await withWriterAdmission("new-work", async () => {
    markWriterOperationUncertain(); await Promise.resolve(); return Response.json({ ok: true });
  }, run)(request())).status, 503);
  await change(false, false); assert.equal((await drain()).uncertain, 1); assert.equal((await drain()).ledgerDrained, false);
  const hidden = (await operator.query("SELECT id FROM frontend_admission.operations WHERE state='uncertain'")).rows[0].id;
  await reconcileFrontendOperation(operator, target, epoch, hidden, "d".repeat(64));
  checks.push("caught-domain-errors-behind-http-success-remain-uncertain-until-owner-reconciliation");
  await change(true, true);
  const lostRun = createWriterAdmissionRunner({ getConfiguration: () => configuration, createClient: options => {
    const client = clientFactory(options), query = client.query.bind(client);
    client.query = async (sql, values) => { const result = await query(sql, values); if (sql.includes("finish_operation")) throw new Error("owned-private-marker"); return result; };
    return client;
  } });
  const beforeLost = effects;
  assert.equal((await withWriterAdmission("recovery", async () => { effects++; return Response.json({ ok: true }); }, lostRun)(request())).status, 503);
  assert.equal(effects, beforeLost + 1); await change(false, false); assert.equal((await drain()).ledgerDrained, true);
  checks.push("lost-settlement-acknowledgement-returns-503-without-replaying-successful-effects");
  await change(true, true);
  let releaseDead, enteredDead;
  const holdDead = new Promise(resolve => { releaseDead = resolve; }), startDead = new Promise(resolve => { enteredDead = resolve; });
  const deadResponse = withWriterAdmission("recovery", async () => { enteredDead(); await holdDead; return Response.json({ ok: true }); }, run)(request());
  await startDead; await change(false, false);
  const disconnected = new Promise(resolve => selectedClient.once("error", resolve));
  await operator.query("SELECT pg_terminate_backend($1,1000)", [selectedClient.processID]); await disconnected;
  releaseDead(); assert.equal((await deadResponse).status, 503);
  assert.equal((await drain()).active, 1); assert.equal((await drain()).ledgerDrained, false);
  const abandoned = (await operator.query("SELECT id FROM frontend_admission.operations WHERE state='active'")).rows[0].id;
  await reconcileFrontendOperation(operator, target, epoch, abandoned, "d".repeat(64));
  checks.push("actual-idle-runtime-connection-loss-retains-active-operation-and-retryable-response");
  assert.equal((await drain()).migrationAuthorized, false);
  return checks;
}
