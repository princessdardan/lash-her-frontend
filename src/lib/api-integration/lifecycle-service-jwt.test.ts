import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { createLifecycleServiceTokenIssuer, LifecycleTokenError } from "./lifecycle-service-jwt";

const current = "current-lifecycle-".padEnd(48, "c");
const previous = "previous-lifecycle-".padEnd(48, "p");
for (const receiver of ["course", "community"] as const) {
  test(`${receiver} lifecycle issuer mints only its dedicated closed service profile using the current key`, () => {
    const prefix = receiver.toUpperCase();
    const mint = createLifecycleServiceTokenIssuer({ now: () => 1234, getEnvironment: () => ({ [`${prefix}_ACCOUNT_LIFECYCLE_JWT_CURRENT_SECRET`]: current, [`${prefix}_ACCOUNT_LIFECYCLE_JWT_PREVIOUS_SECRET`]: previous }) });
    const [header, payload, signature] = mint(receiver).split(".");
    assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), { alg: "HS256", typ: "JWT" });
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    assert.deepEqual(Object.keys(claims).sort(), ["aud", "exp", "iat", "iss", "jti", "sub"]);
    assert.equal(claims.aud, `lash-her-${receiver}-api:account-lifecycle`); assert.equal(claims.sub, "frontend-account-lifecycle"); assert.equal(claims.iss, "lash-her-frontend");
    assert.equal(claims.iat, 1234); assert.equal(claims.exp, 1534);
    assert.match(claims.jti, /^[a-f0-9-]{36}$/u);
    assert.equal(signature, createHmac("sha256", current).update(`${header}.${payload}`).digest("base64url"));
    assert.notEqual(signature, createHmac("sha256", previous).update(`${header}.${payload}`).digest("base64url"));
  });
}

test("lifecycle issuance refuses cross-profile, Auth.js, provider, gateway and rotation-key reuse without disclosure", () => {
  for (const name of ["COMMUNITY_ACCOUNT_LIFECYCLE_JWT_CURRENT_SECRET", "COURSE_LEARNER_JWT_CURRENT_SECRET", "COMMUNITY_ADMIN_JWT_PREVIOUS_SECRET", "AUTH_SECRET", "AUTH_SECRET_1", "CUSTOMER_AUTH_SECRET", "SQUARE_ACCESS_TOKEN", "CUSTOMER_AUTH_RESEND_KEY", "GATEWAY_PROBE_TOKEN", "DATABASE_PASSWORD", "DATABASE_URL", "INTERNAL_SERVICE_JWT_SECRETS"]) {
    const mint = createLifecycleServiceTokenIssuer({ getEnvironment: () => ({ COURSE_ACCOUNT_LIFECYCLE_JWT_CURRENT_SECRET: current, [name]: name.endsWith("SECRETS") ? `other,${current}` : current }) });
    assert.throws(() => mint("course"), error => error instanceof LifecycleTokenError && !error.message.includes(current));
  }
  for (const values of [
    {}, { COURSE_ACCOUNT_LIFECYCLE_JWT_CURRENT_SECRET: "short" },
    { COURSE_ACCOUNT_LIFECYCLE_JWT_CURRENT_SECRET: current, COURSE_ACCOUNT_LIFECYCLE_JWT_PREVIOUS_SECRET: current },
    { COURSE_ACCOUNT_LIFECYCLE_JWT_CURRENT_SECRET: current, COURSE_ACCOUNT_LIFECYCLE_JWT_PREVIOUS_SECRET: "short" },
    { COURSE_ACCOUNT_LIFECYCLE_JWT_CURRENT_SECRET: ` ${current}` },
  ]) assert.throws(() => createLifecycleServiceTokenIssuer({ getEnvironment: () => values })("course"), LifecycleTokenError);
  assert.throws(() => createLifecycleServiceTokenIssuer({ now: () => NaN, getEnvironment: () => ({ COURSE_ACCOUNT_LIFECYCLE_JWT_CURRENT_SECRET: current }) })("course"), LifecycleTokenError);
});
