# Architecture Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decouple payment flows from external providers, make side effects reliable and idempotent, and modernize the frontend architecture to reduce client bundle size while preserving interactivity.

**Architecture:** The plan introduces an outbox pattern for asynchronous payment provider calls, an event-sourcing layer with idempotent consumers for email and calendar side effects, and progressive hydration islands for interactive UI elements. Route-aware dynamic imports and a build-time block manifest further reduce per-page JavaScript.

**Tech Stack:** Next.js App Router, Drizzle ORM, PostgreSQL, Resend, Google Calendar API, `next/dynamic`, Node.js build scripts.

---

**Source:** docs/platform-comprehensive-after-action-review.md  
**Master Spec:** docs/superpowers/specs/2026-06-05-platform-remediation-master-design.md

## Implementation Metadata

| Field                                      | Value                                                                                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Category**                               | Architecture                                                                                                                                                  |
| **Source AAR Issues**                      | 2.1–2.4                                                                                                                                                       |
| **Estimated Duration**                     | 3 weeks (Phase 1 + Phase 2 + Phase 3 + Phase 4)                                                                                                               |
| **Required Sub-Skill for Agentic Workers** | Next.js App Router server/client components, Drizzle ORM transactions, PostgreSQL schema design, background job patterns, dynamic imports, build-time tooling |

---

## Files to Create

| File                                                | Purpose                                |
| --------------------------------------------------- | -------------------------------------- |
| `src/lib/commerce/outbox.ts`                        | Outbox enqueue/poll/retry functions    |
| `src/lib/events/event-store.ts`                     | Event publish and consumer idempotency |
| `src/lib/events/consumers/email-consumer.ts`        | Email side effect consumer             |
| `src/lib/events/consumers/calendar-consumer.ts`     | Calendar side effect consumer          |
| `src/app/api/cron/outbox-worker/route.ts`           | Cron worker for outbox processing      |
| `src/app/api/cron/event-consumer/route.ts`          | Cron worker for event consumption      |
| `src/app/api/checkout/status/route.ts`              | Poll endpoint for checkout status      |
| `src/components/islands/cart-button-island.tsx`     | Hydrated cart button island            |
| `src/components/islands/contact-trigger-island.tsx` | Hydrated contact trigger island        |
| `src/components/islands/index.ts`                   | Island exports                         |
| `scripts/generate-block-manifest.ts`                | Build-time block manifest generator    |
| `src/components/custom/layouts/block-preload.tsx`   | Preload link injector                  |

## Files to Modify

| File                                                    | Change                                              |
| ------------------------------------------------------- | --------------------------------------------------- |
| `src/lib/private-db/schema.ts`                          | Add `outbox`, `events`, `processedEvents` tables    |
| `src/app/api/checkout/route.ts`                         | Write pending order + outbox event; return poll URL |
| `src/app/api/training-checkout/route.ts`                | Same as checkout                                    |
| `src/app/api/webhooks/card-transactions/route.ts`       | Publish event instead of inline side effects        |
| `src/app/api/checkout/validate-payment/route.ts`        | Use event sourcing for side effects                 |
| `src/app/(site)/layout.tsx`                             | Convert to server component; use islands            |
| `src/components/custom/layouts/block-renderer.tsx`      | Dynamic imports per block type                      |
| `src/components/custom/contact-popup/contact-popup.tsx` | Ensure works as lazy-loaded island                  |
| `next.config.ts`                                        | Add webpack chunk name for block bundles            |
| `vercel.json`                                           | Add cron schedules for outbox and event workers     |

---

## Ordered Tasks

### Phase 1: Outbox Infrastructure (Week 1)

#### Task 1.1: Add outbox table to schema

- [ ] Modify `src/lib/private-db/schema.ts`:
  - Add `outbox` table: `id (uuid PK)`, `type (varchar)`, `payload (jsonb)`, `status (varchar)`, `createdAt (timestamptz)`, `processedAt (timestamptz)`, `errorCount (int)`, `lastError (text)`
  - Add index: `CREATE INDEX idx_outbox_status_created ON outbox(status, createdAt)`
- [ ] Generate migration: `npm run db:generate`
- [ ] Apply migration: `npm run db:migrate`
- [ ] Verify: `\d outbox` in psql shows correct schema

#### Task 1.2: Create outbox service

- [ ] Create `src/lib/commerce/outbox.test.ts` first:

  ```typescript
  import { describe, it } from "node:test";
  import assert from "node:assert/strict";
  import { buildOutboxInsert } from "./outbox";

  describe("buildOutboxInsert", () => {
    it("creates a pending outbox row with JSON payload", () => {
      const row = buildOutboxInsert("create_helcim_checkout", {
        orderId: "order_1",
      });
      assert.equal(row.type, "create_helcim_checkout");
      assert.equal(row.status, "pending");
      assert.deepEqual(row.payload, { orderId: "order_1" });
    });
  });
  ```

- [ ] Run `npx tsx --test src/lib/commerce/outbox.test.ts`; expected before implementation: module import fails because `src/lib/commerce/outbox.ts` does not exist
- [ ] Create `src/lib/commerce/outbox.ts` exporting `buildOutboxInsert(type, payload)`, `enqueueOutbox(type, payload)`, `pollPendingOutbox(limit = 10)`, `markProcessed(id)`, and `markFailed(id, error)`
- [ ] Run `npx tsx --test src/lib/commerce/outbox.test.ts`; expected after implementation: test passes

#### Task 1.3: Refactor checkout route to use outbox

- [ ] Create or update a focused checkout orchestration test that asserts checkout inserts a pending order and outbox event before returning a poll URL; if the route is hard to unit-test directly, extract a service function in `src/lib/commerce/checkout-orchestration.ts` and test that service first
- [ ] Run the focused checkout/outbox test; expected before implementation: fails because the current route still creates the provider artifact inline
- [ ] Modify `src/app/api/checkout/route.ts`:
  - Start Drizzle transaction
  - Insert `pending` order with `total`, `items`, `createdAt`
  - Insert outbox event: `type: 'create_helcim_checkout'`, `payload: { orderId, cartItems, total }`
  - Commit transaction
  - Return `{ pollUrl: '/api/checkout/status?orderId=...' }`
- [ ] Create `src/app/api/checkout/status/route.ts`:
  - Query order by ID
  - Return `{ status, providerSessionId, checkoutUrl }`
- [ ] Remove inline provider calls from the user-facing checkout path; do not keep a commented fallback that can be accidentally restored without review
- [ ] Run the focused checkout/outbox test again; expected after implementation: passes
- [ ] Verify: checkout creates pending order and outbox event; no provider call in route

#### Task 1.4: Create outbox worker cron

- [ ] Create `src/app/api/cron/outbox-worker/route.ts`:
  - Validate `CRON_SECRET` header
  - Poll pending outbox events (limit 10)
  - For each event:
    - Call provider (Helcim/Square) with payload
    - Update order with `providerSessionId`
    - Mark outbox as processed
    - On failure: mark failed, retry with exponential backoff
  - Return `{ processed: N, failed: M }`
- [ ] Add cron schedule to `vercel.json`: `"schedule": "*/1 * * * *"` (every minute)
- [ ] Verify: worker processes outbox events within 60 seconds

#### Task 1.5: Repeat for training checkout

- [ ] Apply same pattern to `src/app/api/training-checkout/route.ts`
- [ ] Create `src/app/api/training-checkout/status/route.ts`
- [ ] Verify: training enrollment checkout uses outbox

---

### Phase 2: Event Sourcing (Week 2)

#### Task 2.1: Add events tables to schema

- [ ] Modify `src/lib/private-db/schema.ts`:
  - Add `events` table: `id (uuid PK)`, `type (varchar)`, `aggregateId (varchar)`, `payload (jsonb)`, `occurredAt (timestamptz)`, `idempotencyKey (varchar unique)`
  - Add `processedEvents` table: `eventId (uuid PK)`, `consumerType (varchar)`, `processedAt (timestamptz)`
  - Add composite index on `processedEvents(eventId, consumerType)`
- [ ] Generate migration: `npm run db:generate`; expected: new Drizzle migration file includes `events` and `processed_events`
- [ ] Apply migration: `npm run db:migrate`; expected: migration exits 0 against the current `DATABASE_URL`
- [ ] Verify schema with `psql $DATABASE_URL -c '\d events'` and `psql $DATABASE_URL -c '\d processed_events'`

#### Task 2.2: Create event store

- [ ] Create `src/lib/events/event-store.test.ts` first:

  ```typescript
  import { describe, it } from "node:test";
  import assert from "node:assert/strict";
  import { buildEventInsert } from "./event-store";

  describe("buildEventInsert", () => {
    it("creates an idempotent domain event row", () => {
      const event = buildEventInsert(
        "payment_confirmed",
        "order_1",
        { amount: 100 },
        "webhook_1",
      );
      assert.equal(event.type, "payment_confirmed");
      assert.equal(event.aggregateId, "order_1");
      assert.equal(event.idempotencyKey, "webhook_1");
    });
  });
  ```

- [ ] Run `npx tsx --test src/lib/events/event-store.test.ts`; expected before implementation: module import fails because `event-store.ts` does not exist
- [ ] Create `src/lib/events/event-store.ts`:
  - `buildEventInsert(type, aggregateId, payload, idempotencyKey)` — returns the row object used by `publishEvent`
  - `publishEvent(type, aggregateId, payload, idempotencyKey)` — inserts into events
  - `processEvent(eventId, consumerType, handler)` — checks processedEvents, runs handler, marks processed
  - `getUnprocessedEvents(consumerType, limit)` — joins events with processedEvents
- [ ] Run `npx tsx --test src/lib/events/event-store.test.ts`; expected after implementation: test passes

#### Task 2.3: Refactor webhook handler

- [ ] Add or update `src/app/api/webhooks/card-transactions/route.test.ts` to post a duplicate webhook payload twice and assert one `payment_confirmed` event row is published with a stable idempotency key
- [ ] Run the focused webhook test; expected before implementation: fails because the current handler performs inline side effects
- [ ] Modify `src/app/api/webhooks/card-transactions/route.ts`:
  - Validate signature (existing logic)
  - Generate idempotency key from webhook payload
  - Publish event: `type: 'payment_confirmed'`, `aggregateId: orderId`
  - Return `200 OK` immediately
- [ ] Remove inline email/calendar/update logic
- [ ] Run the focused webhook test again; expected after implementation: passes and handler returns 200 quickly
- [ ] Verify: webhook returns 200 within 100ms; event row created

#### Task 2.4: Create consumers

- [ ] Create `src/lib/events/consumers/email-consumer.test.ts` and `src/lib/events/consumers/calendar-consumer.test.ts` first; each test should process the same event twice and assert the underlying send/add function is called exactly once
- [ ] Run `npx tsx --test src/lib/events/consumers/*.test.ts`; expected before implementation: module imports fail because consumers do not exist
- [ ] Create `src/lib/events/consumers/email-consumer.ts`:
  - Reads unprocessed `payment_confirmed` events
  - Sends confirmation email via Resend
  - Marks event as processed
- [ ] Create `src/lib/events/consumers/calendar-consumer.ts`:
  - Reads unprocessed `payment_confirmed` events with booking data
  - Adds event to Google Calendar
  - Marks event as processed
- [ ] Create `src/app/api/cron/event-consumer/route.ts`:
  - Runs every minute
  - Processes events for each consumer type
  - Protected by `CRON_SECRET`
- [ ] Add cron schedule to `vercel.json`
- [ ] Run `npx tsx --test src/lib/events/consumers/*.test.ts`; expected after implementation: tests pass
- [ ] Verify: duplicate webhooks produce single email and calendar event

---

### Phase 3: Progressive Hydration (Week 2)

#### Task 3.1: Convert site layout to server component

- [ ] Create `tests/site-shell-hydration.spec.ts` first:

  ```typescript
  import { test, expect } from "@playwright/test";

  test("homepage does not eagerly load contact popup or cart sheet chunks", async ({
    page,
  }) => {
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));
    await page.goto("/");
    await expect(page.getByRole("main")).toBeVisible();
    expect(requests.some((url) => url.includes("contact-popup"))).toBe(false);
    expect(requests.some((url) => url.includes("cart-sheet"))).toBe(false);
  });
  ```

- [ ] Run `npx playwright test tests/site-shell-hydration.spec.ts --project=chromium`; expected before implementation: fails if contact/cart chunks are eagerly requested
- [ ] Modify `src/app/(site)/layout.tsx`:
  - Remove `"use client"` if present
  - Remove eager imports of `ContactPopup`, cart sheet, product provider
  - Import islands lazily or as server-rendered placeholders
  - Pass nonce from middleware header for inline scripts
- [ ] Create `src/components/islands/cart-button-island.tsx`:
  - `"use client"`
  - Minimal wrapper that hydrates on hover/click or after 2s idle
  - Uses existing cart context once loaded
- [ ] Create `src/components/islands/contact-trigger-island.tsx`:
  - `"use client"`
  - Minimal button that loads full popup on click
- [ ] Run `npx playwright test tests/site-shell-hydration.spec.ts --project=chromium`; expected after implementation: test passes
- [ ] Verify: static pages show no client JS chunks for cart/contact in Network tab

#### Task 3.2: Ensure booking flow still works

- [ ] Create or update `tests/booking-island-regression.spec.ts` with a booking flow smoke test that visits the booking page, waits for the service/slot UI, and asserts the booking flow remains interactive after shell island extraction
- [ ] Run `npx playwright test tests/booking-island-regression.spec.ts --project=chromium`; expected before implementation: establishes current behavior or fails where providers are still globally coupled
- [ ] Verify `src/components/booking/booking-flow.tsx` remains client component
- [ ] Ensure booking context providers are inside a client island
- [ ] Run E2E tests: `npx playwright test tests/booking-island-regression.spec.ts --project=chromium`
- [ ] Verify no regressions in availability, hold, checkout

---

### Phase 4: Route-Aware Block Bundles (Week 3)

#### Task 4.1: Dynamic imports in block renderer

- [ ] Create `src/components/custom/layouts/block-renderer.dynamic-imports.test.ts` first:

  ```typescript
  import { describe, it } from "node:test";
  import assert from "node:assert/strict";
  import { BLOCK_COMPONENT_IMPORTS } from "./block-renderer";

  describe("block renderer dynamic imports", () => {
    it("uses lazy import functions for registered blocks", () => {
      assert.equal(typeof BLOCK_COMPONENT_IMPORTS.heroSection, "function");
      assert.equal(typeof BLOCK_COMPONENT_IMPORTS.featureSection, "function");
    });
  });
  ```

- [ ] Run `npx tsx --test src/components/custom/layouts/block-renderer.dynamic-imports.test.ts`; expected before implementation: fails because `BLOCK_COMPONENT_IMPORTS` is not exported
- [ ] Modify `src/components/custom/layouts/block-renderer.tsx`:
  - Replace eager imports with `next/dynamic(() => import('./hero-section'), { ssr: true })`
  - Use `loading` prop for skeleton fallback
  - Keep `COMPONENT_REGISTRY` but values are dynamic imports
- [ ] Run `npx tsx --test src/components/custom/layouts/block-renderer.dynamic-imports.test.ts`; expected after implementation: test passes
- [ ] Verify: only blocks on current page appear in Network tab

#### Task 4.2: Generate block manifest at build time

- [ ] Create `scripts/generate-block-manifest.test.ts` first:

  ```typescript
  import { describe, it } from "node:test";
  import assert from "node:assert/strict";
  import { buildBlockManifest } from "./generate-block-manifest";

  describe("buildBlockManifest", () => {
    it("maps routes to unique block type arrays", () => {
      const manifest = buildBlockManifest([
        {
          route: "/",
          blocks: ["heroSection", "heroSection", "featureSection"],
        },
      ]);
      assert.deepEqual(manifest["/"], ["heroSection", "featureSection"]);
    });
  });
  ```

- [ ] Run `npx tsx --test scripts/generate-block-manifest.test.ts`; expected before implementation: module import fails because `generate-block-manifest.ts` does not exist
- [ ] Create `scripts/generate-block-manifest.ts`:
  - Parse page query files or analyze `src/app/(site)/**/*page.tsx`
  - Map routes to likely block types based on GROQ projections
  - Write `public/block-manifest.json`
- [ ] Add to build pipeline: `package.json` prebuild script
- [ ] Run `npx tsx --test scripts/generate-block-manifest.test.ts`; expected after implementation: test passes
- [ ] Verify: `public/block-manifest.json` exists after `npm run build`

#### Task 4.3: Inject preload hints

- [ ] Create `src/components/custom/layouts/block-preload.test.tsx` first with a render assertion that `BlockPreload({ route: "/" })` emits preload links for manifest entries and omits unknown routes
- [ ] Run `npx tsx --test src/components/custom/layouts/block-preload.test.tsx`; expected before implementation: module import fails because `block-preload.tsx` does not exist
- [ ] Create `src/components/custom/layouts/block-preload.tsx`:
  - Reads `block-manifest.json`
  - Renders `link rel="preload" as="script" href="..."` for predicted blocks
  - Only preloads blocks not already on current page
- [ ] Use in page layouts or middleware
- [ ] Run `npx tsx --test src/components/custom/layouts/block-preload.test.tsx`; expected after implementation: test passes
- [ ] Verify: DevTools Network shows preload links for next likely blocks

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

# Outbox queue check
psql $DATABASE_URL -c "SELECT COUNT(*) FROM outbox WHERE status = 'pending';"

# Event queue check
psql $DATABASE_URL -c "SELECT COUNT(*) FROM events e LEFT JOIN processed_events p ON e.id = p.event_id WHERE p.event_id IS NULL;"

# Bundle analysis
npm run build
npx next-bundle-analyzer .next/analyze/__bundle_analysis.json

# Lighthouse
npx lighthouse http://localhost:3000/ --output=json
```

---

## Rollout Gates

| Gate | Criteria                                                     | Owner        |
| ---- | ------------------------------------------------------------ | ------------ |
| G1   | Outbox table created and migration applied                   | Backend dev  |
| G2   | Checkout route writes to outbox; worker processes within 60s | Backend dev  |
| G3   | Webhook returns 200 within 100ms; events created             | Backend dev  |
| G4   | Email and calendar consumers process events idempotently     | Backend dev  |
| G5   | Static pages ship < 50 KB client JS                          | Frontend dev |
| G6   | Block manifest generated; preload hints visible              | Frontend dev |
| G7   | All E2E tests pass with no regressions                       | QA           |

---

## Notes and Cautions

1. **Transaction Scope**: The outbox pattern requires the order insert and outbox insert to be in the same PostgreSQL transaction. Use Drizzle's `db.transaction()` wrapper.
2. **Worker Race Conditions**: If the outbox worker scales to multiple instances, ensure event processing is idempotent. Use `SELECT FOR UPDATE` or application-level locking if needed.
3. **Client Component Boundaries**: When converting the layout to a server component, any child that uses `useState`, `useEffect`, or browser APIs must be wrapped in a client island. Do not assume a component is server-safe without checking.
4. **Dynamic Import Loading States**: Always provide a `loading` fallback for dynamic imports to prevent layout shift. Use skeleton UI that matches the final component dimensions.
5. **Block Manifest Accuracy**: The build-time manifest generator is a heuristic. If page queries change, the manifest may become stale. Add a CI check that verifies manifest freshness.
6. **Cron Endpoint Security**: All cron routes must validate `CRON_SECRET` against the environment variable. Return `401 Unauthorized` if missing or invalid.
