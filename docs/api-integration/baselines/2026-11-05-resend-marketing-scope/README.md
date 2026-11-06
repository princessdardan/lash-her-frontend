# Resend contact and marketing scope qualification

The final runtime is `9374e4362b42048814cff848914e43dc092006bb`, following `9367f821637db7c1137eb3db169e10407514bb33` and `2afd89471814f397ca7c0cee098722883a2f3250`, on isolated frontend base `a85ae6deb4d98976caacfb7e726d32245e2bf97e`. Shared fixed-origin read-only transport source is the owner's `82b06ce2`, locally cherry-picked as `e0391f8a`. Only new scope/test/docs/evidence files were authored here; application source, shared adapter/client code, schemas, packages, and lockfiles were not edited.

Final executed results:

- 29 domain tests passed: 26 owned HTTPS cases using the actual fixed-origin transport and `LockedClient`, and 3 actual PostgreSQL cases using all 83 migrations, TLS hostname verification, and SCRAM authentication.
- The shared transport's 4 owned HTTPS cases passed separately.
- Five owned cases executed the exact historical pure business-environment/broadcast guard. They cover staging Production target, staging Preview target, invalid project/environment binding, local, and production. They do not establish any actual original runtime configuration.
- Python compilation and whitespace validation passed.

The domain cases cover complete second-page contact/segment/topic traversal, strict cursor and state validation, drift, permission/redirect/malformed/oversized failures, denied mutations, safe receipts, unmatched contacts, pending/dead-letter/lost-ack effects, leases, subscription/membership mismatches, broadcast matching/scheduling/orphans, exact source closures, source digest mismatch, missing untracked event requirements, actual message outcomes, original-plan recovery, provider-backed unsubscribe, retained history, and unresolved attempted-send redaction. The no-provider positive path requires every exact source closure plus complete empty actual SQL. Partial closure, source disposition alone, and contradictory SQL cannot select it.

`historical-source-audit.json` records four exact retained commits, their 13 selected path hashes/blob IDs, matching Resend locks, and official SDK archive integrity/module-byte verification. All selected paths match across the four historical commits. The locked SDK has `events.send`; an absent method cannot close that obligation. Original configuration inspection, source-wide credential binding, lifecycle/execution fencing, event/automation history, templates, and the aggregate final provider join remain the shared owners' responsibilities.

No live Resend API, original customer data, actual original runtime configuration, live credential, or mutable provider operation was used. Owned HTTPS endpoints and disposable databases were loopback-only. Test teardown awaited HTTPS threads and PostgreSQL stop; generated CA/key/password material and disposable cluster directories were removed. The public evidence retains no addresses, recipient hashes, message content, credentials, or provider error bodies. The npm SDK archive download was a public package verification, not a Resend provider call.

## Reproduce

From the repository root, with PostgreSQL 16 or 18 binaries at `PG_BIN` (default `/opt/homebrew/opt/postgresql@16/bin`):

```sh
FRONTEND_RESEND_MARKETING_POSTGRES_TEST=true \
  python3 -m unittest discover -s ops/platform/host \
  -p 'frontend_resend_marketing_scope_test.py' -v
python3 -m unittest discover -s ops/platform/host \
  -p 'frontend_scoped_provider_client_test.py' -v
python3 -m py_compile \
  ops/platform/host/frontend_resend_marketing_scope.py \
  ops/platform/host/frontend_resend_marketing_scope_test.py
git diff --check
```

The tests create a new private cluster on an ephemeral loopback port. They accept no existing database URL. Loopback binding must be allowed by the execution sandbox.

## Retained failures

`failed-sandbox-attempt.txt` is the original first test output: 18 socket binding errors caused by sandbox restrictions, with 19 skipped inherited PG cases before the test fixture refactor. The original shell wrapper's trailing output command masked the unittest exit code; the retained unittest failure is authoritative. No test success is inferred from that wrapper.

`failed-history-assertion-attempt.txt` preserves the next actual HTTPS run: 17 passed cases, one failed assertion, and one skipped PG case. The assertion inspected earlier broadcast requests when testing later closure behavior. It was corrected to inspect only the new request interval. No application behavior changed.

The intermediate 21- and 24-pass logs remain historical results. `owned-https-pg-29-pass.txt` and `validation.json` describe the final runtime. The 28-pass log precedes the bounded multi-retry regression. The 27-pass run records the initial source-closure addition before the extra contradictory-campaign regression. Earlier raw logs were not rewritten into successes.

`source-manifest-interface-check.json` uses the source owner's actual Git-verified C07 output with owned empty provider fixtures. It verifies the real interface and retains all 15 selected requirements as missing. Its manifest digests are explicitly provisional and are not release pins or capability closure evidence.
