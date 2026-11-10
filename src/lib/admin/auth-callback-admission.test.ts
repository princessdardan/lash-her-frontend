import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("the real admin Auth.js handlers preserve settled denials and leave failed Google and rotation outcomes uncertain", () => {
  const result = spawnSync(process.execPath, [
    "--import", "./scripts/register-server-only-test.mjs", "--import", "tsx", "--input-type=module", "--eval",
    String.raw`
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { SignJWT, generateKeyPair, exportJWK } from "jose";
import { NextRequest } from "next/server.js";
import { encode } from "next-auth/jwt";
import { currentWriterOperationIdentity, withWriterOperationContext } from "./src/lib/writer-admission/context.ts";
import { interactiveAdmissionFixture } from "./src/lib/writer-admission/interactive-fixture.ts";

const origin = "https://owned.example.invalid";
const actorId = "11111111-1111-4111-8111-111111111111";
const secret = "owned-admin-callback-admission-fixture-secret";
const clientId = "owned-admin-google";
const profile = { sub: "owned-subject", email: "owned@example.invalid" };
Object.assign(process.env, {
  AUTH_SECRET: secret, AUTH_URL: origin, AUTH_TRUST_HOST: "true",
  AUTH_GOOGLE_ID: clientId, AUTH_GOOGLE_SECRET: "owned-google-secret",
  AUTH_REDIRECT_PROXY_URL: "https://owned-proxy.example.invalid/api/auth",
});

let fixture, selected, mode, grantCalls, dbCalls;
const store = {
  findByEmailNormalized: async () => selectedUser(),
  findByProviderUserId: async () => selectedUser(),
};
function selectedUser() {
  assert.ok(currentWriterOperationIdentity());
  dbCalls++;
  if (mode === "database-unavailable") throw new Error("OWNED_DATABASE_CANARY");
  return null;
}
globalThis.ownedAdminCallback = {
  store,
  run(kind, work, options) {
    if (!fixture) return work();
    assert.equal(kind, "recovery");
    return fixture.run(kind, () => selected ? withWriterOperationContext(
      work, currentWriterOperationIdentity(), undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { actorKind: "admin", actorId },
    ) : work(), options);
  },
};
const stubs = {
  "@/lib/admin/admin-user-store": "exports.getAdminUserStore = () => globalThis.ownedAdminCallback.store;",
  "@/lib/writer-admission/runtime": "exports.runWriterAdmission = (...args) => globalThis.ownedAdminCallback.run(...args);",
};
const directory = mkdtempSync(join(tmpdir(), "owned-admin-callback-"));
process.on("exit", () => rmSync(directory, { recursive: true, force: true }));
const stubUrls = new Map(Object.entries(stubs).map(([specifier, source], index) => {
  const path = join(directory, "stub-" + index + ".cjs");
  writeFileSync(path, source);
  return [specifier, pathToFileURL(path).href];
}));
registerHooks({ resolve(specifier, context, next) {
  if (stubUrls.has(specifier)) {
    return { url: stubUrls.get(specifier), format: "commonjs", shortCircuit: true };
  }
  return next(specifier, context);
} });

const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
const jwk = { ...await exportJWK(publicKey), kid: "owned-key", alg: "RS256", use: "sig" };
globalThis.fetch = async (input, init) => {
  const target = String(input);
  if (target === "https://accounts.google.com/.well-known/openid-configuration") {
    if (fixture && mode === "malformed-discovery") return Response.json({});
    return Response.json({
      issuer: "https://accounts.google.com", authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      token_endpoint: "https://oauth2.googleapis.com/token", userinfo_endpoint: "https://openidconnect.googleapis.com/v1/userinfo",
      jwks_uri: "https://www.googleapis.com/oauth2/v3/certs", response_types_supported: ["code"],
      subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"],
    });
  }
  if (target === "https://www.googleapis.com/oauth2/v3/certs") return Response.json({ keys: [jwk] });
  assert.equal(target, "https://oauth2.googleapis.com/token");
  assert.equal(init.method, "POST");
  assert.equal(Boolean(currentWriterOperationIdentity()), Boolean(fixture));
  grantCalls++;
  if (mode === "transport-failure") throw new TypeError(fixture ? "OWNED_PROVIDER_CANARY" : "off-mode fixture failure");
  if (mode === "provider-unavailable") return Response.json({ error: "server_error" }, { status: 503 });
  if (mode === "malformed-token") return Response.json({ access_token: "owned-access", token_type: "Bearer" });
  if (mode === "invalid-grant") return Response.json({ error: "invalid_grant" }, { status: 400 });
  const idToken = await new SignJWT({ ...profile, email_verified: mode !== "unverified" })
    .setProtectedHeader({ alg: "RS256", kid: jwk.kid }).setIssuer("https://accounts.google.com")
    .setAudience(clientId).setIssuedAt().setExpirationTime("5m").sign(privateKey);
  return Response.json({ access_token: "owned-access", token_type: "Bearer", expires_in: 300, id_token: idToken });
};

const { GET, POST } = await import("./src/app/api/auth/[...nextauth]/route.ts");
const cookiePairs = response => response.headers.getSetCookie().map(value => value.split(";", 1)[0]);
const request = (path, init) => new NextRequest(origin + "/api/auth/" + path, init);
async function callback(nextMode, { off = false, redirectJson = false, rotation = false } = {}) {
  fixture = undefined;
  mode = nextMode;
  grantCalls = dbCalls = 0;
  const csrf = await GET(request("csrf"));
  const { csrfToken } = await csrf.json();
  const start = await POST(request("signin/google", {
    method: "POST",
    headers: { cookie: cookiePairs(csrf).join("; "), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrfToken, callbackUrl: origin + "/admin" }),
  }));
  const authorization = new URL(start.headers.get("location"));
  assert.equal(authorization.origin, "https://accounts.google.com");
  const state = authorization.searchParams.get("state");
  assert.ok(state);
  const params = new URLSearchParams({
    ...(mode === "provider-denied" ? { error: "access_denied" } : { code: "owned-code" }),
    state: mode === "invalid-state" ? "invalid-state" : state,
  });
  const pairs = new Map([...cookiePairs(csrf), ...cookiePairs(start)].map(pair => [pair.split("=", 1)[0], pair]));
  fixture = off ? undefined : interactiveAdmissionFixture();
  selected = rotation;
  return GET(request("callback/google?" + params, {
    headers: { cookie: [...pairs.values()].join("; "), ...(redirectJson ? { "x-auth-return-redirect": "1" } : {}) },
  }));
}

function receipt(uncertain) {
  assert.deepEqual(fixture.events, ["admitted", "settled"]);
  assert.equal(fixture.state.uncertain, uncertain);
}
function unavailable(response) {
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "30");
  assert.equal(response.headers.get("set-cookie"), null);
  receipt(true);
}
for (const [failure, redirectJson] of [["transport-failure", false], ["transport-failure", true],
    ["provider-unavailable", false], ["malformed-token", false]]) {
  unavailable(await callback(failure, { redirectJson }));
  assert.equal(grantCalls, 1);
}
unavailable(await callback("malformed-discovery"));
assert.equal(grantCalls, 0);
for (const [denial, exchanges] of [["invalid-state", 0], ["provider-denied", 0], ["invalid-grant", 1], ["unverified", 1], ["different-admin", 1]]) {
  const response = await callback(denial, { rotation: denial === "different-admin" });
  assert.equal(response.status, 302, denial);
  assert.match(response.headers.get("location"), /\/admin\/sign-in\?error=/u);
  assert.equal(grantCalls, exchanges);
  receipt(false);
}
unavailable(await callback("database-unavailable", { rotation: true }));
assert.equal(grantCalls, 1);
assert.equal(dbCalls, 2);
const signedIn = await callback("accepted");
assert.equal(signedIn.headers.get("location"), origin + "/admin");
assert.ok(cookiePairs(signedIn).some(cookie => cookie.startsWith("__Secure-authjs.session-token=")));
receipt(false);

const salt = "__Secure-authjs.session-token";
const jwt = await encode({ secret, salt, token: { ...profile, providerUserId: profile.sub, googleEmailVerified: true } });
const sessionRequest = () => request("session", { headers: { cookie: salt + "=" + jwt } });
selected = true;
mode = "different-admin";
fixture = interactiveAdmissionFixture();
const deniedSession = await GET(sessionRequest());
assert.equal(deniedSession.status, 403);
assert.equal(deniedSession.headers.get("set-cookie"), null);
receipt(false);
mode = "database-unavailable";
fixture = interactiveAdmissionFixture();
unavailable(await GET(sessionRequest()));

const ordinary = await callback("transport-failure", { off: true, redirectJson: true });
assert.equal(ordinary.status, 200);
assert.match((await ordinary.json()).url, /\/admin\/sign-in\?error=Configuration/u);
`,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.doesNotMatch(result.stderr, /OWNED_(DATABASE|PROVIDER)_CANARY/u);
});
