# Best Practices Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Archive stale migration artifacts, replace third-party performance tools with self-hosted metrics, and enforce CMS editorial quality through real-time guidance.

**Architecture:** The plan splits into two tracks: migration hygiene (script archival, runbook documentation, and token IP restrictions) and runtime quality (a self-hosted PerformanceObserver beacon feeding a Next.js metrics endpoint, plus a Sanity editorial plugin that surfaces document badges and blocks publishing when critical fields are missing).

**Tech Stack:** Next.js API routes, PerformanceObserver, Sanity `definePlugin`, Node.js test runner.

---

**Source:** docs/platform-comprehensive-after-action-review.md  
**Master Spec:** docs/superpowers/specs/2026-06-05-platform-remediation-master-design.md

## Implementation Metadata

| Field                                      | Value                                                                                          |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| **Category**                               | Best Practices                                                                                 |
| **Source AAR Issues**                      | 7.1–7.3                                                                                        |
| **Estimated Duration**                     | 1 week (Phase 0 + Phase 4)                                                                     |
| **Required Sub-Skill for Agentic Workers** | Sanity plugin development, browser Performance APIs, Next.js API routes, documentation writing |

---

## Files to Create

| File                                                        | Purpose                               |
| ----------------------------------------------------------- | ------------------------------------- |
| `scripts/archive/README.md`                                 | Explanation of archived scripts       |
| `docs/runbooks/migration.md`                                | Migration runbook with security notes |
| `src/lib/performance/self-hosted-beacon.ts`                 | PerformanceObserver beacon collector  |
| `src/app/api/metrics/route.ts`                              | Metrics ingestion endpoint            |
| `src/sanity/plugins/editorial-guidance/index.ts`            | Main plugin definition                |
| `src/sanity/plugins/editorial-guidance/document-badges.ts`  | Real-time badge logic                 |
| `src/sanity/plugins/editorial-guidance/document-actions.ts` | Publish blocking logic                |
| `src/sanity/schemas/__tests__/schema-validation.test.ts`    | Schema validation tests               |

## Files to Modify

| File                                                | Change                                              |
| --------------------------------------------------- | --------------------------------------------------- |
| `scripts/migrate-strapi-to-sanity.ts`               | Move to `scripts/archive/` or delete                |
| `src/app/layout.tsx`                                | Remove `SpeedInsights`; add self-hosted beacon init |
| `sanity.config.ts`                                  | Register editorial guidance plugin                  |
| `src/sanity/schemas/documents/product.ts`           | Ensure critical fields have validation              |
| `src/sanity/schemas/documents/service.ts`           | Ensure critical fields have validation              |
| `src/sanity/schemas/objects/layout/hero-section.ts` | Ensure critical fields have validation              |

---

## Ordered Tasks

### Phase 0: Migration Hygiene (Week 1)

#### Task 0.1: Archive stale migration script

- [ ] Create `scripts/archive/` directory
- [ ] Move `scripts/migrate-strapi-to-sanity.ts` to `scripts/archive/`
- [ ] Create `scripts/archive/README.md`:

  ```markdown
  # Archived Scripts

  These scripts are preserved for historical reference only.
  Do not run them in production without explicit approval.

  ## Contents

  - `migrate-strapi-to-sanity.ts` — One-time Strapi-to-Sanity migration performed on 2026-06-05.
    Last used: 2026-06-05
    Approval record: See docs/production-cutover-checklist.md and docs/launch-readiness-checklist.md approval records
  ```

- [ ] Verify: `ls scripts/` does not show stale script

#### Task 0.2: Document migration runbook

- [ ] Create `docs/runbooks/migration.md`:

  ```markdown
  # Migration Runbook

  ## Last Migration Record

  - Source: Strapi
  - Destination: Sanity
  - Script: `scripts/archive/migrate-strapi-to-sanity.ts`
  - Date: 2026-06-05
  - Approval: See docs/production-cutover-checklist.md and docs/launch-readiness-checklist.md approval records

  ## Security Notes

  - Sanity write tokens are restricted to office IP ranges.
  - Schema deploys require MFA.
  - Migration scripts require two-engineer review before execution.
  - All migrations are logged in this runbook.

  ## Token Rotation Schedule

  - Write token: Quarterly
  - Read token: Annually
  - Next rotation: 2026-09-05 (quarterly rotation from this plan date)
  ```

- [ ] Verify: runbook is accessible and less than 6 months old

#### Task 0.3: Configure Sanity token restrictions

- [ ] In Sanity project settings (`manage.sanity.io`):
  - Navigate to API → Tokens
  - Restrict write token to office IP range(s)
  - Enable MFA for project owners
- [ ] Document IP ranges in `docs/runbooks/migration.md`
- [ ] Verify: token cannot be used from outside office IP

---

### Phase 4: Self-Hosted Metrics (Week 4)

#### Task 4.1: Create performance beacon

- [ ] Create `src/lib/performance/self-hosted-beacon.ts`:

  ```typescript
  export function initSelfHostedMetrics() {
    if (typeof window === "undefined") return;

    const sanitizeUrl = (rawUrl: string) => {
      const parsed = new URL(rawUrl);
      return parsed.pathname;
    };

    const sendMetric = (
      name: string,
      value: number,
      type: string,
      metadata: Record<string, string | number> = {},
    ) => {
      const safeMetadata: Record<string, string | number> = {};
      if (typeof metadata.initiatorType === "string") {
        safeMetadata.initiatorType = metadata.initiatorType;
      }
      if (typeof metadata.resourceKind === "string") {
        safeMetadata.resourceKind = metadata.resourceKind;
      }

      fetch("/api/metrics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          value,
          type,
          path: sanitizeUrl(window.location.href),
          metadata: safeMetadata,
          timestamp: Date.now(),
        }),
        keepalive: true,
      }).catch(() => {}); // Silently fail
    };

    // Core Web Vitals — observe standard entry types with feature detection
    if ("PerformanceObserver" in window) {
      // LCP
      try {
        const lcpObserver = new PerformanceObserver((list) => {
          const entries = list.getEntries();
          const lastEntry = entries[entries.length - 1];
          if (lastEntry) sendMetric("LCP", lastEntry.startTime, "web-vital");
        });
        lcpObserver.observe({
          type: "largest-contentful-paint",
          buffered: true,
        });
      } catch {
        /* not supported */
      }

      // CLS
      try {
        let clsValue = 0;
        const clsObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (!(entry as any).hadRecentInput) {
              clsValue += (entry as any).value;
            }
          }
          sendMetric("CLS", clsValue, "web-vital");
        });
        clsObserver.observe({ type: "layout-shift", buffered: true });
      } catch {
        /* not supported */
      }

      // INP (event timing)
      try {
        const inpObserver = new PerformanceObserver((list) => {
          const entries = list.getEntries() as PerformanceEventTiming[];
          const lastEntry = entries[entries.length - 1];
          if (lastEntry && lastEntry.interactionId) {
            const inpValue = lastEntry.duration;
            sendMetric("INP", inpValue, "web-vital");
          }
        });
        inpObserver.observe({
          type: "event",
          buffered: true,
          durationThreshold: 40,
        });
      } catch {
        /* not supported */
      }

      // Resource timing
      try {
        const resObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.duration > 0) {
              sendMetric("ResourceDuration", entry.duration, "resource", {
                initiatorType: (entry as PerformanceResourceTiming)
                  .initiatorType,
                resourceKind: (entry as PerformanceResourceTiming)
                  .initiatorType,
              });
            }
          }
        });
        resObserver.observe({ type: "resource", buffered: true });
      } catch {
        /* not supported */
      }
    }

    // Navigation timing
    window.addEventListener("load", () => {
      const nav = performance.getEntriesByType(
        "navigation",
      )[0] as PerformanceNavigationTiming;
      if (nav) {
        sendMetric("TTFB", nav.responseStart - nav.startTime, "navigation");
        sendMetric(
          "DOMContentLoaded",
          nav.domContentLoadedEventEnd - nav.startTime,
          "navigation",
        );
        sendMetric("Load", nav.loadEventEnd - nav.startTime, "navigation");
      }
    });
  }
  ```

- [ ] Verify: compiles without errors

#### Task 4.2: Create metrics API endpoint

- [ ] Add `performance_metrics` table to `src/lib/private-db/schema.ts`:
  ```typescript
  export const performanceMetrics = pgTable("performance_metrics", {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 50 }).notNull(),
    value: real("value").notNull(),
    type: varchar("type", { length: 50 }).notNull(),
    path: text("path"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  });
  ```
- [ ] Generate and apply migration: `npm run db:generate && npm run db:migrate`
- [ ] Create `src/app/api/metrics/route.ts`:

  ```typescript
  import { NextRequest } from "next/server";
  import { log } from "@/lib/logging/logger";
  import { db } from "@/lib/private-db/client";
  import { performanceMetrics } from "@/lib/private-db/schema";

  const ALLOWED_METRICS = new Set([
    "LCP",
    "CLS",
    "TTFB",
    "INP",
    "DOMContentLoaded",
    "Load",
    "ResourceDuration",
  ]);

  export async function POST(request: NextRequest) {
    try {
      const body = await request.json();
      const { name, value, type, path, metadata } = body;

      if (!ALLOWED_METRICS.has(name)) {
        return new Response("Invalid metric", { status: 400 });
      }

      if (typeof value !== "number" || value < 0 || value > 60000) {
        return new Response("Invalid value", { status: 400 });
      }

      const stripQueryAndHash = (rawPath: unknown) => {
        if (typeof rawPath !== "string" || !rawPath.startsWith("/")) return "/";
        const [withoutHash] = rawPath.split("#", 1);
        const [pathname] = withoutHash.split("?", 1);
        return pathname.slice(0, 512) || "/";
      };

      const safePath = stripQueryAndHash(path);
      const safeMetadata = {
        initiatorType:
          typeof metadata?.initiatorType === "string"
            ? metadata.initiatorType.slice(0, 64)
            : undefined,
        resourceKind:
          typeof metadata?.resourceKind === "string"
            ? metadata.resourceKind.slice(0, 64)
            : undefined,
      };

      log("info", "Performance metric", { name, value, type, path: safePath });

      await db.insert(performanceMetrics).values({
        name,
        value,
        type,
        path: safePath,
        metadata: safeMetadata,
        createdAt: new Date(),
      });

      return new Response("OK", { status: 200 });
    } catch {
      return new Response("Bad Request", { status: 400 });
    }
  }
  ```

- [ ] Rate-limit endpoint: max 10 requests/minute per IP (reuse Security rate limiter)
- [ ] Verify: `curl` test returns 200 for valid metric, 400 for invalid

#### Task 4.3: Replace SpeedInsights

- [ ] Modify `src/app/layout.tsx`:
  - Remove `import { SpeedInsights } from "@vercel/speed-insights/next"`
  - Remove `SpeedInsights` component
  - Add `initSelfHostedMetrics()` call in a client component or script
- [ ] Create `src/components/performance/self-hosted-metrics.tsx`:
  - `"use client"`
  - Calls `initSelfHostedMetrics()` in `useEffect`
- [ ] Add component to layout
- [ ] Verify: no `speed-insights` requests in Network tab; `/api/metrics` requests present

#### Task 4.4: Create metrics dashboard (protected internal route)

- [ ] Create `src/app/(site)/admin/metrics/page.tsx`:
  - Protected by basic auth or IP allowlist middleware
  - Query metrics from `performance_metrics` table
  - Display line charts for LCP, CLS, TTFB over time
  - Show 50th, 75th, 95th percentiles
  - Export CSV for offline analysis
- [ ] Verify: dashboard shows real metric data

> **Alternative**: Grafana with Loki/Prometheus or a hosted observability backend can be wired to the same `performance_metrics` table for richer visualization.

---

### Phase 4: Editorial Guidance Plugin (Week 4)

#### Task 4.5: Create plugin structure

- [ ] Create `src/sanity/plugins/editorial-guidance/index.ts`:

  ```typescript
  import { definePlugin } from "sanity";
  import { editorialBadges } from "./document-badges";
  import { editorialActions } from "./document-actions";

  export const editorialGuidancePlugin = definePlugin({
    name: "editorial-guidance",
    document: {
      badges: editorialBadges,
      actions: editorialActions,
    },
  });
  ```

- [ ] Register in `sanity.config.ts`:

  ```typescript
  import { editorialGuidancePlugin } from "./src/sanity/plugins/editorial-guidance";

  export default defineConfig({
    // ...
    plugins: [
      // ...existing plugins
      editorialGuidancePlugin(),
    ],
  });
  ```

#### Task 4.6: Implement document badges

- [ ] Create `src/sanity/plugins/editorial-guidance/document-badges.ts`:

  ```typescript
  export const editorialBadges = (prev: any[], context: any) => {
    const badges = [...prev];
    const doc = context.document;

    // Check for missing alt text on images
    const images = doc?.images || doc?.image ? [doc.image] : [];
    const missingAlt = images.some((img: any) => !img?.alt);
    if (missingAlt) {
      badges.push({
        label: "Missing alt",
        color: "warning",
        title: "Some images are missing alt text",
      });
    }

    // Check for empty title
    if (!doc?.title) {
      badges.push({
        label: "No title",
        color: "critical",
        title: "Title is required",
      });
    }

    // Check for empty slug
    if (!doc?.slug?.current) {
      badges.push({
        label: "No slug",
        color: "critical",
        title: "Slug is required",
      });
    }

    return badges;
  };
  ```

- [ ] Verify: badges appear in Studio document toolbar

#### Task 4.7: Implement publish blocking

- [ ] Create `src/sanity/plugins/editorial-guidance/document-actions.ts`:

  ```typescript
  import { PublishAction } from "sanity";

  export const editorialActions = (prev: any[], context: any) => {
    return prev.map((action: any) => {
      if (action.action === "publish") {
        const doc = context.document;
        const missingCritical =
          !doc?.title ||
          !doc?.slug?.current ||
          (doc?.images || []).some((img: any) => !img?.alt);

        if (missingCritical) {
          return {
            ...action,
            disabled: true,
            title: "Fix critical fields before publishing",
          };
        }
      }
      return action;
    });
  };
  ```

- [ ] Verify: publish button is disabled when critical fields are empty

#### Task 4.8: Add schema validation tests

- [ ] Create `src/sanity/schemas/__tests__/schema-validation.test.ts`:

  ```typescript
  import { describe, it } from "node:test";
  import assert from "node:assert";
  import { product } from "../documents/product";
  import { service } from "../documents/service";

  describe("schema validation", () => {
    it("product has required title", () => {
      const field = product.fields.find((f) => f.name === "title");
      assert.ok(field);
      assert.strictEqual(typeof field.validation, "function");
    });

    it("product has required slug", () => {
      const field = product.fields.find((f) => f.name === "slug");
      assert.ok(field);
      assert.strictEqual(typeof field.validation, "function");
    });

    it("service has required title", () => {
      const field = service.fields.find((f) => f.name === "title");
      assert.ok(field);
      assert.strictEqual(typeof field.validation, "function");
    });
  });
  ```

- [ ] Verify: `npm run test:unit` includes schema tests

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

# Verify SpeedInsights removed
grep -r "SpeedInsights" src/app/layout.tsx || echo "Removed"

# Test metrics endpoint
curl -X POST http://localhost:3000/api/metrics \
  -H "Content-Type: application/json" \
  -d '{"name":"LCP","value":1200,"type":"web-vital","path":"/checkout?email=test@example.com#token"}'
# Expected: stored row has path "/checkout" with query/hash stripped

# Sanity schema deploy
npx sanity schema deploy
```

---

## Rollout Gates

| Gate | Criteria                                          | Owner        |
| ---- | ------------------------------------------------- | ------------ |
| G1   | Stale script archived; runbook documented         | Tech lead    |
| G2   | Sanity token IP restrictions active               | Tech lead    |
| G3   | SpeedInsights removed; self-hosted metrics active | Frontend dev |
| G4   | Metrics endpoint accepts and logs valid data      | Backend dev  |
| G5   | Editorial plugin shows badges in Studio           | CMS dev      |
| G6   | Publish blocked when critical fields empty        | CMS dev      |
| G7   | Schema validation tests pass                      | Backend dev  |

---

## Notes and Cautions

1. **SpeedInsights Removal**: Before removing SpeedInsights, ensure the self-hosted metrics are collecting equivalent data. Compare metrics for 1 week before fully removing.
2. **Metrics Endpoint Security**: The `/api/metrics` endpoint is a potential DDoS vector. Rate-limit aggressively and validate metric names against an allowlist.
3. **Editorial Plugin UX**: Publish blocking can frustrate editors if overused. Only block for truly critical fields (title, slug, alt). Use warnings (non-blocking) for recommended fields.
4. **Schema Validation Tests**: These tests verify that validation functions exist, not that they work correctly. Add integration tests for actual validation behavior if needed.
5. **Token IP Restrictions**: If team works remotely, use VPN IP ranges rather than office IPs. Update ranges when team locations change.
6. **Self-Hosted Metrics Storage**: For high traffic, storing every metric in PostgreSQL may be expensive. Consider batching, sampling (1% of page loads), or using a time-series database.
7. **Metrics Payload Field**: Beacons must send performance measurements under the `value` field. Do not use a `duration` field at the payload level. FID is not collected.
8. **Schema Deploy Guard**: Production schema deploy requires `SANITY_SCHEMA_DEPLOY_TARGET=production`. Always deploy to staging first and verify Studio behavior.
