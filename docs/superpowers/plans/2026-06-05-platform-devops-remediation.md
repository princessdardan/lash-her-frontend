# DevOps Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish automated CI/CD pipelines, structured observability, continuous disaster recovery validation, and repository hygiene.

**Architecture:** The plan builds a GitHub Actions-based CI/CD pipeline with staging preview deployments and branch protection, then layers in OpenTelemetry tracing, structured JSON logging, automated backup validation crons, and quarterly chaos drills. Repository hygiene is enforced through pre-commit hooks and BFG history cleanup.

**Tech Stack:** GitHub Actions, Vercel, OpenTelemetry, PostgreSQL, Husky, BFG Repo-Cleaner, Honeycomb/Datadog.

---

**Source:** docs/platform-comprehensive-after-action-review.md  
**Master Spec:** docs/superpowers/specs/2026-06-05-platform-remediation-master-design.md

## Implementation Metadata

| Field                                      | Value                                                                                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Category**                               | DevOps                                                                                                                                           |
| **Source AAR Issues**                      | 5.1–5.4                                                                                                                                          |
| **Estimated Duration**                     | 4 weeks (Phase 0 + Phase 1 + Phase 4)                                                                                                            |
| **Required Sub-Skill for Agentic Workers** | GitHub Actions workflow authoring, Vercel deployment automation, OpenTelemetry instrumentation, PostgreSQL administration, Git history rewriting |

---

## Files to Create

| File                                          | Purpose                                                       |
| --------------------------------------------- | ------------------------------------------------------------- |
| `.github/workflows/ci.yml`                    | Main CI workflow (lint, unit, audit, build, e2e)              |
| `.github/workflows/deploy-staging.yml`        | Staging deployment on merge to main                           |
| `.github/workflows/deploy-production.yml`     | Production deployment on tag                                  |
| `.github/workflows/backup-validation.yml`     | Weekly backup restore validation                              |
| `src/lib/logging/logger.ts`                   | Structured JSON logger                                        |
| `src/lib/telemetry/instrumentation.ts`        | OpenTelemetry SDK initialization                              |
| `src/app/api/health/route.ts`                 | Health check endpoint for deploy verification                 |
| `src/app/api/cron/backup-validation/route.ts` | Backup restore validation cron                                |
| `scripts/chaos-drill.sh`                      | Quarterly chaos engineering drill                             |
| `.husky/pre-commit`                           | Pre-commit hook for lint and large file blocking              |
| `.husky/commit-msg`                           | Commit message linting (alternative: enforce via CI only)     |
| `docs/runbooks/dr-drill.md`                   | DR drill runbook                                              |
| `docs/runbooks/on-call.md`                    | On-call escalation procedures                                 |
| `playwright.preview.config.ts`                | Playwright config for preview E2E with `webServer: undefined` |

## Files to Modify

| File                                              | Change                                               |
| ------------------------------------------------- | ---------------------------------------------------- |
| `package.json`                                    | Add `lint-staged` config; add telemetry dependencies |
| `src/app/api/webhooks/card-transactions/route.ts` | Replace `console.*` with structured logger           |
| `src/app/api/checkout/route.ts`                   | Replace `console.*` with structured logger           |
| `src/app/api/booking/holds/route.ts`              | Replace `console.*` with structured logger           |
| `src/app/api/revalidate/route.ts`                 | Replace `console.*` with structured logger           |
| `vercel.json`                                     | Add cron schedules for backup validation             |
| `.gitignore`                                      | Ensure tarballs and `.playwright-mcp/` are ignored   |

---

## Ordered Tasks

### Phase 0: Foundation (Week 1)

#### Task 0.1: Remove artifacts from git index

- [ ] Run:
  ```bash
  git rm --cached production-pre-cutover-backup.tar.gz staging-approved-cutover.tar.gz
  git rm -r --cached .playwright-mcp/
  git commit -m "chore: remove build artifacts and logs from index"
  ```
- [ ] Verify: `git ls-files | grep -E '\.(tar\.gz|tgz)$'` returns empty
- [ ] Verify: `git ls-files | grep '.playwright-mcp'` returns empty

#### Task 0.2: Set up pre-commit hooks

- [ ] Install `husky` and `lint-staged`:
  ```bash
  npm install -D husky lint-staged
  npx husky init
  ```
- [ ] Add to `package.json`:
  ```json
  {
    "lint-staged": {
      "*.{ts,tsx}": ["eslint --fix", "prettier --write"],
      "*.{js,jsx}": ["eslint --fix", "prettier --write"],
      "*.{json,md}": ["prettier --write"]
    }
  }
  ```
- [ ] Create `.husky/pre-commit`:

  ```bash
  #!/bin/sh
  . "$(dirname "$0")/_/husky.sh"
  npx lint-staged

  # Block files larger than 1MB
  LARGE_FILES=$(git diff --cached --name-only --diff-filter=ACM | while read file; do
    if [ -f "$file" ] && [ "$(stat -f%z "$file" 2>/dev/null || stat -c%s "$file" 2>/dev/null)" -gt 1048576 ]; then
      echo "$file"
    fi
  done)

  if [ -n "$LARGE_FILES" ]; then
    echo "Error: Files larger than 1MB detected:"
    echo "$LARGE_FILES"
    exit 1
  fi
  ```

- [ ] Make hook executable: `chmod +x .husky/pre-commit`
- [ ] Verify: commit a test file triggers lint-staged

#### Task 0.3: Create basic CI workflow

- [ ] Create `.github/workflows/ci.yml`:
  ```yaml
  name: CI
  on:
    push:
      branches: [main]
    pull_request:
      branches: [main]
  jobs:
    lint-and-unit:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-node@v4
          with:
            node-version: 20
            cache: npm
        - run: npm ci
        - run: npm run lint
        - run: npm run test:unit
    audit:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-node@v4
          with:
            node-version: 20
            cache: npm
        - run: npm ci
        - run: npm audit --audit-level=moderate
    build:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-node@v4
          with:
            node-version: 20
            cache: npm
        - run: npm ci
        - run: npm run build
          env:
            NEXT_PUBLIC_SANITY_PROJECT_ID: 3auncj84
            NEXT_PUBLIC_SANITY_DATASET: staging-2026-05-10
            NEXT_PUBLIC_SANITY_API_VERSION: 2026-03-24
            SANITY_API_READ_TOKEN: ${{ secrets.SANITY_API_READ_TOKEN }}
  ```
- [ ] Store `SANITY_API_READ_TOKEN` in GitHub repository secrets before enabling the build job
- [ ] Keep `SANITY_SCHEMA_DEPLOY_TARGET` unset in CI build jobs; schema deploy jobs set it explicitly only for approved production deploys
- [ ] Verify: workflow runs on PR with all jobs passing

---

### Phase 1: Preview Environments + Required Checks (Week 2)

#### Task 1.1: Add PR preview deployment

- [ ] Modify `.github/workflows/ci.yml` to add a `deploy-preview` job that runs on `pull_request` and exposes a `preview_url` output for downstream E2E tests:
  ```yaml
  deploy-preview:
    runs-on: ubuntu-latest
    outputs:
      preview_url: ${{ steps.vercel.outputs.preview-url }}
    steps:
      - uses: actions/checkout@v4
      - id: vercel
        uses: amondnet/vercel-action@v25
        with:
          vercel-token: ${{ secrets.VERCEL_TOKEN }}
          vercel-org-id: ${{ secrets.VERCEL_ORG_ID }}
          vercel-project-id: ${{ secrets.VERCEL_PROJECT_ID }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          github-comment: true
  ```
- [ ] Add Vercel secrets to GitHub repository settings
- [ ] Verify: each PR gets a preview URL comment and the `deploy-preview` job exposes a non-empty `preview_url` output

#### Task 1.2: Add E2E job against preview URL

- [ ] Create `playwright.preview.config.ts`:

  ```typescript
  import baseConfig from "./playwright.config";
  import { defineConfig } from "@playwright/test";

  export default defineConfig({
    ...baseConfig,
    use: {
      ...baseConfig.use,
      baseURL: process.env.BASE_URL,
    },
    webServer: undefined,
  });
  ```

- [ ] Modify `.github/workflows/ci.yml`:
  - Add `e2e` job that:
    - Depends on `deploy-preview`
    - Waits for the preview URL to return HTTP 200
    - Runs Playwright against preview URL with `playwright.preview.config.ts` so the local dev server is not started
  ```yaml
  e2e:
    runs-on: ubuntu-latest
    needs: [deploy-preview]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - name: Wait for preview
        run: |
          for i in {1..30}; do
            if curl -fsS "${BASE_URL}" >/dev/null; then
              exit 0
            fi
            sleep 10
          done
          exit 1
        env:
          BASE_URL: ${{ needs.deploy-preview.outputs.preview_url }}
      - run: npx playwright test --config=playwright.preview.config.ts --project=chromium
        env:
          BASE_URL: ${{ needs.deploy-preview.outputs.preview_url }}
  ```
- [ ] Keep local `playwright.config.ts` unchanged so local `npm test` still starts `npm run dev` on `http://localhost:3000`
- [ ] Verify: E2E tests run against preview URL and pass

#### Task 1.3: Add staging deployment on main

- [ ] Create `.github/workflows/deploy-staging.yml` for `push` to `main` after required checks pass:
  ```yaml
  name: Deploy Staging
  on:
    push:
      branches: [main]
  jobs:
    deploy-staging:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: amondnet/vercel-action@v25
          with:
            vercel-token: ${{ secrets.VERCEL_TOKEN }}
            vercel-org-id: ${{ secrets.VERCEL_ORG_ID }}
            vercel-project-id: ${{ secrets.VERCEL_PROJECT_ID }}
            github-token: ${{ secrets.GITHUB_TOKEN }}
            vercel-args: "--target=preview"
  ```
- [ ] Verify: merge to `main` triggers staging deploy independently of PR preview E2E

#### Task 1.4: Configure branch protection

- [ ] In GitHub repository settings → Branches → `main`:
  - Enable "Require a pull request before merging"
  - Enable "Require status checks to pass before merging"
  - Add required checks: `lint-and-unit`, `audit`, `build`, `e2e`
  - Enable "Require branches to be up to date before merging"
- [ ] Verify: PR cannot merge until all checks pass

---

### Phase 4: Observability + DR + Hygiene (Weeks 8–9)

#### Task 4.1: Implement structured logging

- [ ] Create `src/lib/logging/logger.ts`:
  ```typescript
  export function log(
    level: "info" | "warn" | "error" | "debug",
    message: string,
    meta?: Record<string, unknown>,
  ): void {
    console.log(
      JSON.stringify({
        level,
        message,
        timestamp: new Date().toISOString(),
        service: "lash-her-frontend",
        environment: process.env.NODE_ENV,
        requestId: meta?.requestId,
        ...meta,
      }),
    );
  }
  ```
- [ ] Replace `console.*` in all API routes with `log()`
- [ ] Verify: logs are parseable JSON

#### Task 4.2: Add OpenTelemetry instrumentation

- [ ] Install dependencies:
  ```bash
  npm install @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-http @opentelemetry/auto-instrumentations-node
  ```
- [ ] Create `src/lib/telemetry/instrumentation.ts`:

  ```typescript
  import { NodeSDK } from "@opentelemetry/sdk-node";
  import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
  import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";

  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter({
      url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    }),
    instrumentations: [getNodeAutoInstrumentations()],
  });

  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    sdk.start();
  }
  ```

- [ ] Import instrumentation at app startup (e.g., in `src/app/layout.tsx` or `next.config.ts`)
- [ ] Add `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_SERVICE_NAME` to Vercel env vars
- [ ] Verify: traces appear in Honeycomb/Datadog dashboard

#### Task 4.3: Set up alerting

- [ ] In Honeycomb/Datadog, create alert rules:
  - 5xx rate > 1% for > 2 minutes → PagerDuty
  - Webhook failure rate > 5% for > 5 minutes → Slack
  - Outbox queue depth > 100 for > 5 minutes → PagerDuty
  - p95 API latency > 1000ms for > 5 minutes → Slack
- [ ] Create `docs/runbooks/on-call.md` with escalation procedures
- [ ] Test alerts with synthetic failures
- [ ] Verify: alert notifications received within 2 minutes

#### Task 4.4: Implement backup validation cron

- [ ] Create a private GCS bucket named `lash-her-db-backups` in the same region as the database
- [ ] Configure provider-managed Postgres backup export to write to `lash-her-db-backups` on a daily schedule
- [ ] Create `src/app/api/cron/backup-validation/route.ts`:
  - Validate `CRON_SECRET`
  - Download latest backup from `gs://lash-her-db-backups/` using `gcloud storage cp` or signed URL
  - Restore to staging DB: `pg_restore --clean --dbname="$STAGING_DATABASE_URL" "$LATEST_BACKUP_PATH"`
  - Run health check: `SELECT COUNT(*) FROM orders;`
  - Log result with structured logger
- [ ] Add cron to `vercel.json`: `"schedule": "0 6 * * 1"` (Mondays 6 AM)
- [ ] Verify: cron runs weekly; health check passes

> **Alternatives**: AWS S3 (`s3://lash-her-db-backups/`) or a provider-managed backup URL can be used instead of GCS. Update the download step and environment credentials accordingly.

#### Task 4.5: Create chaos drill script

- [ ] Create `scripts/chaos-drill.sh`:

  ```bash
  #!/bin/bash
  set -euo pipefail

  # Require staging environment variables
  : "${STAGING_DATABASE_URL:?STAGING_DATABASE_URL must be set}"
  : "${RESTORE_DATABASE_URL:?RESTORE_DATABASE_URL must be set}"
  : "${LATEST_BACKUP_PATH:?LATEST_BACKUP_PATH must be set}"

  # Refuse production URLs
  if [[ "$STAGING_DATABASE_URL" == *"production"* ]] || [[ "$RESTORE_DATABASE_URL" == *"production"* ]]; then
    echo "Error: Production URLs are not allowed in chaos drills. Use staging only."
    exit 1
  fi

  START_TIME=$(date +%s)

  # Step 1: Restore latest backup to isolated restore database
  echo "Restoring latest backup to restore database..."
  pg_restore --clean --if-exists --dbname="$RESTORE_DATABASE_URL" "$LATEST_BACKUP_PATH"

  # Step 2: Run health checks
  echo "Running health checks..."
  ORDER_COUNT=$(psql "$RESTORE_DATABASE_URL" -t -c "SELECT COUNT(*) FROM orders;")
  echo "Orders table row count: $ORDER_COUNT"

  if [[ -z "$ORDER_COUNT" ]] || [[ "$ORDER_COUNT" -lt 0 ]]; then
    echo "Error: Health check failed — could not read orders table."
    exit 1
  fi

  # Step 3: Verify staging DB is still reachable (no cross-environment impact)
  pg_isready -d "$STAGING_DATABASE_URL" >/dev/null || {
    echo "Error: Staging database is unreachable after restore."
    exit 1
  }

  END_TIME=$(date +%s)
  RTO=$((END_TIME - START_TIME))
  echo "RTO: ${RTO}s"
  echo "Chaos drill completed successfully."
  ```

- [ ] Create `docs/runbooks/dr-drill.md` with step-by-step instructions
- [ ] Schedule first drill 1 month after backup validation is stable
- [ ] Verify: drill completes and RTO is measured

#### Task 4.6: Run BFG Repo-Cleaner

- [ ] **Approval gate**: stop here until the repository owner explicitly approves history rewriting in writing, confirms all open PRs are closed or coordinated, and schedules a team re-clone window
- [ ] Verify canonical remote before any destructive command:
  ```bash
  git remote -v
  ```
  Expected: `origin` points to `https://github.com/princessdardan/lash-her-frontend.git`
- [ ] Backup repository: `git clone --mirror https://github.com/princessdardan/lash-her-frontend.git backup.git`
- [ ] Download BFG:
  ```bash
  wget https://repo1.maven.org/maven2/com/madgag/bfg/1.14.0/bfg-1.14.0.jar
  ```
- [ ] Run BFG:
  ```bash
  java -jar bfg-1.14.0.jar --strip-blobs-bigger-than 1M .
  git reflog expire --expire=now --all
  git gc --prune=now --aggressive
  ```
- [ ] Verify history: `git rev-list --objects --all | git cat-file --batch-check='%(objecttype) %(objectname) %(objectsize) %(rest)' | awk '$1 == "blob" && $3 > 1048576'` returns empty
- [ ] Re-check canonical remote immediately before pushing:
  ```bash
  git remote -v
  git status --short
  ```
- [ ] Push rewritten history only after the approval gate is satisfied, using lease protection:
  ```bash
  git push --force-with-lease --all origin
  git push --force-with-lease --tags origin
  ```
- [ ] Notify team to re-clone and invalidate any stale local clones; do not let teammates continue work from pre-BFG history

---

## Verification Commands

```bash
# Build
npm run build

# Lint
npm run lint

# Unit tests
npm run test:unit

# E2E tests
npm test

# Secret scan
detect-secrets scan --all-files

# Large file check
git rev-list --objects --all | git cat-file --batch-check='%(objecttype) %(objectname) %(objectsize) %(rest)' | awk '$1 == "blob" && $3 > 1048576 {print $4}'

# Health check
curl http://localhost:3000/api/health

# Backup restore (manual)
pg_restore --clean --dbname="$STAGING_DATABASE_URL" "$LATEST_BACKUP_PATH"
psql "$STAGING_DATABASE_URL" -c "SELECT COUNT(*) FROM orders;"
```

---

## Rollout Gates

| Gate | Criteria                                                | Owner  |
| ---- | ------------------------------------------------------- | ------ |
| G1   | Artifacts removed from index; `git status` clean        | DevOps |
| G2   | Pre-commit hooks run on every commit                    | DevOps |
| G3   | CI passes on PR with lint, unit, audit, build           | DevOps |
| G4   | Preview URL generated on PR; E2E passes against preview | DevOps |
| G5   | Branch protection requires all checks                   | DevOps |
| G6   | Structured logs visible in Vercel dashboard             | DevOps |
| G7   | OTel traces visible in Honeycomb/Datadog                | DevOps |
| G8   | Alerts trigger within 2 minutes of synthetic failure    | DevOps |
| G9   | Weekly backup restore passes                            | DevOps |
| G10  | BFG run completed; history clean                        | DevOps |

---

## Notes and Cautions

1. **Vercel Secrets**: Store `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` in GitHub repository secrets, not in workflow files.
2. **OTel in Serverless**: OpenTelemetry SDK initialization in serverless functions requires care. Use `NodeSDK` and ensure it starts before any instrumented code runs. Consider Vercel's OTel integration if available.
3. **Backup Storage**: The backup validation cron needs access to backup files. Store backup download URL or credentials in Vercel env vars.
4. **BFG Coordination**: BFG rewrites history for all branches. Notify team 1 week in advance. Provide rebase instructions for open branches.
5. **Alert Fatigue**: Start with high-threshold alerts (e.g., 5xx > 5%) and lower them over time as false positive rate is understood.
6. **Chaos Drill Isolation**: Run chaos drills against staging or a dedicated DR test environment, never production.
7. **Preview E2E Config**: Always use `playwright.preview.config.ts` with `webServer: undefined` for preview URL tests. Do not start a local dev server in CI when running against a deployed preview.
