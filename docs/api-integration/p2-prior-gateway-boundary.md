# Prior gateway replacement boundary

The host closes and drains the **actual mounted prior gateway before frontend SQL or any API service recreation**. Gateway process-local uncertainty survives containment in immutable receipts. An unavailable operations endpoint, stopped process, missing lineage, or restarted process never implies zero.

The fixed broker protocol is `prepare-prior-gateway` with only `id` and `operation`. It returns `PRIOR_GATEWAY_PREPARED` only after source-owned preparation returns `PRIOR_GATEWAY_CLOSED_ZERO`. Initialization performs read-only preflight before `LOCKED`; it does not close eligible recovery. The Node parent calls preparation after frontend recovery drains, both frontend admission categories close, provider reconciliation and producer checks complete, and before the before-SQL fence. Recovery calls it before `arm-recovery`. The physical frontend/schema observer remains armed at the existing API-start stage.

The source observer verifies the sole staging Docker gateway, local host/engine identity, exact pinned image, read-only mounts, runtime/gateway bytes, process/container identity, admission-file hash acknowledgement, and both typed active/uncertain counters. Closing uses the existing admission-file protocol and its existing 13-second drain bound. Both categories must be closed with active and uncertain counts zero. The process must remain the same through the API stages; the fixed gateway-last replacement is recorded before its command and read back against the new candidate. Later current-source work does not retroactively change the retained prior-process proof.

| Observed state | Ordinary replacement prerequisite |
| --- | --- |
| Running, known counters | Actual mounted close/hash acknowledgement and same-process active0/uncertain0. |
| Running, sticky uncertainty or unknown counters | Refuse. Retain counters/identity, or explicit unknown metadata. |
| Stopped, same retained Docker identity | Source pre-stop closed-zero observation plus ordered-stop receipt and matching process/configuration; contradictory newer lineage refuses. |
| Absent Docker gateway | The same stop chain plus exact latest root-owned `.p2-gateway-lineage.json` pointer. Missing/pending/newer/unknown lineage refuses. |

`priorGatewayReference` is an optional closed path/hash union validated independently by Node and Python:

- `retained-runtime`: `candidateDirectory`, `configurationDirectory`, `runtimeReceiptDirectory`, `candidateSha256`, `runtimeReceiptSha256`; optional paired `stopReceiptDirectory` and `stopReceiptSha256`.
- `stopped-current-candidate`: `stopReceiptDirectory` and `stopReceiptSha256`.

All directories are canonical private paths beneath `/var/lib/lash-her/releases/staging`. References select source evidence, not counters, images, or an asserted safety result. A different prior candidate is checked through its own candidate, pinned retained Compose/configuration and exact gateway runtime receipt. An accepted eight-service P1 prior need not satisfy the new candidate's ten-service/P2 schema. A newly reviewed recovery may select the fresh current-candidate stop reference; it must not reuse a stale earlier P1 reference for a newer gateway.

The independent guard and surviving broker fallback capture the actual mounted gateway before stopping services, retaining `prior-gateway-before-stop.json` and `prior-gateway-stopped.json` without overwriting originals. Known nonzero and unknown counters remain so after stop. The after-quiescence and surviving-broker attempts have fixed source-selected child directories. The atomic fixed-root lineage pointer records observed identity and pending replacements; callers cannot choose another pointer. Retained stop receipts bind this helper's exact source hash and are not silently adopted under changed helper bytes.

`observe_prior_gateway(...)` and `observe_stopped_prior_gateway(...)` expose sanitized read-only observations for the separately implemented known-ACK binder. The stopped observer preserves trusted nonzero counts. Neither observer issues replacement authority. The ordinary `PriorGatewayBoundary` remains source-only and closed-zero; this package adds **no known-ACK exception, counter override, SQL replay, login restoration, role preparation, or production control**.

Evidence: [owned qualification](baselines/2026-11-06-p2-prior-gateway-boundary/validation.json). The owned tests run the real gateway HTTPS/operations server and actual process termination, with projected Docker metadata and fixture API-current results; they do not claim live Docker, Vercel, provider, or staging database qualification.
