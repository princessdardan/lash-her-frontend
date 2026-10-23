import assert from "node:assert/strict";
import test from "node:test";
import { prepareStagingSecretValues } from "../import-release-secrets.mjs";

function inputs() {
  const connection = (host, role, password) => `postgresql://${role}:${password}@${host}/neondb?sslmode=require&channel_binding=require`;
  return {
    communityOwner: {
      projectId: "still-darkness-27201043",
      directOwnerUrl: connection("ep-fancy-glitter-b81a2g6r.c-14.us-east-1.aws.neon.tech", "neondb_owner", "synthetic-community-owner"),
      productionToken: "must-not-copy",
    },
    communityRuntime: {
      projectId: "still-darkness-27201043", role: "lash_her_community_staging_runtime", DATABASE_TARGET: "staging",
      STAGING_DATABASE_URL: connection("ep-fancy-glitter-b81a2g6r-pooler.c-14.us-east-1.aws.neon.tech", "lash_her_community_staging_runtime", "synthetic-runtime-only"),
      ownerPassword: "must-not-copy", providerToken: "must-not-copy",
    },
    frontendOwnerUrl: connection("ep-plain-field-b7yma047.c-13.us-east-1.aws.neon.tech", "neondb_owner", "synthetic-frontend-owner"),
  };
}

test("exports only isolated runtime and direct migration fields with verified TLS", () => {
  const result = prepareStagingSecretValues(inputs());
  assert.deepEqual(Object.keys(result), ["CommunityRuntime", "CommunityMigration", "FrontendMigration"]);
  assert.equal(result.CommunityRuntime.username, "lash_her_community_staging_runtime");
  assert.equal(result.CommunityMigration.username, "neondb_owner");
  assert.equal(result.FrontendMigration.username, "neondb_owner");
  assert.equal(result.CommunityRuntime.DATABASE_TARGET, "staging");
  assert.equal(result.FrontendMigration.PRIVATE_DB_MIGRATION_TARGET, "staging");
  assert(!JSON.stringify(result).includes("must-not-copy"));
  assert(!JSON.stringify(result.CommunityRuntime).includes("synthetic-community-owner"));
  assert(!JSON.stringify(result.CommunityRuntime).includes("synthetic-frontend-owner"));
  for (const record of Object.values(result)) {
    const url = new URL(record.STAGING_DATABASE_URL ?? record.DATABASE_URL);
    assert.equal(url.searchParams.get("sslmode"), "verify-full");
    assert.equal(record.password, decodeURIComponent(url.password));
  }
});

for (const [name, mutate] of [
  ["wrong project", value => { value.communityOwner.projectId = "production-project"; }],
  ["wrong runtime project", value => { value.communityRuntime.projectId = "production-project"; }],
  ["production target", value => { value.communityRuntime.DATABASE_TARGET = "production"; }],
  ["owner role in runtime", value => { value.communityRuntime.STAGING_DATABASE_URL = value.communityRuntime.STAGING_DATABASE_URL.replace("lash_her_community_staging_runtime", "neondb_owner"); }],
  ["owner metadata in runtime", value => { value.communityRuntime.role = "neondb_owner"; }],
  ["unreviewed host", value => { value.frontendOwnerUrl = value.frontendOwnerUrl.replace("ep-plain-field-b7yma047", "production"); }],
  ["direct host in runtime", value => { value.communityRuntime.STAGING_DATABASE_URL = value.communityRuntime.STAGING_DATABASE_URL.replace("-pooler", ""); }],
  ["runtime in migration", value => { value.communityOwner.directOwnerUrl = value.communityOwner.directOwnerUrl.replace("neondb_owner", "lash_her_community_staging_runtime"); }],
  ["insecure TLS", value => { value.frontendOwnerUrl = value.frontendOwnerUrl.replace("sslmode=require", "sslmode=disable"); }],
  ["nonpostgres protocol", value => { value.frontendOwnerUrl = value.frontendOwnerUrl.replace("postgresql:", "https:"); }],
  ["unexpected port", value => { value.frontendOwnerUrl = value.frontendOwnerUrl.replace("/neondb", ":6432/neondb"); }],
  ["different database", value => { value.frontendOwnerUrl = value.frontendOwnerUrl.replace("/neondb", "/production"); }],
  ["session override", value => { value.frontendOwnerUrl += "&options=-crole%3Dother"; }],
  ["credential reuse", value => { value.communityRuntime.STAGING_DATABASE_URL = value.communityRuntime.STAGING_DATABASE_URL.replace("synthetic-runtime-only", "synthetic-community-owner"); }],
]) {
  test(`refuses ${name}`, () => {
    const value = inputs(); mutate(value);
    assert.throws(() => prepareStagingSecretValues(value));
  });
}
