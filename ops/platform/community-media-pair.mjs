import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { bindCommunityMediaRecovery } from "./community-media-recovery.mjs";

const hash = data => "sha256:" + createHash("sha256").update(data).digest("hex");
const reportFiles = ["community-media-recovery.json", "media-platform-recovery.json"];

export function communityMediaPair(candidate, source, directory) {
  const qualified = bindCommunityMediaRecovery(candidate, source, directory);
  if (JSON.stringify(qualified.integration.communityMediaRecovery) !==
      JSON.stringify(candidate.integration?.communityMediaRecovery))
    throw new Error("Attested candidate recovery binding mismatch");
  const issuerFile = "ops/platform/community-media-issuer-proof.json";
  const issuerBytes = readFileSync(join(source, issuerFile));
  const issuer = JSON.parse(issuerBytes);
  const identityPrefix = "arn:aws:sts::691588646557:assumed-role/";
  const scope = issuer.teardown?.scope;
  if (issuer.version !== 1 || issuer.scope !== "disposable-roles-anywhere-issuer-chain" ||
      issuer.accountId !== "691588646557" || issuer.region !== "us-east-1" ||
      !/^p503-check-[a-f0-9]{8}$/u.test(scope ?? "") ||
      issuer.liveWorkloadIssuerConfigured !== false || issuer.trafficAuthorized !== false ||
      issuer.teardown.stackStatus !== "DELETE_COMPLETE" || issuer.teardown.resourcesRemoved !== 8 ||
      issuer.teardown.directAbsenceConfirmed !== true || issuer.teardown.localCertificateKeysRemoved !== true ||
      ["api", "worker"].some(role => {
        const session = issuer.sessions?.[role];
        return session?.oppositeTargetDenied !== true ||
          !session.issuer.startsWith(identityPrefix + scope + "-" + role + "-issuer/") ||
          session.target !== identityPrefix + scope + "-" + role + "-target/" + scope + "-" + role ||
          !Number.isFinite(Date.parse(session.expiresAt));
      }) ||
      issuer.templateSha256 !== hash(readFileSync(join(source, "tests/support/community-media-issuer-qualification.yaml"))).slice(7) ||
      issuer.probeSha256 !== hash(readFileSync(join(source, "tests/support/community-media-issuer-qualification.py"))).slice(7)) {
    throw new Error("Completed isolated AWS issuer and teardown evidence required");
  }
  const current = readFileSync(join(directory, "release.candidate.json"));
  const previous = readFileSync(join(source, "ops/platform/community-media-predecessor.json"));
  if (JSON.stringify(JSON.parse(current)) !== JSON.stringify(candidate))
    throw new Error("Exact published candidate bytes required");
  const predecessor = JSON.parse(previous);
  return {
    version: 1,
    status: "ISOLATED_MEDIA_RECOVERY_PAIR_VERIFIED",
    current: { releaseId: candidate.releaseId, manifestSha256: hash(current),
      sources: candidate.sources, images: Object.fromEntries(Object.entries(candidate.artifacts).map(([key, entry]) => [key, entry.image])) },
    predecessor: { releaseId: predecessor.releaseId, manifestSha256: hash(previous),
      sources: predecessor.sources, images: Object.fromEntries(Object.entries(predecessor.artifacts).map(([key, entry]) => [key, entry.image])) },
    evidence: { ...Object.fromEntries(reportFiles.map(file => [file, hash(readFileSync(join(directory, file)))])),
      issuerQualificationSha256: hash(issuerBytes) },
    runtime: candidate.runtime,
    scope: "isolated-platform-rollback-and-community-database-restore",
    liveWorkloadIssuerConfigured: false,
    trafficAuthorized: false,
    releaseAccepted: false,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 4) throw new Error();
    const [directory, source] = process.argv.slice(2).map(value => resolve(value));
    const candidate = JSON.parse(readFileSync(join(directory, "release.candidate.json")));
    const pair = communityMediaPair(candidate, source, directory);
    writeFileSync(join(directory, "community-media-pair.json"), JSON.stringify(pair, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    process.stdout.write("ISOLATED_MEDIA_RECOVERY_PAIR_VERIFIED\n");
  } catch {
    process.stderr.write("MEDIA_RECOVERY_PAIR_REFUSED\n");
    process.exitCode = 1;
  }
}
