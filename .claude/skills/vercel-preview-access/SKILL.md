---
name: vercel-preview-access
description: Reach an SSO-protected Vercel preview/staging deployment programmatically or in the browser, using the project's Protection Bypass for Automation secret. Use whenever a preview/staging URL (anything other than the public lashher.com production site) returns a Vercel login/SSO page, a 401, or redirect-loops — e.g. "check the staging deploy", "hit the preview API", "why does this preview URL 307 forever".
---

# Access SSO-protected Vercel preview deployments

Preview deployments for `lash-her-frontend` have Vercel Authentication (SSO) enabled
(`ssoProtection.deploymentType: "preview"`); only production (`lashher.com`) is public. A plain
`curl`/`fetch`/browser request to a preview URL gets redirected to a Vercel login page, and a
followed fetch loops on the 307 (`redirect count exceeded`). Use the project's **Protection Bypass
for Automation** secret to get through.

## The secret

`VERCEL_AUTOMATION_BYPASS_SECRET` lives in the gitignored **`.codex/config.toml`** under
`[mcp.servers.vercel.env]`. **Never** read it into chat, a URL you commit, a log, a PR, or a
committed file. The helper below reads it directly and never prints it — prefer the helper over
handling the value yourself. If it is missing, ask the owner; do not guess.

## Programmatic access (preferred) — the helper script

`bypass-fetch.mjs` reads the secret, sends `x-vercel-protection-bypass` on every request (so there
is no redirect loop), captures and reuses the `_vercel_jwt` cookie, and follows redirects manually
and only on the same host (so the secret never leaks to an off-host SSO page).

```bash
# GET a preview page or API route
node .claude/skills/vercel-preview-access/bypass-fetch.mjs "https://<preview-host>/api/health"

# POST JSON
node .claude/skills/vercel-preview-access/bypass-fetch.mjs "https://<preview-host>/api/checkout/quote" \
  --method POST --header "content-type: application/json" --data '{"...":"..."}'
```

Useful flags: `--data-file <path>`, `--header "K: V"` (repeatable), `--dump-headers`,
`--max-body <N>` (default 100000; `0` = no limit). It prints `STATUS`, `content-type`, any
`location`, then the body; exit code is non-zero on 4xx/5xx.

**Reading it right:** `STATUS 200` with real content means the bypass worked. A `STATUS 3xx` with a
`location:` pointing at `vercel.com/sso-api` (or any off-host login) means the bypass did **not**
take — check that the secret is current and that you targeted a deployment on this project.

## Browser access (in-app browser)

Do the cookie handshake once, then navigate normally — the `_vercel_jwt` cookie carries the session.
Build the handshake URL without hardcoding the secret:

```bash
node .claude/skills/vercel-preview-access/bypass-fetch.mjs --print-bypass-query
```

Navigate the browser to `https://<preview-host>/<path>?<that-query-string>`. Vercel sets the
`_vercel_jwt` cookie and subsequent same-origin navigation works. (This does put the secret in that
one URL — fine for the local in-app browser; never paste such a URL into chat, a commit, or a
screenshot.)

## Finding the preview URL

Production is public and needs none of this. For a preview/staging URL, use the Vercel MCP
(`list_deployments` / `get_deployment`) or `vercel ls`, or the URL from a staging push
(`npm run git:push-staging`).

## Known gotcha — staging crons are dormant

Staging is a preview deployment, so **Vercel crons do not run there**. The shipping worker
(`/api/cron/chitchats-shipping`) stays dormant: product shipping quotes POST fine (`202`) but stay
`queued` forever. Triggering the worker needs `CHITCHATS_WORKER_CRON_SECRET` / `CRON_SECRET`, which
is a Sensitive env var (`vercel env pull` returns it empty) — only the owner can supply it. Don't
mistake a stuck-`queued` quote on staging for a bug in the quote path.
