import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import {
  APPLICATION_TOKEN_PROFILES,
  ApplicationTokenError,
  createApplicationTokenIssuer,
  type ApplicationPrincipal,
} from "./application-jwt";
import { parseApiClaims } from "./boundary-validation";

const subject = "d4a35059-4955-4a57-80c9-5af12bd506fb";
const instant = 1_800_000_000;
const environment = Object.fromEntries(Object.values(APPLICATION_TOKEN_PROFILES)
  .map((profile, index) => [profile.current, `test-only-profile-${index}-${"x".repeat(40)}`]));
const principals: ApplicationPrincipal[] = [
  { profile: "course-learner", customerId: subject },
  { profile: "community-member", customerId: subject },
  { profile: "course-admin", adminId: subject, capabilities: ["course-editor"] },
  { profile: "community-admin", adminId: subject, capabilities: ["community-moderator"] },
];

for (const principal of principals) {
  test(`${principal.profile} signs only the published profile with its current key`, () => {
    const mint = createApplicationTokenIssuer({ getEnvironment: () => environment, now: () => instant });
    const token = mint(principal);
    const [header, payload, signature] = token.split(".");
    assert.ok(header && payload && signature);
    assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), { alg: "HS256", typ: "JWT" });
    const profile = APPLICATION_TOKEN_PROFILES[principal.profile];
    const claims = parseApiClaims(profile.schema, JSON.parse(Buffer.from(payload, "base64url").toString()), instant);
    assert.equal(claims.sub, subject);
    assert.equal(claims.aud, profile.audience);
    assert.equal(claims.exp - claims.iat, 300);
    assert.equal(claims.iat, instant);
    assert.equal(signature, createHmac("sha256", environment[profile.current]!).update(`${header}.${payload}`).digest("base64url"));
    for (const other of Object.values(APPLICATION_TOKEN_PROFILES)) {
      if (other.current !== profile.current) assert.notEqual(signature,
        createHmac("sha256", environment[other.current]!).update(`${header}.${payload}`).digest("base64url"));
    }
    const secondPayload = mint(principal).split(".")[1]!;
    assert.notEqual(JSON.parse(Buffer.from(secondPayload, "base64url").toString()).jti, claims.jti);
    assert.equal("email" in claims, false);
  });
}

test("a previous key cannot be selected by the caller or become the minting key", () => {
  const config = { ...environment, COURSE_LEARNER_JWT_PREVIOUS_SECRET: "previous-test-only-key-".repeat(3) };
  const token = createApplicationTokenIssuer({ getEnvironment: () => config, now: () => instant })(principals[0]!);
  const [header, payload, signature] = token.split(".");
  assert.notEqual(signature, createHmac("sha256", config.COURSE_LEARNER_JWT_PREVIOUS_SECRET).update(`${header}.${payload}`).digest("base64url"));
});

for (const invalid of [undefined, "", "short", ` ${"x".repeat(40)}`]) {
  test("missing, short or padded signing keys fail without secret details", () => {
    const mint = createApplicationTokenIssuer({ getEnvironment: () => ({ ...environment, COURSE_LEARNER_JWT_CURRENT_SECRET: invalid }), now: () => instant });
    assert.throws(() => mint(principals[0]!), { name: "ApplicationTokenError", message: "Integration application token unavailable" });
  });
}

for (const duplicateName of ["COURSE_ADMIN_JWT_CURRENT_SECRET", "COMMUNITY_MEMBER_JWT_PREVIOUS_SECRET", "AUTH_SECRET", "INTERNAL_SERVICE_JWT_SECRET", "RESEND_API_KEY"]) {
  test(`refuses key reuse with ${duplicateName}`, () => {
    const mint = createApplicationTokenIssuer({ getEnvironment: () => ({ ...environment, [duplicateName]: environment.COURSE_LEARNER_JWT_CURRENT_SECRET }), now: () => instant });
    assert.throws(() => mint(principals[0]!), ApplicationTokenError);
  });
}

test("refuses a profile key reused inside the service rotation list", () => {
  const mint = createApplicationTokenIssuer({ getEnvironment: () => ({ ...environment,
    INTERNAL_SERVICE_JWT_SECRETS: `other-test-key, ${environment.COURSE_LEARNER_JWT_CURRENT_SECRET}` }), now: () => instant });
  assert.throws(() => mint(principals[0]!), ApplicationTokenError);
});

for (const invalidSubject of [subject.toUpperCase(), "google-provider-id", "person@example.test", "00000000-0000-0000-0000-000000000000"]) {
  test("refuses noncanonical subjects", () => {
    const mint = createApplicationTokenIssuer({ getEnvironment: () => environment, now: () => instant });
    assert.throws(() => mint({ profile: "course-learner", customerId: invalidSubject }), ApplicationTokenError);
  });
}

test("runtime validation rejects capability confusion, duplicates and invalid clock", () => {
  const mint = createApplicationTokenIssuer({ getEnvironment: () => environment, now: () => instant });
  for (const capabilities of [[], ["community-moderator"], ["course-editor", "course-editor"]]) {
    assert.throws(() => mint({ profile: "course-admin", adminId: subject, capabilities } as ApplicationPrincipal), ApplicationTokenError);
  }
  for (const value of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => createApplicationTokenIssuer({ getEnvironment: () => environment, now: () => value })(principals[0]!), ApplicationTokenError);
  }
});
