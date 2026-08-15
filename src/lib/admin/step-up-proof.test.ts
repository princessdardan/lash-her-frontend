import assert from "node:assert/strict";
import test from "node:test";

import {
  assertStepUpReauthenticationCompleted,
  createAdminStepUpTarget,
  createPendingStepUpChallenge,
  verifyPendingStepUpChallenge,
} from "./step-up-proof";

const originalAuthSecret = process.env.AUTH_SECRET;
process.env.AUTH_SECRET = "step-up-proof-test-secret-with-more-than-32-bytes";

test.after(() => {
  if (originalAuthSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = originalAuthSecret;
});

test("step-up signing rejects low-diversity Auth.js secrets", () => {
  process.env.AUTH_SECRET = "a".repeat(32);
  assert.throws(
    () =>
      createPendingStepUpChallenge({
        action: "risk:clear_false_positive",
        actorAdminUserId: "actor-1",
        target: "incident-1",
      }),
    /at least 12 distinct characters/,
  );
  process.env.AUTH_SECRET = "step-up-proof-test-secret-with-more-than-32-bytes";
});

test("pending step-up challenge is actor, action, and target bound", () => {
  const now = new Date("2026-08-15T12:00:00.000Z");
  const token = createPendingStepUpChallenge({
    action: "address:fraud_clearance",
    actorAdminUserId: "actor-1",
    now,
    target: "address-request-1",
  });
  const challenge = verifyPendingStepUpChallenge({
    actorAdminUserId: "actor-1",
    now,
    token,
  });
  assert.equal(challenge.action, "address:fraud_clearance");
  assert.equal(challenge.actorAdminUserId, "actor-1");
  assert.equal(challenge.issuedAt, now.getTime());
  assert.equal(challenge.target, createAdminStepUpTarget("address-request-1"));
  assert.match(challenge.nonce, /^[A-Za-z0-9_-]+$/);
  assert.throws(
    () =>
      verifyPendingStepUpChallenge({
        actorAdminUserId: "actor-2",
        now,
        token,
      }),
    /another actor/,
  );
});

test("step-up targets use stable full-scope SHA-256 identities without truncation collisions", () => {
  const first = {
    evidenceReference: "e".repeat(300) + "-first",
    enabled: true,
    postageType: "tracked",
  };
  const reordered = {
    postageType: "tracked",
    enabled: true,
    evidenceReference: "e".repeat(300) + "-first",
  };
  const differentAfterFormerTruncation = {
    ...first,
    evidenceReference: "e".repeat(300) + "-second",
  };
  const target = createAdminStepUpTarget(first);
  assert.match(target, /^sha256:[0-9a-f]{64}$/);
  assert.equal(target, createAdminStepUpTarget(reordered));
  assert.equal(target, createAdminStepUpTarget(target));
  assert.notEqual(
    target,
    createAdminStepUpTarget(differentAfterFormerTruncation),
  );
});

test("pending challenge rejects tampering and expiry", () => {
  const issuedAt = new Date("2026-08-15T12:00:00.000Z");
  const token = createPendingStepUpChallenge({
    action: "risk:clear_false_positive",
    actorAdminUserId: "actor-1",
    now: issuedAt,
    target: "incident-1",
  });
  assert.throws(
    () =>
      verifyPendingStepUpChallenge({
        actorAdminUserId: "actor-1",
        now: new Date(issuedAt.getTime() + 120_001),
        token,
      }),
    /expired/,
  );
  assert.throws(
    () =>
      verifyPendingStepUpChallenge({
        actorAdminUserId: "actor-1",
        now: issuedAt,
        token: `${token.slice(0, -1)}x`,
      }),
    /invalid/,
  );
});

test("an ordinary fresh session predating the challenge is not step-up", () => {
  const issuedAt = new Date("2026-08-15T12:00:30.000Z");
  assert.throws(
    () =>
      assertStepUpReauthenticationCompleted({
        authenticatedAt: new Date("2026-08-15T12:00:00.000Z"),
        challengeIssuedAt: issuedAt.getTime(),
        now: issuedAt,
      }),
    /did not complete/,
  );
  assert.doesNotThrow(() =>
    assertStepUpReauthenticationCompleted({
      authenticatedAt: issuedAt,
      challengeIssuedAt: issuedAt.getTime(),
      now: issuedAt,
    }),
  );
});
