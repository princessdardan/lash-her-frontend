import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { frontendCrmShippingQueries, frontendCrmShippingSnapshotSha256, observeFrontendCrmShippingDatabase } from "./frontend-crm-shipping-effects.mjs";

const host = fileURLToPath(new URL("./host", import.meta.url));
const base = { environment: "staging", sourceBindingSha256: "a".repeat(64), databaseSnapshotSha256: "b".repeat(64),
  retiredCredentialBindingSha256: "c".repeat(64), replacementCredentialBindingSha256: "d".repeat(64) };
const bindings = {
  highlevel: { ...base, locationId: "owned-location", companyId: "owned-company", credentialKind: "private-integration-token",
    retiredIntegrationId: "owned-integration", expectedProviderContactIds: [], expectedWorkflowIds: [] },
  chitchats: { ...base, clientId: "owned-client", credentialKind: "personal-access-token", expectedProviderShipmentIds: [] },
};
const python = code => JSON.parse(execFileSync("python3", ["-I", "-B", "-c", `import sys,json; sys.path.insert(0,sys.argv[1]); import frontend_crm_shipping_retirement as m; ${code}`, host],
  { input: JSON.stringify(bindings), encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } }));

test("every fixed Node SQL projection and parameter exactly matches the source-owned provider component", () => {
  const expected = python("bindings=json.loads(sys.stdin.read()); print(json.dumps({p:m.database_queries(p,b) for p,b in bindings.items()}))");
  for (const provider of ["highlevel", "chitchats"]) assert.deepEqual(frontendCrmShippingQueries(provider, bindings[provider]), expected[provider]);
  assert.throws(() => frontendCrmShippingQueries("highlevel", { ...bindings.highlevel, locationId: "vd09FLBpPLXuHb5Tnhn4" }));
  assert.throws(() => frontendCrmShippingQueries("arbitrary-provider", bindings.chitchats));
});

test("canonical snapshot hashes match Python for nested, non-ASCII and control metadata", () => {
  const value = { z: [null, true, 10, "caf\u00e9", String.fromCodePoint(0x1f600), "\u007f"], a: { y: "\n", x: false } };
  const result = JSON.parse(execFileSync("python3", ["-I", "-B", "-c", "import sys,json; sys.path.insert(0,sys.argv[1]); import frontend_crm_shipping_retirement as m; print(json.dumps(m.snapshot_sha256(json.loads(sys.stdin.read()))))", host],
    { input: JSON.stringify(value), encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } }));
  assert.equal(frontendCrmShippingSnapshotSha256(value), result);
});

test("the bridge observes every fixed query in one read-only snapshot and refuses overflow or lost verification", async () => {
  const observed = [], queries = frontendCrmShippingQueries("chitchats", bindings.chitchats), expected = { shipments: [], jobs: [] };
  const client = { async query(sql, params) { observed.push([sql, params]); return { rows: [] }; } };
  const selected = { ...bindings.chitchats, databaseSnapshotSha256: frontendCrmShippingSnapshotSha256(expected) };
  assert.deepEqual(await observeFrontendCrmShippingDatabase(client, "chitchats", selected, async () => {}), expected);
  assert.equal(observed[0][0], "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  assert.deepEqual(observed.slice(1, -1), queries.map(([name, sql, params]) => { assert.ok(name); return [`${sql} LIMIT 4097`, params]; }));
  assert.equal(observed.at(-1)[0], "COMMIT");
  const overflow = { async query(sql) { return { rows: sql.startsWith("SELECT") ? Array.from({ length: 4097 }, () => ({})) : [] }; } };
  await assert.rejects(observeFrontendCrmShippingDatabase(overflow, "chitchats", selected, async () => {}), /FRONTEND_CRM_SHIPPING_DATABASE_REFUSED/u);
  let calls = 0;
  await assert.rejects(observeFrontendCrmShippingDatabase(client, "chitchats", selected, async () => { if (++calls === 2) throw new Error("private-lock-marker"); }),
    error => error.message === "FRONTEND_CRM_SHIPPING_DATABASE_REFUSED");
  assert.equal(observed.at(-1)[0], "ROLLBACK");
});
