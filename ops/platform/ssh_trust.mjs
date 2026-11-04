// Public server-key verification only. Empty AWS metadata never authorizes
// first-use trust, ssh-keyscan, removal of old trust or credential retrieval.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";

function timestamp(value) {
  const result = typeof value === "number" ? value * 1000 : Date.parse(value);
  assert.ok(Number.isFinite(result) && result > 0, "AWS SSH timestamp required");
  return result;
}

function publicKey(value) {
  assert.equal(typeof value, "string");
  const parts = value.trim().split(/\s+/u);
  assert.ok(parts.length === 1 || parts.length === 2, "Bare blob or public key line required");
  const encoded = parts.at(-1);
  assert.match(encoded, /^[A-Za-z0-9+/]+={0,2}$/u);
  const blob = Buffer.from(encoded, "base64");
  assert.ok(blob.length > 4 && blob.length < 8192 && blob.toString("base64").replace(/=+$/u, "") === encoded.replace(/=+$/u, ""));
  const length = blob.readUInt32BE(0);
  assert.ok(length > 0 && length < 80 && blob.length > 4 + length);
  const algorithm = blob.subarray(4, 4 + length).toString("ascii");
  assert.ok(["ssh-ed25519", "ecdsa-sha2-nistp256", "ssh-rsa"].includes(algorithm), "Reviewed SSH server key required");
  if (parts.length === 2) assert.equal(parts[0], algorithm);
  if (algorithm === "ssh-ed25519") {
    assert.equal(blob.length, 4 + length + 4 + 32);
    assert.equal(blob.readUInt32BE(4 + length), 32);
  }
  return {algorithm, encoded: blob.toString("base64"), fingerprint: "SHA256:" + createHash("sha256").update(blob).digest("base64").replace(/=+$/u, "")};
}

export function awsSshTrust(metadata, infrastructure, spec, actionStartedAt, now = Date.now()) {
  assert.equal(infrastructure.status, "STAGING_INFRASTRUCTURE_STATE_VERIFIED");
  assert.equal(infrastructure.state, "attached");
  assert.equal(infrastructure.addressArn, spec.addressArn); assert.equal(infrastructure.address, spec.address);
  assert.notEqual(infrastructure.instanceArn, spec.originalInstanceArn);
  const created = timestamp(infrastructure.instanceCreatedAt);
  assert.ok(Number.isSafeInteger(actionStartedAt) && created >= actionStartedAt && created <= now + 5000, "Actual newly created instance required");
  assert.deepEqual(Object.keys(metadata).sort(), ["hostKeys", "instanceName", "ipAddress", "protocol", "username"]);
  assert.equal(metadata.instanceName, spec.instanceName); assert.equal(metadata.ipAddress, spec.address);
  assert.equal(metadata.username, "ubuntu"); assert.equal(metadata.protocol, "ssh");
  assert.ok(Array.isArray(metadata.hostKeys) && metadata.hostKeys.length > 0 && metadata.hostKeys.length <= 8,
    "AWS_AUTHENTICATED_SSH_HOST_KEYS_UNAVAILABLE");
  const keys = metadata.hostKeys.map(key => {
    const parsed = publicKey(key.publicKey);
    assert.equal(key.fingerprintSHA256, parsed.fingerprint, "AWS public-key fingerprint mismatch");
    // AWS names the key algorithm separately; the wire blob is authoritative.
    assert.ok([parsed.algorithm, parsed.algorithm.replace(/^ssh-/u, ""), parsed.algorithm.startsWith("ecdsa-") ? "ecdsa" : ""].includes(key.algorithm));
    const witnessed = timestamp(key.witnessedAt);
    assert.ok(witnessed >= created - 5000 && witnessed <= now + 5000 && now - witnessed <= 900_000,
      "Fresh AWS server-key observation required");
    if (key.notValidBefore != null) assert.ok(timestamp(key.notValidBefore) <= now);
    if (key.notValidAfter != null) assert.ok(timestamp(key.notValidAfter) > now);
    return parsed;
  });
  assert.equal(new Set(keys.map(key => key.algorithm)).size, keys.length, "Duplicate server key algorithm refused");
  const key = keys.find(k => k.algorithm === "ssh-ed25519");
  assert.ok(key, "AWS_AUTHENTICATED_ED25519_HOST_KEY_REQUIRED");
  return {status: "NEW_STAGING_SSH_PUBLIC_TRUST_VERIFIED", instanceArn: infrastructure.instanceArn,
    addressArn: spec.addressArn, address: spec.address, fingerprint: key.fingerprint,
    knownHosts: `${spec.address} ${key.algorithm} ${key.encoded}\n`,
    hostKeyAlgorithm: key.algorithm, credentialsRetrieved: false, oldTrustChanged: false};
}

// This is deliberately first-use acceptance by the sole operator. It does not
// claim that AWS authenticated the key. The CLI never selects this mode until
// Dardan chooses it, and acceptance must bind this action, new instance and key.
export function operatorAcceptedSshTrust(proof, infrastructure, spec, action, actionStartedAt, now=Date.now()) {
  assert.equal(infrastructure.status,"STAGING_INFRASTRUCTURE_STATE_VERIFIED");assert.equal(infrastructure.state,"attached");
  assert.equal(infrastructure.addressArn,spec.addressArn);assert.equal(infrastructure.address,spec.address);
  assert.notEqual(infrastructure.instanceArn,spec.originalInstanceArn);
  const created=timestamp(infrastructure.instanceCreatedAt);
  assert.ok(created>=actionStartedAt&&created<=now+5000);
  assert.equal(proof.version,1);assert.equal(proof.trustMode,"operator-first-use");assert.equal(proof.acceptedBy,"Dardan");
  assert.equal(proof.action,action);assert.equal(proof.instanceArn,infrastructure.instanceArn);assert.equal(proof.address,spec.address);
  assert.equal(typeof proof.acceptedAt,"string");
  const accepted=Date.parse(proof.acceptedAt);
  assert.ok(Number.isFinite(accepted)&&accepted>=created&&accepted<=now+5000,"Acceptance after new instance creation required");
  const key=publicKey(proof.hostPublicKey);
  assert.equal(key.algorithm,"ssh-ed25519");assert.equal(proof.acceptedFingerprint,key.fingerprint);
  return {status:"OPERATOR_ACCEPTED_NEW_STAGING_SSH_KEY",trustMode:"operator-first-use",action,
    instanceArn:infrastructure.instanceArn,address:spec.address,fingerprint:key.fingerprint,
    knownHosts:`${spec.address} ${key.algorithm} ${key.encoded}\n`,hostKeyAlgorithm:key.algorithm,
    awsAuthenticatedHostKey:false,credentialsRetrieved:false,oldTrustChanged:false};
}
