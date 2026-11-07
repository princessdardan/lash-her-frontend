# Owned lifecycle boundary regression evidence

Fix commit: `49ad7ef05ab55e6b87cd1e36581b72f52c1de3d4`, isolated from `cee1a263293cf2992b94f0a2c94007997ad0cf67`. Scope is the lifecycle qualifier, its tests/owned fixtures and documentation. Shared driver, application/API source, native runtime, provider settings and prior evidence were untouched.

The retained post-barrier snapshot now supplies the delivery baseline. Qualification requires outstanding work in that snapshot before native enable and a strictly increased attempt count on a subsequently acknowledged delivery. A completion interleaved with the barrier cannot be credited to the native window.

Containment rechecks exact locked project/deployment/source/URL/schedule/disabled metadata after draining, retaining a separate final-boundary record. A final failed readback produces `nativeEnabled: null` and no verified fence. The main qualifier also gates its disabled claim on its final current boundary, including a runtime check after the final ledger read.

## Executed evidence

| Artifact | Result |
| --- | --- |
| `protocol-before-fixes.log` | Baseline plus new assertions: 16 tests, 11 passed, five failed. Two incorrectly qualified delivery-progress cases, stale disabled claims and the missing containment final readback are preserved. This was a failing baseline, not accepted qualification. |
| `protocol-after-fixes.log` | 16 passed, zero failed/skipped. Covers acknowledgements during barrier UPDATE, attempts unchanged since the post-barrier snapshot, main final native/source drift and eight post-drain containment scenarios. |
| `owned-https.log` | Seven passed using the actual lifecycle host adapter and owned HTTPS control/protected-probe fixtures. No provider endpoint was contacted. |
| `postgres16.json`, `postgres16-summary.json` | Actual owned TLS/SCRAM PostgreSQL 16, all 83 migrations, nine executed checks, zero skips. Actual app cron/admission/store/trace and HTTPS receiver requests; provider classification is modeled. |
| `major-mismatch-stderr.log` | Selecting major 18 while supplying the actual major-16 binary refuses in ownership before opening a listener. This is an expected version denial, not a PostgreSQL 18 pass. |
| `focused-eslint.log` | Focused lint exited zero; empty output. |

The real PostgreSQL regression adds a dedicated third command and acknowledges both receiver deliveries from a second real database connection while the barrier UPDATE is in progress. The post-barrier snapshot contains those acknowledgements. The qualifier returns OPEN before native enable, emits no new cron request or receiver effect, and leaves both admission classes closed. The original nonempty/empty native-model window still passes its actual route/SQL/HTTPS checks.

Containment scenarios are stable completion, concurrent enable, source drift, deployment drift, URL drift, schedule drift, unavailable final metadata and lost environment lock. Only the stable scenario retains the final metadata record and reports a verified closed source fence. Unknown outcomes are not retried or settled.

The owned app/source binding used the worktree's then-committed app revision `cee1a263293cf2992b94f0a2c94007997ad0cf67`. The executed qualifier bytes exactly match fix commit `49ad7ef0`; `sourceModuleSha256` and the manifest record that distinction. The changed qualifier/test/docs do not alter the reviewed app blobs. Final merged exact-source CI remains a separate root-owned check.

`postgres16-stderr.log` retains Node's existing typeless TypeScript package warning. No package or app-source change was made to suppress it. Text logs normalize only trailing horizontal whitespace; matching `.raw.gz` files preserve the exact original bytes where changed.

## Qualification limits

`OWNED_POSTGRES_MAJOR` now accepts only 16 (default) or explicitly selected 18, verifies the actual owned binary and binds the target/child verifier to it. The output records `postgresMajor`. Only PostgreSQL 16 ran locally; PostgreSQL 18 remains the root-owned CI check.

Actual Vercel-native request details, managed staging/PG18 same-action execution, provider cancellation and whole-release acceptance remain unqualified. Provider queue/active counts remain unknown. These source tests do not close live P2-11/P2-12 gates, promote a release or authorize production.

`validation.json` contains the code/source bindings, actual counts, raw-log identities and file hashes. Existing November 5 and accepted G1 evidence remain unchanged.
