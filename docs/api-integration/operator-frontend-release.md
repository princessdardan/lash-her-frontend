# Frontend provider release component

`ops/platform/host/vercel.py` implements provider operations for the unfinished parent frontend/API release coordinator. It has no standalone command or automatic activation. The [single-operator release policy](release-policy.md) remains authoritative; this component does not bypass the existing frontend quiescence hold or qualify a release.

## Implemented operations

- `disable_schedules` verifies the exact environment's fixed project, team and connected frontend repository, disables native crons with the provider API and reads back the disabled state. It refuses an unrelated production-target change. It does **not** claim running invocations, callbacks, historical deployment URLs or database writers are drained. Its result always reports `frontendQuiescenceVerified=false`.
- `stage_frontend` uses the selected project's **Production target** for its environment configuration. Business staging selects the dedicated staging project; production selects the separate live project. It builds remotely from the exact reviewed Git commit, without pulling secrets or uploading a local checkout. It sets `autoAssignCustomDomains=false`, then verifies the returned deployment's project, Git repository/commit, release identity and ready state while checking the existing production target and disabled-cron state remain unchanged.
- The remote build has an exclusive durable intent before creation, a separately retained deployment ID as soon as one is returned, and a sanitized outcome. Neither errors nor observation timeouts retry creation, promote, roll back, enable schedules or admit traffic. An uncertain POST requires provider inventory/reconciliation. An observation timeout retains the existing deployment ID for subsequent inspection; it does not mean the remote build stopped.

The parent supplies its scoped provider credential privately at runtime. The client fixes the HTTPS API origin and team, verifies TLS, disables ambient proxies and redirects, bounds response sizes and replaces provider exception details with fixed diagnostics. Provider responses may contain environment/protection data; they are never persisted. Common records retain selected identities/results only. No environment-variable values or authentication files are read by this component.

## Integration still required

The parent must verify the candidate, hold the shared release lock, establish actual frontend writer/scheduler suspension, complete the three migrations and start/verify the API runtime before staging the frontend build. After staging, it must verify actual frontend workload authentication and affected behavior, perform the reviewed domain promotion, restore eligible producers/schedules and explicitly admit gateway writes. Native scheduler execution/cancellation and all remaining initial P1 live evidence are still required. A build returning `FRONTEND_STAGED` always has `trafficAuthorized=false` and `promotionAuthorized=false`.

The existing host full-bundle CLI still refuses apply without the reviewed quiescence coordinator. Do not wire `disable_schedules` directly into that callback: future schedule cancellation alone cannot prove suspension of all writers. Project pausing is also insufficient evidence of in-flight or historical-deployment drain.

## Verification and provider references

The host suite exercises these operations through an owned HTTPS server and fixture CA with synthetic credentials. It covers exact source/target selection, schedule-disable readback, production-target drift, TLS refusal, redirect refusal, error redaction, bounded responses, uncertain creation, failed builds and observation timeout/handle retention. These are real HTTP/TLS exchanges with controlled provider responses, not live Vercel qualification.

Provider semantics were checked against [Vercel deployment creation](https://vercel.com/docs/rest-api/deployments/create-a-new-deployment), [deployment inspection with Git metadata](https://vercel.com/docs/rest-api/deployments/get-a-deployment-by-id-or-url), [CLI skip-domain behavior](https://vercel.com/docs/cli/deploy#skip-domain) and [Vercel's cron-control client](https://github.com/vercel/terraform-provider-vercel/blob/main/client/project_crons.go). The installed official Vercel CLI 50.0.0 maps `--skip-domain` to `autoAssignCustomDomains=false`; the component uses that request field directly. The connector's project metadata response omits the full Git/cron/production-target state, so it cannot supply the complete verification required by this component.

No provider mutation, credential retrieval, deployment or migration was performed while developing or testing this component. The deferred runtime/release credential handoff remains in effect.
