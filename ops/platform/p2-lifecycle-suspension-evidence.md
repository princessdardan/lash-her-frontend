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
fresh isolated Playwright contexts. Dardan completes normal customer and owner
Google/Resend sign-in; no credentials, storage state or session are fabricated.
Authentication has a separate fifteen-minute timeout and completes before ARM.
The already-qualified current deployment must allow normal new work while
recovery and native scheduling are disabled. The parent must verify the actual
deployment/source/configuration before opening the sign-in pages.

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
await browser.authenticated();
// Fixed parent performs its fresh current checks, binds the controller's actual
// challenge, arms the held physical scope and opens only the reviewed window.
const stage = host.suspensionEvidenceStage(plan, browser);
await browser.start();
const controlled = await captureP2SuspensionControlledAuthority(plan, stage);
await browser.suspend();
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
