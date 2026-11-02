import assert from "node:assert/strict";
import { before, test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createWorkloadVerifier } from "./oidc.mjs";

const config = {
  issuer: "https://oidc.vercel.com/test-team", audience: "https://vercel.com/test-team",
  subject: "owner:test-team:project:test-project:environment:production",
  ownerId: "team_test", projectId: "prj_test", environment: "production",
};
const seconds = 1_800_000_000;
let first, second, jwks;
before(async () => {
  first = await generateKeyPair("RS256"); second = await generateKeyPair("RS256");
  jwks = { keys: [{ ...await exportJWK(first.publicKey), kid: "first", alg: "RS256" }, { ...await exportJWK(second.publicKey), kid: "second", alg: "RS256" }] };
});
async function token(overrides = {}, key = first.privateKey, header = {}) {
  const claims = {
    iss: config.issuer, aud: config.audience, sub: config.subject, owner_id: config.ownerId,
    project_id: config.projectId, environment: config.environment,
    iat: seconds, nbf: seconds, exp: seconds + 7200, ...overrides,
  };
  for (const name of Object.keys(claims)) if (claims[name] === undefined) delete claims[name];
  return new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "first", ...header }).sign(key);
}
function verifier(fetch = async () => Response.json(jwks)) {
  return createWorkloadVerifier(config, { fetch, currentDate: () => new Date(seconds * 1000) });
}

test("valid workload is verified with pinned JWKS URL and bounded fetch", async () => {
  const verify = verifier(async (url, init) => {
    assert.equal(url, `${config.issuer}/.well-known/jwks`);
    assert.equal(init.redirect, "manual");
    assert.ok(init.signal);
    return Response.json(jwks);
  });
  assert.deepEqual(await verify(await token()), { projectId: config.projectId });
});

test("signed wrong identity, audience, environment and invalid lifetime fail closed", async () => {
  const verify = verifier();
  for (const override of [
    { iss: "https://oidc.vercel.com/other" }, { aud: "other" }, { aud: [config.audience, "other"] },
    { sub: "other" }, { owner_id: "team_other" }, { project_id: "prj_other" },
    { environment: "preview" }, { environment: "development" },
    { exp: seconds - 10 }, { iat: seconds + 10, nbf: seconds + 10 }, { nbf: seconds + 10 },
    { exp: seconds + 7201 }, { exp: seconds }, { iat: seconds - 7206 },
    { iat: seconds + 0.5 }, { nbf: seconds - 10 }, { nbf: seconds + 7200 },
  ]) await assert.rejects(verify(await token(override)), JSON.stringify(override));
  for (const name of ["iss", "aud", "sub", "owner_id", "project_id", "environment", "iat", "nbf", "exp"]) {
    await assert.rejects(verify(await token({ [name]: undefined })), name);
  }
});

test("forgery, unsigned/HS256 proofs, unknown keys and missing proof are refused", async () => {
  const verify = verifier();
  await assert.rejects(verify(await token({}, second.privateKey)));
  await assert.rejects(verify(await token({}, first.privateKey, { kid: "unknown", jku: "https://attacker.test" })));
  const hs = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).sign(new Uint8Array(32));
  for (const proof of [undefined, "", "bad", "x".repeat(16_385), hs, "eyJhbGciOiJub25lIn0.e30."]) await assert.rejects(verify(proof));
});

test("overlapping rotation works; cold unverifiable JWKS refuses", async () => {
  let reads = 0;
  const verify = verifier(async () => { reads++; return Response.json(jwks); });
  await verify(await token());
  await verify(await token({}, second.privateKey, { kid: "second" }));
  assert.equal(reads, 1);
  await assert.rejects(verifier(async () => { throw new Error("offline"); })(await token()));
  await assert.rejects(verifier(async () => new Response("redirect", { status: 302, headers: { location: "https://attacker.test" } }))(await token()));
  await assert.rejects(verifier(async () => Response.json({ keys: [] }))(await token()));
});

test("stale keys are not accepted during a JWKS outage; new keys reload after cooldown", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: seconds * 1000 });
  let liveKeys = { keys: [jwks.keys[0]] }, offline = false, reads = 0;
  const verify = verifier(async () => {
    reads++;
    if (offline) throw new Error("offline");
    return Response.json(liveKeys);
  });
  await verify(await token());
  liveKeys = jwks;
  await assert.rejects(verify(await token({}, second.privateKey, { kid: "second" })));
  assert.equal(reads, 1);
  t.mock.timers.tick(30_001);
  await verify(await token({}, second.privateKey, { kid: "second" }));
  assert.equal(reads, 2);
  offline = true;
  await verify(await token()); // Fresh public-key cache remains usable.
  t.mock.timers.tick(300_001);
  await assert.rejects(verify(await token()));
  assert.equal(reads, 3);
});
