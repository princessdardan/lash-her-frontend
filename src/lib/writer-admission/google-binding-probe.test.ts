import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import test from "node:test";
import { createFrontendGoogleBindingProbe } from "./google-binding-probe";

const source = { environment: "staging", sourceCommit: "a".repeat(40) }, challenge = "c".repeat(64);
const environment = () => ({ APP_ENV: "staging", VERCEL_GIT_COMMIT_SHA: source.sourceCommit,
  AUTH_GOOGLE_ID: "185770842371-d3thak0b2btgb77pngj968nvhpjkqmgf.apps.googleusercontent.com",
  GOOGLE_CLIENT_ID: "185770842371-lg0fktlf96u88pnqjnoom83st75btv4d.apps.googleusercontent.com",
  AUTH_GOOGLE_SECRET: randomBytes(32).toString("hex"), GOOGLE_CLIENT_SECRET: randomBytes(32).toString("hex") });

test("Google runtime equality proofs bind each exact client, challenge and domain without exposing keys", async () => {
  const env = environment(), run = createFrontendGoogleBindingProbe({ environment: () => env });
  const value = await run(source, challenge);
  for (const [kind, key] of [["identity", "AUTH_GOOGLE_SECRET"], ["calendar", "GOOGLE_CLIENT_SECRET"]] as const) {
    assert.equal(value.googleBinding[kind].proof, createHmac("sha256", env[key]).update(`lash-her:frontend-google-binding:v1:${kind}:${challenge}`).digest("hex"));
    assert.equal(JSON.stringify(value).includes(env[key]), false);
  }
  assert.equal(value.googleBinding.projectId, "lash-her-staging-20261022");
  assert.notEqual((await run(source, "d".repeat(64))).googleBinding.identity.proof, value.googleBinding.identity.proof);
  assert.notEqual(value.googleBinding.identity.proof, value.googleBinding.calendar.proof);
});

test("Google proof refuses wrong source, production, client substitutions and malformed or reused keys", async () => {
  const env = environment();
  for (const change of [{ APP_ENV: "production" }, { VERCEL_GIT_COMMIT_SHA: "b".repeat(40) }, { AUTH_GOOGLE_ID: env.GOOGLE_CLIENT_ID },
    { GOOGLE_CLIENT_ID: env.AUTH_GOOGLE_ID }, { AUTH_GOOGLE_SECRET: "" }, { GOOGLE_CLIENT_SECRET: "short" },
    { AUTH_GOOGLE_SECRET: env.GOOGLE_CLIENT_SECRET }]) {
    await assert.rejects(createFrontendGoogleBindingProbe({ environment: () => ({ ...env, ...change }) })(source, challenge), { message: "FRONTEND_GOOGLE_BINDING_PROBE_REFUSED" });
  }
  let reads = 0;
  const run = createFrontendGoogleBindingProbe({ environment: () => { reads++; return env; } });
  await assert.rejects(run({ ...source, environment: "production" }, challenge));
  await assert.rejects(run(source, "wrong")); assert.equal(reads, 0);
});
