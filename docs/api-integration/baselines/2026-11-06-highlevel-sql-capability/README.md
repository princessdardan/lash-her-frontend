# HighLevel outbound exclusions and frontend SQL capability

The pre-fix C07 observer incorrectly promoted outbound credential absence into a whole frontend SQL capability closure. With an owned, source-bound catalog containing `AUTH_SECRET` and `DATABASE_URL`, but no HighLevel client/location/encryption keys, it emitted all eight HighLevel closures and no HighLevel frontend SQL residuals. The actual HighLevel component then returned zero active/uncertain effects and complete webhook/workflow fields from an empty fixed SQL snapshot with no provider client. [repro-before.json](repro-before.json) retains that original result and exact source identities.

This is a source-scope classification defect. A whole release-barrier bypass was not demonstrated: the independent physical NOLOGIN, affected-session, ingress, admission-owner and active/uncertain ledger checks remain required. `AUTH_SECRET` also leaves Google residuals in the reported reproduction. Neither current catalog metadata nor these owned fixtures proves an actual historical deployment's configuration or effects.

The corrected observer separates two kinds of evidence:

- `outboundCredentialExclusions` records only the source-bound original configuration requirement for the seven affected HighLevel families. Its fixed scope is `source-outbound-provider-credential-paths-only`. It contains no generic `requirementIds` covering SQL intents, accepted requests or callbacks. The observer retains these facts beside the source context, so existing compact receipt serialization preserves useful outbound evidence without treating it as quiescence.
- Generic `capabilityClosures` no longer close those seven frontend SQL families merely because an outbound key is absent. They remain in `unresolvedFrontendSqlFamilyIds` while the reviewed application `DATABASE_URL` path is configured. Actual later SQL-login/session/admission/effect proofs are separate; this correction introduces no new reducer for them.

The missing-location webhook exclusion remains valid: the exported handler returns 404 before persistence, and `persistHighLevelWebhook` itself resolves location before starting its SQL transaction. When location is present, the built-in provider public-key signature requires no client or encryption secret, and a valid event can insert a receipt before contact lookup or event-specific handling. Outbound switches and credential denial cannot replace this ingress obligation.

The exact reviewed application SQL path can still close when its `DATABASE_URL` name is absent from the bound original catalog. The deployment path and the two existing source-approved default-DB scripts (`highlevel-backfill.ts` and `highlevel-config-check.ts`) retain that positive case. An arbitrary imported helper, injected transaction/client, different invocation environment or unsupported entrypoint does not inherit it. Other supported manual programs are not assigned a new HighLevel SQL exclusion by this correction. All original source-wide SQL credential/provenance checks remain intact.

The scope-policy identity `highlevel-outbound-and-private-sql-separate-v2` is now part of verified requirements for the eight already credential-reviewed HighLevel source profiles. Their `requirementsSha256` values change, so existing strict source-context readback cannot silently reaccept pre-fix closures. Git trees, source inventories, all 33 stored profile files and registered revisions are unchanged. [scope-policy-identities.json](scope-policy-identities.json) records the eight changed and 25 unchanged stored sources. Old receipts remain historical evidence; this is not a receipt rewrite or automatic replay.

The frozen catalog register had classified 24 surfaces as HighLevel credential-path blocked. Every one contains `DATABASE_URL`, and none contains `HIGHLEVEL_LOCATION_ID`. [frozen-catalog-impact.json](frozen-catalog-impact.json) preserves their exact IDs: the outbound exclusion and missing-location webhook fact remain useful, while the other seven frontend SQL families stay unresolved. The original 81-surface register is unchanged. No unknown/unprofiled surface is excluded, and no candidate admission is applied retroactively to historical source.

## Executed checks

The two source/observer suites pass 35 tests, including the real unchanged HighLevel Python component refusing zero from corrected source output. The provider-fence join and PG18-helper suites pass another 27 tests. No provider component, shared join, admission or SQL-role code changed.

The owned PostgreSQL16 fixture applies all 83 frontend migrations and passes 13 named checks. It authenticates a writable source role over TLS/SCRAM, runs the actual source observer with a separate read-only credential connection and actual parent markers, then executes exact Git/profile-verified C07 function bodies. The only DB dependency is bridged to that owned Drizzle/TLS writer. It proves:

- `completeInstallation` commits deletion of a valid old OAuth state before missing-client-ID failure, with all four HighLevel keys absent.
- `enqueueCrmEvent` writes the outbox without HighLevel keys.
- `createInstallation` inserts OAuth state before looking up client ID.
- The actual webhook handler persists a receipt without client/encryption keys. This signature test uses an explicitly owned Ed25519 key through the existing dependency seam; it does not claim possession of the provider key or a live provider delivery.
- The actual HighLevel component cannot return its no-client complete/zero result from the corrected observer facts.

Provider egress is blocked and counted at zero. No supplied database URL, private original record or live provider credential is read. No physical release fence is performed. The final run uses a closed environment with explicit `LANG=C`; PostgreSQL18 and live staging qualification are not claimed. The original source false-positive, initial canonical-path harness refusal and a coarse cluster-setup refusal from an earlier minimal-environment attempt are retained separately. The setup failure's exact cause was not established; the final explicit-environment run passes.

Reproduce the owned database test with Node24 and an actual PostgreSQL16 or18 binary directory:

```sh
env -i PATH=/path/to/node24/bin:/path/to/openssl/bin:/usr/bin:/bin HOME="$HOME" LANG=C \
  FRONTEND_HISTORICAL_SOURCE_OWNED_TEST=true PG_BIN=/absolute/postgresql/bin OWNED_POSTGRES_MAJOR=16 \
  /path/to/node24/bin/node docs/api-integration/baselines/2026-11-06-highlevel-sql-capability/run-owned-pg.mjs
```

The new facts are source-owned observations, not caller-authored completion flags. SQL/callback uncertainty remains explicit until supported actual controls and effects are observed.
