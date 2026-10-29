# Integration contracts v1

P1-01 initial v1 contract specification, reviewed 2026-10-29. The manifest pins the selected immutable Course
and Community OpenAPI artifacts and the Community-owned enrollment event schema.
`boundary-contracts.json` defines the target identity and lifecycle wire shapes.
Those shapes do not establish deployed authentication or account-lifecycle routes.
Runtime implementation and enforcement remain P2-01/P2-02/P2-03/P2-11.

## Identity and JWT boundaries

Learner/member `sub` is the immutable frontend `customer_users.id`. Administrator
`sub` is the immutable frontend `admin_users.id`, never a Google provider ID or
email. UUID subjects use the lowercase format already required by the enrollment
contract. Customer and administrator identity namespaces and sessions remain
separate. Every user token requires `version: 1`, `iss`, a scalar `aud`, `sub`,
integer `iat`/`exp`, and `jti`. No email or other private profile data is included.

| Profile                 | Issuer              | Audience                        | Receiver capability                                              |
| ----------------------- | ------------------- | ------------------------------- | ---------------------------------------------------------------- |
| Course learner          | `lash-her-frontend` | `lash-her-course-api:learner`   | Authenticated learner; enrollment checked separately             |
| Community member        | `lash-her-frontend` | `lash-her-community-api:member` | Authenticated member; online Course authority checked separately |
| Course administrator    | `lash-her-frontend` | `lash-her-course-api:admin`     | Explicit `course-editor` and/or `course-support`                 |
| Community administrator | `lash-her-frontend` | `lash-her-community-api:admin`  | Explicit `community-moderator`                                   |

Sign HS256 with independent cryptographically random secrets of at least 32 bytes
for each profile and environment. Mint at most 300 seconds of validity. Verify the
signature and allowlisted algorithm before validating claims. Require
`0 < exp - iat <= 300`, allow at most 30 seconds of clock skew, reject audiences
supplied as arrays, and reject missing/unknown claims. The schema/lifetime parser
is contract validation, not a signature verifier or proof of authorization.

Mint with the current key only. Receivers accept the configured current and
previous key during a controlled rotation window; retire the previous key after
the maximum token lifetime plus clock skew following the last old-key issuance.
Never accept a key from token-controlled input. Environment separation depends on
separate keys/endpoints, not the audience alone. A customer token cannot authorize
an admin operation, even if its subject matches an administrator UUID.

Frontend maps verified staff permissions to capabilities; each API enforces its
own operation-to-capability mapping: `course-editor` authorizes the pinned
`/v1/admin/courses/**`, `/v1/admin/modules/**`, and `/v1/admin/lessons/**`
operations; `course-support` authorizes `/v1/admin/entitlements/**`. Holding
one does not imply the other. `community-moderator` authorizes Community
moderation operations when those routes are implemented. These capabilities
do not authorize service-only routes or account-lifecycle commands. No capability is inferred from email, a
request body, an enrollment event, or a browser assertion. Current Course
`FIRST_PARTY_AUTH_*` and administrator allowlists predate this target: replacing
them is P2-02, with explicit rejection/rotation/capability tests.

## Service credentials

| Boundary                                 | Issuer / subject                                      | Audience                                          | Contract status                                                                                                        |
| ---------------------------------------- | ----------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Frontend entitlement commands            | `lash-her-frontend` / `frontend`                      | `lash-her-course-api`                             | Existing configurable Course contract; frontend should mint 300-second tokens within the receiver's configured maximum |
| Course enrollment publication            | `lash-her-course-api` / `course-enrollment-publisher` | `lash-her-community-api:course-enrollment-events` | Existing exact 300-second lifetime and 30-second skew                                                                  |
| Community authority reads                | `lash-her-community-api` / `community-course-reader`  | `lash-her-course-api:community-course-reads`      | Existing exact 300-second lifetime and 30-second skew                                                                  |
| Frontend lifecycle commands to Course    | `lash-her-frontend` / `frontend-account-lifecycle`    | `lash-her-course-api:account-lifecycle`           | Target; separate credential, bounded 300-second lifetime                                                               |
| Frontend lifecycle commands to Community | `lash-her-frontend` / `frontend-account-lifecycle`    | `lash-her-community-api:account-lifecycle`        | Target; separate credential, bounded 300-second lifetime                                                               |

Use distinct keys for every row and environment, independent from user/admin
keys, Auth.js, provider secrets, and database credentials. Service JWT verification
does not replace private HTTPS, validated CA trust, restricted ingress, or route
authorization. P1-03 owns those network boundaries. The entitlement signer target is HS256, `iss: lash-her-frontend`, scalar
`aud: lash-her-course-api`, `sub: frontend`, integer `iat`/`exp`, a fresh UUID
`jti`, lifetime at most 300 seconds and at most 30 seconds skew. The existing
receiver is more permissive (configurable maximum, default 3600 seconds,
legacy subject aliases); P2-02 must enforce the target. Lifecycle service
tokens use the same bounded claim shape with each dedicated issuer/subject/
audience in the table, and separate keys. Enrollment publication and authority
reads retain their existing exact 300-second lifetime and nonempty `jti`
(up to 128 characters). No service token carries administrator capabilities.
Deployment credential, endpoint and claim bindings must be checked at P1-03/
P2-02/P2-03 before affected calls are enabled; this contract publication
does not certify deployed configuration.

## Entitlements, events, and errors

Course OpenAPI is authoritative for grant/revoke/reconciliation request and
response shapes. Header `X-Idempotency-Key` must equal body `idempotencyKey`.
Internal and administrator mutations share the immutable idempotency namespace:
identical replay returns the stored result; semantic reuse returns 409 without
partial mutation. Frontend financial state/outbox owns payment-driven commands;
Course remains provider-neutral. Retain historical `helcim` compatibility.

Community owns `enrollment-event.schema.json`. The Course vendored release retains
its own Community revision pin and fixture/checksum checks. This bundle does not
transfer ownership or replace those checks. Versions start at 1; version 0 is
reserved for materialized historical snapshot items. Preserve per-stream ordering and RFC 8785 canonical serialization over exact
validated values. Event and stream IDs are lowercase UUIDv4, customer/course
IDs are canonical UUIDs, timestamps are UTC, stream versions are integers
1 through 2147483647, and event type must agree with state. Receive one event
per request within 16 KiB. Exact event replay is acknowledged without new
effects; conflicting event-ID/digest or stream-version reuse is rejected.
These rules do not make the projection the access authority: protected
Community operations still consult Course online and fail closed.

Current Course errors contain `{ error: { code, message } }` with uppercase codes;
Community errors also contain `requestId` and use lowercase codes. Keep these wire
shapes and validate responses against each operation/status. The response parser
rejects undocumented statuses, missing fields and malformed values without
coercing, inserting defaults or stripping fields. It does not include upstream
bodies or validator details in errors. Stable UI error translation belongs in
P2-09/P2-10 adapters. Preserve safe `X-Request-ID` correlation where available.

## Account lifecycle target

Target receiver endpoint: `POST /v1/internal/accounts/commands`. This is a future
route, not present in the pinned OpenAPI. Use the dedicated lifecycle credential
above and `X-Idempotency-Key: <commandId>`. Commands contain only the version,
immutable command/customer UUIDs, per-account sequence `accountVersion`, action,
and issuance timestamp. Actions are `suspend`, `restore`, `export`, and `delete`.

Frontend creates the command and durable delivery record transactionally. Revoke
customer sessions immediately on suspension/deletion. Each receiver records the
command and effects transactionally. Exact command replay returns the stored
receipt with `duplicate`; command-ID reuse with different content returns 409.
Require consecutive account versions; a gap returns a retryable conflict for
ordered delivery. Export commands also advance that command stream. The frontend sends every
command/version to both receivers; otherwise an export that skipped one API
would create a permanent gap there. Each receiver begins at version 1. An older
command cannot restore an account after a newer suspension/deletion.

Deletion is terminal for that customer UUID: retain a minimal version/tombstone
and required financial/audit records, remove eligible personal content, and never
recreate identity from delayed enrollment events. Restoration requires a later
ordered command and cannot undo deletion. Account suspension is distinct from
Community participation sanctions and does not erase their history. Export
artifacts are private and delivered through authenticated frontend retrieval;
commands/receipts contain no exported data or bearer URLs.

The target receiver returns HTTP 200 with `AccountLifecycleReceipt` after
transactional acceptance/effects, for both first delivery (`accepted`) and
exact replay (`duplicate`). The receipt echoes the command ID and version.
Check exact replay before sequence/tombstone rejection, including retries of
a successful delete. A command-ID/content conflict, a stale/nonconsecutive
version, or a new command after deletion returns HTTP 409 with the receiver
error envelope; none advances the stream or applies partial effects. Error
codes are `IDEMPOTENCY_CONFLICT`, `ACCOUNT_VERSION_CONFLICT`, `ACCOUNT_DELETED`
for Course and their lowercase equivalents for Community. A gap is retried
only after predecessor delivery; stale/conflicting/deleted commands need
resolution, not blind retries. Malformed/header-mismatched input returns 400,
invalid service authentication 401, unauthorized service 403, throttling 429
with `Retry-After`, and unexpected failure 500, using that API's error envelope.
Export after deletion is rejected like any new command; retained-record
requests require a separately authorized frontend process.

P2-11 owns durable
storage, authorization, retry, retention/export rules, and all replay/race tests.

## Generation and compatibility

```sh
npm run contracts:generate
npm run contracts:check
npm run contracts:sources
npm run contracts:test
node scripts/check-api-contracts.mjs --baseline /absolute/path/to/released/bundle
npm run contracts:release-check -- --sources .. --release-revision <full-frontend-sha> --baseline /absolute/path/to/released/bundle --baseline-revision <full-baseline-sha>
```

Generation uses openapi-typescript from vendored bytes only and produces Course,
Community and target boundary types. Integrity checks verify all artifact
hashes and full commit pins; source checking additionally reads the exact commits
from sibling checkouts. Frontend CI performs integrity/generated-type drift
checks without requiring private sibling access. Release checking requires
source verification, full frontend and baseline commit SHAs, committed bundle
byte equality and a hash of this normative README; P1-05 adds scoped cross-repo access and required release
workflow enforcement.

Compatibility requires an explicit released baseline, never moving `main`.
Existing operations, parameter/body/response shapes, security and referenced
components must remain structurally equal; new operations and annotation-only
changes are permitted. This conservative check can require review for safe wire
changes. Closed event/identity/lifecycle changes require coordinated version
review. Do not bypass failures by relabeling a candidate as released. Record the
reviewed baseline, source verification and all three published revisions in the
release manifest. Manifest status and the publication receipt determine release status. A
candidate cannot certify a release. No earlier integration release exists.

The release review is recorded in
[the P1-01 review](../../../docs/api-integration/reviews/2026-10-29-p1-01-v1-review.md).

For the first v1 release, the owner must approve and publish an immutable initial
bundle as the explicit released baseline. Comparing that same approved initial
bundle establishes reproducibility, not compatibility with an earlier deployed
integration. Subsequent candidates compare against its archived immutable bytes.

Generator and validator references: [openapi-typescript CLI](https://openapi-ts.dev/cli)
and [Ajv JSON Schema support](https://ajv.js.org/json-schema.html).
