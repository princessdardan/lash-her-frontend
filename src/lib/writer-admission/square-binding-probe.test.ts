import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import type { IncomingMessage } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFrontendSquareBindingProbe, readSquareLocation } from "./square-binding-probe";

const locationId = "LE2H76M5V90AM", source = { environment: "staging", sourceCommit: "a".repeat(40) };
const environment = () => ({ APP_ENV: "staging", VERCEL_GIT_COMMIT_SHA: source.sourceCommit, SQUARE_ACCESS_TOKEN: "owned-private-marker",
  SQUARE_LOCATION_ID: locationId, SQUARE_ENVIRONMENT: "sandbox", SQUARE_APPLICATION_ID: "sandbox-sq0idb-owned", LASH_RELEASE_SQUARE_MERCHANT_ID: "ownedMerchant" });

test("Square binding requires exact staging/source/location before accessing a server credential", async () => {
  let calls = 0;
  const readLocation = async () => { calls++; return { location: { id: locationId, merchant_id: "ownedMerchant", currency: "CAD", country: "CA", status: "ACTIVE", secret: "provider-private-marker" } }; };
  const run = createFrontendSquareBindingProbe({ environment, readLocation });
  assert.deepEqual(await run(source), { squareBinding: { environment: "sandbox", locationId, merchantId: "ownedMerchant", applicationId: "sandbox-sq0idb-owned", currency: "CAD", country: "CA", locationStatus: "ACTIVE" } });
  assert.equal(calls, 1);
  for (const values of [{ APP_ENV: "production" }, { VERCEL_GIT_COMMIT_SHA: "b".repeat(40) }, { SQUARE_ACCESS_TOKEN: "" },
    { SQUARE_LOCATION_ID: "production" }, { SQUARE_ENVIRONMENT: "production" }, { SQUARE_APPLICATION_ID: "sq0idp-production" }]) {
    await assert.rejects(createFrontendSquareBindingProbe({ environment: () => ({ ...environment(), ...values }), readLocation })(source), /FRONTEND_SQUARE_BINDING_PROBE_REFUSED/u);
  }
  assert.equal(calls, 1);
  for (const value of [{ location: { id: locationId, merchant_id: "wrongMerchant", currency: "CAD", country: "CA", status: "ACTIVE" } }, { location: { id: locationId, merchant_id: "ownedMerchant", currency: "CAD", country: "CA", status: "INACTIVE" } }]) {
    await assert.rejects(createFrontendSquareBindingProbe({ environment, readLocation: async () => value })(source), /FRONTEND_SQUARE_BINDING_PROBE_REFUSED/u);
  }
  await assert.rejects(createFrontendSquareBindingProbe({ environment, readLocation: async () => { throw new Error("private-provider-marker"); } })(source), error => !String(error).includes("private-provider-marker"));
});

test("fixed inert Square HTTPS GET rejects TLS, redirects, wrong type, oversized and unauthorized responses", async () => {
  const directory = mkdtempSync(join(tmpdir(), "square-binding-owned-"));
  const key = join(directory, "server.key"), certificate = join(directory, "server.crt");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });
  const ca = readFileSync(certificate), privateKey = readFileSync(key);
  let status = 200, body = JSON.stringify({ location: { id: locationId, merchant_id: "ownedMerchant", currency: "CAD", country: "CA", status: "ACTIVE" } }), type = "application/json", untrusted = false, calls = 0;
  const server = https.createServer({ key: privateKey, cert: ca }, (request, response) => {
    calls++; assert.equal(request.method, "GET"); assert.equal(request.url, `/v2/locations/${locationId}`);
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
      assert.equal(options.protocol, "https:"); assert.equal(options.hostname, "connect.squareupsandbox.com"); assert.equal(options.port, 443);
      assert.equal(options.method, "GET"); assert.equal(options.path, `/v2/locations/${locationId}`); assert.equal(options.rejectUnauthorized, true);
      return real({ ...options, hostname: "127.0.0.1", port: address.port, servername: "localhost", ...(untrusted ? {} : { ca }) }, callback);
    }) as typeof https.request;
    syncBuiltinESMExports();
    assert.equal((await readSquareLocation(locationId, "owned-private-marker") as { location: { id: string } }).location.id, locationId);
    for (const bad of ["unauthorized", "redirect", "type", "large", "tls"]) {
      status = bad === "unauthorized" ? 401 : bad === "redirect" ? 302 : 200;
      type = bad === "type" ? "text/html" : "application/json"; body = bad === "large" ? "x".repeat(65_537) : "private-provider-marker"; untrusted = bad === "tls";
      await assert.rejects(readSquareLocation(locationId, "owned-private-marker"), error => !String(error).includes("private-provider-marker"));
    }
    const before = calls;
    await assert.rejects(readSquareLocation("../api-keys", "owned-private-marker")); assert.equal(calls, before);
  } finally {
    https.request = real; syncBuiltinESMExports();
    await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true });
  }
});
