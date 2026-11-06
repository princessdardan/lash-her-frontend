# P2 application-user JWT rotation certification

This source package prepares the deliberate staging rotation of exactly four
application-user JWT profiles:

- Course learner
- Course administrator
- Community member
- Community administrator

It does not rotate account-lifecycle, enrollment, publisher, internal-service,
session, provider, database, workload, or ingress credentials. It does not add
a Community feature or a public debug/token endpoint.

## Current execution boundary

The package is source-complete but live-ineligible. `PARENT_ADAPTER_READY` and
`sourceParentDispatchIntegrated` are false, `keyRemovalVerified` remains false,
and the controller refuses non-fixture execution. Live execution requires a
separately reviewed fixed certification
parent that retains the actual Linux release flock and frontend PostgreSQL
physical advisory/nonce lock throughout each configuration mutation, runtime
recreation, frontend build/promotion, and proof. Retained-READY recovery and
failed/canceled forward recovery are not rotation authority.

The fixed controller, physical observer, typed host scope, configuration
validator, API recreation adapter, Vercel rollout adapter, and private
JavaScript child are implemented for that future parent. They have no
standalone activation path or generic command callback.

## Reviewed private configurations

The action binds three root-owned configuration references under
`/var/lib/lash-her/releases/staging`:

1. `baseline`: the old key is current and no previous application-user key is
   configured.
2. `overlap`: the new key is current and the old key is previous for all four
   profiles.
3. `currentOnly`: the new key is current and every previous application-user
   key is absent.

Restoration aliases exactly the reviewed `baseline` or `overlap` directory;
there is no caller-selected fourth configuration.

The future parent must compare configuration values privately. Across phases,
every non-profile value must be byte-identical. The overlap configuration must
contain eight distinct profile keys, all separate from lifecycle, enrollment,
publisher, service, session, provider, database and workload credentials.
Common receipts retain only existing whole-configuration record bindings; they
contain no credential value or per-key credential hash.

The private reviewed plan separately retains a byte hash for each
credential-bearing directory. That private hash is checked in process and is
never copied to controller or common evidence. The public phase SHA is the
noncredential configuration-record identity and must differ from the private
byte hash.

The only allowed per-build difference outside those three base configurations
is the existing `frontend_probe.prepare` overlay:
`LASH_RELEASE_PROBE_SECRET`, `LASH_RELEASE_PROBE_EXPIRES_AT`,
`LASH_RELEASE_SCHEDULER_QUALIFICATION`, and
`API_GATEWAY_STAGING_ORIGIN`. The fixed helper generates a fresh overlay for
each build. An old or expired probe record is never reused as workload proof.

Vercel Sensitive values are not readable after creation. The adapter never
requests or claims secret-value readback. It inventories fixed Production
metadata first, writes every desired profile value from the reviewed private
reference, requires each provider acknowledgement, retains a nonsecret
acknowledgement record, and then proves the staged build behavior. A lost or
partial environment-variable acknowledgement cannot be inferred from the
metadata inventory and remains closed for review.

## Fixed order

1. Verify the exact source, candidate, host, ten-container inventory, runtime
   target, current frontend deployment, closed native schedules, and both held
   locks. Retain mutation intent before any provider or Compose call.
2. Recreate Course and Community with one registered Compose mutation on the
   exact same images using `overlap`.
   Prove old and new controlled tokens for both API profiles are accepted. The
   existing deployed Course verifier probe supplies the actual Course runtime
   current/previous configuration and module proof; the Course HTTP child alone
   deliberately reports no configuration-observation claim.
3. Create and promote one exact frontend `overlap` build. Verify the actual
   protected Course learner/admin frontend operations use the new current key.
4. Record when the old frontend deployment stopped issuing. Keep overlap for at
   least 330 seconds: the 300-second maximum token lifetime plus 30-second
   verifier skew. Continuous guards must retain source, candidate,
   configuration, runtime, provider intent, and both locks.
5. Only after that drain, immediately before removal, privately issue
   controlled, unexpired old and new tokens for all four profiles. Tokens
   remain only in root-owned mode-0600
   action records and are never hashed into common output.
6. Promote one exact frontend `currentOnly` build while both APIs still accept
   overlap, then recreate Course and Community on the same images with
   `currentOnly`.
7. Prove the old unexpired token is rejected and the new token accepted for
   every profile. Course learner/admin use real protected HTTPS operations and
   exact request IDs/statuses. Community has no user feature route in this
   phase, so its evidence is explicitly `deployed-private-community-verifier`:
   the fixed child runs inside the exact selected Community container, imports
   its real configured member/admin verifier, proves previous-key absence and
   verifies moderator capability enforcement. It is not a Community member UI
   or HTTP-journey claim.
8. Re-prove actual frontend protected Course operations and qualified
   restoration readiness. Only the final joined receipt may set
   `keyRemovalVerified: true`.

## Failure and restoration

Every Vercel mutation is preceded by an immutable intent. Reconciliation is
GET-first. Each action permits at most one build and promotion per phase.
Unknown/lost POST outcomes, mixed API configurations, source/runtime drift,
lock loss, child cleanup uncertainty, or an unsupported response close
admission, terminate and reap registered mutators, and remain
`REQUIRES_REVIEW`; they are never retried automatically.

Deliberate restoration can use only the exact last fully qualified reviewed
configuration: `baseline` before overlap qualifies or `overlap` before removal
qualifies. Restoration re-runs configuration, runtime, frontend workload, and
profile guards. It does not run SQL, prepare roles, change database login,
replay a migration, recreate a terminal receipt, or silently reopen admission.
If any mutation acknowledgement or containment step is uncertain, automatic
restoration is refused.

## Evidence classes

The final receipt discloses one evidence class for each profile:

- `actual-protected-course-http`
- `deployed-private-community-verifier`

It also reports observed status, source commit, exact container/image,
configuration record binding, and timing. It never reports JWT bytes, signing
keys, key hashes, subjects, customer data, or provider credentials.

## Source checks

```sh
node --test ops/platform/p2-identity-key-rotation.test.mjs
node --test ops/platform/p2-identity-key-rotation-controller.test.mjs
python3 -m unittest \
  ops/platform/host/p2_identity_key_rotation_test.py \
  ops/platform/host/p2_identity_key_rotation_adapter_test.py
```

These are non-live checks. They use synthetic keys, owned HTTP/verifier
fixtures, and no staging, provider, database, Vercel, Course, or Community
request. They do not establish key removal or release acceptance.
