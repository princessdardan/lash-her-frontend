# On-Call Runbook: Lash Her Frontend

Date: 2026-06-06

Use this runbook when responding to production alerts, performing on-call rotations, or setting up monitoring for the Lash Her Next.js application. This covers the four primary alerts, escalation paths, and synthetic testing procedures.

## Scope

This runbook applies to:

- Production environment (`https://lash-her-frontend.vercel.app` or custom domain)
- Staging environment (preview deployments from `main`)
- OpenTelemetry-instrumented API routes and background workers
- PostgreSQL private database, Upstash Redis, and external provider webhooks

## Alert Inventory

| Alert Name                  | Condition                              | Threshold  | Duration    | Severity    | Routing       |
| --------------------------- | -------------------------------------- | ---------- | ----------- | ----------- | ------------- |
| `high-5xx-rate`             | HTTP 5xx response rate                 | > 1%       | > 2 minutes | P1-Critical | PagerDuty     |
| `high-webhook-failure-rate` | Webhook delivery/verification failures | > 5%       | > 5 minutes | P2-High     | Slack #alerts |
| `outbox-queue-depth`        | Outbox table unprocessed row count     | > 100 rows | > 5 minutes | P1-Critical | PagerDuty     |
| `high-api-latency`          | p95 API response latency               | > 1000ms   | > 5 minutes | P2-High     | Slack #alerts |

### Alert Details

#### `high-5xx-rate` → PagerDuty

- **What it means**: More than 1% of HTTP responses are 5xx status codes for a sustained period.
- **Likely causes**: Deployment regression, database connectivity loss, downstream provider outage (Square/Helcim/Resend), unhandled exception in hot path.
- **Impact**: Customers cannot complete bookings, checkout, or form submissions.
- **Response SLA**: Acknowledge within 5 minutes; initial assessment within 15 minutes.

#### `high-webhook-failure-rate` → Slack #alerts

- **What it means**: More than 5% of incoming webhooks (Helcim card transactions, Square service bookings) fail signature verification, parsing, or processing.
- **Likely causes**: Provider configuration drift, signature key rotation, malformed payload, idempotency conflict, downstream consumer failure.
- **Impact**: Payment events may be delayed or lost; provider retries increase.
- **Response SLA**: Acknowledge within 15 minutes; investigate within 30 minutes.

#### `outbox-queue-depth` → PagerDuty

- **What it means**: The `outbox` table has more than 100 unprocessed events.
- **Likely causes**: Background worker stalled, database lock contention, consumer exception loop, deployment causing worker restart.
- **Impact**: Side effects (emails, calendar events, analytics) are delayed. Customer-facing confirmations may not send.
- **Response SLA**: Acknowledge within 5 minutes; initial assessment within 15 minutes.

#### `high-api-latency` → Slack #alerts

- **What it means**: 95th percentile API latency exceeds 1 second.
- **Likely causes**: Database query regression, missing index, N+1 query, external API slowdown, Redis contention.
- **Impact**: Degraded user experience; potential timeout errors on slower connections.
- **Response SLA**: Acknowledge within 30 minutes; investigate within 1 hour.

## Escalation Procedures

### Primary On-Call Engineer

- **Responsibilities**: First responder for all P1 and P2 alerts. Acknowledge, triage, and mitigate. Communicate in `#incidents` Slack channel.
- **Rotation**: Weekly rotation. Hand off at Monday 09:00 UTC with a brief status summary.

### Escalation Path

| Step | Condition                     | Action                                                | Timeout    |
| ---- | ----------------------------- | ----------------------------------------------------- | ---------- |
| 1    | Any P1 alert fires            | Primary on-call receives PagerDuty notification       | —          |
| 2    | P1 alert unacknowledged       | PagerDuty escalates to secondary on-call              | 10 minutes |
| 3    | P1 alert still unacknowledged | PagerDuty escalates to engineering lead               | 10 minutes |
| 4    | P2 alert fires                | Slack #alerts notification; primary on-call monitors  | —          |
| 5    | P2 alert persists or degrades | Primary on-call creates incident thread in #incidents | 30 minutes |
| 6    | Customer impact confirmed     | Post to #incidents with severity, scope, ETA          | Immediate  |
| 7    | Outage > 30 minutes           | Page engineering lead regardless of ack status        | 30 minutes |
| 8    | Outage > 1 hour               | Page CTO/founder; consider public status page update  | 1 hour     |

### Severity Definitions

| Severity    | Criteria                                                                     | Examples                                                      |
| ----------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------- |
| P1-Critical | Complete or severe functional outage; revenue-impacting; data integrity risk | Checkout broken; all webhooks failing; outbox worker dead     |
| P2-High     | Significant degradation; workaround exists; partial feature failure          | Slow API; elevated webhook failures; elevated 5xx rate        |
| P3-Medium   | Minor issue; no customer impact; tech debt or hygiene                        | Elevated 4xx rate; slow build times; non-critical job failure |
| P4-Low      | Observation; no action required unless trend worsens                         | Single 5xx spike; one-off webhook timeout                     |

### Communication Protocol

1. **Acknowledge**: React to the PagerDuty alert or post in #alerts within the SLA.
2. **Assess**: Determine severity, scope (which routes/features affected), and customer impact.
3. **Mitigate**: Apply the fastest fix to restore service (roll back, restart, scale, bypass).
4. **Communicate**: Post updates in #incidents every 15 minutes until resolved.
5. **Resolve**: Mark PagerDuty resolved; post final summary in #incidents.
6. **Retro**: Schedule a post-mortem within 48 hours for any P1 or P2 incident > 15 minutes.

## Runbook Procedures

### Responding to `high-5xx-rate`

1. Check Vercel deployments:
   - Open Vercel dashboard → project → deployments.
   - If a recent deployment correlates with the alert start time, consider rolling back.
2. Check runtime logs:
   - Filter Vercel runtime logs for `statusCode:5xx` in the last 10 minutes.
   - Look for stack traces, database connection errors, or provider timeouts.
3. Check database connectivity:
   - Run health check: `GET /api/health` should return 200.
   - If health check fails, verify `DATABASE_URL` and database provider status.
4. Check provider status pages:
   - Square: https://status.squareup.com
   - Helcim: check provider status page
   - Resend: https://resend-status.com
   - Upstash: check provider status page
5. If deployment rollback is available and safe, roll back to the previous deployment.
6. If no clear cause, page secondary on-call.

### Responding to `high-webhook-failure-rate`

1. Identify which webhook route is failing:
   - Filter logs by `source:webhook` and look for route patterns (`/api/webhooks/*`).
2. Check signature verification:
   - Verify `SQUARE_WEBHOOK_SIGNATURE_KEY` and `HELCIM_WEBHOOK_VERIFIER_TOKEN` are current.
   - Confirm `SQUARE_SERVICE_BOOKING_WEBHOOK_URL` matches the exact URL Square is configured to call.
3. Check for idempotency conflicts:
   - Look for duplicate webhook deliveries with the same idempotency key.
   - Verify `processedEvents` table is not blocking legitimate retries.
4. Check downstream consumers:
   - If webhook returns 200 quickly but side effects fail, check outbox worker logs.
5. If failure rate is due to provider-side retries, contact provider support with delivery IDs.

### Responding to `outbox-queue-depth`

1. Check current queue depth:
   - Query: `SELECT COUNT(*) FROM outbox WHERE status = 'pending';`
2. Check worker logs:
   - Look for the background worker process (outbox consumer) in Vercel function logs or cron logs.
   - Look for errors: database connection, provider timeout, unhandled exception.
3. Check for deadlocks or locks:
   - Query: `SELECT * FROM pg_locks WHERE NOT granted;`
   - Check for long-running transactions.
4. If worker is stalled:
   - Trigger a manual run of the outbox processor if exposed via API.
   - Consider scaling the worker if it is a Vercel cron or background function.
5. If queue depth is due to provider outage (Resend, Google Calendar), queue will clear when provider recovers. Monitor.
6. If depth is due to a code bug, consider a targeted deployment fix.

### Responding to `high-api-latency`

1. Identify slow routes:
   - Use OpenTelemetry traces to find the slowest spans.
   - Filter by route and look for database or external API spans.
2. Check database query performance:
   - Look for missing indexes on hot tables (`orders`, `holds`, `events`, `outbox`).
   - Check for N+1 queries in booking availability or checkout routes.
3. Check external API latency:
   - Square API, Google Calendar API, Helcim API.
   - If external API is slow, consider caching or circuit breaker activation.
4. Check Redis/Upstash latency:
   - Verify `KV_REST_API_URL` is reachable and not rate-limited.
5. If latency is due to a deployment, consider rollback.

## Manual Alert Setup (Honeycomb / Datadog)

> **Note**: The following steps are for manual configuration in your observability backend. They are not performed locally and require admin access to Honeycomb or Datadog, plus PagerDuty and Slack integration.

### Prerequisites

- OpenTelemetry traces are flowing to Honeycomb or Datadog (verify in dashboard).
- Structured JSON logs are available in Vercel runtime logs or log drain.
- PagerDuty integration key created for this service.
- Slack webhook URL or Slack app configured for #alerts channel.

### Honeycomb Setup

1. **Create derived column for 5xx rate**:
   - Name: `http.server.active_requests`
   - Query: `COUNT_DISTINCT(trace.trace_id) WHERE http.status_code >= 500`
   - Compare to total requests to calculate rate.

2. **Create Burn Alert or Trigger for 5xx rate**:
   - Trigger name: `high-5xx-rate`
   - Query: `RATE_MAX(http.status_code >= 500) / RATE_MAX(http.status_code)`
   - Threshold: `> 0.01` (1%)
   - Duration: `2 minutes`
   - Notification: PagerDuty integration

3. **Create Trigger for webhook failure rate**:
   - Trigger name: `high-webhook-failure-rate`
   - Query: Filter spans where `http.route` matches `/api/webhooks/*` and `http.status_code >= 400`
   - Threshold: `> 0.05` (5%)
   - Duration: `5 minutes`
   - Notification: Slack #alerts

4. **Create Trigger for outbox queue depth**:
   - Trigger name: `outbox-queue-depth`
   - Query: This requires a custom metric or log-based query. Send outbox queue depth as a metric from the health check or a cron.
   - Threshold: `> 100`
   - Duration: `5 minutes`
   - Notification: PagerDuty integration

5. **Create Trigger for p95 latency**:
   - Trigger name: `high-api-latency`
   - Query: `P95(duration_ms) WHERE http.route matches /api/*`
   - Threshold: `> 1000`
   - Duration: `5 minutes`
   - Notification: Slack #alerts

### Datadog Setup

1. **Create Metric Monitor for 5xx rate**:
   - Metric: `trace.http.request.errors{service:lash-her-frontend}.as_rate() / trace.http.request.hits{service:lash-her-frontend}.as_rate()`
   - Threshold: `> 0.01`
   - Evaluation window: `2 minutes`
   - Notify: PagerDuty integration

2. **Create Metric Monitor for webhook failure rate**:
   - Metric: `trace.http.request.errors{service:lash-her-frontend,resource_name:/api/webhooks/*}.as_rate() / trace.http.request.hits{service:lash-her-frontend,resource_name:/api/webhooks/*}.as_rate()`
   - Threshold: `> 0.05`
   - Evaluation window: `5 minutes`
   - Notify: Slack #alerts

3. **Create Metric Monitor for outbox queue depth**:
   - Metric: Custom metric `app.outbox.queue_depth` emitted by health check or cron.
   - Threshold: `> 100`
   - Evaluation window: `5 minutes`
   - Notify: PagerDuty integration

4. **Create Metric Monitor for p95 latency**:
   - Metric: `trace.http.request.duration{service:lash-her-frontend}.rollup(p95)`
   - Threshold: `> 1000`
   - Evaluation window: `5 minutes`
   - Notify: Slack #alerts

### PagerDuty Integration

1. In PagerDuty, create a service named `lash-her-frontend`.
2. Add an integration of type `Honeycomb` or `Datadog` (or generic Events API v2).
3. Copy the integration key.
4. In Honeycomb/Datadog, add the PagerDuty integration using this key.
5. Configure escalation policy:
   - Level 1: Primary on-call engineer (10-minute timeout)
   - Level 2: Secondary on-call engineer (10-minute timeout)
   - Level 3: Engineering lead

### Slack Integration

1. Create a Slack app or incoming webhook for #alerts.
2. In Honeycomb/Datadog, add the Slack integration using the webhook URL.
3. Route P2 alerts (webhook failure, latency) to #alerts.
4. Ensure #incidents channel exists for human-driven incident communication.

## Synthetic Failure Testing

> **Warning**: Perform synthetic testing in staging only. Never trigger synthetic failures in production during business hours without explicit approval.

### Test: `high-5xx-rate`

1. Deploy a staging branch that throws an unhandled exception in a hot API route (e.g., `/api/health`).
2. Use `curl` or a load tester to hit that route at ~10 requests/second for 3 minutes.
3. Verify:
   - PagerDuty alert fires within 2 minutes of threshold breach.
   - Alert contains the route name and error rate.
4. Roll back the staging branch immediately after verification.

### Test: `high-webhook-failure-rate`

1. In staging, temporarily corrupt the `SQUARE_WEBHOOK_SIGNATURE_KEY` or `HELCIM_WEBHOOK_VERIFIER_TOKEN`.
2. Send 20+ webhook requests with valid payloads from the provider test console (or using a signed test payload).
3. Verify:
   - Slack #alerts receives a notification within 5 minutes.
   - Alert mentions webhook route and failure rate.
4. Restore the correct signature key/token.

### Test: `outbox-queue-depth`

1. In staging, pause or disable the outbox worker/cron.
2. Generate 150+ outbox events by creating holds, checkouts, or payments.
3. Verify:
   - PagerDuty alert fires within 5 minutes of queue depth exceeding 100.
   - Alert contains the current queue depth.
4. Re-enable the worker and confirm queue drains.

### Test: `high-api-latency`

1. In staging, add an artificial `await sleep(2000)` to a frequently hit API route (e.g., `/api/booking/availability`).
2. Use a load tester to send sustained traffic for 6 minutes.
3. Verify:
   - Slack #alerts receives a notification within 5 minutes.
   - Alert mentions the route and p95 latency value.
4. Remove the artificial delay.

### Verification Checklist

After each synthetic test, confirm:

- [ ] Alert notification was received within 2 minutes of the threshold being breached.
- [ ] Alert payload contains enough context (route, metric value, duration).
- [ ] Escalation policy correctly routes to the expected channel (PagerDuty for P1, Slack for P2).
- [ ] After the synthetic failure is removed, the alert resolves automatically within 5 minutes.
- [ ] No duplicate alerts were sent for the same incident.

## Rollback Procedures

### Vercel Deployment Rollback

1. Open Vercel dashboard → project → deployments.
2. Find the last known good deployment (before the incident start time).
3. Click "Promote to Production" (or set as production deployment).
4. Verify `/api/health` returns 200 and the 5xx rate drops.
5. Monitor for 5 minutes before declaring the rollback successful.

### Database Rollback (Emergency Only)

1. **Do not roll back the database unless data corruption is confirmed.**
2. If required, restore from the latest validated backup (see `docs/runbooks/dr-drill.md`).
3. Coordinate with the engineering lead before any database restore.

## Post-Incident Process

1. Within 24 hours: Write a brief incident summary in #incidents.
2. Within 48 hours: Schedule a blameless post-mortem.
3. Post-mortem document includes:
   - Timeline (alert fired, acknowledged, mitigated, resolved)
   - Root cause (5 Whys)
   - Impact (customers affected, revenue at risk, data affected)
   - Action items (with owners and due dates)
   - Alert tuning recommendations (if false positive or threshold was wrong)
4. Update this runbook if the response procedure was incomplete or incorrect.

## Contacts

| Role              | Contact Method       | Details                             |
| ----------------- | -------------------- | ----------------------------------- |
| Primary on-call   | PagerDuty            | Rotates weekly                      |
| Secondary on-call | PagerDuty            | Escalation target                   |
| Engineering lead  | PagerDuty + Slack DM | `@engineering-lead`                 |
| Founder/CTO       | PagerDuty + phone    | Escalation after 1 hour             |
| Square support    | Web                  | https://developer.squareup.com/help |
| Helcim support    | Web                  | Provider support portal             |
| Resend support    | Web                  | https://resend.com/support          |

## Related Documents

- `docs/runbooks/dr-drill.md` — Disaster recovery and backup validation
- `docs/booking-system-runbook.md` — Booking system operations
- `docs/square-service-booking-setup.md` — Square webhook configuration
- `docs/superpowers/plans/2026-06-05-platform-devops-remediation.md` — DevOps remediation plan
