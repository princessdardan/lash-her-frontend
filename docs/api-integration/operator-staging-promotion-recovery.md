# Recover the promoted staging runtime

Release `p1-41541683416-1` applied all 17 Course and 10 Community migrations, verified the already-current frontend database read-only, started the eight pinned containers and passed the real Vercel server-to-gateway catalog check. Vercel then successfully promoted deployment `dpl_HnN7FbtaRP2mBsQPg9QeZiSuupP8` to `staging.lashher.com`. The coordinator misclassified the promotion acknowledgement and stopped the APIs. Its original failure records remain unchanged.

Read-only reconciliation confirms the exact deployment/source/release binding, the successful promotion job (`requestedAt=1793662853100`), matching project pointer/custom alias and disabled native schedules. No migration, promotion, rollback or application restart was repeated. The original database/runtime/frontend receipt bytes are retained privately off-host; all existing receipt hash bindings verify.

Two provider adapter corrections are prepared in an isolated checkout based on qualified frontend source `74ca26736e5834fce639407278b4575bf4d05670`:

- Accept an empty 201/202 acknowledgement only for the exact reviewed promotion endpoint. Acceptance still requires read-only observation of the successful job and matching deployment.
- Request `rollbackInfo=true` when inspecting promotion state; the ordinary project query omits `lastAliasRequest`.

These match the [official promotion API](https://vercel.com/docs/rest-api/projects/point-production-traffic-to-a-given-deployment), [official SDK response handling](https://github.com/vercel/sdk/blob/main/src/funcs/projectsRequestPromote.ts) and [official CLI project query](https://github.com/vercel/vercel/blob/main/packages/cli/src/util/projects/get-project-by-id-or-name.ts). The original POST's exact response status/body was not retained, so its wire response cannot be reconstructed. The parsing defect is reproduced with an owned HTTPS server; actual promotion completion is separately established by provider reads.

## Reviewed recovery action

The [recovery component](../../ops/platform/host/staging_recovery.py) restores only the eight existing stopped containers from this release. Its [tests](../../ops/platform/host/staging_recovery_test.py) cover receipt tampering, confirmation, lock contention, changed aliases/schedules, missing containers, startup failure handling, expired probes and repeat refusal.

1. Recheck the exact host machine identity, successful database receipts and their hashes, original runtime/frontend failure and successful server proof.
2. Under the shared release/watchdog lock, verify the completed promotion and staging alias, disabled schedules, all eight original container IDs, pinned images, labels and stopped state.
3. Record a new exclusive recovery intent. Start the existing containers in the original dependency order and wait for readiness. No container is recreated or pulled.
4. Repeat all five runtime boundary checks and check all eight container identities/health. If the existing deployment's one-hour probe remains valid, repeat its real server catalog call. If that probe has expired, retain the original server proof, record that no new server/native qualification was performed, and do not extend credentials or rebuild implicitly.
5. Recheck provider state and retain a separate recovery outcome. Gateway writes remain in maintenance and native schedules remain disabled. Any recovery failure stops the runtime and requires inspection; no automatic retry occurs.

There is no database execution, frontend build/promotion, provider mutation, container replacement, production change, VM deletion/replacement or final admission in this command. Reviewed maintenance and native scheduling remain subsequent qualification work.

## Exact prepared inputs

- Host: `184.196.129.231`; machine ID `ec265c34b9fbf4d051aecfa185362c0a`.
- Existing source/deployment and all application image digests remain those of `p1-41541683416-1`.
- Private host tools: `/var/lib/lash-her/release-inputs/staging/p1-41541683416-1/promotion-recovery-tools-1`.
- `vercel.py` SHA256: `014ec41e1f86155c24d1d23fcc0da10112cfda7d07403f0d22612eccdef66c77`.
- `staging_recovery.py` SHA256: `015628111f84b67d43e98518ad9651f923cbfe26cc04de8a08fa2e3cff9180c0`.
- New output: `/var/lib/lash-her/releases/staging/recovery-p1-41541683416-1-1`.
- Existing private 1Password injection supplies only the Vercel token to the host recovery process; database/registry credentials are not forwarded.

The actual host read-only preflight passes for all eight stopped containers and the completed promotion. The isolated qualified-source checkout passes all 130 host tests, including 13 recovery checks; the two empty-response regression cases fail before the adapter correction and pass afterward. These tests do not constitute live recovery or native scheduler qualification.

After Dardan reviews the failure and explicitly starts recovery, the prepared Mac wrapper is:

```sh
python3 /private/tmp/lash-p1-apply-reviewed-runtime-recovery.py
```

It verifies the exact prepared tool hashes, records an exclusive local intent, injects the token privately over pinned SSH and invokes the guarded recovery component once. The wrapper has been compiled, but has not executed. The existing [release policy](release-policy.md) requires Dardan to review a failed release before a deliberate retry. The original release command must not be rerun.
