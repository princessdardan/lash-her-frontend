// Import private staging DB values without printing them or reading cloud values.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const ACCOUNT = "691588646557";
const OPERATOR = `arn:aws:iam::${ACCOUNT}:user/Dardan`;
const REGION = "us-east-1";
const COMMUNITY_PROJECT = "still-darkness-27201043";
const RUNTIME_ROLE = "lash_her_community_staging_runtime";
const COMMUNITY_DIRECT = "ep-fancy-glitter-b81a2g6r.c-14.us-east-1.aws.neon.tech";
const COMMUNITY_POOLED = "ep-fancy-glitter-b81a2g6r-pooler.c-14.us-east-1.aws.neon.tech";
const FRONTEND_DIRECT = "ep-plain-field-b7yma047.c-13.us-east-1.aws.neon.tech";
const NAMES = {
  CommunityRuntime: "lash-her/staging/community/runtime",
  CommunityMigration: "lash-her/staging/community/migration",
  FrontendMigration: "lash-her/staging/frontend/migration",
};

function parseConnection(value, hostname, username) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Invalid private DB connection format"); }
  // The CLI prints only error classes; never log assertion objects or URL inputs.
  assert(["postgres:", "postgresql:"].includes(url.protocol), "Unexpected DB protocol");
  assert.equal(url.hostname, hostname, "Unexpected staging DB host");
  assert(["", "5432"].includes(url.port), "Unexpected staging DB port");
  assert.equal(url.pathname, "/neondb", "Unexpected staging database");
  assert.equal(decodeURIComponent(url.username), username, "Unexpected DB role");
  assert.equal(url.hash, "", "Connection fragments are forbidden");
  assert(["require", "verify-ca", "verify-full"].includes(url.searchParams.get("sslmode")), "TLS is required");
  assert([...url.searchParams.keys()].every(key => ["sslmode", "channel_binding"].includes(key)), "Unexpected DB connection options");
  const password = decodeURIComponent(url.password);
  assert(password.length >= 16, "Missing or insufficient DB credential");
  url.searchParams.set("sslmode", "verify-full");
  return { url: url.toString(), password, username, host: hostname, port: 5432, dbname: "neondb", engine: "postgres" };
}

export function prepareStagingSecretValues({ communityOwner, communityRuntime, frontendOwnerUrl }) {
  assert.equal(communityOwner.projectId, COMMUNITY_PROJECT, "Unexpected Community project");
  assert.equal(communityRuntime.projectId, COMMUNITY_PROJECT, "Unexpected runtime project");
  assert.equal(communityRuntime.role, RUNTIME_ROLE, "Unexpected runtime role metadata");
  assert.equal(communityRuntime.DATABASE_TARGET, "staging", "Runtime target must be staging");
  const runtime = parseConnection(communityRuntime.STAGING_DATABASE_URL, COMMUNITY_POOLED, RUNTIME_ROLE);
  const community = parseConnection(communityOwner.directOwnerUrl, COMMUNITY_DIRECT, "neondb_owner");
  const frontend = parseConnection(frontendOwnerUrl, FRONTEND_DIRECT, "neondb_owner");
  assert(runtime.password !== community.password && runtime.password !== frontend.password, "Runtime must use independent credentials");
  const { url: runtimeUrl, ...runtimeFields } = runtime;
  const { url: communityUrl, ...communityFields } = community;
  const { url: frontendUrl, ...frontendFields } = frontend;
  return {
    CommunityRuntime: { ...runtimeFields, DATABASE_TARGET: "staging", STAGING_DATABASE_URL: runtimeUrl },
    CommunityMigration: { ...communityFields, DATABASE_TARGET: "staging", STAGING_DATABASE_URL: communityUrl },
    FrontendMigration: { ...frontendFields, DATABASE_URL: frontendUrl, PRIVATE_DB_MIGRATION_TARGET: "staging", PRIVATE_DB_MIGRATION_HOST: FRONTEND_DIRECT },
  };
}

function readPrivate(file) {
  const stat = fs.lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0, "Private input must be a regular mode-0600 file");
  assert.equal(stat.uid, process.getuid(), "Private input owner mismatch");
  return fs.readFileSync(file, "utf8");
}

async function main() {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const flags = new Map();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--write") continue;
    assert(["--private-dir", "--sdk-root", "--aws-config", "--profile"].includes(args[i]), "Unexpected option");
    assert(args[i + 1] && !args[i + 1].startsWith("--"), "Missing option value");
    flags.set(args[i], args[++i]);
  }
  const privateDir = flags.get("--private-dir");
  assert(privateDir && path.isAbsolute(privateDir), "Supply an absolute private input directory");
  const require = createRequire(new URL("../../package.json", import.meta.url));
  const env = require("dotenv").parse(readPrivate(path.join(privateDir, ".env.production.local")));
  const payloads = prepareStagingSecretValues({
    communityOwner: JSON.parse(readPrivate(path.join(privateDir, "community-release-credentials.json"))),
    communityRuntime: JSON.parse(readPrivate(path.join(privateDir, "community-runtime-credentials.json"))),
    frontendOwnerUrl: env.DATABASE_URL_UNPOOLED,
  });
  if (!write) {
    console.log(JSON.stringify({ dryRun: true, records: Object.entries(payloads).map(([id, payload]) => ({ name: NAMES[id], fields: Object.keys(payload) })) }));
    return;
  }
  for (const key of ["--sdk-root", "--aws-config", "--profile"]) assert(flags.has(key), `Missing ${key}`);
  const sdk = createRequire(path.join(path.resolve(flags.get("--sdk-root")), "package.json"));
  const { fromIni } = sdk("@aws-sdk/credential-providers");
  const { STSClient, GetCallerIdentityCommand } = sdk("@aws-sdk/client-sts");
  const { SecretsManagerClient, DescribeSecretCommand, GetResourcePolicyCommand, PutSecretValueCommand } = sdk("@aws-sdk/client-secrets-manager");
  const config = { region: REGION, credentials: fromIni({ profile: flags.get("--profile"), configFilepath: flags.get("--aws-config") }), maxAttempts: 2 };
  const identity = await new STSClient(config).send(new GetCallerIdentityCommand({}));
  assert.equal(identity.Account, ACCOUNT, "Wrong AWS account");
  assert.equal(identity.Arn, OPERATOR, "Wrong release operator");
  const metadataFile = new URL("./release-store.json", import.meta.url);
  const metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
  assert.equal(metadata.accountId, ACCOUNT); assert.equal(metadata.region, REGION); assert.equal(metadata.operatorArn, OPERATOR);
  assert.equal(metadata.ciAccessConfigured, false); assert.equal(metadata.hostAccessConfigured, false);
  const client = new SecretsManagerClient(config);
  const stateFile = path.join(privateDir, "release-store-import-state.json");
  const state = fs.existsSync(stateFile) ? JSON.parse(readPrivate(stateFile)) : {};
  // Verify every target before any write, including the original initialized version.
  for (const [id, payload] of Object.entries(payloads)) {
    const record = metadata.records[id];
    assert.equal(record.name, NAMES[id]);
    assert(record.arn.startsWith(`arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:${NAMES[id]}-`), "Unexpected secret ARN");
    const described = await client.send(new DescribeSecretCommand({ SecretId: record.arn }));
    assert.equal(described.Name, NAMES[id]); assert.equal(described.KmsKeyId, metadata.keyArn);
    assert(!described.DeletedDate, "Secret is scheduled for deletion");
    const policy = JSON.parse((await client.send(new GetResourcePolicyCommand({ SecretId: record.arn }))).ResourcePolicy);
    const deny = policy.Statement.find(statement => statement.Sid === "DenyUnreviewedValueReaders");
    assert.equal(deny.Effect, "Deny"); assert.equal(deny.Action, "secretsmanager:GetSecretValue");
    assert.deepEqual(deny.Condition.ArnNotEquals["aws:PrincipalArn"], [OPERATOR, `arn:aws:iam::${ACCOUNT}:root`]);
    const current = Object.entries(described.VersionIdsToStages).find(([, stages]) => stages.includes("AWSCURRENT"))?.[0];
    const fingerprint = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    if (state[id]) {
      assert.equal(state[id].arn, record.arn); assert.equal(state[id].fingerprint, fingerprint, "Private inputs changed; reviewed rotation is required");
      assert([record.initialVersionId, state[id].versionId].includes(current), "Unexpected current secret version");
    } else {
      assert.equal(record.initialized, false, "Missing private import receipt for initialized record");
      assert(record.initialVersionId && current === record.initialVersionId, "Initialization version changed");
      state[id] = { arn: record.arn, fingerprint, versionId: randomUUID() };
    }
  }
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n", { mode: 0o600, flag: fs.existsSync(stateFile) ? "w" : "wx" });
  for (const [id, payload] of Object.entries(payloads)) {
    const record = metadata.records[id];
    await client.send(new PutSecretValueCommand({ SecretId: record.arn, ClientRequestToken: state[id].versionId, SecretString: JSON.stringify(payload), VersionStages: ["AWSCURRENT"] }));
    // Metadata propagation may lag a successful PutSecretValue. Retry metadata,
    // never issue a new version token or retrieve the value to resolve that lag.
    let verified = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      const described = await client.send(new DescribeSecretCommand({ SecretId: record.arn }));
      if (described.VersionIdsToStages[state[id].versionId]?.includes("AWSCURRENT")) { verified = true; break; }
      if (attempt < 5) await delay(250 * 2 ** attempt);
    }
    assert(verified, "Import version verification failed; retry with the saved receipt");
    record.initialized = true; record.currentVersionId = state[id].versionId;
  }
  metadata.privateImportCompletedAt = new Date().toISOString();
  fs.writeFileSync(metadataFile, JSON.stringify(metadata, null, 2) + "\n");
  console.log(JSON.stringify({ imported: true, records: Object.values(metadata.records).map(({ name, arn, currentVersionId }) => ({ name, arn, currentVersionId })), valuesLogged: false, cloudValuesRead: false }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    // SDK/URL/assertion errors can contain private values; print only the class.
    console.error(`Staging secret import failed (${error.name ?? "Error"}); inspect private inputs and metadata without logging their values.`);
    process.exitCode = 1;
  });
}
