# Consent recovery writer admission

P2-00 component only. This extends the [product checkout adapter](frontend-writer-route-admission.md) and [training admission](frontend-training-admission.md) to three consent recovery POST endpoints. Admission remains disabled by default. No live database, bootstrap, grants, deployment or provider settings changed.

| Entrypoint | Class | Work covered |
| --- | --- | --- |
| `POST /api/webhooks/resend` | recovery | Verified contact-unsubscribe persistence and local durable queue changes. |
| `POST /api/webhooks/highlevel` | recovery | Verified contact/DND/uninstall receipts, consent updates, token revocation and local durable queue changes. |
| `POST /api/marketing/unsubscribe` | recovery | Signed-token unsubscribe persistence and local durable queue changes. |

## Policy and execution

The inherited adapter validates the hosted/source/producer identity and requires the application and ledger database URLs to use the same reviewed direct target/login with verified TLS. It observes the current policy epoch per request and commits admission before invoking the handler or consuming its request. Recovery can remain open after new work closes; closing recovery refuses with retryable HTTP 503 before signature verification or persistence. No new flags or credentials are introduced.

The wrapper passes the original request untouched. Raw webhook bytes remain subject to the existing size caps and signature verification. Sender/tenant checks, consent semantics, receipt/idempotency keys and durable queues retain their existing behavior. No response is streamed and all handler persistence is awaited. Provider delivery and queue workers are separate executions and remain outside this component.

A caught handler 5xx, thrown error, connection loss or lost settlement acknowledgement produces a sanitized retryable 503 under enforcement. Possible effects retain unresolved operation state; the wrapper does not replay them or acknowledge webhook success. An HTTP 4xx rejection without effects completes that execution. Business retries preserve existing domain keys and do not reconcile earlier uncertain executions automatically. Off mode preserves existing handler responses.

The token-bearing unsubscribe endpoint uses an endpoint-specific admission failure response: empty body, `Cache-Control: no-store, max-age=0`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff` and `Retry-After: 30`. The factory receives no token, request or exception. The shared wrapper retains its existing generic response for other endpoints. Unsubscribe GET only validates the token and renders a confirmation form; it remains read-only and available when recovery writes are closed. POST still performs the actual unsubscribe.

The ledger receives execution identity and reviewed target/producer bindings, never webhook payloads, contact emails or unsubscribe tokens. This component does not change the existing application consent records or their retention rules.

## Validation and limits

The [validation record](baselines/2026-11-04-p2-00-consent-recovery/validation.json) records eight new tests through the real handler factories and adapter. Tests use the Resend SDK's actual Svix verifier and the HighLevel Ed25519 verifier with owned fixture keys and exact raw bytes, including whitespace and a trailing newline. They cover pre-body refusal, recovery while new work is closed, invalid signatures and oversized bodies, persistence still in flight after policy closure, caught persistence failures, lost settlement acknowledgement, blank unsubscribe privacy responses, read-only GET and off-mode behavior.

Business persistence and ledger clients are injected in these handler tests. Owned PostgreSQL16/18 rerun the inherited actual adapter protocol: eight adapter, 14 ledger, 11 historical-login and 15 migration checks each. Those fixtures do not prove the combined real consent Drizzle flow under enforcement, live webhook delivery, worker drain or provider finality. CI qualifies the normal build/business database/browser paths with admission off. No live bootstrap, producer or immutable image is qualified here.

PR #72 was reviewed with no actionable findings within its stated training scope. All ten CI jobs passed on `a28e1d3bcbd8682cd36342194ddd1a71734de82d` ([run](https://github.com/princessdardan/lash-her-frontend/actions/runs/41782198018)); staging merged at `b8e8879559aeae864d259d080a4d5c50544e86ee`.

Other booking/payment/webhook, GET mutation, admin/form/action and worker entrypoints still require qualification. Historical deployment/provider fencing, initial live bootstrap, exhaustive operation/deferred-work drain and the parent migration/deployment/recovery coordinator remain unfinished. Pending SQL stays disabled; Fresha/410 reservation closure and live staging/production are unchanged. P2-00 remains in progress.
