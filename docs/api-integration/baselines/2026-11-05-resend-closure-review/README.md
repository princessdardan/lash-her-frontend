# Resend closure false-completion correction

This baseline preserves independently reproduced false-completes and their correction. It qualifies owned source/fixtures only. No live provider call, credential retrieval, original deployed configuration, or staging database was involved. Existing failed and successful evidence under `2026-11-05-resend-marketing-scope` remains unchanged.

## Original findings

The frozen original is commit `fcdada77bf86913ddb408d59747041827c3ad172`, helper SHA256 `eda224f438c99a13e714a89e517693c4cc5f51e550cfd196bcd7567964cab893`, identical to the shared integration owner's helper before this correction.

`frozen-reproduction.json` uses the source owner's original actual Git-verified C07 manifest. `frozen-current-source-reproduction.json` repeats the same defects against the refreshed actual source getter/reducer context used by the positive compatibility check. Both reproduce on the old helper; neither relies on an invented replacement DTO. Deliberately forged closure input reproduces:

1. Omitting source-wide SQL credential requirements still returns whole-helper `complete:true`.
2. Using `absent-from-verified-source` for actually reachable families still returns whole-helper `complete:true`.
3. A partial broadcast closure clears a positive persisted/provider mismatch, reporting zero unresolved family effects and covered IDs.

`frozen-nine-regressions.txt` runs the nine new negative regressions against those exact frozen helper bytes. All nine fail as expected, with no setup/errors; owned HTTPS teardown completes. It covers the three findings plus context replay, duplicate/noncanonical closure evidence, provider-only broadcast omission, pending contact/event effects, and an ignored contradictory original snapshot. These are failures of the original helper, not failures manufactured by the new required fields.

## Correction and passing scope

Runtime fix: `7ce24a0b70081023aba9f2c34e33cb2d32b7b3b2`. Independent read-only re-review confirmed the three reported paths corrected and found no new actionable issue in the two-file runtime/test surface.

The corrected helper requires the exact family requirement union plus **all** source SQL credential requirements, one closure per family, the disposition matching the verified source, canonical evidence, and exact source/surface/configuration/provenance context. Original snapshots are always validated when supplied. Only all five valid closures plus complete empty original/current SQL can take the no-provider path. The normal path always reads contacts and broadcasts and retains each family's relevant SQL/provider contradictions. Untracked events remain unknown without actual source-owned closure; no event-history endpoint is invented.

The corrected domain suite passes 38 tests: 35 owned HTTPS cases using the actual fixed-origin transport/locked checkpoints and 3 actual PostgreSQL TLS/SCRAM cases with all 83 migrations. Recovery cases include unchanged original retry budgets, normal multi-retry completion, provider-backed unsubscribe, retained consent history, and attempted-send redaction remaining unknown. Compilation and whitespace checks pass. `validation.json` binds exact runtime/test/receipt hashes.

`actual-source-checks.json` additionally passes 17 whole-helper checks with **actual source functions**: `verifiedSourceRequirements`, `prepareHistoricalSourceOriginalConfiguration`, `observeHistoricalSourceSqlCredentials`, and `deriveHistoricalSourceCapabilityClosures`. The original configuration is an explicitly synthetic, complete empty key catalog. There are zero configured SQL peers, zero SQL/provider calls, and no inference about a real original environment. The actual collector proves all four source SQL keys absent from this owned catalog; the actual reducer emits matching surface-bound closures. The complete helper then positively settles without a client and covers 15 family plus 4 global requirements. Tampering each global ID, disposition, context, duplicate/evidence, or a partial broadcast contradiction refuses or stays unknown. Separate actual PostgreSQL tests establish SQL projection/recovery behavior; the source no-key case does not claim configured-peer or live credential qualification.

The large source context stays outside Git. Only its hash, exact source/module identities and sanitized results are retained. Source-profile identities in these checks identify the tested source getter output and are not candidate release pins.

## Reproduce

Use a clean selected source with the source owner's historical module/profiles available. `SOURCE_MODULE` is the actual source-owned `ops/platform/frontend-historical-source.mjs`, `REPOSITORY` its Git repository root, and `OWNED_CONTEXT` a new temporary output path. The generator imports that fixed selected module and checks its bytes unchanged; it constructs no provider client and has no credential/network operation.

```sh
node docs/api-integration/baselines/2026-11-05-resend-closure-review/create-owned-source-context.mjs SOURCE_MODULE REPOSITORY OWNED_CONTEXT
python3 docs/api-integration/baselines/2026-11-05-resend-closure-review/verify-source-context.py OWNED_CONTEXT
FRONTEND_RESEND_MARKETING_POSTGRES_TEST=true \
  python3 -m unittest discover -s ops/platform/host \
  -p 'frontend_resend_marketing_scope_test.py' -v
python3 -m py_compile ops/platform/host/frontend_resend_marketing_scope.py \
  ops/platform/host/frontend_resend_marketing_scope_test.py
git diff --check
```

For the original reproduction, export the exact old helper to a new temporary file and supply the retained actual verified C07 manifest:

```sh
git show fcdada77:ops/platform/host/frontend_resend_marketing_scope.py > FROZEN_HELPER
python3 docs/api-integration/baselines/2026-11-05-resend-closure-review/reproduce-pre-fix.py FROZEN_HELPER VERIFIED_C07_MANIFEST
```

All test database/HTTPS endpoints are owned loopback fixtures. The disposable PostgreSQL cluster is stopped and removed and server threads are joined. No plaintext address, credential, JWT, recipient hash or provider body appears in retained common results.
