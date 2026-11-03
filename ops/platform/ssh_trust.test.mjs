import test from "node:test";
import assert from "node:assert/strict";
import {createHash, generateKeyPairSync} from "node:crypto";
import {awsSshTrust,operatorAcceptedSshTrust} from "./ssh_trust.mjs";

const now = Date.parse("2026-11-03T05:00:00Z");
function fixture() {
  const key = generateKeyPairSync("ed25519").publicKey.export({format:"jwk"});
  const algorithm = Buffer.from("ssh-ed25519");
  const blob = Buffer.alloc(4 + algorithm.length + 4 + 32);
  blob.writeUInt32BE(algorithm.length, 0); algorithm.copy(blob, 4); blob.writeUInt32BE(32, algorithm.length + 4);
  Buffer.from(key.x, "base64url").copy(blob, algorithm.length + 8);
  const hostKey = {algorithm:"ssh-ed25519", publicKey:blob.toString("base64"),
    fingerprintSHA256:"SHA256:" + createHash("sha256").update(blob).digest("base64").replace(/=+$/u, ""),
    witnessedAt: new Date(now - 1000).toISOString(), notValidBefore:null, notValidAfter:null};
  const spec = {addressArn:"unchanged-static-ip",address:"184.196.129.231",originalInstanceArn:"old-instance",instanceName:"lash-her-api-staging-host"};
  const infrastructure = {status:"STAGING_INFRASTRUCTURE_STATE_VERIFIED",state:"attached",addressArn:spec.addressArn,
    address:spec.address,instanceArn:"new-instance",instanceCreatedAt:new Date(now - 3000).toISOString()};
  const metadata = {instanceName:spec.instanceName,ipAddress:spec.address,protocol:"ssh",username:"ubuntu",hostKeys:[hostKey]};
  return {metadata,infrastructure,spec};
}
const verify = f => awsSshTrust(f.metadata,f.infrastructure,f.spec,now-5000,now);

test("AWS-bound fresh key yields a separate explicit known_hosts line", () => {
  const f=fixture(), result=verify(f);
  assert.equal(result.status,"NEW_STAGING_SSH_PUBLIC_TRUST_VERIFIED");
  assert.equal(result.oldTrustChanged,false); assert.equal(result.credentialsRetrieved,false);
  assert.equal(result.knownHosts,`${f.spec.address} ssh-ed25519 ${f.metadata.hostKeys[0].publicKey}\n`);
});
test("empty provider metadata or temporary credentials never establish first-use trust", () => {
  const f=fixture(); f.metadata.hostKeys=[];
  assert.throws(()=>verify(f),/HOST_KEYS_UNAVAILABLE/u);
  f.metadata.privateKey="unrequested-value";
  assert.throws(()=>verify(f));
});
test("old instance, old witness, changed allocation or fingerprint refuse", () => {
  for(const mutate of [
    f=>f.infrastructure.instanceArn=f.spec.originalInstanceArn,
    f=>f.infrastructure.addressArn="replacement-ip",
    f=>f.metadata.hostKeys[0].witnessedAt=new Date(now-1_000_000).toISOString(),
    f=>f.metadata.hostKeys[0].fingerprintSHA256="SHA256:changed",
    f=>f.metadata.hostKeys[0].notValidAfter=new Date(now-1).toISOString(),
    f=>f.metadata.ipAddress="another-host",
  ]) {const f=fixture();mutate(f);assert.throws(()=>verify(f));}
});
test("explicit operator first-use acceptance binds the new action, instance, address and exact key without claiming AWS key authentication",()=> {
  const f=fixture(),key=f.metadata.hostKeys[0];
  const proof={version:1,trustMode:"operator-first-use",acceptedBy:"Dardan",action:"p1-recreate-owned",
    instanceArn:f.infrastructure.instanceArn,address:f.spec.address,acceptedAt:new Date(now).toISOString(),hostPublicKey:key.publicKey,
    acceptedFingerprint:key.fingerprintSHA256};
  const result=operatorAcceptedSshTrust(proof,f.infrastructure,f.spec,proof.action,now-5000,now);
  assert.equal(result.awsAuthenticatedHostKey,false);assert.equal(result.oldTrustChanged,false);
  assert.equal(result.fingerprint,key.fingerprintSHA256);
});
test("pre-creation acceptance, a different action or a changed key cannot establish first-use trust",()=> {
  const f=fixture(),key=f.metadata.hostKeys[0];
  const base={version:1,trustMode:"operator-first-use",acceptedBy:"Dardan",action:"p1-recreate-owned",
    instanceArn:f.infrastructure.instanceArn,address:f.spec.address,acceptedAt:new Date(now).toISOString(),hostPublicKey:key.publicKey,
    acceptedFingerprint:key.fingerprintSHA256};
  for(const change of [{action:"another-action"},{instanceArn:"another-instance"},{acceptedBy:"another-operator"},
    {acceptedAt:new Date(now-6000).toISOString()},{acceptedFingerprint:"SHA256:changed"}])
    assert.throws(()=>operatorAcceptedSshTrust({...base,...change},f.infrastructure,f.spec,base.action,now-5000,now));
});
