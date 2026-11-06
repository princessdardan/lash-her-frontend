# Source browser and pending-delivery evidence

This component records normal staging owner/customer behavior and the untouched
frontend delivery state before any lifecycle worker. It creates no fixture,
applies no migration, edits no account directly, and exposes no standalone apply
command. A fixed certification parent must hold the real host flock and fresh
frontend physical lock, own all admission/native transitions, and await
containment before releasing either lock. This component alone does not qualify
S12, S13, a native invocation, or the complete release.

`prepareP2LifecycleSuspensionPlan(candidate,input)` binds the qualified P2
candidate, complete normalized persistence plan, host/configuration/three-source
and three-target identities, immutable API images, exact frontend deployment,
fixed ten-control profile, admission owner/producer, operator target and existing
private `{userId,courseId,lessonId}` resources. The resources are hashed in the
public plan; they are not emitted. The action has no command witness until the
normal UI creates it. Operator and immutable app source commits must be equal.
The browser, pending observer, parent and host files must match committed Git
blobs. No supplemental operator is eligible for this reader-dependent case.

The fixed source browser uses the exact retained program bytes plus
`P2_LIFECYCLE_BROWSER_LAUNCHER`, passed to Node 24 over its fixed source launcher.
This avoids rereading a mutable script after the parent hashes it. It creates two
fresh isolated Playwright contexts only after a source capability releases the
authentication barrier. Initially it reports `initialized()` without opening a
browser or sending HTTP. The fixed parent arms a separate 300-second
authentication-preparation action, verifies actual `newWork:true,recovery:false`
and native scheduling off, then issues its process-local authentication handle.
Only `beginAuthentication(handle)` can open the normal sign-in pages. Dardan
completes customer and owner Google/Resend sign-in; no credentials, storage state
or session are fabricated. The parent's actual deployment/source/configuration
checks precede those pages. The child's fifteen-minute authentication wait and
thirty-minute overall wait are process liveness bounds, not authorization to
leave admission open. The parent closes both gates and proves zero work after
the 300-second action, retaining the same live opaque child for the next action.

After ARM, the fixed 840-second browser window allows normal authentication and
learning/progress writers with `newWork:true,recovery:false`, native scheduling
off. It loads the ordinary existing lesson, observes real same-origin playback
200 with a fresh approximately 600-second authorization and one `mux-player`,
and waits for the parent to capture its controlled token. It then uses the normal
owner form at `/admin/customer-accounts` to select suspend and submit once. The
handler enforces an active owner, no developer mode and Google authentication
within five minutes. The recorder additionally requires less than four minutes
before submission. Unknown POST outcomes are never automatically retried.

The actual 202 body supplies command ID/version/action/status. Request ID comes
from `x-request-id`; `issuedAt` is not a response field and is derived later from
the canonical database row. The player renews naturally at approximately 570
seconds. The recorder requires the actual ordinary renewal response to be
401/`sign_in_required` with private/no-store, followed by zero `mux-player`
elements and the session-ended alert. Redirects, quota responses, service errors
and network failures cannot qualify. It records measured wall/monotonic events,
not an asserted 600-second removal time. No clock control, request interception,
test endpoint or product implementation control is used. Tokens/playback IDs are
discarded in memory; raw HAR and token digests are not retained.

The parent sequence is fixed:

```js
const browser = launchP2LifecycleBrowserRecorder(plan, privateBrowserDirectory);
await browser.initialized(); // no browser/HTTP yet
// Fixed parent arms auth300, checks actual newWork true/recovery false/native off.
await browser.beginAuthentication(actualAuthenticationStageHandle);
readP2LifecycleBrowserAuthentication(plan, await browser.authenticated());
// Parent closes both gates/drains and ends auth300. Same live child is retained.
// A new current physical scope arms browser840 and opens only its reviewed window.
const stage = host.suspensionEvidenceStage(plan, browser);
readP2LifecycleBrowserAuthentication(plan, await browser.recheckAuthenticated());
await browser.start(stage);
const controlled = await captureP2SuspensionControlledAuthority(plan, stage);
await browser.suspend(controlled);
const observing = observeP2SuspensionControlledAuthority(plan, controlled);
const browserArtifact = await browser.complete();
const naturalArtifact = await observing;
const pending = await captureP2SuspensionPending(plan, browserArtifact,
  naturalArtifact, actualFrontendClient, {
    verifyEnvironment, verifySession, directory: privatePendingDirectory,
  });
// Actual source transport readers reject copied/serialized handles.
const operations = readP2CertificationSuspensionStage(stage, plan);
await operations.retain(browserArtifact);
await operations.capturePending(pending);
// Parent closes both admission gates, disables/readbacks native scheduling,
// drains actual global active/uncertain work, scrubs private credentials and
// retains its own CLOSED terminal. These operations must run on every failure.
```

The browser artifact handle is issued only after ordered fixed-child IPC, actual
exit zero, and exclusive/fsynced source bytes. The pending handle is issued only
after the real TLS PostgreSQL client with the actual physical advisory lock runs
the fixed qualified SELECT-only observer. A parser result or copied handle never
establishes source authority. The observer requires the canonical suspend command,
matching active owner attribution, revoked frontend sessions, no later command,
and both delivery rows pending with zero attempts, no leases and no ACKs. It runs
after controlled-token denial and before any worker. Quota/log writes are outside
this evidence; the complete action is not globally read-only.

The fixed host class is
`host/p2_lifecycle_suspension_evidence.py:P2LifecycleSuspensionEvidenceStage`.
It requires the real `P2ReleaseScope` subclass, canonical Linux FD, actual frontend
receipt/target, reviewed runtime inventory/security/mounts, machine, configuration
and complete installed source. Controlled capture reuses the S13 private source
program in the exact gateway with the separate current learner key matched to
the actual Course process environment. The same 300-second token is retained
privately and polled around its natural expiry plus thirty-second skew; it is not
regenerated. The actual Course-signed Mux URL is separately observed at its
natural expiry. Any service error, early denial, imprecise boundary, unknown
effect or failed readback remains OPEN.

Noncredential source records are fixed under
`/var/lib/lash-her/releases/staging/p2-suspension-<actionId>` (root 0700/files 0600,
O_NOFOLLOW/O_EXCL and fsync). The credential-bearing controlled capture is
separate at `/run/lash-her-p2-suspension-private/<actionId>/controlled-capture.json`.
It never enters the common receipt tree or common hashes. The parent must call
`scrub_controlled_credentials()` in cleanup; this verifies and removes only this
instance's exact capture, without depending on the original PG/provider verifier.
No generic directory, command, URL, token or module selector is accepted.
`load_retained_suspension` supports a later bounded worker/native action under a
new real current scope, preserving original source/deployment/configuration and
exact private pending-record SHA. It never replays SQL, creates a command, or
reopens admission. A separate native plan then uses the actual issued command ID.

The direct-worker join is a subsequent source stage. Its approved runtime-only
credential is `FRONTEND_STAGING_CRON_SECRET`, resolved by the fixed apply parent;
it is absent from settings, arguments and receipts. A direct request must join
the authenticated cron's actual admitted `x-request-id` UUID to the completed
recovery ledger row and both receiver ACKs. It must never be labeled native.
That worker/receiver-denial artifact and the parent integration are not completed
by this component's parser/owned database tests.

## Direct worker source recorder

`p2-lifecycle-worker-evidence.mjs` defines the separate
`direct-known-suspension-v1` stage. Its plan consumes the actual known command in
a genuine native component plan, the original browser plan, and the exact
root-private pending record SHA. It does not claim a native invocation. The fixed
apply parent creates `createP2LifecycleWorkerPrivateResolvers(getProviderContext)`;
plan preparation reads neither private input. The actual source transport can
read only `FRONTEND_STAGING_CRON_SECRET` and the existing source-private
`providerContext.frontendRuntimeDatabaseUrl`. There is no caller-selected key,
file, URL or body. These values and their digests are never retained or printed.

The parent starts CLOSED with actual global active/uncertain zero. The fixed
normal cron GET must reject a generated wrong key with 401/no operation UUID;
the actual key must reach the closed admission gate and return 503 without an
operation UUID or ledger work. Unexpected success, an issued UUID, redirects,
provider protection, unknown HTTP state, or a changed profile fails preflight.
It then opens only reviewed recovery for one direct GET. The returned 200 must
report exactly two ACKs and no retry/block/export/expiry work. Its authenticated
`x-request-id` must equal the single actual completed recovery ledger operation
with the exact source, producer, role and epoch. A header alone proves nothing.

The normal worker can claim twenty deliveries and expire/scrub unrelated
frontend exports. `P2_DIRECT_WORKER_ELIGIBILITY_SQL` therefore requires exactly
the two selected pending deliveries, both untouched and ready, and no other
unacknowledged delivery. It refuses any pending/ready export or residual bytes in
failed/expired exports. This bounds certification effects without changing
retention or introducing a selective worker. Run this case before creating the
S14 ready-export fixture. The profile cannot settle an ACK-loss case with one
already-ACKed delivery, attempts, or retained uncertainty; that requires a
separate explicit reconciliation action.

After the parent closes both gates and drains, the source helper reuses
`p2_lifecycle_persistence_probe.observe_with_scope` under
`HeldWorkerPersistenceScope`. It delegates every allowlisted child to the actual
P2 parent and retains its same FD/physical verifier. It never acquires a second
flock, closes that FD, substitutes the migration operator for the frontend
runtime role, or reimplements the three-domain SELECTs. The existing reader
checks actual runtime role/OID, host/database/TLS/schema and brackets both
receiver snapshots with stable frontend reads. Its durable lifecycle-account
record proves the same canonical command and both ACKs.

Receiver denial evidence has two explicit classes. Course uses a fresh current
learner JWT against the real protected HTTPS course GET and requires the exact
403 account-access error. Community has no member feature route in scope. The
fixed probe instead runs in its exact configured image: the real member verifier
accepts a fresh current signed canonical subject, the actual lifecycle repository
reads its real TLS database in a read-only transaction, and the actual
`registerCommunityUserAuth` hook refuses that subject with 403. This is labeled
`deployed-private-community-account-access-guard`, with `httpStatus:null`.
`receiverDeniedCount` is two; `receiverDeniedHttpCount` is one. No debug/member
route is added. Invalid credentials, a wrong role/OID, or a mocked caller context
cannot establish live authority; the private entry loads the pinned modules
itself.

The source parent uses fixed `readP2CertificationWorkerStage` capabilities for
preflight, invocation, witness and denial reads. The Node join verifies actual
ledger rows and issues an opaque JoinedHandle; the source transport accepts only
`readP2DirectWorkerSourceArtifact` results. The fixed host class
`P2LifecycleWorkerEvidenceStage` writes root-private
`/var/lib/lash-her/releases/staging/p2-worker-<actionId>/joined-worker.json` and
the shared `lifecycle-account.json` with O_NOFOLLOW/O_EXCL and fsync.
`load_retained_worker` is the fixed private S13 adapter; it binds actual bytes and
source/context/canonical command to both retained captures. No copied JSON
record or source SHA string is authority. HTTP/record loss preserves an explicit
REQUIRES_REVIEW receipt or original intent, never an automatic retry or reopen.

The actual operator-parent case and immutable-image path must still be integrated
and qualified before this source recorder is live-eligible. The owned command
below proves the actual default exported cron, SQL admission/store/dispatcher,
both pinned API routes/repositories, header/ledger join and separately typed
denials over three disposable TLS databases. It does not run a deployed provider,
the Linux Docker host class, a real browser, workload OIDC or natural token expiry.

```sh
node --test ops/platform/p2-lifecycle-worker-evidence.test.mjs
python3 -I -B -c 'import sys,unittest;sys.path.insert(0,"ops/platform/host");import p2_lifecycle_worker_evidence_test as m;unittest.main(module=m)'
P2_LIFECYCLE_WORKER_OWNED_TEST=true PG_BIN=/absolute/postgresql16/bin node ops/platform/test-p2-lifecycle-worker-local.mjs
```

Owned checks:

```sh
node --test ops/platform/p2-lifecycle-suspension-evidence.test.mjs
python3 -I -B -c 'import sys,unittest;sys.path.insert(0,"ops/platform/host");import p2_lifecycle_suspension_evidence_test as m;unittest.main(module=m)'
P2_LIFECYCLE_PENDING_OWNED_TEST=true PG_BIN=/absolute/postgresql16/bin node ops/platform/test-p2-lifecycle-pending-local.mjs
```

These cover parser/authority/filesystem guards and the actual fixed pending
observer over disposable TLS PostgreSQL with all 83 frontend migrations. They
do not establish an actual headed browser, Linux/Docker parent path, real Google,
Mux expiry or deployed worker outcome. Those require the operator-started exact
source candidate and retained deployed evidence.

## Canonical browser origin

Normal UI authentication uses the fixed approved staging origin
`https://staging.lashher.com`. `deploymentUrl` remains the separate immutable
`https://<deployment>.vercel.app` provenance; it is never relabeled as the browser
origin. The child accepts only this one canonical browser origin and captures
same-origin response/DOM evidence there. It does not spoof Host, fabricate
cookies, or accept an arbitrary origin.

The source parent must invoke `p2_canonical_browser_origin.observe` before ARM and
throughout its actual current-state verifier. The fixed read-only helper brackets
an authenticated `phase2-auth-origins` workload challenge **on the canonical alias** with two
provider alias readbacks and immutable READY/source/project/release/current-target
checks. Promotion metadata alone does not prove the custom alias. Redirected,
deleted, foreign or microfrontend aliases refuse. The common Node validator is a
schema/binding check, not an authority-issuing callback or caller JSON importer.

The API shape was verified against Vercel's primary documentation on 2026-11-06:
[Get an Alias](https://vercel.com/docs/rest-api/aliases/get-an-alias) documents
`GET /v4/aliases/{idOrAlias}` and its required `alias`, `projectId` and
`deploymentId`. The helper reads only the fixed staging hostname and uses the
existing team-scoped private provider client. It never assigns an alias.

The existing app release-probe handler has no incoming host restriction. Its
source secret, challenge, exact P2 flags/admission binding and one-hour expiry
still apply. The existing Python immutable-deployment probe is unchanged; the
new fixed canonical-origin HTTPS client uses normal verified TLS and refuses
redirects. No lifetime extension or automatic probe regeneration is provided.
Expired original private probe input makes this observation ineligible.
The helper requires the exact closed runtime `authenticationOrigins` projection:
customer/admin origins both canonical, no admin redirect proxy, and the customer
redirect proxy disabled. A missing, foreign, or additional field refuses. The
existing phase2 mode is insufficient. Actual Google/Resend provider callback
configuration and normal sign-in still require deployed qualification. Owned
HTTPS responses are not deployed evidence.
