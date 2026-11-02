# Frontend release workload probe

The release components can now verify a pinned frontend deployment through its actual HTTPS endpoint and server-only gateway transport. The [initial staging coordinator](operator-staging-qualification.md) connects this verifier to the locked database/API/frontend stages. Final qualification/admission and production orchestration remain unfinished. This component adds no operator credential handoff, new secret service or permanent scheduled monitor.

## Automatic configuration

After the locked parent verifies API readiness and disables native schedules, `ops/platform/host/frontend_probe.py:prepare` generates a random 256-bit probe credential and a one-hour expiry. It preserves them in `frontend-probe-private.json` inside the existing private configuration directory, outside Git. This file contains a credential: keep it out of common receipt exports, logs and chat. Its owner/mode and release/source/project binding are checked before use.

The component uses the existing scoped Vercel token to configure three variables on the selected project's **Production target** before the pinned Git build:

- `LASH_RELEASE_PROBE_SECRET`: sensitive, generated automatically.
- `LASH_RELEASE_PROBE_EXPIRES_AT`: automatic expiry in Unix milliseconds.
- `API_GATEWAY_STAGING_ORIGIN` or `API_GATEWAY_PRODUCTION_ORIGIN`: the reviewed gateway host from runtime configuration.

Business staging uses the dedicated staging project; production uses the separate production project. Each provider mutation has retained private input and a sanitized intent before it runs. Partial failures are not retried automatically. The component verifies each returned key/type/target and checks that the production deployment and disabled-cron state have not changed. It neither reads nor replaces `CRON_SECRET`. Existing deployed environments are immutable; configuring a new probe does not change their credentials.

The generated credential remains sensitive in the existing project and is replaced by the next explicit release. The handler refuses it after expiry; no scheduled cleanup or operator rotation task is required. Missing, malformed or expired configuration leaves the endpoint unavailable.

## Deployed verification

`GET /api/internal/release-probe` requires its exact bearer credential and a fresh challenge before doing outbound work. It accepts only the reviewed Production-target environment/project binding and a valid Vercel Git source identity. The endpoint uses the ordinary SDK transport to obtain workload proof from the current function execution, then fetches and runtime-validates the gateway's Course catalog. Incoming credentials are not relayed upstream. Responses are `no-store`; errors omit private diagnostics. HEAD does not execute the GET probe.

`frontend_probe.verify` rechecks the retained deployment's source/project/release identity and READY state. It consumes the existing project automation bypass privately for deployment protection, without forwarding the Vercel API token. Its HTTPS client fixes the deployment URL/path, verifies certificates, rejects proxies/redirects, bounds the response and requires JSON with `no-store`. A successful response must match the fresh challenge, selected environment/project/source and exact gateway origin; the credential must still be unexpired. Provider bodies, credentials and challenges are not retained in the common outcome.

This function can supply `promote_frontend`'s real verification callback. `FRONTEND_VERIFIED` covers the server-to-gateway catalog path only. It keeps `trafficAuthorized=false` and `nativeSchedulerVerified=false`. Native scheduled execution/cancellation, producer restoration, final admission and the other initial P1 checks remain independent requirements.

## Evidence and integration boundary

Four new handler tests cover configuration, authentication-before-work, challenge/source/gateway binding and sanitized failures. Together with existing transport/response/smoke tests, 14 focused source tests pass. Fourteen host probe tests use owned HTTPS provider/deployment servers and synthetic credentials. All 94 host tests pass, including seven connected staging coordinator cases. Type checking and focused lint pass. These fixtures do not execute a deployed Vercel function or prove real workload OIDC; the initial live staging check is still required.

The initial staging coordinator calls preparation before `stage_frontend`, then calls this verifier through `promote_frontend` while the runtime continuation retains the host release lock. The standalone API CLI does not invoke these provider operations or authorize traffic. Source publication and CI do not apply the configuration or deploy anything.

Provider behavior is based on [project environment upserts](https://vercel.com/docs/rest-api/projects/create-one-or-more-environment-variables), [sensitive variables](https://vercel.com/docs/environment-variables/sensitive-environment-variables) and [automation protection bypass](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation). The installed official Vercel CLI also selects automation bypass values from the exact project's `protectionBypass` metadata. No secret-returning connector result is brought into chat.
