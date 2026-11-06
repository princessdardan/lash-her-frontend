import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  observeCommunityRotation,
  observeCourseRotation,
  qualifyIdentityKeyRotation,
  validateRotationPrivateInput,
} from "./p2-identity-key-rotation.mjs";

const oldKey = "old-" + "a".repeat(48), newKey = "new-" + "b".repeat(48);
const subject = "11111111-1111-4111-8111-111111111111";
const courseId = "22222222-2222-4222-8222-222222222222";
const sha = value => createHash("sha256").update(value).digest("hex");
const ca = Buffer.from("owned-ca");
const uuid = () => "33333333-3333-4333-8333-333333333333";

function input(profile, phase = "overlap") {
  return { version: 1, mode: profile.startsWith("course-") ? "rotation-course-http" : "rotation-community-verifier",
    environment: "staging", bindingSha256: sha("binding"), phase, profile, subject, courseId, oldKey, newKey,
    gatewayCaSha256: sha(ca), configurationSha256: sha(phase), runtimeEnvironment: profile.startsWith("community-")
      ? { DATABASE_TARGET: "staging" } : null };
}

test("private input is closed, fixed to four profiles, and keeps old/new keys distinct", () => {
  assert.equal(validateRotationPrivateInput(input("course-learner")).profile, "course-learner");
  for (const mutate of [value => { value.environment = "production"; }, value => { value.profile = "service"; },
    value => { value.newKey = value.oldKey; }, value => { value.url = "https://example.invalid"; },
    value => { value.mode = "rotation-community-verifier"; }]) {
    const value = structuredClone(input("course-learner")); mutate(value);
    assert.throws(() => validateRotationPrivateInput(value));
  }
});

test("Course learner/admin use actual protected HTTP status semantics and enforce admin capability", async () => {
  for (const phase of ["overlap", "current-only"]) for (const profile of ["course-learner", "course-admin"]) {
    const statuses = [phase === "overlap" ? 200 : 401, 200, ...(profile === "course-admin" ? [403] : [])];
    const receipt = await observeCourseRotation(input(profile, phase), { ca, nowMs: () => 1_799_999_900_000, randomUuid: uuid,
      read: async () => ({ status: statuses.shift(), requestId: uuid(), observedAt: "2027-01-15T07:05:00.000Z", elapsedMs: 1 }) });
    assert.equal(receipt.evidenceClass, "actual-protected-course-http");
    assert.equal(receipt.oldResult, phase === "overlap" ? "accepted" : "rejected");
    assert.equal(receipt.newResult, "accepted");
    assert.equal(receipt.capabilityEnforced, true);
    assert.equal(statuses.length, 0);
  }
});

test("owned Course HTTPS hook verifies hostname/path/auth and refuses redirects, 429 and 5xx as rotation evidence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "owned-p2-rotation-tls-"));
  const certificate = join(directory, "cert.pem"), privateKey = join(directory, "key.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=course-tls",
    "-addext", "subjectAltName=DNS:course-tls,IP:127.0.0.1", "-keyout", privateKey, "-out", certificate], { stdio: "ignore" });
  const ownedCa = readFileSync(certificate); let mode = "pass", count = 0; const calls = [];
  const server = createServer({ cert: ownedCa, key: readFileSync(privateKey) }, (incoming, outgoing) => {
    calls.push({ method: incoming.method, url: incoming.url, authorization: incoming.headers.authorization });
    const headers = { "x-request-id": uuid() };
    if (mode === "redirect") { outgoing.writeHead(302, { ...headers, location: "https://foreign.invalid" }); outgoing.end(); return; }
    if (mode === "429") { outgoing.writeHead(429, headers); outgoing.end(); return; }
    if (mode === "500") { outgoing.writeHead(500, headers); outgoing.end(); return; }
    outgoing.writeHead([200, 200, 403][count++] ?? 500, headers); outgoing.end("{}");
  });
  server.on("tlsClientError", () => {});
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const connector = (options, callback) => request({ ...options, hostname: "127.0.0.1", port: server.address().port, ca: ownedCa }, callback);
  const value = { ...input("course-admin"), gatewayCaSha256: sha(ownedCa) };
  try {
    const receipt = await observeCourseRotation(value, { ca: ownedCa, request: connector, nowMs: () => 1_799_999_900_000, randomUuid: uuid });
    assert.equal(receipt.oldHttpStatus, 200);
    assert.equal(receipt.newHttpStatus, 200);
    assert.deepEqual(calls.map(row => row.method), ["GET", "GET", "GET"]);
    assert.ok(calls.every(row => row.url === `/v1/admin/courses/${courseId}` && row.authorization?.startsWith("Bearer ")));
    for (const selected of ["redirect", "429", "500"]) {
      mode = selected; count = 0;
      await assert.rejects(() => observeCourseRotation(value, { ca: ownedCa, request: connector,
        nowMs: () => 1_799_999_900_000, randomUuid: uuid }));
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});

function signatureValid(token, key) {
  const [header, payload, signature] = token.split(".");
  return createHmac("sha256", key).update(`${header}.${payload}`).digest("base64url") === signature;
}

function communityLoader(phase, profile) {
  const prefix = profile === "community-member" ? "COMMUNITY_MEMBER" : "COMMUNITY_ADMIN";
  const verify = authorization => {
    const token = authorization.slice(7), payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    const valid = signatureValid(token, newKey) || phase === "overlap" && signatureValid(token, oldKey);
    if (!valid) return null;
    if (profile === "community-admin" && (payload.capabilities?.join() !== "community-moderator")) return null;
    return { kind: profile.endsWith("admin") ? "admin" : "member", claims: payload };
  };
  return async () => ({ implementation: { createCommunityUserVerifier: () => ({ verifyMember: verify, verifyAdmin: verify }) },
    configured: { env: { [`${prefix}_JWT_CURRENT_SECRET`]: newKey,
      ...(phase === "overlap" ? { [`${prefix}_JWT_PREVIOUS_SECRET`]: oldKey } : {}) }, resolveCommunityUserRuntime: value => value } });
}

test("Community member/admin use deployed private verifier evidence and enforce moderator capability", async () => {
  for (const phase of ["overlap", "current-only"]) for (const profile of ["community-member", "community-admin"]) {
    const prefix = profile === "community-member" ? "COMMUNITY_MEMBER" : "COMMUNITY_ADMIN";
    const environment = { DATABASE_TARGET: "staging", [`${prefix}_JWT_CURRENT_SECRET`]: newKey,
      ...(phase === "overlap" ? { [`${prefix}_JWT_PREVIOUS_SECRET`]: oldKey } : {}) };
    const receipt = await observeCommunityRotation(input(profile, phase), { environment, loadVerifier: communityLoader(phase, profile),
      nowMs: () => 1_799_999_900_000, randomUuid: uuid });
    assert.equal(receipt.evidenceClass, "deployed-private-community-verifier");
    assert.equal(receipt.oldResult, phase === "overlap" ? "accepted" : "rejected");
    assert.equal(receipt.newResult, "accepted");
    assert.equal(receipt.capabilityEnforced, true);
  }
});

function row(profile, phase, observedAt) {
  const course = profile.startsWith("course-");
  return { profile, evidenceClass: course ? "actual-protected-course-http" : "deployed-private-community-verifier",
    configurationSha256: sha(phase), sourceCommit: "a".repeat(40), containers: course
      ? [{ service: "course-api", containerId: "b".repeat(64), image: `ghcr.io/princessdardan/lash-her-platform-course-runtime@sha256:${"c".repeat(64)}` },
        { service: "gateway", containerId: "d".repeat(64), image: `ghcr.io/princessdardan/lash-her-platform-gateway@sha256:${"e".repeat(64)}` }]
      : [{ service: "community-api", containerId: "b".repeat(64), image: `ghcr.io/princessdardan/lash-her-platform-community-runtime@sha256:${"c".repeat(64)}` }],
    previousConfigured: phase === "overlap", oldResult: phase === "overlap" ? "accepted" : "rejected", newResult: "accepted",
    oldTokenIssuedAt: phase === "overlap" ? "2027-01-15T06:55:00.000Z" : "2027-01-15T07:05:00.000Z",
    oldTokenExpiresAt: phase === "overlap" ? "2027-01-15T07:00:00.000Z" : "2027-01-15T07:10:00.000Z", observedAt,
    runtimeConfigurationBindingVerified: true, capabilityEnforced: true,
    oldHttpStatus: course ? (phase === "overlap" ? 200 : 401) : null, newHttpStatus: course ? 200 : null,
    oldRequestId: course ? uuid() : null, newRequestId: course ? uuid() : null,
    moduleSha256: { "dist/auth.js": sha(profile + phase) } };
}

function qualification() {
  const profiles = ["community-admin", "community-member", "course-admin", "course-learner"];
  return { version: 1, environment: "staging", actionId: "p2-key-rotation-owned", bindingSha256: sha("binding"),
    candidateSha256: sha("candidate"), sourceCommit: "a".repeat(40), hostMachineId: "d".repeat(32), baselineConfigurationSha256: sha("baseline"),
    restorationTargetSha256: sha("overlap"), parent: { sourceOwnedFixedAction: true, hostLockHeld: true, frontendPhysicalLockHeld: true,
      configOnly: true, sqlExecuted: false, rolesPrepared: false, loginChanged: false, serviceCredentialsUnchanged: true,
      providerStateReconciled: true, restorationQualified: true },
    overlap: { configurationSha256: sha("overlap"), startedAt: "2027-01-15T06:55:00.000Z", completedAt: "2027-01-15T06:56:00.000Z",
      frontendIssuanceCutoffAt: "2027-01-15T06:57:00.000Z", profiles: profiles.map(profile => row(profile, "overlap", "2027-01-15T06:56:00.000Z")) },
    currentOnly: { configurationSha256: sha("current-only"), startedAt: "2027-01-15T07:02:30.000Z", completedAt: "2027-01-15T07:06:00.000Z",
      frontendIssuanceCutoffAt: "2027-01-15T07:03:00.000Z", profiles: profiles.map(profile => row(profile, "current-only", "2027-01-15T07:06:00.000Z")) } };
}

test("qualification discloses per-profile evidence class only after 330-second overlap drain and old rejection", () => {
  const result = qualifyIdentityKeyRotation(qualification());
  assert.equal(result.keyRemovalVerified, true);
  assert.equal(result.overlapDrainSeconds, 330);
  assert.deepEqual(result.profileEvidence.map(row => row.profile).sort(), ["community-admin", "community-member", "course-admin", "course-learner"]);
  assert.equal(result.profileEvidence.find(row => row.profile === "community-member").evidenceClass, "deployed-private-community-verifier");
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /old-a|new-b|eyJ|userToken|oldKey|newKey|credentialSha256/u);
  assert.equal(result.tokenBytesOutput, false);
  assert.equal(result.credentialHashesOutput, false);
});

test("qualification refuses short drain, configured previous key, grace acceptance, incomplete profile evidence and parent mutation claims", () => {
  for (const mutate of [value => { value.currentOnly.startedAt = "2027-01-15T07:02:29.999Z"; },
    value => { value.currentOnly.profiles[0].previousConfigured = true; }, value => { value.currentOnly.profiles[1].oldResult = "accepted"; },
    value => { value.currentOnly.profiles.pop(); }, value => { value.parent.sqlExecuted = true; },
    value => { value.currentOnly.profiles[2].oldTokenExpiresAt = value.currentOnly.profiles[2].observedAt; },
    value => { value.currentOnly.profiles[0].configurationSha256 = sha("other"); },
    value => { value.currentOnly.profiles[1].oldTokenIssuedAt = "2027-01-15T07:06:01.000Z"; },
    value => { value.currentOnly.profiles[2].containers.pop(); }, value => { value.restorationTargetSha256 = sha("other"); }]) {
    const value = qualification(); mutate(value);
    assert.throws(() => qualifyIdentityKeyRotation(value));
  }
});
