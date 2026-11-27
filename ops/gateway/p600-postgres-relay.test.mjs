import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { connect, createServer } from "node:net";
import { test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { WebSocket } from "ws";
import { createPostgresRelay } from "./p600-postgres-relay.mjs";

const host = "api-p600.lashher.com";
const path = "/internal/p6-00/postgres";
const issuer = "https://oidc.vercel.com/dardan-demiris-projects";
const audience = "https://vercel.com/dardan-demiris-projects";
const subject = "owner:dardan-demiris-projects:project:lash-her-frontend-staging:environment:production";
const proof = "a".repeat(64);
const sslRequest = Buffer.from("0000000804d2162f", "hex");
const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = { ...await exportJWK(publicKey), alg: "RS256", kid: "test" };

async function jwt(overrides = {}) {
  const time = Math.floor(Date.now() / 1_000);
  return new SignJWT({
    iss: issuer, aud: audience, sub: subject, iat: time, nbf: time, exp: time + 60,
    owner_id: "team_2Hrn5eMZyZxfAWdmYvyKi9t3", project_id: "prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM", environment: "production",
    ...overrides,
  }).setProtectedHeader({ alg: "RS256", kid: "test" }).sign(privateKey);
}

function tryUpgrade(url, headers) {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(url, { headers, perMessageDeflate: false });
    client.once("open", () => resolve(client));
    client.once("error", reject);
    client.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode);
      client.terminate();
    });
  });
}

async function listen(server) {
  const ready = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await ready;
  return server.address().port;
}

async function fixture(t, proofTtlMs = 60_000) {
  const received = [];
  const targets = [];
  const backend = createServer((socket) => {
    socket.on("data", (data) => {
      received.push(data);
      socket.write(data);
    });
  });
  const port = await listen(backend);
  const relay = createPostgresRelay({
    proofHash: createHash("sha256").update(proof, "ascii").digest("hex"),
    proofExpiresAt: new Date(Date.now() + proofTtlMs).toISOString(),
    fetchJwks: async (request) => {
      assert.equal(String(request), `${issuer}/.well-known/jwks`);
      return Response.json({ keys: [jwk] });
    },
    connectDatabase: (target) => {
      targets.push(target);
      return connect({ host: "127.0.0.1", port });
    },
  });
  const url = `ws://127.0.0.1:${await listen(relay.server)}${path}`;
  t.after(async () => {
    await new Promise((resolve) => relay.close(resolve));
    await new Promise((resolve) => backend.close(resolve));
  });
  return { received, targets, url };
}

async function headers(claims) {
  return { Host: host, "x-lash-p600-db-proof": proof, "x-lash-workload-token": await jwt(claims) };
}

test("unauthorized workloads and alternate request targets never open a database socket", async (t) => {
  const { targets, url } = await fixture(t);
  const primary = await headers();
  assert.equal(await tryUpgrade(url, { Host: host }), 401);
  assert.equal(await tryUpgrade(url, { ...primary, "x-lash-p600-db-proof": "b".repeat(64) }), 401);
  assert.equal(await tryUpgrade(url, { ...primary, "x-lash-p600-db-proof": [proof, proof] }), 401);
  assert.equal(await tryUpgrade(url, { ...primary, Origin: "https://example.invalid" }), 401);
  assert.equal(await tryUpgrade(url, { ...primary, Host: "example.invalid" }), 404);
  assert.equal(await tryUpgrade(`${url}?host=other`, primary), 404);
  for (const claims of [
    { iss: "https://oidc.vercel.com/another-team" },
    { aud: "https://vercel.com/another-team" },
    { sub: subject.replace("staging", "production") },
    { owner_id: "team_other" },
    { project_id: "prj_other" },
    { environment: "preview" },
    { exp: Math.floor(Date.now() / 1_000) - 10 },
  ]) assert.equal(await tryUpgrade(url, await headers(claims)), 401);
  assert.deepEqual(targets, []);
});

test("the relay waits for a binary TLS request and uses one fixed backend for subsequent data", async (t) => {
  const { received, targets, url } = await fixture(t);
  const primary = await headers();
  const invalid = await tryUpgrade(url, primary);
  const denied = once(invalid, "close");
  invalid.send("plaintext");
  await denied;
  assert.deepEqual(targets, []);

  const valid = await tryUpgrade(url, primary);
  assert.deepEqual(targets, []);
  let message = once(valid, "message");
  valid.send(sslRequest);
  assert.deepEqual(await message, [sslRequest, true]);
  const bytes = Buffer.from([0, 255, 1, 13, 0]);
  message = once(valid, "message");
  valid.send(bytes);
  assert.deepEqual(await message, [bytes, true]);
  assert.deepEqual(targets, [{ host: "p600-frontend-db.lashher.com", port: 5432 }]);
  assert.deepEqual(received, [sslRequest, bytes]);
  valid.close();
});

test("the relay bounds active WebSockets, then expires existing sessions with the proof", async (t) => {
  const { targets, url } = await fixture(t, 1_000);
  const primary = await headers();
  const clients = await Promise.all(Array.from({ length: 8 }, () => tryUpgrade(url, primary)));
  for (const client of clients) assert.ok(client instanceof WebSocket);
  const closures = Promise.all(clients.map((client) => once(client, "close")));
  assert.equal(await tryUpgrade(url, primary), 503);
  await closures;
  assert.equal(await tryUpgrade(url, primary), 401);
  assert.deepEqual(targets, []);
});
