// Both indexes are already managed by drizzle/0017_big_hulk.sql. A standalone
// DDL command cannot bypass the environment and physical migration locks.
console.error("[private-db] Standalone index creation is retired. Use db:migrate for an isolated local database or the reviewed ops/platform/frontend-migration.mjs release for staging/production.");
process.exitCode = 1;
