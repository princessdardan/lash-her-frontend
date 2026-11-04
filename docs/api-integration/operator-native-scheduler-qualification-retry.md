# Native scheduler qualification retry after preflight refusal

The original staging server-to-gateway check passed, but its one-hour probe expired before native scheduling was qualified. Recovery restored all eight original containers. This action refreshes only the frontend qualification deployment, using the already-qualified frontend source and current API images/database state.


## First attempt and correction

Dardan approved the first action, and its exact-source CI passed. Its local start/outcome records are retained. It stopped before creating the remote qualification directory, so the controller could not reach any provider mutation. Read-only reconciliation confirms the original frontend pointer, disabled schedules, unchanged Production+Preview cron binding and eight healthy original containers. No deployment, probe configuration, cron window or SQL was created by that attempt. [Failure evidence](baselines/2026-11-02-native-qualification-preflight-refusal.json) preserves the uncertainty: the old wrapper discarded the exception class. The watchdog ran during the preflight; shared-lock contention is likely but not conclusively proven.

The correction waits at most 30 seconds for that same release/watchdog lock, before provider access or action intent, rather than failing immediately during brief watchdog work. A sustained conflict stops with `NATIVE_RELEASE_LOCK_BUSY`. Permission failures and interruption stop without retry. Safe failure reporting preserves a bounded error class/code without arbitrary exception payloads. No build, promotion or cron mutation gains an automatic retry.

The new actual read-only preflight passes with the exact corrected tool hashes. All 154 host tests pass, including 24 focused native cases. New exact-source CI must also pass before execution. A new exclusive attempt/output is used; neither the old intent/outcome nor original release/recovery records is overwritten. Dardan must review this failure before a deliberate retry under the accepted [release policy](release-policy.md).

## Exact scope

- Action: `native-qualification-p1-41541683416-1-2`.
- Existing host: `184.196.129.231`; machine ID `ec265c34b9fbf4d051aecfa185362c0a`.
- Release: `p1-41541683416-1`; candidate SHA256 `b086558ed575cbdd0ceea8a3267e178e7ac390b77db9d2361cb721f750792900`.
- Frontend source: `74ca26736e5834fce639407278b4575bf4d05670`, still the current `staging` branch head. Existing frontend source CI and candidate qualification remain applicable.
- Dedicated staging Vercel project: `prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM`; team `team_2Hrn5eMZyZxfAWdmYvyKi9t3`.
- Expected current deployment: `dpl_HnN7FbtaRP2mBsQPg9QeZiSuupP8`; refuse a changed pointer.
- Native job: only `/api/internal/release-scheduler-probe`, `* * * * *`.
- Observation window: up to 180 seconds from the enable request, then request disable, verify disabled state, drain 16 seconds and observe cancellation for another 60 seconds. Provider request latency remains bounded by the existing 30-second request timeout; an uncertain disable is a failure requiring review.

No SQL, API restart/replacement, new VM, production-project change, business-schedule activation or gateway write admission is included. A new frontend build/promotion and the existing staging cron binding's scope correction are included, so this requires a fresh operator start action under the [release policy](release-policy.md).

## Existing credential scope correction

Read-only metadata shows one unbranched sensitive `CRON_SECRET` binding targeting both Production and Preview in the staging project. Its value was not decrypted or displayed. The reviewed command narrows that same binding to `target=["production"]` using a PATCH containing only `target`; it omits `value`, `key` and `type`, then confirms the same binding ID/type and target by metadata readback. It does not rotate, copy, retrieve or submit the credential. Ambiguous/ignored changes stop the action without repeating the request.

This uses the documented optional metadata fields in [Vercel's environment-variable edit API](https://vercel.com/docs/rest-api/projects/edit-an-environment-variable). No new credential handoff is required.

## Execution and retained evidence

1. Acquire the shared release/watchdog lock. Verify durable successful database receipts, original candidate/source identity, all eight original healthy container IDs/images, the exact current frontend pointer and disabled schedules.
2. Narrow the existing cron binding as above. Recheck the unchanged project pointer.
3. Create a new private expiring probe at execution time. Configure only the existing staging project's probe/gateway bindings. Keep `CRON_SECRET` otherwise unchanged.
4. Build frontend source `74ca267` without assigning domains, verify its exact project/source/release binding and execute the real server-to-gateway catalog check. Promote that retained deployment once and observe successful native promotion. Uncertain creation/promotion is not repeated or rolled back automatically; the healthy API runtime remains running.
5. Verify the promoted deployment has exactly the dedicated smoke schedule and no business definitions. Enable it once, observe the bounded window and always request disabling in cleanup, including after an ambiguous enable or interruption. Verify disabled state and retain drain/cancellation timestamps. Do not manually invoke the cron endpoint or retrieve its bearer secret.
6. Query Vercel provider logs for the exact new deployment/window. Require a genuine function request ID and the matching `FRONTEND_SCHEDULED_WORKLOAD_PROBE_PASS` receipt, source/project/environment, invocation ID and timestamps. Correlate native job metadata and actual request records; application headers or a success label alone cannot establish native origin. Inspect requests through the post-disable observation period before declaring cancellation verified.

The controller returns `NATIVE_WINDOW_CLOSED_AWAITING_PROVIDER_EVIDENCE` after cleanup. It deliberately keeps `nativeSchedulerVerified=false` and `releaseAccepted=false`; only actual provider invocation/cancellation evidence can qualify those separate checks. VM recreation, compatible rollback and the remaining P1 matrix remain independent.

Original release/recovery failure records are preserved. New records go to `/var/lib/lash-her/releases/staging/native-qualification-p1-41541683416-1-2`; its `private` subdirectory contains the new expiring probe and must not enter common exports or Git. The local wrapper also retains an exclusive intent/outcome, without printing credentials.

## Reviewed implementation and preparation

- [Controller](../../ops/platform/host/native_qualification.py) and [owned tests](../../ops/platform/host/native_qualification_test.py).
- Inactive host tools: `/var/lib/lash-her/release-inputs/staging/p1-41541683416-1/native-qualification-tools-3`.
- Controller SHA256: `4dca67800f3949d9eed8cf50c5b137533cca7920bb54b8fe9e1334b95065c72d`.
- Provider adapter SHA256: `014ec41e1f86155c24d1d23fcc0da10112cfda7d07403f0d22612eccdef66c77`.
- Recovery receipt verifier SHA256: `015628111f84b67d43e98518ad9651f923cbfe26cc04de8a08fa2e3cff9180c0`.

The actual host read-only preflight passes for the eight healthy original containers, candidate/database receipts, frontend pointer/source pins, existing automation access and sensitive cron binding metadata. It explicitly records the proposed target correction; no setting, deployment or schedule has changed during preparation. The new source adds tests for actual POSIX lock contention, bounded timeout, permission/interruption behavior, safe diagnostics and refusal before any provider access. Existing owned HTTPS, credential-scoping, cancellation, ambiguity and repeat-refusal checks remain required. Full host verification and source publication are recorded in the [preparation evidence](baselines/2026-11-02-native-scheduler-qualification-retry-preparation.json).

After Dardan explicitly starts this reviewed action, use:

```sh
python3 /private/tmp/lash-p1-apply-reviewed-native-qualification-2.py
```

The wrapper verifies the exact inactive tool hashes and passes only the existing Vercel token over pinned SSH. It has been compiled but has not executed. The action does not authorize source merges, VM deletion/replacement or final traffic admission.
