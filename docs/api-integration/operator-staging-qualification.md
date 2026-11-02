# Initial staging qualification coordinator

`ops/platform/host/staging_release.py` joins three-database verification/migration, API runtime startup, frontend probe configuration, pinned frontend build, real HTTP workload verification and staging domain promotion under the existing release/watchdog lock. It is preparation for the remaining initial live qualification. It keeps gateway writes in maintenance and native schedules disabled; success is not P1 acceptance.

Use the qualified immutable candidate, private three-database bundle and runtime configuration from [operator migrations](operator-migrations.md) and [API runtime release](operator-runtime-release.md). Source CI and owned rehearsals do not supply a qualified registry candidate or a deployment host. Private credentials must be verified before a live run; the outstanding Course setup remains a separate prerequisite.

## Inspect and execute

The default command reads the selected public target configuration and displays a plan without acquiring provider/database credentials, running Docker or contacting Vercel:

```sh
python3 ops/platform/host/staging_release.py BUNDLE CONFIGURATION RESULTS
```

It requires the dedicated staging project and all three database jobs. The plan identifies the frontend source/project, API images, database targets, host and frontend stages. This initial coordinator supports an already-current frontend database. Pending frontend SQL is displayed but apply refuses before credentials or database changes until actual writer/scheduler draining is implemented. An empty reviewed pending list still needs the migration image's real read-only schema/lineage/grant proof before either API database is changed.

After reviewing the plan, Dardan explicitly starts the action on the selected Linux AMD64 root host with its local Docker socket:

```sh
python3 ops/platform/host/staging_release.py BUNDLE CONFIGURATION RESULTS --apply --confirm staging/RELEASE_ID
```

Inject the existing `VERCEL_TOKEN` and the three named staging migration variables privately into this process. Reuse the supplied credential mechanism; no new operator credential or secret service is needed. The command does not load an ambient dotenv file or accept tokens/URLs in arguments. Each child container receives only its selected runtime/migration inputs, without the Vercel token. Existing host/configuration/source/recovery checks remain in force. Production is refused by this initial staging command; the [production policy](release-policy.md) still requires the tested candidate and complete recovery/acceptance checks.

Before database work, the command verifies provider project/protection access and refuses active alias jobs or unsupported rolling release state. It then calls the API coordinator. Inside the locked continuation, after durable database/API readiness:

1. Recheck provider state and disable native schedules with readback; retain their previous enablement state. Probe preparation selects the expiring staging qualification configuration: that frontend build contains only the dedicated native smoke definition, with business cron definitions excluded. It does not enable the scheduler.
2. Configure the [automatic expiring probe](operator-frontend-workload-probe.md) in the existing staging project.
3. Build the exact frontend Git revision as a Production-target deployment without assigning domains.
4. Verify the deployed server-to-gateway path through the real HTTP callback, then promote that retained deployment and verify native promotion completion.

No second approval is requested between these stages.

## Outcomes and remaining checks

`RESULTS/runtime-RELEASE_ID/frontend/staging-outcome.json` binds the candidate, migration/API records, workload result and promotion result. `STAGING_READY_FOR_LIVE_QUALIFICATION` confirms the selected stages completed. It records `frontendDomainsPromoted=true` and `frontendServerWorkloadVerified=true`, while retaining `releaseAccepted=false`, `trafficAuthorized=false`, `gatewayTrafficAuthorized=false`, `nativeSchedulerVerified=false` and `externalIngressVerified=false`.

The actual host/TLS/IPv4/IPv6 negative matrix, native scheduled execution/cancellation, recreation/restart, worker recovery and compatible recovery/rollback still need initial live evidence. Eligible producer/schedule restoration and final gateway admission remain unfinished. The coordinator does not write `acceptance.json`, enable native schedules or disable gateway maintenance. Monitoring/alerts remain deferred and billing-access/spending evidence remains excluded.

Provider failures inside the continuation stop the API runtime while the lock is held. Database success remains independently recorded; later failure never rolls it back. If frontend domains may have moved, the outcome preserves uncertainty rather than claiming no mutation. An uncertain build/promotion is not retried, rolled back or followed by automatic schedule restoration. Inspect actual provider/database state and the separate runtime failure record before a deliberate new attempt. Existing attempt directories are never overwritten. Keep the entire private configuration, including its probe credential, out of common receipt exports.

## Verification scope

Seven connected coordinator tests use actual filesystem receipts and flock contention, simulated Docker and owned HTTPS provider/deployment servers. They cover plan-only behavior, early scope/confirmation/credential refusals, ordered success with gateway/schedules still held, failed deployed-probe suspension, ambiguous promotion without retry/rollback and provider drift before mutation. They do not contact AWS/Vercel/Neon or execute a live deployed function. The separate leaf tests cover TLS, source/target/authentication/expiry and response failures.
