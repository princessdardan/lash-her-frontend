# Performance Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate database connection exhaustion, remove the global calendar lock bottleneck, optimize image delivery, and ensure all animations run on the compositor thread.

**Architecture:** The plan hardens the database layer with proxy-aware pool limits and a reservation saga pattern that replaces the global calendar lock with database-backed state machine transitions. Image delivery is optimized via responsive srcSet and next/image integration, while animations are refactored to use compositor-only properties with reduced-motion support.

**Tech Stack:** PostgreSQL, Drizzle ORM, PgBouncer/RDS Proxy, Next.js `next/image`, Sanity image URLs, CSS transforms, `requestAnimationFrame`.

---

**Source:** docs/platform-comprehensive-after-action-review.md  
**Master Spec:** docs/superpowers/specs/2026-06-05-platform-remediation-master-design.md

## Implementation Metadata

| Field                                      | Value                                                                                                                                  |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Category**                               | Performance                                                                                                                            |
| **Source AAR Issues**                      | 3.1–3.4                                                                                                                                |
| **Estimated Duration**                     | 2 active engineering weeks within roadmap Phases 1–4                                                                                   |
| **Required Sub-Skill for Agentic Workers** | PostgreSQL administration, Drizzle ORM schema design, Next.js image optimization, CSS animation performance, Chrome DevTools profiling |

---

## Files to Create

| File                                      | Purpose                                       |
| ----------------------------------------- | --------------------------------------------- |
| `src/lib/booking/reservation-saga.ts`     | Saga pattern for hold/confirm/release         |
| `src/app/api/cron/calendar-sync/route.ts` | Background calendar sync worker               |
| `src/hooks/use-reduced-motion.ts`         | Detects `prefers-reduced-motion`              |
| `src/lib/performance/raf-scroll.ts`       | requestAnimationFrame scroll batching utility |

## Files to Modify

| File                                               | Change                                                                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `src/lib/private-db/pool-config.ts`                | Add proxy-aware `max`, `idleTimeoutMillis`, `connectionTimeoutMillis`, `allowExitOnIdle`                      |
| `src/lib/private-db/schema.ts`                     | Add `reservations` table                                                                                      |
| `src/lib/booking/operational-store.ts`             | Remove global calendar lock; add per-slot lock helpers if still needed                                        |
| `src/app/api/booking/holds/route.ts`               | Refactored to use reservation saga                                                                            |
| `src/app/api/booking/availability/route.ts`        | Cache availability results with short TTL (15 s default)                                                      |
| `src/components/custom/training-detail-items.tsx`  | Replace width/grid-row animations with transform/opacity reveals; do not animate or measure layout properties |
| `src/components/custom/layouts/hero-carousel.tsx`  | Replace width animation with transform                                                                        |
| `src/components/custom/layouts/header-wrapper.tsx` | Use requestAnimationFrame for scroll reads                                                                    |
| `src/components/ui/sanity-image.tsx`               | Add srcSet, sizes, and LQIP placeholder                                                                       |
| `next.config.ts`                                   | Add custom image loader domain config                                                                         |

---

## Ordered Tasks

### Phase 1: Database Connection Hardening (Week 1)

#### Task 1.1: Update pool configuration

- [ ] Modify `src/lib/private-db/pool-config.ts`:
  - If `DATABASE_URL` contains `pgbouncer` or `pooler`, set `max: 3`
  - Otherwise, set `max: 10` (direct connection)
  - Always set: `idleTimeoutMillis: 30000`, `connectionTimeoutMillis: 5000`, `allowExitOnIdle: true`
- [ ] Verify: `npm run build` and `npm run test:unit` pass
- [ ] Monitor connection count in staging

#### Task 1.2: Set up connection proxy (Supabase Pooler recommended)

- [ ] Provision Supabase Pooler (or managed PgBouncer) for the project database
- [ ] Update connection string to `postgresql://.../postgres?pgbouncer=true`
- [ ] Set `DATABASE_URL_POOLER` in Vercel environment variables
- [ ] Set application pool `max: 3` when proxy is active
- [ ] Verify: `pg_stat_activity` shows ≤ 20 connections under load test

> **Alternatives**: Self-hosted PgBouncer via Docker or managed service, or AWS RDS Proxy if on AWS infrastructure. Update `DATABASE_URL` accordingly and apply the same application pool limit.

---

### Phase 2: Booking Saga (Week 1)

#### Task 2.1: Add reservations table

- [ ] Modify `src/lib/private-db/schema.ts`:
  - Add `reservations` table:
    - `id (uuid PK)`
    - `slotId (varchar)`
    - `customerId (varchar)`
    - `status (varchar)` — enum: `held`, `confirmed`, `released`
    - `heldAt (timestamptz)`
    - `confirmedAt (timestamptz)`
    - `releasedAt (timestamptz)`
    - `calendarEventId (varchar)`
  - Add unique constraint on `(slotId, status)` where `status IN ('held', 'confirmed')`
- [ ] Generate and apply migration
- [ ] Verify schema

#### Task 2.2: Implement reservation saga

- [ ] Create `src/lib/booking/reservation-saga.ts`:
  - `holdSlot(slotId, customerId)` — inserts reservation with `status: 'held'`
  - `confirmReservation(id)` — updates to `status: 'confirmed'`
  - `releaseReservation(id)` — updates to `status: 'released'` (compensation)
  - `syncToCalendar(reservation)` — calls Google Calendar API
- [ ] Handle DB unique constraint violation as `409 Conflict`
- [ ] Verify with unit test

#### Task 2.3: Refactor booking holds route

- [ ] Modify `src/app/api/booking/holds/route.ts`:
  - Replace global KV lock with saga `holdSlot()`
  - Return hold confirmation immediately
  - Enqueue calendar sync to outbox (reuse Architecture outbox)
- [ ] Remove or deprecate global calendar lock in `operational-store.ts`
- [ ] Verify: hold endpoint returns within 100ms; duplicate hold returns 409

#### Task 2.4: Create calendar sync worker

- [ ] Create `src/app/api/cron/calendar-sync/route.ts`:
  - Poll `reservations` where `status = 'held'` and `calendarEventId IS NULL`
  - Sync each to Google Calendar
  - On success: update `calendarEventId` and `status = 'confirmed'`
  - On failure: update `status = 'released'` and notify (log / alert)
  - Protected by `CRON_SECRET`
- [ ] Add cron schedule to `vercel.json`: `"schedule": "*/2 * * * *"` (every 2 minutes)
- [ ] Verify: calendar sync completes within 2 minutes of hold

---

### Phase 3: Image Optimization (Week 2)

#### Task 3.1: Add responsive srcSet to SanityImage

- [ ] Modify `src/components/ui/sanity-image.tsx`:
  - Generate `srcSet` with widths: 320, 640, 960, 1280, 1920, 2560
  - Use `urlFor(image).width(w).auto("format").url()`
  - Add `sizes` prop with sensible defaults: `"(max-width: 768px) 100vw, 50vw"`
  - Keep `alt` handling
- [ ] Verify: rendered `img` has `srcSet` and `sizes` attributes

#### Task 3.2: Integrate next/image with custom loader

- [ ] Modify `src/components/ui/sanity-image.tsx`:
  - Import `Image` from `next/image`
  - Create custom loader: `({ src, width }) => urlFor({ _ref: src }).width(width).auto("format").url()`
  - Set `width` and `height` props (can be large defaults)
  - Set `priority` for above-fold images (hero)
- [ ] Add `cdn.sanity.io` to `images.remotePatterns` in `next.config.ts`
- [ ] Verify: Lighthouse "Properly size images" score improves

#### Task 3.3: Add LQIP placeholders

- [ ] Use Sanity's `?blur=10&w=100` for LQIP
- [ ] Generate base64 blur data URL at build time or request time
- [ ] Pass to `next/image` `placeholder="blur"` and `blurDataURL`
- [ ] Verify: blur visible before full image loads

---

### Phase 4: Animation Performance (Week 2)

#### Task 4.1: Refactor training detail items

- [ ] Modify `src/components/custom/training-detail-items.tsx`:
  - Remove animated `grid-template-rows`, `height`, and related layout-property transitions entirely
  - Let the layout open/close instantly, then animate only child content with `opacity` and `transform: translateY()`
  - Use CSS classes or Motion variants that only change `opacity` and `transform`
  - If vertical motion is required by design, replace it with an instant state change and a short opacity/translate reveal rather than measuring layout
- [ ] Verify: Chrome DevTools Performance panel shows no animation-caused purple "Layout" bars during expand/collapse
- [ ] Verify: no forced synchronous layout (no interleaved read/write of layout properties) during animation

#### Task 4.2: Refactor hero carousel

- [ ] Modify `src/components/custom/layouts/hero-carousel.tsx`:
  - Replace `width` animation with `transform: translateX()` or `opacity`
  - Use `transform: translate3d()` for hardware acceleration
- [ ] Verify: carousel transitions at 60fps

#### Task 4.3: Batch scroll reads in header

- [ ] Modify `src/components/custom/layouts/header-wrapper.tsx`:
  - Use `requestAnimationFrame` to batch scroll position reads
  - Store `rafId` in ref; cancel on unmount
  - Use `passive: true` event listener
- [ ] Create `src/lib/performance/raf-scroll.ts` utility if reusable
- [ ] Verify: scroll handler fires max once per frame

#### Task 4.4: Add reduced motion support

- [ ] Create `src/hooks/use-reduced-motion.ts`:
  - `useState(false)` + `useEffect` with `matchMedia('(prefers-reduced-motion: reduce)')`
  - Returns boolean
- [ ] Apply in carousel, training items, contact popup:
  - If reduced motion: disable auto-rotation, use instant transitions
- [ ] Verify: macOS "Reduce motion" setting disables animations

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

# Database connections under load
autocannon -c 20 -d 30 http://localhost:3000/api/booking/availability?date=2026-06-10
psql $DATABASE_URL -c "SELECT count(*) FROM pg_stat_activity WHERE state = 'active';"

# Booking hold latency
autocannon -c 10 -d 30 -m POST -H "Content-Type: application/json" \
  -b '{"slotId":"test","customerId":"test"}' \
  http://localhost:3000/api/booking/holds

# Lighthouse
npx lighthouse http://localhost:3000/ --output=json --chrome-flags="--headless"

# Animation profiling
# Chrome DevTools → Performance → Record → Interact → Stop
# Check for purple "Layout" bars
```

---

## Rollout Gates

| Gate | Criteria                                                         | Owner        |
| ---- | ---------------------------------------------------------------- | ------------ |
| G1   | Pool config updated; no connection timeouts in staging           | Backend dev  |
| G2   | Connection proxy active (if applicable); connection count stable | DevOps       |
| G3   | Reservations table created; hold endpoint < 100ms p95            | Backend dev  |
| G4   | Calendar sync works; compensation releases slot on failure       | Backend dev  |
| G5   | SanityImage renders srcSet; Lighthouse image score ≥ 90          | Frontend dev |
| G6   | Animations run at 60fps; no layout thrashing                     | Frontend dev |
| G7   | Reduced motion respected across all animated components          | Frontend dev |

---

## Notes and Cautions

1. **Connection Proxy Migration**: When switching to a proxy, some PostgreSQL features (prepared statements, session-level advisory locks) may not work in transaction pooling mode. Test all queries before cutting over.
2. **Booking Saga Compensation**: The compensation (release on calendar sync failure) must be idempotent. A slot may be released multiple times if the worker retries.
3. **next/image Styling**: `next/image` requires explicit `width` and `height` or `fill` prop. Ensure the existing Tailwind styling approach is compatible.
4. **LQIP Base64 Size**: LQIP images should be < 300 bytes base64. Use Sanity's smallest blur (`w=10`, `blur=10`).
5. **requestAnimationFrame Cleanup**: Always cancel the RAF ID in the cleanup function. Failing to do so causes memory leaks and stale state updates.
6. **Reduced Motion Default**: When `prefers-reduced-motion: reduce` is active, all motion should be instant or disabled. Do not partially reduce — it creates an inconsistent experience.
7. **Avoid Reflow-Inducing Animation**: Do not introduce techniques that force reflow (e.g., reading layout geometry, animating dimensional properties) or layout-driven animation modes for critical interactions. Keep motion strictly on `transform` and `opacity`.
