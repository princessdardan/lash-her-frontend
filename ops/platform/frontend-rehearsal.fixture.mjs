import { contractManifestHash } from "./release.mjs";

// Synthetic bindings for source/qualification tests, never a release receipt.
export function frontendRehearsalFixture(candidate, commit = "a".repeat(40)) {
  const contractManifestSha256 = contractManifestHash();
  candidate.sources ??= {}; candidate.sources.frontend ??= {}; candidate.sources.frontend.commit = commit;
  candidate.artifacts ??= {};
  candidate.artifacts.frontendMigration = { image: `ghcr.io/princessdardan/lash-her-platform-frontend-migration@sha256:${"f".repeat(64)}` };
  candidate.frontendMigration = { sqlArtifactSha256: "a".repeat(64), contractManifestSha256, schemaBaselines: { 18: "c".repeat(64) } };
  return { status: "FRONTEND_MIGRATION_OWNED_POSTGRES_PASS", postgresMajor: 18, providerTouched: false,
    sourceCommit: commit, packagedCliVerified: true, migrationImageDigest: `sha256:${"f".repeat(64)}`,
    sqlArtifactSha256: candidate.frontendMigration.sqlArtifactSha256, contractManifestSha256, schemaBaselineSha256: "c".repeat(64),
    checks: ["fresh-apply", "already-current", "data-bearing-upgrade", "lock-contention", "pending-chain-refusal",
      "lineage-refusal", "schema-refusal", "runtime-privilege-refusal", "tls-certificate-refusal", "exact-artifact-production-promotion"] };
}
