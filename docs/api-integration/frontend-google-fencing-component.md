# Selected staging Google fencing component

This component prepares the existing reviewed staging action. No live provider,
database, Redis, credential or deployment change was executed by this source
work. The accepted C07, host/network and private handoff remain accepted inputs;
the component reads them back at execution. It adds no signer, approval click,
short-lived approval permit, billing condition or production action.

## Exact scope

The source owns only project `lash-her-staging-20261022`, number `185770842371`,
and these existing clients:

| Kind | Client | Runtime variables |
| --- | --- | --- |
| Administrator Identity | `185770842371-d3thak0b2btgb77pngj968nvhpjkqmgf.apps.googleusercontent.com` | `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` |
| Calendar | `185770842371-lg0fktlf96u88pnqjnoom83st75btv4d.apps.googleusercontent.com` | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |

The new customer Identity profile is separate. These observations do not certify
`CUSTOMER_AUTH_GOOGLE_ID`/`CUSTOMER_AUTH_GOOGLE_SECRET`. The unrelated historical
production Google project/client is never selected.

`frontendProviderBindingsArtifact()` normalizes `googleRetirement` with exact
project/client IDs, nonsecret credential-binding provenance hashes, the initial
database snapshot/digest, legacy Redis snapshot digest, selected grant IDs and
owner hashes, `retire`/`preserve` dispositions, and hashed Calendar IDs. Credential
binding hashes describe nonsecret IDs/provenance; they never hash secret values.

The initial normalized `databaseBeforeSnapshot` retains only connection IDs,
credential presence, owner hashes, assignment IDs/status, Calendar ID hashes, and
stored event/etag/status/source-hold references. It contains no email, name,
calendar title, event content, credential, ciphertext, secret reference or OAuth
code. `databaseSnapshotSha256` is the recursive-key-sorted compact UTF-8 JSON
SHA-256 of that snapshot. Its original bytes and digest remain unchanged during
recovery; later actual snapshots are separate observations.

## Actual SQL and Redis discovery

The fixed Node observer reads all Google connections, assignments, appointment
event references, historical hold references and checkout Calendar continuations
in one read-only repeatable-read transaction. It invokes the parent's actual lock
verifier between reads and refuses incomplete/oversized results. It decodes the
application's existing base64 32-byte AES-256-GCM key and exact `v1:iv:tag:payload`
format only inside the private runtime. Stored secret references must resolve
through the supplied existing private runtime mapping. No secret value enters
the artifact, ordinary receipts or model output.

The Redis client is fixed to the already isolated
`tidy-monarch-236694.upstash.io` host. It reads both
`booking:google-refresh-token:production` and the legacy unscoped
`booking:google-refresh-token`. This is intentional: the dedicated staging
frontend uses a Vercel Production target, and the existing source selects that
namespace before the unscoped fallback. A current empty SQL connection table
does not establish legacy grant absence.

Complete cursor-based SCAN reads only `booking:calendar-oauth-state:*`. The client
can GET the two exact legacy token keys and DEL exact Calendar OAuth-state keys;
it cannot read arbitrary Redis keys, delete refresh credentials, flush a database
or scan another namespace. OAuth state identifiers are retained only as hashes.
Its continuation count covers this stored Redis namespace; it does not invent
an account-wide count of browser cookies or untracked historical executions.

## One reviewed control sequence

The closed, drained recovery stage invokes `retireFrontendGoogleGrants()`. The
fixed Python child remains under the existing environment and physical database
locks. Every provider/Redis request checks parent liveness before and after the
request, including expected HTTP denial paths.

1. Privately calibrate each selected client with one synthetic wrong secret and
   the same deliberately unissued grant. That negative must return
   `invalid_client`. Actual old and replacement secrets must either successfully
   refresh a real grant and verify its OpenID UserInfo owner, or return
   `invalid_grant` for that same unissued grant. Any nondiscriminating or different
   error refuses. The latter is a bounded live inference of client authentication,
   not proof of an owner, usable grant, or settled effects. Administrator Identity
   requests no offline grant in the existing application and requires no new
   offline consent. The exact private clients remain in memory throughout.
2. Verify the protected, actually built admission frontend uses the selected
   replacement runtime values. The authenticated `google-binding` probe returns
   exact client IDs and a fresh challenge-bound HMAC per secret. The host compares
   HMACs privately using `compare_digest`; it retains only sanitized IDs and the
   verified runtime/deployment binding. Proofs, challenges and credential-derived
   digests are not written to common receipts. Both admission controls and all
   bootstrap feature controls must be closed.
3. Inventory every actual SQL and legacy Redis grant. Refresh each actual grant,
   verify its Google owner, and compare the complete grant-ID set with the reviewed
   binding. Inspect complete Calendar event pages twice and require matching
   stored IDs, etags or immutable hold/checkout metadata and terminal outcomes.
   An orphan, pending effect, changed principal or unknown outcome refuses.
4. The same reviewed action observes Dardan's supported Google Auth Platform
   client-secret retirement. It polls these same actual old credentials for
   `invalid_client`, while replacement authentication continues to pass the same
   calibrated test or actual refresh/UserInfo check. No Google
   client-management endpoint is invented. The existing 300-second observation
   budget bounds the action; it is not an approval expiry.
5. Revoke only selected grants through Google's documented `POST /revoke`, then
   require actual `invalid_grant` from the replacement client for every selected
   retired stored grant. A 200 acknowledgement alone is insufficient. Retain each
   exact completed grant separately; a lost acknowledgement remains uncertain and
   never triggers automatic replay.
6. Close exact observed Redis Calendar OAuth states, retain individual deletion
   acknowledgements, and require a complete independent empty-state scan. Preserve
   the actual legacy refresh-key presence; the component does not delete stored
   grants or rewrite SQL state. Recheck the protected replacement frontend after
   retirement.

Google documents that revoking one owner's authorization removes that owner's
project authorization across clients. Before any grant revocation, the source
refuses an owner selected for both retirement and preservation. An independent
preserved owner keeps its grant usable; a preserved scope is never silently
revoked merely to obtain zero counts. If an operator-selected scope is actually
shared, it must remain preserved and fenced through the applicable independent
recovery boundary.

## Expected recovery transitions

The initial snapshot is evidence of prestate. It does not require every dynamic
status to remain frozen. A source-owned reducer permits declared pending
Calendar rows to reach a terminal state while preserving record, Calendar and
existing event identity. A newly materialized appointment event is permitted only
when its actual appointment foreign key links it to an already declared pending
hold/checkout and its event identity matches that completed source record.

SQL changes alone do not qualify these transitions. Complete actual Google reads
must also match the resulting event/etag or immutable hold/checkout metadata and
terminal status. The output retains original/current snapshot digests and the
specific declared transitions separately. Credential/principal/assignment
changes, missing original rows, unrelated new effects and altered terminal
records refuse. Ordinary positively verified declared recovery does not require
another approval or a replacement initial snapshot.

## Independent observation and private runtime

`observeFrontendGoogleScope()` performs read-only SQL/Redis/provider observations.
After project grant revocation, replacement-client verification and Calendar
readback use current replacement verification grants obtained through the
existing staging qualification flow. A newly consented replacement grant does
not make an old revoked stored grant valid: every selected old stored grant
still has to return `invalid_grant`. No grants are created by the observer.

The private runtime supplies the two replacement secrets, two exact old secrets,
existing Redis credential, base64 Calendar credential-encryption key/reference
mapping, any existing verification grants and required legacy Calendar ID. Actual
Calendar grants still require successful refresh, UserInfo and event readback;
the negative client-authentication probe cannot replace these observations. These are
private runtime inputs, never reviewed artifact fields. The component exposes no
standalone live CLI or ambient credential acquisition path.

The result distinguishes actual grant/event/Redis uncertainty from historical
execution coverage. `activeExecutions` remains `null` because Google and Redis
readbacks do not count untracked historical frontend invocations. The component
does not by itself issue a whole-fence certificate or authorize SQL/admission.
The coordinator must join the historical deployment/login/direct-caller and
other provider observations before its existing strict fence validator permits
the reviewed application SQL.

The owned validation includes 14 Google HTTPS cases, Node adapter/binding
tests, and a fresh TLS PostgreSQL 16 run through all 83 source migrations. The
database run exercises the five Google projections, real application-format
AES-GCM decoding, redaction, wrong-key refusal and snapshot mismatch. The
protected runtime proof test loads the exact completed Google probe dependency
from `00b5b52e`/`2ec0a23c` read-only; that dependency must be included in the
integrated candidate. These checks touch no live providers and do not certify
PostgreSQL 18 or live G2.

Primary references: [Google client-secret rotation](https://support.google.com/cloud/answer/15549257),
[Google web-server refresh and revocation](https://developers.google.com/identity/protocols/oauth2/web-server),
[Google OpenID Connect errors](https://developers.google.com/identity/openid-connect/reference),
[OAuth error discrimination](https://www.rfc-editor.org/rfc/rfc6749#section-5.2),
[OpenID UserInfo](https://developers.google.com/identity/openid-connect/openid-connect),
[Calendar event listing](https://developers.google.com/workspace/calendar/api/v3/reference/events/list),
[Upstash Redis REST API](https://upstash.com/docs/redis/features/restapi).
