# Square Sandbox/Staging Certification & Production Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the card-on-file and no-show charge lifecycle with real Square sandbox/staging behavior before enabling production flags.

**Architecture:** Add repeatable smoke-test documentation and lightweight verification scripts around the already-hardened implementation. This plan does not change payment semantics; it creates the evidence gate for production enablement.

**Tech Stack:** Next.js 16, Playwright, Square sandbox dashboard/API, Vercel logs/cron, private PostgreSQL staging DB, existing docs/runbooks.

---

## Plan Set Position

This is **Plan 5 of 5** and depends on completion of Plans 1–4.

Production gate after this plan: production card-on-file can be enabled only if every smoke result is captured and approved.

---

## Files

- Modify: `docs/square-service-booking-setup.md`
- Modify: `docs/booking-system-runbook.md`
- Modify: `docs/launch-readiness-checklist.md`
- Create: `docs/superpowers/reports/square-card-on-file-sandbox-certification.md`
- Create or modify: `tests/booking-card-on-file-config.spec.ts`
- Create: `scripts/check-square-card-on-file-env.mjs`

---

## Task 1: Add a preflight environment check script

**Files:**

- Create: `scripts/check-square-card-on-file-env.mjs`
- Modify: `package.json`

- [ ] **Step 1: Create script**

Create `scripts/check-square-card-on-file-env.mjs`:

```js
const required = [
  "SERVICE_BOOKING_SQUARE_ENABLED",
  "SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED",
  "SQUARE_ENVIRONMENT",
  "SQUARE_APPLICATION_ID",
  "SQUARE_ACCESS_TOKEN",
  "SQUARE_LOCATION_ID",
  "SQUARE_WEBHOOK_SIGNATURE_KEY",
  "SQUARE_SERVICE_BOOKING_WEBHOOK_URL",
  "SQUARE_SERVICE_BOOKING_RETURN_URL",
  "BOOKING_ADMIN_PAYMENT_ACTION_SECRET",
  "PAYMENT_RECONCILIATION_CRON_SECRET",
  "DATABASE_URL",
];

const missing = required.filter((name) => {
  const value = process.env[name];
  return typeof value !== "string" || value.trim().length === 0;
});

if (missing.length > 0) {
  console.error(
    `[square-card-on-file-env] Missing required variables: ${missing.join(", ")}`,
  );
  process.exit(1);
}

const trueFlags = [
  "SERVICE_BOOKING_SQUARE_ENABLED",
  "SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED",
];

for (const name of trueFlags) {
  if (process.env[name] !== "true") {
    console.error(`[square-card-on-file-env] ${name} must be exactly "true"`);
    process.exit(1);
  }
}

if (
  process.env.SQUARE_ENVIRONMENT !== "sandbox" &&
  process.env.SQUARE_ENVIRONMENT !== "production"
) {
  console.error(
    "[square-card-on-file-env] SQUARE_ENVIRONMENT must be sandbox or production",
  );
  process.exit(1);
}

if (
  process.env.VERCEL_ENV === "production" &&
  process.env.PAYMENT_GATEWAY_MODE === "mock"
) {
  console.error(
    "[square-card-on-file-env] PAYMENT_GATEWAY_MODE=mock is not allowed in production",
  );
  process.exit(1);
}

if (
  process.env.VERCEL_ENV === "production" &&
  process.env.SQUARE_ENVIRONMENT !== "production"
) {
  console.error(
    "[square-card-on-file-env] Production Vercel environment must use Square production credentials",
  );
  process.exit(1);
}

if (
  process.env.VERCEL_ENV !== undefined &&
  process.env.VERCEL_ENV !== "production" &&
  process.env.SQUARE_ENVIRONMENT === "production"
) {
  console.error(
    "[square-card-on-file-env] Preview/staging Vercel environments must use Square sandbox credentials",
  );
  process.exit(1);
}

function validateUrl(name) {
  const value = process.env[name];
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    console.error(`[square-card-on-file-env] ${name} must be a valid URL`);
    process.exit(1);
  }

  if (parsed.protocol !== "https:") {
    console.error(`[square-card-on-file-env] ${name} must use https`);
    process.exit(1);
  }
}

validateUrl("SQUARE_SERVICE_BOOKING_WEBHOOK_URL");
validateUrl("SQUARE_SERVICE_BOOKING_RETURN_URL");

console.log(
  "[square-card-on-file-env] Required environment variables are present",
);
```

- [ ] **Step 2: Add npm script**

In `package.json`, add:

```json
"check:square-card-on-file-env": "node scripts/check-square-card-on-file-env.mjs"
```

- [ ] **Step 3: Run script locally with missing env**

Run:

```bash
npm run check:square-card-on-file-env
```

Expected locally without full Square env: exits non-zero and lists variable names only, not values.

---

## Task 2: Add browser-level config/fallback smoke test

**Files:**

- Create: `tests/booking-card-on-file-config.spec.ts`

- [ ] **Step 1: Add Playwright spec**

Create `tests/booking-card-on-file-config.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

test("booking page falls back to legacy checkout when card-on-file config is unavailable", async ({
  page,
}) => {
  await page.route("**/api/booking/square/config", async (route) => {
    await route.fulfill({ status: 404, json: { error: "disabled" } });
  });

  await page.goto("/booking");

  await expect(page.getByText(/Select Service/i)).toBeVisible();
});

test("public Square config endpoint never exposes secrets", async ({
  request,
}) => {
  const response = await request.get("/api/booking/square/config");
  if (response.status() === 404) {
    expect(response.status()).toBe(404);
    return;
  }

  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  expect(JSON.stringify(body)).not.toMatch(
    /accessToken|webhookSignatureKey|BOOKING_ADMIN/i,
  );
});
```

- [ ] **Step 2: Run focused spec**

Run:

```bash
npx playwright test tests/booking-card-on-file-config.spec.ts --project=chromium
```

Expected: PASS.

---

## Task 3: Write sandbox certification report template

**Files:**

- Create: `docs/superpowers/reports/square-card-on-file-sandbox-certification.md`

- [ ] **Step 1: Create report file**

Create `docs/superpowers/reports/square-card-on-file-sandbox-certification.md`:

```md
# Square Card-on-File Sandbox Certification

Date: 2026-06-20
Environment: staging with Square sandbox credentials
Reviewer: Dardan / operator-approved agent

## Required automated evidence

- `npm run lint`: not run yet for this certification
- `npm run test:unit`: not run yet for this certification
- `npm run build`: not run yet for this certification
- `npx playwright test tests/booking.spec.ts --project=chromium`: not run yet for this certification
- `npx playwright test tests/booking-card-on-file-config.spec.ts --project=chromium`: not run yet for this certification
- `TEST_DATABASE_URL=... npx tsx --test src/lib/private-db/card-on-file-repository.db.test.ts src/lib/booking/payments/service-reconciliation-monitor.test.ts`: not run yet for this certification

## Required Square sandbox scenarios

| Scenario                            | Expected result                                                                                                                                                                                                                                               | Evidence |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Web Payments SDK STORE tokenization | Square card iframe loads, tokenization returns a token, booking POST receives source token and optional verification token                                                                                                                                    | pending  |
| Cards API save                      | Square card-on-file is created for the sandbox customer; app stores only Square card ID, brand, last4, expiry                                                                                                                                                 | pending  |
| Draft no-show invoice/order         | Square order and DRAFT invoice are created with max authorized amount and saved card                                                                                                                                                                          | pending  |
| Admin exact amount charge           | Admin route publishes the invoice for the stored max amount only                                                                                                                                                                                              | pending  |
| Webhook charged finalization        | Square webhook marks local no-show charge `charged` only after invariant validation                                                                                                                                                                           | pending  |
| Declined/failed charge              | Local record becomes `charge_failed` or `charge_pending` according to provider certainty; alert is emitted                                                                                                                                                    | pending  |
| Publish timeout recovery            | Stale `charge_pending` is surfaced by reconciliation; retry only after reconciliation confirms no terminal Square payment/invoice state advanced, preserve idempotency and audit evidence, and follow the manual-review runbook; otherwise follow up manually | pending  |
| Legacy Payment Link fallback        | Card-on-file config 404 opens legacy Square checkout without losing the hold                                                                                                                                                                                  | pending  |
| Training Square invoice event       | Training invoice webhook still finalizes before no-show/service fallback handlers                                                                                                                                                                             | pending  |

## Production decision

Production card-on-file flag remains disabled until every row above has concrete evidence and operator approval.
```

- [ ] **Step 2: Verify report has no secrets**

Run:

```bash
git diff -- docs/superpowers/reports/square-card-on-file-sandbox-certification.md
```

Expected: report contains no API keys, bearer tokens, webhook secrets, raw card tokens, or customer PII.

---

## Task 4: Update runbooks with exact staging smoke order

**Files:**

- Modify: `docs/square-service-booking-setup.md`
- Modify: `docs/booking-system-runbook.md`
- Modify: `docs/launch-readiness-checklist.md`

- [ ] **Step 1: Add staging smoke order**

Add to `docs/square-service-booking-setup.md`:

```md
## Card-on-file staging certification order

1. Confirm production flag remains off.
2. Apply latest private DB migrations to staging.
3. Run DB-backed tests against staging clone.
4. Enable `SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED=true` only in staging with Square sandbox credentials.
5. Complete one successful booking through Square Web Payments SDK STORE tokenization.
6. Verify Square customer, card, order, and DRAFT invoice in Square sandbox.
7. Trigger the admin no-show route with exact `allowedAmountCents` after the appointment end time.
8. Verify webhook finalizes the no-show charge and records a sanitized event.
9. Run payment reconciliation route with the staging cron secret and save the JSON result.
10. Disable the staging flag if any scenario produces `manual_followup`, unreconciled `charge_pending`, or provider mismatch.
```

- [ ] **Step 2: Add launch checklist gate**

Add to `docs/launch-readiness-checklist.md`:

```md
- [ ] Square card-on-file production enablement approved: sandbox certification report complete, staging smoke run complete, reconciliation route returns `ok: true`, and production Square webhook subscriptions include invoice and payment events for the shared webhook URL.
```

- [ ] **Step 3: Add rollback instructions**

Add to `docs/booking-system-runbook.md`:

```md
## Card-on-file rollback

Set `SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED=false` and redeploy. Existing confirmed card-on-file bookings and no-show records remain in private DB for staff follow-up, but new customer booking confirmations use the legacy Square hosted checkout fallback. Do not delete Square saved cards or invoices during emergency rollback unless a staff operator has reconciled the matching private DB record.
```

---

## Task 5: Execute certification commands and fill report

**Files:**

- Modify: `docs/superpowers/reports/square-card-on-file-sandbox-certification.md`

- [ ] **Step 1: Run local automated verification**

Run:

```bash
npm run lint
npm run test:unit
npm run build
npx playwright test tests/booking.spec.ts --project=chromium
npx playwright test tests/booking-card-on-file-config.spec.ts --project=chromium
```

Expected: all commands complete successfully. Record exact outcomes in the report.

- [ ] **Step 2: Run DB-backed staging tests**

Run against a migrated staging clone:

```bash
TEST_DATABASE_URL="$TEST_DATABASE_URL" npx tsx --test src/lib/private-db/card-on-file-repository.db.test.ts src/lib/booking/payments/service-reconciliation-monitor.test.ts
```

Expected: DB-backed tests pass. Record the outcome in the report without writing the database URL.

- [ ] **Step 3: Perform Square sandbox manual scenarios**

Use the scenario table in the report. For each row, record:

```md
- Timestamp in UTC
- Local booking hold reference
- Square sandbox object type and redacted ID prefix only
- Local DB status after webhook/reconciliation
- Operator decision
```

Do not record full tokens, full webhook signatures, raw source IDs, or raw customer card data.

- [ ] **Step 4: Production go/no-go note**

At the bottom of the report, add one of these exact decisions:

```md
Decision: Do not enable production. Reason: one or more required sandbox/staging rows remain pending or failed.
```

or:

```md
Decision: Approved for production enablement. Reason: all required automated, DB-backed, Square sandbox, staging webhook, and reconciliation checks passed with no unresolved manual-followup states.
```

---

## Plan Self-Review Checklist

- Covers: live Square Web Payments SDK STORE validation, Cards API save, draft invoice/order behavior, invoice publish/charge, webhook mapping, decline/timeout behavior, cron route, DB-backed skipped tests, production rollback.
- This plan intentionally creates evidence and documentation rather than changing charge semantics.
- Production enablement requires explicit completed report evidence.
