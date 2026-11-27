import assert from "node:assert/strict";
import test from "node:test";
import { checkCopyIdentity } from "./p600-offline-rehearsal.mjs";

test("only the closed, socket-only staging copy can enter the SQL rehearsal", () => {
  const identity = { cluster: "7712934692662906902", db: "lash_her_p600_frontend", version: "180006",
    login: "postgres", local: true, listen: "", other_logins: 0, other_sessions: 0, prepared: 0, recovery: false };
  checkCopyIdentity(identity);
  for (const changes of [{cluster:"7712937457246089265"}, {db:"neondb"}, {version:"180007"}, {local:false},
    {login:"runtime"}, {listen:"*"}, {other_logins:1}, {other_sessions:1}, {prepared:1}, {recovery:true}]) {
    assert.throws(() => checkCopyIdentity({...identity, ...changes}), /COPY_IDENTITY_REFUSED/u);
  }
});
