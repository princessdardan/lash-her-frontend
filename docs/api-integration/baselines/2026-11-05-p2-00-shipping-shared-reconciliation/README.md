# Shared shipping reconciliation integration

This record qualifies the shared parent fixture after integrating the complete authenticated shipping cron boundary. Application source remains identical to the shipping component at `d4cc5b668ae56e6b95e5c4d7fe88b4ef2a9fec4c`, with inventory SHA256 `433fe22e936b512b868df4d92e42c3a29a33786c61e115f2202e586a8202ee12`. Only the shared reconciliation harness and these new evidence files change.

The updated assertions account separately for the enclosing recovery entry and the preserved refund and preparation entries. A clean enabled cron completes those three entries; execution reuses its semantic parent. Optional PII maintenance has its own new-work entry. Recovery-only cases explicitly report `redactionSkipped: true` and omit a redacted count. Stage uncertainty cannot become a completed enclosing operation.

Blocked provider and PostgreSQL transactions observe the same active parent through refund, preparation, execution and PII stages. Stage-backend death deliberately preserves the earlier parent session and verifies both ledger outcomes. The three added cases cover a blocked/suppressed execution claim and blocked PII redaction during closure or stage-ledger death. PII persistence is checked field by field after settlement. No provider or PII effect is inferred from a fabricated zero count.

All 72 reconciliation check identities in the original preparation-review PostgreSQL 16 record remain present; the new total is 75. Original PR #91 preparation implementation, unit tests, fault scenarios, evidence files and runtime artifacts remain unchanged. The shared harness adaptation has its own hash in [validation.json](validation.json), with a new [parent PostgreSQL 16 receipt](postgres16.json). The older component's source bindings continue to describe its original harness version.

Reproduce with Node 24:

```sh
FRONTEND_MIGRATION_LOCAL_TEST=true PG_BIN=/opt/homebrew/opt/postgresql@16/bin node --import tsx ops/platform/test-frontend-migration-local.mjs
```

The unchanged parent driver creates and removes its own loopback PostgreSQL 16 TLS/SCRAM cluster. Providers are intercepted; it accepts no configured database URL. Its `sourceCommit` identifies a synthetic partial migration checkout, and its fixed image digest is a synthetic fixture input. Neither identifies a deployed application or release image. The validation record binds the actual application inventory and harness separately.

This is source integration evidence. It does not complete P2-00, authorize release or claim deployed/provider certification. The exact combined candidate still needs its own source and artifact binding, required checks, historical/provider fences and staging evidence.
