import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { checkReviewDiscussionsProof, reviewDiscussionsSignature } from "./staging-review-community.mjs";

const now = 1795207200;
const scope = { subject: randomUUID(), course: randomUUID(), key: "ad".repeat(32), end: now + 500 };
const discussion = `/community/v1/discussions/${randomUUID()}`;
const cursor = randomUUID();
const member = (sub) => "head." + Buffer.from(JSON.stringify({
  sub, iss: "lash-her-frontend", aud: "lash-her-community-api:member", exp: now + 300,
})).toString("base64url") + ".signature";

function request(overrides = {}) {
  const data = {
    method: "GET", target: `${discussion}?after=${cursor}`, token: member(scope.subject),
    body: "", expires: now + 30, nonce: randomUUID(), ...overrides,
  };
  return { ...data, now, authorization: "Bearer " + data.token,
    proof: `1.${data.expires}.${data.nonce}.${reviewDiscussionsSignature(scope.key, data)}` };
}

test("binds a discussion page proof to its exact cursor and staging member", () => {
  const proof = request();
  const used = new Map();
  assert.equal(checkReviewDiscussionsProof(scope, proof, used), true);
  assert.equal(checkReviewDiscussionsProof(scope, proof, used), false);
  assert.equal(checkReviewDiscussionsProof(scope, {
    ...proof, target: `${discussion}?after=${randomUUID()}`,
  }, new Map()), false);
  assert.equal(checkReviewDiscussionsProof(scope, request({
    token: member(randomUUID()),
  }), new Map()), false);
});

test("preserves existing scoped routes and rejects malformed cursor queries", () => {
  for (const entry of [
    request({ target: discussion }),
    request({ method: "POST", target: `${discussion}/comments`, body: "{}" }),
    request({ target: "/community/v1/profile" }),
  ]) assert.equal(checkReviewDiscussionsProof(scope, entry, new Map()), true);
  for (const entry of [
    request({ target: `${discussion}?after=` }),
    request({ target: `${discussion}?after=${cursor}\n` }),
    request({ target: `${discussion}?after=${cursor}&after=${cursor}` }),
    request({ target: `${discussion}?other=${cursor}` }),
    request({ target: `${discussion}?after=${cursor}#fragment` }),
    request({ method: "POST", target: `${discussion}/comments?after=${cursor}` }),
    request({ target: `${discussion}/comments?after=${cursor}` }),
    request({ target: `/community/v1/profile?after=${cursor}` }),
  ]) assert.equal(checkReviewDiscussionsProof(scope, entry, new Map()), false);
});
