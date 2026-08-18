# CLAUDE.md

The full working guide for this repo lives in **[AGENTS.md](AGENTS.md)** — repo layout, commands, Sanity/PostgreSQL boundaries, payment/booking constraints, and design guidance. Read it first.

@AGENTS.md

## Claude Code automation in this repo

- **MCP:** `.mcp.json` adds a `postgres` server (uses `DATABASE_URL` from the environment). Authorize the **Sanity** connector to introspect content schema.
- **Hooks** (`.claude/settings.json`): edits to committed `drizzle/NNNN_*.sql` migrations are blocked (regenerate via `npm run db:generate`); `tsc --noEmit` runs after TypeScript edits and surfaces type errors.
- **Subagents** (`.claude/agents/`): `payment-security-reviewer` for changes under `commerce`/`payments`/`checkout`/`webhooks`/`auth`; `migration-reviewer` for schema/migration changes.
- **Skill** (`.claude/skills/create-migration/`): the project-safe migration workflow — run it with `/create-migration`.
