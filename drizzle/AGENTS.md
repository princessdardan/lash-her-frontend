# DRIZZLE MIGRATIONS

## OVERVIEW

Generated SQL migrations and Drizzle metadata for the private PostgreSQL database.

## STRUCTURE

```text
drizzle/
├── 0000_*.sql          # generated private DB migrations
├── 0001_*.sql
├── 0002_*.sql
└── meta/               # Drizzle snapshots and migration journal
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Schema source | `../src/lib/private-db/schema.ts` | Edit this first, then generate. |
| Migration command | `../package.json` | `npm run db:generate`, `npm run db:migrate`. |
| Runner | `../scripts/migrate-private-db.ts` | Applies SQL to the configured database. |
| Runbook | `../docs/private-database-migration-runbook.md` | Staging/production safety process. |

## CONVENTIONS

- Migration files are generated artifacts tied to `src/lib/private-db/schema.ts`.
- `_journal.json` and snapshot files must stay consistent with generated SQL.
- Treat all migration execution as external-side-effect work.

## ANTI-PATTERNS

- Do not run `npm run db:migrate` without explicit user approval.
- Do not assume `DATABASE_URL` points at staging; verify before migration execution.
- Do not hand-edit snapshots to make diffs look clean.
- Do not remove historical migrations after they have been applied to any shared database.
