# PRIVATE DB

## OVERVIEW

Private PostgreSQL/Drizzle storage for PII, checkout orders, payment events, training enrollments, marketing contacts, form submissions, and consent events.

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Schema | `schema.ts` | Drizzle tables, enums, snapshot payload types, indexes. |
| Client | `client.ts` | Server-only database connection boundary. |
| Migrations | `../../../drizzle` | Generated SQL snapshots and migration journal. |
| Runner | `../../../scripts/migrate-private-db.ts` | Applies migrations; external side effect. |
| Runbook | `../../../docs/private-database-migration-runbook.md` | Human approval and environment verification process. |

## CONVENTIONS

- Private DB is the canonical store for sensitive customer, checkout, payment, training, marketing, contact, and consent records.
- Snapshot JSON fields preserve purchase/program state at the time of checkout.
- Email-normalized uniqueness protects marketing contacts; submission/event tables preserve audit history.
- Schema changes require generated Drizzle migration files and review of `drizzle/meta/_journal.json`.
- Runtime code should import repositories/stores, not reach around them with ad hoc SQL.

## ANTI-PATTERNS

- Do not put private records or payment reconciliation state in public Sanity datasets.
- Do not run migrations without explicit user approval and verified `DATABASE_URL` target.
- Do not edit generated migration snapshots casually; regenerate from intentional schema changes.
- Do not expose this client through browser-importable modules.
