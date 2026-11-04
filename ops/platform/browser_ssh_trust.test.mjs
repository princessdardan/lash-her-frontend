import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import test from "node:test";
import {verifiedBrowserSshProof} from "./browser_ssh_trust.mjs";

function owned() {
  const header=Buffer.alloc(4),length=Buffer.alloc(4);header.writeUInt32BE(11);length.writeUInt32BE(32);
  const wire=Buffer.concat([header,Buffer.from("ssh-ed25519"),length,Buffer.alloc(32,7)]);
  const instance={instanceArn:"arn:aws:lightsail:us-east-1:691588646557:Instance/22222222-2222-4222-8222-222222222222",
    address:"184.196.129.231",accessRecoveryPhase:"verify-key",browserSshEnabled:true};
  const proof={version:1,action:"p1-recreate-access-owned",method:"authenticated-aws-browser",accountId:"691588646557",
    browserAccountVerified:true,instanceArn:instance.instanceArn,address:instance.address,hostMachineId:"2".repeat(32),
    hostPublicKey:"ssh-ed25519 "+wire.toString("base64"),fingerprint:"SHA256:"+createHash("sha256").update(wire).digest("base64").replace(/=+$/u,"")};
  return {proof,instance};
}
test("actual browser key output binds account, new instance, machine, key bytes and strict SSH pin",()=> {
  const f=owned(),p=verifiedBrowserSshProof(f.proof,f.instance,f.proof.action,"1".repeat(32));
  assert.equal(p.knownHosts,`184.196.129.231 ${f.proof.hostPublicKey}\n`);assert.equal(p.keyPinnedBeforePrivateTransfer,true);
});
test("an unverified account, substituted endpoint/key, old machine or other action cannot establish trust",()=> {
  for(const mutate of [f=>{f.proof.browserAccountVerified=false;},f=>{f.proof.accountId="other";},f=>{f.proof.instanceArn+="other";},
    f=>{f.proof.address="192.0.2.1";},f=>{f.proof.hostMachineId="1".repeat(32);},f=>{f.proof.fingerprint+="x";},
    f=>{f.proof.hostPublicKey+=" comment";},f=>{f.proof.method="ssh-keyscan";},f=>{f.proof.action+="other";}]) {
    const f=owned();mutate(f);assert.throws(()=>verifiedBrowserSshProof(f.proof,f.instance,"p1-recreate-access-owned","1".repeat(32)));
  }
});
