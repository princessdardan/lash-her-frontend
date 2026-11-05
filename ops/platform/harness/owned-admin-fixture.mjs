// Exercise the exact staging helper against published APIs on the owned mesh.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { SignJWT } from "/app/node_modules/jose/dist/webapi/index.js";
import { prepareFixture, privateTlsCaller } from "/test/staging-fixture.mjs";

assert.equal(process.env.OWNED_RECOVERY_FIXTURE, "1");
assert.equal(process.env.NODE_ENV, "test");
const phase2 = process.env.HARNESS_CONTRACT_PHASE === "p2";
const secret = phase2 ? process.env.HARNESS_COURSE_ADMIN_SECRET : process.env.HARNESS_FIRST_PARTY_SECRET;
assert.match(secret ?? "", /^[a-f0-9]{64}$/u);
const actorUserId = randomUUID(), nonce = randomUUID().replaceAll("-", "");
const builder = new SignJWT(phase2 ? { version: 1, capabilities: ["course-editor", "course-support"] } : { role: "courseAdmin" });
if (phase2) builder.setIssuer("lash-her-frontend").setAudience("lash-her-course-api:admin").setJti(randomUUID());
const applicationToken = await builder.setProtectedHeader({ alg: "HS256" })
  .setSubject(actorUserId).setIssuedAt().setExpirationTime("5m")
  .sign(new TextEncoder().encode(secret));
const result = await prepareFixture({ version: phase2 ? 2 : 1, environment: "staging", actionId: `recovery-fixture-owned-${randomUUID()}`,
  nonce, actorUserId, userIds: [randomUUID(), randomUUID()], applicationToken },
{ call: privateTlsCaller(readFileSync("/test/tls/ca.pem")) });
assert.equal(result.status, "STAGING_FIXTURE_TWO_GRANTS_CREATED");
process.stdout.write(JSON.stringify(result) + "\n");
