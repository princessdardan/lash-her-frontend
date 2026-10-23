// Read-only verification. Resolve RELEASE_DB_URL with asm-exec; never print it.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(new URL("../../package.json", import.meta.url));
const { Client } = require("pg");
const targets = {
  CommunityRuntime: ["ep-fancy-glitter-b81a2g6r-pooler.c-14.us-east-1.aws.neon.tech", "lash_her_community_staging_runtime"],
  CommunityMigration: ["ep-fancy-glitter-b81a2g6r.c-14.us-east-1.aws.neon.tech", "neondb_owner"],
  FrontendMigration: ["ep-plain-field-b7yma047.c-13.us-east-1.aws.neon.tech", "neondb_owner"],
};
let client;
try {
  const scope = process.argv[2];
  assert(Object.hasOwn(targets, scope));
  const [host, role] = targets[scope];
  const url = new URL(process.env.RELEASE_DB_URL);
  delete process.env.RELEASE_DB_URL;
  assert.equal(url.hostname, host); assert.equal(decodeURIComponent(url.username), role);
  assert.equal(url.pathname, "/neondb"); assert.equal(url.searchParams.get("sslmode"), "verify-full");
  client = new Client({ connectionString: url.toString(), connectionTimeoutMillis: 15000, statement_timeout: 10000, application_name: "lash-her-staging-release-read-check" });
  await client.connect();
  await client.query("BEGIN READ ONLY");
  const { rows: [identity] } = await client.query("SELECT current_user, current_database() AS database, has_schema_privilege(current_user, 'public', 'CREATE') AS public_create");
  assert.equal(identity.current_user, role); assert.equal(identity.database, "neondb");
  if (scope === "CommunityRuntime") assert.equal(identity.public_create, false);
  const stream = client.connection.stream;
  assert.equal(stream.encrypted, true); assert.equal(stream.authorized, true);
  await client.query("ROLLBACK");
  console.log(JSON.stringify({ scope, host, role, readOnlyConnectionVerified: true, clientCertificateAuthorized: true, tlsProtocol: stream.getProtocol(), valuesLogged: false }));
} catch (error) {
  console.error(`Protected release DB verification failed (${error.name ?? "Error"}); no credential details logged.`);
  process.exitCode = 1;
} finally {
  if (client) await client.end();
}
