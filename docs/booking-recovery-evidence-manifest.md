# Booking operations recovery evidence manifest

Recorded: 2026-07-15

## Git provenance

- Base branch: `staging`
- Base commit: `0818297805d6d95a669b3f78c7859d5464d5e1cf`
- Empty historical feature branch: `codex/booking-operations-dashboard`
- Recovery branch: `codex/booking-operations-dashboard-recovery`
- Forensic source: `/private/tmp/lash-her-booking-stage0018.X863uT`
- Durable evidence copy: `/Users/dardan/workspace/lash-her-booking-recovery-evidence-20260715`

The durable copy excludes `.git`, `.next`, `node_modules`, local environment files,
credentials, and `.recovery-report.json`. The application transfer was compared to
the forensic source with an `rsync --dry-run --delete` comparison using the same
exclusions; no differences were reported after transfer.

## Migration SHA-256 checksums

| Migration | SHA-256 |
| --- | --- |
| `drizzle/0018_grey_xorn.sql` | `ed1d83d9a57a5947b713a00270ed7cedf5029d6052395a7b247299e7642587b0` |
| `drizzle/0019_rainy_lorna_dane.sql` | `fe2f4d5f38421d02ed8e0b71309ef378ae1bd3b51662102c49b95fb92ee7399d` |
| `drizzle/0020_eager_stark_industries.sql` | `5c251835bc8e7f7652178cdf24c0ba1d9b3ab1a2e930eb5dcab1a3c30e44c984` |
| `drizzle/0021_grey_professor_monster.sql` | `5b06e89f076095658a43f7f9c36b66f0e96eddb3d7e5a6e425d2ab70460c9270` |
| `drizzle/0022_cold_mikhail_rasputin.sql` | `7e50ee7e7b61214b8d9514f24e5776e6e43031591c3c4e4f34e645b3c590a62f` |

Migrations `0018` through `0021` are recovered evidence and must retain their
filenames, contents, journal order, and timestamps. Migration `0022` is the
forward-only capture-lease remediation generated on the recovery branch.

## Session provenance

The evidence directory contains 25 matching session JSONL files from 2026-07-10,
2026-07-14, and 2026-07-15. They were selected because they reference the original
booking worktree or the reconstructed migration chain. The primary implementation
session is:

`rollout-2026-07-10T16-35-33-019f4dbe-2158-7ad2-8964-5be708eb0e06.jsonl`

## Database deployment status

All 23 journal entries, through `0022`, were applied successfully to two new
disposable local PostgreSQL databases on 2026-07-15. The second independent
verification database reported 23 journal rows and both capture-lease columns.

Application of migrations `0018` through `0021` to any shared, staging, or
production-like database is not established by repository-local evidence. Treat
that status as unknown until the database owner identifies each relevant target
and its `__drizzle_migrations` state is inspected. Do not run these migrations
against a shared target based only on this manifest.
