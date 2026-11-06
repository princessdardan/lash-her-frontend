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

The package is plan-only and live-ineligible. `PARENT_ADAPTER_READY` is false,
`keyRemovalVerified` remains false, and every non-plan controller operation is
refused. Live execution requires a separately reviewed fixed certification
parent that retains the actual Linux release flock and frontend PostgreSQL
physical advisory/nonce lock throughout each configuration mutation, runtime
recreation, frontend build/promotion, and proof. Retained-READY recovery and
failed/canceled forward recovery are not rotation authority.

The private JavaScript child and pure receipt qualifier are source fixtures for
that future parent. They have no standalone activation path.

## Reviewed private configurations

The action binds four root-owned configuration references under
`/var/lib/lash-her/releases/staging`:

1. `baseline`: the old key is current and no previous application-user key is
   configured.
2. `overlap`: the new key is current and the old key is previous for all four
   profiles.
3. `currentOnly`: the new key is current and every previous application-user
   key is absent.
4. `restoration`: exactly the reviewed `baseline` or `overlap` directory, never
   a caller-selected fourth configuration.

The future parent must compare configuration values privately. Across phases,
every non-profile value must be byte-identical. The overlap configuration must
contain eight distinct profile keys, all separate from lifecycle, enrollment,
publisher, service, session, provider, database and workload credentials.
Common receipts retain only existing whole-configuration record bindings; they
contain no credential value or per-key credential hash.

## Fixed order

1. Verify the exact source, candidate, host, ten-container inventory, runtime
   target, current frontend deployment, closed native schedules, and both held
   locks. Retain mutation intent before any provider or Compose call.
2. Recreate Course and Community on the exact same images with `overlap`.
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
5. Immediately before removal, privately issue controlled, unexpired old and
   new tokens for all four profiles. Tokens remain only in root-owned mode-0600
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
python3 ops/platform/host/p2_identity_key_rotation_test.py
```

These are non-live checks. They use synthetic keys, owned HTTP/verifier
fixtures, and no staging, provider, database, Vercel, Course, or Community
request. They do not establish key removal or release acceptance.
