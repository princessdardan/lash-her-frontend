# Independent A review corrections

This corrects the two HIGH findings against source-preparation A2d905186. The
original exact reproduction script and its observed output are retained here;
source A and all original PG receipts remain unchanged in their original commit.
No deployed or live action occurred.

The corrected closed reducers allow exactly two scoped operations: the one
uncertain503 request and one later completed200 normal replay. Any third request
refuses before domain/request/settlement authority, including an extra completed
request already present before the settlement snapshot. This closes the original
three-request acceptance, rather than only checking for a new row after a
retained snapshot.

The private authorization registry atomically reserves unused->consuming under
one source mutex before verifier I/O. The second concurrent caller refuses
without entering the verifier. Verification failure poisons the attempted
capability; it cannot be retried. Successful verification consumes it once.
Plain/copied/wrong-action/wrong-scope objects remain rejected. Deterministic
threaded tests hold the first verifier while the second consumer attempts use.

The actual three-DB fixture now hashes frontend, Course and Community migration
journals before and after the whole route/drop/replay/specific-settlement path,
and requires exact equality for all three. The API snapshots in the future B
controller must additionally retain their existing current-schema/roles/source
checks under the same physical scope. No runtime role gains journal privileges;
these owned fixture digests use only the disposable cluster's own administrator.

Final results, exact helper/harness hashes, and limits are in validation.json.
The PG16 and macOS-owned PG18 fixtures use actual83/22/11 migrations, actual
canonical API routes/repos and verified loopback TLS; source-domain negative
cases now include a third completed request before settlement. The original FE1
and samegateway1 stay durable through normal replay; only the exact observed FE
operation is reconciled under its source evidence, producing FE0 and oldgateway1.
OIDC/provider/native classification and host process/lease installation remain
fixture models. No replacement authority is issued by the actual DB fixture.

This remains source preparation A only. NEW source parent/host issuer and typed
same-session runtime consumer B, actual Docker/SSH/provider request-details,
independent exact-correction review, staging/S12/S14 and full qualification remain
OPEN. No ordinary recovery/zero gate, runtime/config/image, SQL/role/login or
workflow/source-cap changes are included.
