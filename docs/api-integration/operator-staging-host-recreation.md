# Staging host recreation

**Held November 3:** The operator's public address changed while both original SSH firewalls still permit the old address. Do not execute this original-host coordinator. First review the separate [operator-access recovery](operator-staging-access-recovery.md), which retains authenticated browser recovery access and restores the current runtime without claiming P1 qualification. Subsequent live qualification needs the new machine's actual receipts and access policy; this original proposal cannot be reused unchanged.

Preparation only. The original host remains at `184.196.129.231`. Gateway application writes and business schedules remain suspended. No rollback, host retirement or replacement is authorized by this document. This exercise qualifies the initial P1 foundation; routine releases do not repeat it.

## Current validation

The [component validation](baselines/2026-11-03-staging-recreation-component-validation-4.json) binds the prepared source and distinguishes owned tests from live evidence. It records 250 host tests on Mac and Ubuntu Linux, 124 platform tests under Node 24, focused ESLint, and the [eight offline source-receiver/systemd checks](baselines/2026-11-03-owned-recreation-controls.json). The [existing-host cache check](baselines/2026-11-03-existing-host-image-cache-preflight.json) found all six current and three compatible runtime images without pulling or changing the host.

The earlier [owned application recovery](baselines/2026-11-02-owned-admin-durable-recovery.json) passes 45 checks over actual published current/previous/current images, 24 graceful process stops, retained lease/retry recovery and preserved business rows. These checks do not prove live recreation. The compatible candidate was qualified in owned fixtures; it was not a previously working live release.

Existing actual infrastructure, strict SSH, database TLS/current-state, and privately authorized business checks remain retained in the operator workspace. No private row fingerprints, table counts, schema exports, key material or environment values belong in public evidence. The approved business-summary transfer was limited to `/private/tmp/lash-p1-business-fingerprint-preflight.json`; it does not authorize new transfers or execution of this action.

## Reviewable action

`ops/platform/recreate-staging.mjs` connects the tested host phases to the ordered AWS change-set driver and strict SSH transport. It keeps the selected application candidate `p1-41541683416-1`, frontend source `74ca26736e5834fce639407278b4575bf4d05670`, existing external databases and existing static IPv4 allocation. It does not run migration application.

The action performs these steps once, retaining actual outcomes between them:

1. Verify the clean committed operator source, canonical repository, current branch head, latest exact-source CI and all ten required jobs. CI explicitly checks out the pull-request head. Verify the original stack, instance, address and machine identity. Stage only reviewed public source and bounded private inputs from existing protected Mac copies.
2. Verify the exact nine cached images and a fresh complete Mux Dev webhook inventory. Under the release lock, fence native schedules, public gateway ingress and maintenance timers; drain processes. Create controlled synthetic Course fixtures through the existing private administrator APIs and retain repository-managed lease/retry work. Perform the compatible runtime rollback and current runtime restoration without overlapping processes or applying SQL.
3. Refresh the Mux inventory, fence and drain again, and verify all eight graceful stops. Retain pending external database work, keyed business summaries and the new current-runtime receipt privately on the Mac. Every retained file and its directory are fsynced before compute removal.
4. Create, inspect and execute three ordered CloudFormation transitions: `attached → detached → absent → attached`. The static allocation remains. Each change set is bound to the exact account, stack, parameters and template. Refuse address removal, unexpected resources, host property changes or ambiguous execution. Never delete the stack or automatically retry an uncertain mutation.
5. Establish the separately selected new-host SSH trust, preserving the original trust file. Verify a new AWS instance ARN and different machine ID. Run the reviewed POSIX initialization and pinned Docker bootstrap; verify SSH/UFW/forwarding controls. Cache only the six exact current images, authenticating privately only if necessary.
6. Restore the already-held TLS, ACME account and configuration copies with private permissions, rebinding only new-machine references. Install the existing watchdog and certificate units disabled. Preserve their existing resource limits and daily certificate schedule. Do not restore the old bootstrap receipt or fetch another secret archive.
7. Run the three exact current-state database checks read-only, then restore receivers before workers. Verify new container identities, pinned images, readiness, private boundaries, actual publisher recovery, Community reconciliation and business preservation. Original migration and runtime receipts remain unchanged.
8. Build the qualified frontend source with a fresh private probe, verify its real server workload, promote only the staging project and run the bounded native smoke. Always disable/drain native schedules. Bind the qualification to the new runtime receipt. Verify a fresh actual certificate-service invocation and then enable the existing maintenance timers.
9. Retain a sanitized outcome and elapsed timings. Success remains `STAGING_HOST_RECREATED_AWAITING_PROVIDER_AND_EXTERNAL_EVIDENCE`; native provider records and independent external boundary checks are still required. Gateway write admission and business job activation remain separate reviewed actions.

## Operator inputs and commands

No new credentials are requested. Apply uses the existing 1Password-mounted frontend Environment bindings: `PLATFORM_SOURCE_READ_TOKEN`, `VERCEL_TOKEN`, `GHCR_USERNAME`, `GHCR_READ_TOKEN`, `FRONTEND_STAGING_MIGRATION_DATABASE_URL`, `COURSE_STAGING_DATABASE_URL` and `COMMUNITY_STAGING_DATABASE_URL`. Values go only to scoped child processes/private SSH stdin. The Course/Community administrator URLs and the value of `CRON_SECRET` are not needed. The existing frontend migration binding is used only for its server-enforced read-only verification.

1. Publish and verify the complete operator source before execution review. Use a clean checkout at the reviewed 40-character commit, with the repository's Node 24 runtime and installed dependencies.
2. Prepare a mode-600 JSON settings file outside Git:

   ```json
   {
     "version": 1,
     "action": "p1-recreate-reviewed-action",
     "sourceCommit": "REVIEWED_40_CHARACTER_COMMIT",
     "trustMode": "pending"
   }
   ```

   Replace the example action and source placeholder with the reviewed values. The action uses lowercase letters, digits and hyphens. Keep `trustMode` pending until Dardan resolves the existing choice described below.
3. Run the plan:

   ```sh
   node ops/platform/recreate-staging.mjs plan /ABSOLUTE/PRIVATE/settings.json
   ```

   Planning validates protected local copies and prints only review metadata: source, project, immutable images, database targets/roles and the private receipt destination. It does not read `.env`, query providers or change the host. The plan does not grant execution approval.
4. Resolve new-host SSH trust. AWS currently returns no public host keys; Chrome is authenticated, but browser SSH is blocked by the existing firewall. Dardan's pending choice is either a temporary AWS browser SSH allowance for independent key verification, removed before application startup, or explicit operator first-use acceptance after verifying the new AWS instance/address. No firewall expansion or automatic acceptance is inferred. Only the optional `operator-first-use` path is implemented; `pending` and `provider-browser` refuse apply before provider/private binding access. If browser verification is selected, its bounded allowance/removal must be implemented and reviewed first.
5. Review one complete action including the selected trust method, deletion/recreation of the staging disk, staging frontend promotion, controlled synthetic API work and the bounded private transfer destinations. This includes existing Mac recovery material sent to the new staging host and fixed JSON receipts copied back to the private Mac action directory. No live action starts before Dardan's approval.
6. After approval, refresh the complete masked Mux Dev dashboard inventory into the mode-600 file `/Users/dardan/.local/share/lash-her/recreations/staging/incoming/mux-inventory.json`. The controller requests a fresh inventory before both rollback and retirement. This is a producer observation, not a new monitoring requirement.
7. Start the approved action once:

   ```sh
   node ops/platform/recreate-staging.mjs apply /ABSOLUTE/PRIVATE/settings.json --confirm staging/p1-recreate-reviewed-action
   ```

   The confirmation must match the settings action exactly. Complete the existing 1Password unlock if prompted. In operator-first-use mode, the controller pauses after new-instance verification and prints the exact address, ARN, key fingerprint and private acceptance-file path. Dardan must deliberately accept that observed key for that action; this is recorded as operator acceptance, not AWS-authenticated key verification.
8. Review actual Vercel native invocation/cancellation records and affected independent IPv4/IPv6/proxy boundary evidence against the new runtime. An unavailable IPv6 path on the operator network is not evidence that remote ingress is blocked. Do not enable business schedules or gateway writes based on the controller's intermediate success status.

## Private receipts and failure handling

Action receipts stay under `/Users/dardan/.local/share/lash-her/recreations/staging/ACTION`, outside Git, with mode-700 directories and mode-600 files. The generated fingerprint key is retained privately before any remote mutation so a deliberate recovery can verify existing work. Fixed receipt exports exclude environment files, keys, probe credentials and raw provider errors. Public source is installed under `/opt/lash-her/operators/COMMIT`; an existing exact copy may be verified and reused, but changed/unreviewed source is never overwritten.

The source receiver, bootstrap/cache, host phases, maintenance installation and AWS transitions have bounded operations and one-attempt mutations. The controller records phase intent before mutation and attempts only fixed-file observation after a failure. Missing terminal receipts preserve uncertainty that the remote phase may still be running. It does not treat SSH interruption as proof that remote cleanup finished.

On failure, retain actual state and dependent traffic suspension. Do not rerun the complete action, substitute new IDs into old receipts or replay migrations. Review the terminal phase/provider state and prepare a deliberate scoped continuation using the retained private inputs. The complete CLI does not automatically resume a partial recreation. Timings report action duration, maintenance-action duration and an upper bound for gateway outage; they do not claim an exact observed outage interval.
