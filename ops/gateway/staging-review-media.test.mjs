import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { checkReviewMediaProof, reviewMediaSignature } from "./staging-review-media.mjs";

const now = 1795207200;
const scope = { subject: randomUUID(), post: randomUUID(), key: "ad".repeat(32), end: now + 500 };
const encode = (claims) => "head." + Buffer.from(JSON.stringify(claims)).toString("base64url") + ".signature";
const member = (sub) => encode({ sub, iss: "lash-her-frontend", aud: "lash-her-community-api:member", exp: now + 300 });
const target = `/community/v1/discussions/${scope.post}/media`;

function request(overrides = {}) {
  const data = { method: "POST", target, token: member(scope.subject), body: "{}", expires: now + 30, nonce: randomUUID(), ...overrides };
  return { ...data, now, authorization: "Bearer " + data.token,
    proof: `1.${data.expires}.${data.nonce}.${reviewMediaSignature(scope.key, data)}` };
}

test("only one media proof succeeds and replay is refused", () => {
  const proof = request();
  const used = new Map();
  assert.equal(checkReviewMediaProof(scope, proof, used), true);
  assert.equal(checkReviewMediaProof(scope, proof, used), false);
});

test("refuses altered data, foreign account, unrelated route, and expired permission", () => {
  const proof = request();
  for (const invalid of [
    { ...proof, body: " " },
    request({ token: member(randomUUID()) }),
    request({ target: `/community/v1/discussions/${randomUUID()}/media` }),
    request({ target: `/community/v1/media/${randomUUID()}/other` }),
    request({ method: "PUT" }),
    request({ expires: now + 75 }),
    { ...proof, now: now + 32 },
  ]) assert.equal(checkReviewMediaProof(scope, invalid, new Map()), false);
  assert.equal(checkReviewMediaProof(undefined, proof, new Map()), false);
});
