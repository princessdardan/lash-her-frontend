# Scheduled Jobs Runbook

`vercel.json` is the source of truth for scheduled routes and cadence. All eight jobs are `GET` handlers running on the Node.js runtime. Vercel invokes them with `Authorization: Bearer <CRON_SECRET>`; keep every secret server-only and record only sanitized counts/statuses. The repository does not declare a scheduler timezone, so use the cron expressions below rather than translating them to a local launch time.

## Required Authentication

- Set `CRON_SECRET` in Production. It authenticates Vercel's scheduled request for every route.
- Set `PAYMENT_RECONCILIATION_CRON_SECRET` as well. Its presence enables `/api/admin/payment-reconciliation`; after that route is enabled, either its route-specific bearer or `CRON_SECRET` is accepted. `CRON_SECRET` alone produces `404`.
- Set `RESEND_MARKETING_SYNC_CRON_SECRET` as well. Its presence enables `/api/admin/marketing-contact-sync`; after that route is enabled, either its route-specific bearer or `CRON_SECRET` is accepted. `CRON_SECRET` alone produces `404`.
- `CHITCHATS_WORKER_CRON_SECRET` is an additional accepted bearer for the two shipping cron routes. It does not replace the production `CRON_SECRET` used by Vercel's scheduler.

Missing `CRON_SECRET` returns `404` on retention, backup validation, customer-email outbox, and stock reservation routes. The two shipping routes return `401` when neither accepted secret is configured. Never put a bearer value in a URL, evidence, ticket, or chat.

## Job Matrix

| Route                                   | Schedule                         | Enable/disabled behavior                                                                                                                                                                                                                                                              | Expected outcome and alert condition                                                                                                                                                                                                                                                               |
| --------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/admin/private-data-retention`     | Daily, `17 8 * * *`              | No feature flag. Requires `CRON_SECRET`, `DATABASE_URL`, and the current schema.                                                                                                                                                                                                      | `200` returns `ok`, retention windows, operations, `runAt`, and `totalAffected`. Alert on `503`, auth failures, or an unexplained absence of runs.                                                                                                                                                 |
| `/api/cron/backup-validation`           | Weekly Monday, `0 6 * * 1`       | `BACKUP_VALIDATION_ENABLED` defaults off. Disabled is a `200` no-op with `manualActionRequired: true`. Enabling also requires `BACKUP_GCS_BUCKET_URI`, `BACKUP_RESTORE_DATABASE_URL`, and `BACKUP_RESTORE_EXPECTED_DB_NAME`; the isolated restore target must pass the safety checks. | This is only an external-runner scaffold. Even valid enabled configuration returns `validationPerformed: false`, `manualActionRequired: true`, and `scaffoldStatus: external_restore_runner_required`. Invalid enabled config returns `503`. Never count a `200` as proof that a backup restored.  |
| `/api/admin/payment-reconciliation`     | Every 30 minutes, `*/30 * * * *` | Disabled (`404`) unless `PAYMENT_RECONCILIATION_CRON_SECRET` exists. Always runs operational service reconciliation and booking-email retry. Square commerce capture reconciliation is skipped when `SQUARE_COMMERCE_ENABLED` is not `true`.                                          | Primary monitor success returns `200` with `ok`, `findings`, and `checkedAt`; `ok: false` still uses `200` and requires review. Primary monitor failure returns `503`. Booking-email and commerce-capture subtask failures are logged without changing the HTTP status, so monitor their logs too. |
| `/api/cron/chitchats-shipping`          | Every minute, `* * * * *`        | Accepts `CRON_SECRET` or `CHITCHATS_WORKER_CRON_SECRET`. Square product-refund draining runs when `SQUARE_COMMERCE_ENABLED=true`, even if Chit Chats shipping is off. With `CHITCHATS_SHIPPING_ENABLED` off, shipment polling/operations are skipped.                                 | Disabled shipping normally returns `200 {enabled:false,queued:0,refunds}`. Alert on `503`, `refunds.needsReview > 0`, or any retried, dead-lettered, or fenced shipping operation. Enabled success also reports queued, abandoned, operation, and redaction counts.                                |
| `/api/cron/customer-email-outbox`       | Every 5 minutes, `*/5 * * * *`   | No feature flag. Requires `CRON_SECRET` and the private DB. Actual sends require the relevant Resend configuration.                                                                                                                                                                   | Returns `{claimed,enqueued,failed,sent}`. `failed > 0` produces `503`; otherwise `200`. It backfills missing paid-product confirmation jobs and drains product/shipping customer email from `customer_email_outbox`.                                                                               |
| `/api/cron/product-stock-reservations`  | Every 15 minutes, `*/15 * * * *` | No feature flag. Requires `CRON_SECRET` and the private DB. It runs even when Square commerce is off; when `SQUARE_COMMERCE_ENABLED=true`, Square credentials add provider re-verification before release.                                                                            | Returns `200 {scanned,released,skipped,failed}` even when individual orders failed. Alert whenever `failed > 0`; HTTP status alone is insufficient. The sweep releases old unpaid reservations and cancels the corresponding abandoned orders.                                                     |
| `/api/admin/marketing-contact-sync`     | Every 5 minutes, `*/5 * * * *`   | Disabled (`404`) unless `RESEND_MARKETING_SYNC_CRON_SECRET` exists. Requires the private DB. Missing `RESEND_API_KEY` is a logged `200` no-op that does not claim jobs.                                                                                                               | Returns `200` with `processed`, `succeeded`, `retryableFailed`, `deadLettered`, `failedToClaim`, `skippedUnconfigured`, and `runAt`. Alert on any failure/dead-letter/claim counter or an unexpected all-zero run with queued work. Only an exception escaping the worker produces `503`.          |
| `/api/cron/shipping-rate-cache-refresh` | Weekly Monday, `30 7 * * 1`      | Accepts `CRON_SECRET` or `CHITCHATS_WORKER_CRON_SECRET`. Both `CHITCHATS_SHIPPING_ENABLED=true` and `FLAT_RATE_SHIPPING_ENABLED=true` are required for work; otherwise it returns a `200` no-op. Function budget is 300 seconds.                                                      | Disabled returns `200 {enabled:false,updated:0}`. Enabled returns attempted/updated/skipped/failed cell counts. Any failed cell or top-level failure returns `503`; skipped cells alone remain `200`.                                                                                              |

## Backup Validation Requires An External Runner

`/api/cron/backup-validation` validates configuration safety only. It does not download a backup, restore PostgreSQL, query restored data, measure recovery time, or delete a restore database. `BACKUP_VALIDATION_ENABLED=true` must not be used to claim successful restore testing.

An external, access-controlled runner must:

1. Select the intended backup object and record its sanitized age/identifier.
2. Restore it into the isolated database named by `BACKUP_RESTORE_EXPECTED_DB_NAME`; never use production or staging.
3. Run the approved schema, migration-lineage, row-integrity, and application health checks against the restore.
4. Record sanitized pass/fail evidence and recovery timing.
5. Destroy the isolated restore according to the retention policy.

Until that runner exists, leave the scaffold disabled or treat every response as `manualActionRequired: true`.

## Deployment And Monitoring Checks

Before production cutover:

1. Verify the deployed `vercel.json` contains exactly the eight routes and schedules above.
2. Verify `CRON_SECRET`, both mandatory route-enabling secrets, and each enabled feature's provider/database variables in the Production scope.
3. Confirm `customer_email_outbox` and `marketing_contact_sync_jobs` have no unexplained retryable or dead-letter backlog.
4. Review response bodies, not only HTTP status. Payment reconciliation, stock sweeping, and marketing sync can report actionable failures with `200`.
5. Check logs for route-specific errors that are intentionally isolated from the main response, especially payment-reconciliation email/capture subtasks.
6. Use an authorized manual invocation only when necessary for staging or incident recovery. Send the bearer in the `Authorization` header and keep it out of shell history and evidence.

After changing `vercel.json` or scheduled-job environment variables, redeploy and verify the next recorded invocation. Treat repeated auth failures, missed schedules, `503` responses, nonzero failure counters, dead letters, or `manualActionRequired` as operational incidents requiring review.
