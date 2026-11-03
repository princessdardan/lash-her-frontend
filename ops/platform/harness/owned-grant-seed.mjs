// One-off synthetic producer; executed on the owned gateway peer only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { SignJWT } from "/app/node_modules/jose/dist/webapi/index.js";

const fixtures = JSON.parse(readFileSync("/test/seed-grants.json", "utf8"));
assert.equal(fixtures.length, 2);
for (const fixture of fixtures) {
  const now = Math.floor(Date.now() / 1000), idempotencyKey = randomUUID();
  const token = await new SignJWT({ iat: now, exp: now + 300, jti: randomUUID() })
    .setProtectedHeader({ alg: "HS256" }).setIssuer("lash-her-frontend").setAudience("lash-her-course-api")
    .setSubject("lash-her-frontend").sign(new TextEncoder().encode(process.env.HARNESS_FRONTEND_SECRET));
  const reply = await fetch("https://course-tls:8443/v1/internal/entitlements/grants", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-idempotency-key": idempotencyKey },
    body: JSON.stringify({ ...fixture, orderId: `fixture-${idempotencyKey}`, idempotencyKey, grantReason: "import", grantedAt: new Date().toISOString() }),
    signal: AbortSignal.timeout(5000),
  });
  assert.ok([200, 201].includes(reply.status)); await reply.arrayBuffer();
}
process.stdout.write('{"status":"OWNED_PENDING_GRANTS_CREATED","count":2}\n');
