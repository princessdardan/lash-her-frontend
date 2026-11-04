// The operator/agent records actual public-key output from authenticated AWS
// browser SSH. This does not infer provider authentication from ssh-keyscan.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";

export function verifiedBrowserSshProof(proof,instance,action,originalMachine) {
  assert.equal(proof.version,1);assert.equal(proof.action,action);assert.equal(proof.method,"authenticated-aws-browser");
  assert.equal(proof.accountId,"691588646557");assert.equal(proof.browserAccountVerified,true);
  assert.equal(proof.instanceArn,instance.instanceArn);assert.equal(proof.address,"184.196.129.231");
  assert.equal(instance.address,proof.address);assert.equal(instance.accessRecoveryPhase,"verify-key");
  assert.equal(instance.browserSshEnabled,true);
  assert.match(proof.hostMachineId,/^[a-f0-9]{32}$/u);assert.notEqual(proof.hostMachineId,originalMachine);assert.notEqual(proof.hostMachineId,"0".repeat(32));
  const parts=proof.hostPublicKey.split(" ");assert.equal(parts.length,2);assert.equal(parts[0],"ssh-ed25519");
  const raw=Buffer.from(parts[1],"base64");assert.equal(raw.toString("base64"),parts[1]);assert.equal(raw.length,51);
  assert.equal(raw.readUInt32BE(0),11);assert.equal(raw.subarray(4,15).toString(),"ssh-ed25519");assert.equal(raw.readUInt32BE(15),32);
  const fingerprint="SHA256:"+createHash("sha256").update(raw).digest("base64").replace(/=+$/u,"");
  assert.equal(proof.fingerprint,fingerprint);
  return {...proof,keyPinnedBeforePrivateTransfer:true,knownHosts:proof.address+" "+proof.hostPublicKey+"\n"};
}
