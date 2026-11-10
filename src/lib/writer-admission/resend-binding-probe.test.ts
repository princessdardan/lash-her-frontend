import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import type { IncomingMessage } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFrontendResendBindingProbe, readResendDomain } from "./resend-binding-probe";

const domainId = "d7371c9b-b16d-41d8-b9e8-3286b58eb432", source = { environment: "staging", sourceCommit: "a".repeat(40) };
const environment = () => ({ APP_ENV: "staging", VERCEL_GIT_COMMIT_SHA: source.sourceCommit, RESEND_API_KEY: "owned-private-marker",
  LASH_RELEASE_RESEND_DOMAIN_ID: domainId, LASH_RELEASE_RESEND_DOMAIN_NAME: "mail.staging.lashher.com" });

test("Resend binding requires exact staging/source/domain before accessing a server credential", async () => {
  let calls = 0;
  const readDomain = async () => { calls++; return { id: domainId, name: "mail.staging.lashher.com", status: "verified", secret: "provider-private-marker" }; };
  const run = createFrontendResendBindingProbe({ environment, readDomain });
  assert.deepEqual(await run(source), { resendBinding: { domainId, domainName: "mail.staging.lashher.com", domainStatus: "verified" } });
  assert.equal(calls, 1);
  for (const values of [{ APP_ENV: "production" }, { VERCEL_GIT_COMMIT_SHA: "b".repeat(40) }, { RESEND_API_KEY: "" },
    { LASH_RELEASE_RESEND_DOMAIN_ID: "../api-keys" }, { LASH_RELEASE_RESEND_DOMAIN_NAME: "mail.lashher.com" }]) {
    await assert.rejects(createFrontendResendBindingProbe({ environment: () => ({ ...environment(), ...values }), readDomain })(source), /FRONTEND_RESEND_BINDING_PROBE_REFUSED/u);
  }
  assert.equal(calls, 1);
  for (const value of [{ id: domainId, name: "mail.lashher.com", status: "verified" }, { id: domainId, name: "mail.staging.lashher.com", status: "pending" }]) {
    await assert.rejects(createFrontendResendBindingProbe({ environment, readDomain: async () => value })(source), /FRONTEND_RESEND_BINDING_PROBE_REFUSED/u);
  }
  await assert.rejects(createFrontendResendBindingProbe({ environment, readDomain: async () => { throw new Error("private-provider-marker"); } })(source), error => !String(error).includes("private-provider-marker"));
});

test("fixed inert Resend HTTPS GET rejects TLS, redirects, wrong type, oversized and unauthorized responses", async () => {
  const directory = mkdtempSync(join(tmpdir(), "resend-binding-owned-"));
  const key = join(directory, "server.key"), certificate = join(directory, "server.crt");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });
  const ca = readFileSync(certificate), privateKey = readFileSync(key);
  let status = 200, body = JSON.stringify({ id: domainId, name: "mail.staging.lashher.com", status: "verified" }), type = "application/json", untrusted = false, calls = 0;
  const server = https.createServer({ key: privateKey, cert: ca }, (request, response) => {
    calls++; assert.equal(request.method, "GET"); assert.equal(request.url, `/domains/${domainId}`);
    assert.equal(request.headers.authorization, "Bearer owned-private-marker");
    response.writeHead(status, { "content-type": type, location: "https://untrusted.example.invalid/secret" }); response.end(body);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const real = https.request;
  try {
    // Test-only transport mapping. Assert the production helper always selects
    // the fixed official provider host/port/method/path with verified TLS.
    https.request = ((options: https.RequestOptions, callback: (response: IncomingMessage) => void) => {
      assert.equal(options.protocol, "https:"); assert.equal(options.hostname, "api.resend.com"); assert.equal(options.port, 443);
      assert.equal(options.method, "GET"); assert.equal(options.path, `/domains/${domainId}`); assert.equal(options.rejectUnauthorized, true);
      return real({ ...options, hostname: "127.0.0.1", port: address.port, servername: "localhost", ...(untrusted ? {} : { ca }) }, callback);
    }) as typeof https.request;
    syncBuiltinESMExports();
    assert.equal((await readResendDomain(domainId, "owned-private-marker") as Record<string, unknown>).id, domainId);
    for (const bad of ["unauthorized", "redirect", "type", "large", "tls"]) {
      status = bad === "unauthorized" ? 401 : bad === "redirect" ? 302 : 200;
      type = bad === "type" ? "text/html" : "application/json"; body = bad === "large" ? "x".repeat(65_537) : "private-provider-marker"; untrusted = bad === "tls";
      await assert.rejects(readResendDomain(domainId, "owned-private-marker"), error => !String(error).includes("private-provider-marker"));
    }
    const before = calls;
    await assert.rejects(readResendDomain("../api-keys", "owned-private-marker")); assert.equal(calls, before);
  } finally {
    https.request = real; syncBuiltinESMExports();
    await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true });
  }
});
