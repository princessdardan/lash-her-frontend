# Course Management Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the course API, admin dashboard, and existing marketing-site integration described in `docs/superpowers/specs/2026-05-04-course-management-microservice-design.md`.

**Architecture:** The Fastify API is the entitlement authority and owns course content, orders, enrollments, video access, progress, and operational records. The existing Next.js marketing app renders sales pages and protected student learning UI by calling the API. A separate Next.js admin dashboard manages course content and operational workflows through protected admin API endpoints.

**Tech Stack:** Fastify, TypeScript, PostgreSQL, Drizzle ORM, Zod, OpenAPI, Clerk, HelcimPay.js, Mux, Next.js, Vercel, Railway/Render/Fly-style API hosting, npm.

---

## Scope Split

The approved spec covers three independently deployable subsystems. Implement in this order so each milestone leaves working, testable software:

1. **API foundation and contracts** — creates the source of truth and generated API contract.
2. **Course/content/admin API** — enables admin-managed course structure and Mux upload lifecycle.
3. **Payments/enrollments/progress API** — enables checkout, webhook-confirmed enrollment, playback authorization, and progress.
4. **Admin dashboard** — provides the management UI.
5. **Marketing frontend integration** — adds public course sales pages and protected student learning UI to the existing site.

Do not begin admin or marketing UI implementation before the API contract for the relevant endpoints exists.

## Repository Layout

Create two new local repositories beside the current monorepo unless the user provides remote repositories first:

- `/Users/dardan/workspace/lash-her-course-api` — Fastify/PostgreSQL API.
- `/Users/dardan/workspace/lash-her-course-admin` — Next.js admin dashboard.

Modify the existing marketing frontend only under:

- `/Users/dardan/Documents/lash-her/frontend`

## Contract and Naming Decisions Locked By This Plan

- API base path: `/v1`.
- Public course sales route in marketing frontend: `/courses/[slug]`.
- Student library route in marketing frontend: `/learn`.
- Student lesson route in marketing frontend: `/learn/[courseSlug]/[lessonSlug]`.
- Admin route root: `/` in the admin dashboard app, deployed to the chosen admin subdomain.
- Admin authorization strategy for MVP: Clerk public metadata key `courseAdmin: true`, verified by the API after Clerk JWT verification.
- API contract output: OpenAPI JSON at `/v1/openapi.json`, generated TypeScript client package emitted from the API repo into `generated/client` for consumers to copy or publish.

## Phase 1: API Foundation

### Task 1: Create Fastify API repository scaffold

**Files:**
- Create: `/Users/dardan/workspace/lash-her-course-api/package.json`
- Create: `/Users/dardan/workspace/lash-her-course-api/tsconfig.json`
- Create: `/Users/dardan/workspace/lash-her-course-api/src/server.ts`
- Create: `/Users/dardan/workspace/lash-her-course-api/src/app.ts`
- Create: `/Users/dardan/workspace/lash-her-course-api/src/config/env.ts`
- Create: `/Users/dardan/workspace/lash-her-course-api/tests/health.test.ts`

- [ ] **Step 1: Create the repo directory and initialize git**

Run:
```bash
mkdir -p /Users/dardan/workspace/lash-her-course-api
cd /Users/dardan/workspace/lash-her-course-api
git init
npm init -y
```
Expected: a new git repository with `package.json`.

- [ ] **Step 2: Install API dependencies**

Run:
```bash
npm install fastify @fastify/cors @fastify/helmet @fastify/rate-limit @fastify/swagger @fastify/swagger-ui zod dotenv pino pino-pretty
npm install -D typescript tsx vitest @types/node eslint
```
Expected: dependencies installed and `package-lock.json` created.

- [ ] **Step 3: Replace `package.json` scripts**

Set scripts to:
```json
{
  "dev": "tsx watch src/server.ts",
  "build": "tsc --noEmit",
  "start": "tsx src/server.ts",
  "test": "vitest run",
  "test:watch": "vitest",
  "lint": "eslint ."
}
```

- [ ] **Step 4: Create strict TypeScript config**

Create `tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "outDir": "dist"
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 5: Write failing health test**

Create `tests/health.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

describe("health", () => {
  it("returns ok", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });

    await app.close();
  });
});
```

- [ ] **Step 6: Run test and verify it fails**

Run:
```bash
npm test -- tests/health.test.ts
```
Expected: FAIL because `src/app.ts` does not exist.

- [ ] **Step 7: Implement Fastify app and server**

Create `src/app.ts`:
```ts
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(helmet);
  await app.register(cors, {
    origin: true,
    credentials: true,
  });
  await app.register(rateLimit, {
    max: 120,
    timeWindow: "1 minute",
  });

  app.get("/health", async () => ({ status: "ok" }));

  return app;
}
```

Create `src/config/env.ts`:
```ts
import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
});

export interface AppEnv extends z.infer<typeof envSchema> {}

export const env: AppEnv = envSchema.parse(process.env);
```

Create `src/server.ts`:
```ts
import { buildApp } from "./app.js";
import { env } from "./config/env.js";

const app = await buildApp();

await app.listen({ port: env.PORT, host: "0.0.0.0" });
```

- [ ] **Step 8: Verify test and build**

Run:
```bash
npm test -- tests/health.test.ts
npm run build
```
Expected: health test passes and TypeScript exits 0.

- [ ] **Step 9: Commit**

Run:
```bash
git add .
git commit -m "feat(api): scaffold fastify service"
```

### Task 2: Add database, migrations, and core schema

**Files:**
- Create: `/Users/dardan/workspace/lash-her-course-api/src/db/client.ts`
- Create: `/Users/dardan/workspace/lash-her-course-api/src/db/schema.ts`
- Create: `/Users/dardan/workspace/lash-her-course-api/drizzle.config.ts`
- Modify: `/Users/dardan/workspace/lash-her-course-api/src/config/env.ts`
- Test: `/Users/dardan/workspace/lash-her-course-api/tests/schema.test.ts`

- [ ] **Step 1: Install database dependencies**

Run:
```bash
npm install drizzle-orm pg
npm install -D drizzle-kit @types/pg
```

- [ ] **Step 2: Extend environment schema**

Modify `src/config/env.ts` to require `DATABASE_URL` outside tests:
```ts
import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().url().optional(),
});

export interface AppEnv extends z.infer<typeof envSchema> {}

export const env: AppEnv = envSchema.parse(process.env);

if (env.NODE_ENV !== "test" && !env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required outside test mode");
}
```

- [ ] **Step 3: Create Drizzle schema**

Create `src/db/schema.ts` with tables for `users`, `courses`, `modules`, `lessons`, `video_assets`, `orders`, `payment_events`, `enrollments`, `lesson_progress`, `admin_actions`, and `operational_events`. Use UUID primary keys, timestamp columns, unique slugs, foreign keys, and enum-like text columns for `draft|published`, `pending|confirmed|enrolled|failed|cancelled|refunded|revoked`, and `active|revoked|refunded`.

- [ ] **Step 4: Create database client**

Create `src/db/client.ts`:
```ts
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { env } from "../config/env.js";
import * as schema from "./schema.js";

export type Database = NodePgDatabase<typeof schema>;

export function createDatabase(): Database {
  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required to create a database client");
  }

  const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
  return drizzle(pool, { schema });
}
```

- [ ] **Step 5: Add Drizzle config**

Create `drizzle.config.ts`:
```ts
import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/lash_her_courses",
  },
});
```

- [ ] **Step 6: Add schema smoke test**

Create `tests/schema.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { courses, enrollments, lessons, modules, orders, users } from "../src/db/schema.js";

describe("database schema", () => {
  it("exports core course commerce tables", () => {
    expect(users).toBeDefined();
    expect(courses).toBeDefined();
    expect(modules).toBeDefined();
    expect(lessons).toBeDefined();
    expect(orders).toBeDefined();
    expect(enrollments).toBeDefined();
  });
});
```

- [ ] **Step 7: Verify schema and migration generation**

Run:
```bash
npm test -- tests/schema.test.ts
npx drizzle-kit generate
npm run build
```
Expected: tests pass, migration files appear under `drizzle/`, and TypeScript exits 0.

- [ ] **Step 8: Commit**

Run:
```bash
git add .
git commit -m "feat(api): add course platform schema"
```

### Task 3: Add auth, API envelope, and OpenAPI foundation

**Files:**
- Create: `/Users/dardan/workspace/lash-her-course-api/src/auth/clerk.ts`
- Create: `/Users/dardan/workspace/lash-her-course-api/src/http/errors.ts`
- Create: `/Users/dardan/workspace/lash-her-course-api/src/http/openapi.ts`
- Modify: `/Users/dardan/workspace/lash-her-course-api/src/app.ts`
- Test: `/Users/dardan/workspace/lash-her-course-api/tests/auth.test.ts`

- [ ] **Step 1: Install Clerk and OpenAPI helpers**

Run:
```bash
npm install @clerk/backend @sinclair/typebox
```

- [ ] **Step 2: Add Clerk env vars**

Extend `src/config/env.ts` with optional test-safe vars: `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `CLERK_JWT_ISSUER`, and `ADMIN_CLERK_USER_IDS` as comma-separated admin allowlist fallback.

- [ ] **Step 3: Write auth module**

Create `src/auth/clerk.ts` exporting `AuthenticatedUser`, `requireUser(request)`, and `requireAdmin(request)`. `requireUser` verifies Clerk auth and returns `{ clerkUserId, email }`. `requireAdmin` accepts users with `courseAdmin: true` metadata or whose Clerk ID is in `ADMIN_CLERK_USER_IDS`.

- [ ] **Step 4: Add HTTP error helpers**

Create `src/http/errors.ts` with typed `HttpError`, `unauthorized`, `forbidden`, `notFound`, `conflict`, and `badRequest` helpers. Register a Fastify error handler in `src/app.ts` that returns `{ error: { code, message } }`.

- [ ] **Step 5: Register OpenAPI**

Create `src/http/openapi.ts` to register `@fastify/swagger` and `@fastify/swagger-ui`, exposing `/v1/openapi.json` and `/docs`.

- [ ] **Step 6: Verify auth tests and build**

Run:
```bash
npm test -- tests/auth.test.ts
npm run build
```

- [ ] **Step 7: Commit**

Run:
```bash
git add .
git commit -m "feat(api): add auth and openapi foundation"
```

## Phase 2: Course Content and Admin API

### Task 4: Implement public and admin course endpoints

**Files:**
- Create: `/Users/dardan/workspace/lash-her-course-api/src/courses/course.schemas.ts`
- Create: `/Users/dardan/workspace/lash-her-course-api/src/courses/course.repository.ts`
- Create: `/Users/dardan/workspace/lash-her-course-api/src/courses/course.routes.ts`
- Modify: `/Users/dardan/workspace/lash-her-course-api/src/app.ts`
- Test: `/Users/dardan/workspace/lash-her-course-api/tests/courses.test.ts`

- [ ] **Step 1: Write tests for public published-course reads and admin mutations**

Tests must cover: public list only returns published courses; public slug lookup hides drafts; admin can create course; admin can update publish state; non-admin cannot mutate.

- [ ] **Step 2: Implement course schemas**

Create Zod schemas for create/update course, module, and lesson payloads. Use integer cents or decimal string consistently for price; store canonical currency as ISO code.

- [ ] **Step 3: Implement repository**

Create repository functions for listing published courses, fetching published course by slug, admin CRUD for courses/modules/lessons, and ordering updates.

- [ ] **Step 4: Implement routes**

Expose:
```text
GET /v1/courses
GET /v1/courses/:slug
GET /v1/admin/courses
POST /v1/admin/courses
PATCH /v1/admin/courses/:courseId
POST /v1/admin/courses/:courseId/modules
PATCH /v1/admin/modules/:moduleId
POST /v1/admin/modules/:moduleId/lessons
PATCH /v1/admin/lessons/:lessonId
```

- [ ] **Step 5: Verify**

Run:
```bash
npm test -- tests/courses.test.ts
npm run build
```

- [ ] **Step 6: Commit**

Run:
```bash
git add .
git commit -m "feat(api): add course content endpoints"
```

### Task 5: Implement Mux upload and webhook processing

**Files:**
- Create: `/Users/dardan/workspace/lash-her-course-api/src/video/mux.client.ts`
- Create: `/Users/dardan/workspace/lash-her-course-api/src/video/video.routes.ts`
- Create: `/Users/dardan/workspace/lash-her-course-api/src/video/video.repository.ts`
- Modify: `/Users/dardan/workspace/lash-her-course-api/src/app.ts`
- Test: `/Users/dardan/workspace/lash-her-course-api/tests/video.test.ts`

- [ ] **Step 1: Install Mux SDK**

Run:
```bash
npm install @mux/mux-node jsonwebtoken
npm install -D @types/jsonwebtoken
```

- [ ] **Step 2: Add video env vars**

Add `MUX_TOKEN_ID`, `MUX_TOKEN_SECRET`, `MUX_WEBHOOK_SECRET`, `MUX_SIGNING_KEY_ID`, and `MUX_SIGNING_PRIVATE_KEY` to `src/config/env.ts`.

- [ ] **Step 3: Write tests**

Tests must cover: admin can create direct upload; upload attaches to lesson; Mux webhook updates video asset status; student playback token is denied without enrollment; enrolled student receives signed playback data.

- [ ] **Step 4: Implement routes**

Expose:
```text
POST /v1/admin/lessons/:lessonId/video-upload
POST /v1/webhooks/mux
GET /v1/student/lessons/:lessonId/playback
```

- [ ] **Step 5: Verify raw body webhook handling**

Ensure Mux signature verification reads the raw request body before parsing. Add a test that fails if parsed JSON is used instead of the raw body for signature verification.

- [ ] **Step 6: Verify**

Run:
```bash
npm test -- tests/video.test.ts
npm run build
```

- [ ] **Step 7: Commit**

Run:
```bash
git add .
git commit -m "feat(api): add mux video workflow"
```

## Phase 3: Payments, Enrollment, and Progress API

### Task 6: Implement Helcim checkout initialization and webhook-confirmed enrollment

**Files:**
- Create: `/Users/dardan/workspace/lash-her-course-api/src/payments/helcim.client.ts`
- Create: `/Users/dardan/workspace/lash-her-course-api/src/payments/payment.routes.ts`
- Create: `/Users/dardan/workspace/lash-her-course-api/src/payments/payment.repository.ts`
- Modify: `/Users/dardan/workspace/lash-her-course-api/src/app.ts`
- Test: `/Users/dardan/workspace/lash-her-course-api/tests/payments.test.ts`

- [ ] **Step 1: Add Helcim env vars**

Add `HELCIM_API_TOKEN`, `HELCIM_WEBHOOK_VERIFIER_TOKEN`, `HELCIM_API_BASE_URL`, `MARKETING_SITE_URL`, and `ADMIN_SITE_URL` to `src/config/env.ts`.

- [ ] **Step 2: Write checkout tests**

Tests must cover: checkout creates pending order; checkout uses server-side course price; browser success validation records payment event but does not enroll; webhook confirmation enrolls; duplicate webhook does not duplicate enrollment; mismatched amount is rejected.

- [ ] **Step 3: Implement Helcim client**

Implement checkout initialization against HelcimPay.js initialize endpoint. Store `checkoutToken`, `secretToken`, expiry, expected amount/currency, and internal order ID.

- [ ] **Step 4: Implement routes**

Expose:
```text
POST /v1/checkout/course/:courseId
POST /v1/checkout/helcim-success
POST /v1/webhooks/helcim
```

- [ ] **Step 5: Verify raw body webhook handling**

Helcim webhook signature verification must use raw body, `webhook-id`, `webhook-timestamp`, and `webhook-signature` headers. Add a replay/idempotency record keyed by webhook ID and transaction ID.

- [ ] **Step 6: Verify**

Run:
```bash
npm test -- tests/payments.test.ts
npm run build
```

- [ ] **Step 7: Commit**

Run:
```bash
git add .
git commit -m "feat(api): add helcim checkout fulfillment"
```

### Task 7: Implement enrollments, refunds, and progress

**Files:**
- Create: `/Users/dardan/workspace/lash-her-course-api/src/enrollments/enrollment.routes.ts`
- Create: `/Users/dardan/workspace/lash-her-course-api/src/enrollments/enrollment.repository.ts`
- Create: `/Users/dardan/workspace/lash-her-course-api/src/progress/progress.routes.ts`
- Create: `/Users/dardan/workspace/lash-her-course-api/src/progress/progress.repository.ts`
- Modify: `/Users/dardan/workspace/lash-her-course-api/src/app.ts`
- Test: `/Users/dardan/workspace/lash-her-course-api/tests/enrollments-progress.test.ts`

- [ ] **Step 1: Write tests**
Tests must cover: student sees active enrollments; revoked/refunded enrollment loses access; admin marks enrollment refunded with external reference and note; video progress only increases unless explicit reset; lesson completion is idempotent.

- [ ] **Step 2: Implement routes**
Expose:
```text
GET /v1/student/enrollments
GET /v1/student/courses/:courseId
PATCH /v1/student/lessons/:lessonId/progress
POST /v1/student/lessons/:lessonId/complete
GET /v1/admin/enrollments
POST /v1/admin/enrollments/:enrollmentId/refund-mark
POST /v1/admin/enrollments/:enrollmentId/revoke
```

- [ ] **Step 3: Implement audit events**
Every admin refund/revoke action writes an `admin_actions` row and an `operational_events` row.

- [ ] **Step 4: Verify**
Run:
```bash
npm test -- tests/enrollments-progress.test.ts
npm run build
```

- [ ] **Step 5: Commit**
Run:
```bash
git add .
git commit -m "feat(api): add enrollment and progress workflows"
```

### Task 8: Generate and publish API contract

**Files:**
- Create: `/Users/dardan/workspace/lash-her-course-api/scripts/generate-client.ts`
- Create: `/Users/dardan/workspace/lash-her-course-api/generated/client/`
- Modify: `/Users/dardan/workspace/lash-her-course-api/package.json`

- [ ] **Step 1: Add contract generation script**
Add a script that starts the app in test mode, fetches `/v1/openapi.json`, and generates TypeScript types/client into `generated/client`.

- [ ] **Step 2: Add npm script**
Add:
```json
{
  "generate:client": "tsx scripts/generate-client.ts"
}
```

- [ ] **Step 3: Verify**
Run:
```bash
npm run generate:client
npm run build
```

- [ ] **Step 4: Commit**
Run:
```bash
git add .
git commit -m "feat(api): publish generated client contract"
```

## Phase 4: Admin Dashboard

### Task 9: Create Next.js admin dashboard repository

**Files:**
- Create: `/Users/dardan/workspace/lash-her-course-admin/package.json`
- Create: `/Users/dardan/workspace/lash-her-course-admin/src/app/layout.tsx`
- Create: `/Users/dardan/workspace/lash-her-course-admin/src/app/page.tsx`
- Create: `/Users/dardan/workspace/lash-her-course-admin/src/lib/api-client.ts`
- Create: `/Users/dardan/workspace/lash-her-course-admin/src/lib/clerk.ts`

- [ ] **Step 1: Scaffold Next.js app**
Run:
```bash
npx create-next-app@latest /Users/dardan/workspace/lash-her-course-admin --ts --eslint --app --src-dir --tailwind --use-npm
cd /Users/dardan/workspace/lash-her-course-admin
git init
```

- [ ] **Step 2: Install Clerk and UI dependencies**
Run:
```bash
npm install @clerk/nextjs lucide-react class-variance-authority clsx tailwind-merge
```

- [ ] **Step 3: Configure environment**
Create `.env.local.example` with `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, and `NEXT_PUBLIC_COURSE_API_URL`.

- [ ] **Step 4: Add authenticated shell**
Use Clerk middleware and layout protection so every admin route requires login. Still rely on API admin authorization for real permission checks.

- [ ] **Step 5: Verify**
Run:
```bash
npm run lint
npm run build
```

- [ ] **Step 6: Commit**
Run:
```bash
git add .
git commit -m "feat(admin): scaffold dashboard app"
```

### Task 10: Implement admin course management UI

**Files:**
- Create: `/Users/dardan/workspace/lash-her-course-admin/src/app/courses/page.tsx`
- Create: `/Users/dardan/workspace/lash-her-course-admin/src/app/courses/[courseId]/page.tsx`
- Create: `/Users/dardan/workspace/lash-her-course-admin/src/components/courses/course-form.tsx`
- Create: `/Users/dardan/workspace/lash-her-course-admin/src/components/courses/module-list.tsx`
- Create: `/Users/dardan/workspace/lash-her-course-admin/src/components/courses/lesson-form.tsx`
- Create: `/Users/dardan/workspace/lash-her-course-admin/src/components/video/video-upload-panel.tsx`

- [ ] **Step 1: Copy generated API client from API repo**
Copy `/Users/dardan/workspace/lash-her-course-api/generated/client` into `src/lib/course-api-client` or install it as a package if published.

- [ ] **Step 2: Implement course list and editor**
Build pages for list/create/edit/publish/unpublish of courses, modules, and lessons using API admin endpoints.

- [ ] **Step 3: Implement Mux upload panel**
Use `POST /v1/admin/lessons/:lessonId/video-upload` to obtain upload details and upload directly to Mux. Show processing status from the API.

- [ ] **Step 4: Verify**
Run:
```bash
npm run lint
npm run build
```

- [ ] **Step 5: Commit**
Run:
```bash
git add .
git commit -m "feat(admin): add course management workflow"
```

### Task 11: Implement admin enrollment and operational views

**Files:**
- Create: `/Users/dardan/workspace/lash-her-course-admin/src/app/enrollments/page.tsx`
- Create: `/Users/dardan/workspace/lash-her-course-admin/src/app/operations/page.tsx`
- Create: `/Users/dardan/workspace/lash-her-course-admin/src/components/enrollments/enrollment-table.tsx`
- Create: `/Users/dardan/workspace/lash-her-course-admin/src/components/enrollments/refund-mark-dialog.tsx`
- Create: `/Users/dardan/workspace/lash-her-course-admin/src/components/operations/operational-events-table.tsx`

- [ ] **Step 1: Implement enrollment lookup**
Admin can search enrollments/orders and inspect status, course, user, and payment references.

- [ ] **Step 2: Implement manual refund/revoke actions**
Dialog requires external Helcim reference and admin note before calling refund/revoke endpoints.

- [ ] **Step 3: Implement operations page**
Show failed Helcim webhook events, failed Mux webhook events, video processing issues, and recent admin actions.

- [ ] **Step 4: Verify**
Run:
```bash
npm run lint
npm run build
```

- [ ] **Step 5: Commit**
Run:
```bash
git add .
git commit -m "feat(admin): add enrollment operations views"
```

## Phase 5: Existing Marketing Frontend Integration

### Task 12: Add course API client and Clerk to marketing frontend

**Files:**
- Modify: `/Users/dardan/Documents/lash-her/frontend/package.json`
- Create: `/Users/dardan/Documents/lash-her/frontend/src/lib/course-api/client.ts`
- Create: `/Users/dardan/Documents/lash-her/frontend/src/lib/course-api/types.ts`
- Modify: `/Users/dardan/Documents/lash-her/frontend/src/app/layout.tsx`
- Create: `/Users/dardan/Documents/lash-her/frontend/middleware.ts`

- [ ] **Step 1: Install Clerk**
Run from `/Users/dardan/Documents/lash-her/frontend`:
```bash
npm install @clerk/nextjs
```

- [ ] **Step 2: Add env example entries**
Add `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, and `NEXT_PUBLIC_COURSE_API_URL` to the frontend env example file.

- [ ] **Step 3: Add API client**
Create a server-safe API client that calls the course API with Clerk auth where required and handles the API error envelope.

- [ ] **Step 4: Wire Clerk provider**
Wrap the root layout with Clerk provider without breaking existing fonts, Vercel Analytics, Sanity Studio, or marketing pages.

- [ ] **Step 5: Verify**
Run from `/Users/dardan/Documents/lash-her/frontend`:
```bash
npm run lint
npm run build
```

- [ ] **Step 6: Commit**
Run from `/Users/dardan/Documents/lash-her`:
```bash
git add frontend
git commit -m "feat(frontend): add course api auth foundation"
```

### Task 13: Add public course sales pages and checkout launch

**Files:**
- Create: `/Users/dardan/Documents/lash-her/frontend/src/app/(site)/courses/[slug]/page.tsx`
- Create: `/Users/dardan/Documents/lash-her/frontend/src/components/courses/course-sales-page.tsx`
- Create: `/Users/dardan/Documents/lash-her/frontend/src/components/courses/course-checkout-button.tsx`
- Create: `/Users/dardan/Documents/lash-her/frontend/src/components/courses/helcim-pay-modal.tsx`
- Test: `/Users/dardan/Documents/lash-her/frontend/tests/course-sales.spec.ts`

- [ ] **Step 1: Write Playwright test**
Test `/courses/sample-course` renders title, price, modules/lessons preview, and a purchase CTA. Mock API responses using Playwright route interception.

- [ ] **Step 2: Implement sales page route**
Server component fetches public course by slug from API. Use existing design tokens and layout conventions from the marketing app.

- [ ] **Step 3: Implement checkout button and Helcim iframe modal**
Button requests `POST /v1/checkout/course/:courseId`, loads HelcimPay.js script, renders iframe with checkout token, forwards browser success response to API for recording, and displays “payment pending confirmation” until webhook-confirmed enrollment is visible.

- [ ] **Step 4: Verify**
Run from `/Users/dardan/Documents/lash-her/frontend`:
```bash
npx playwright test tests/course-sales.spec.ts --project=chromium
npm run build
```

- [ ] **Step 5: Commit**
Run from `/Users/dardan/Documents/lash-her`:
```bash
git add frontend
git commit -m "feat(frontend): add course sales checkout flow"
```

### Task 14: Add protected student learning UI

**Files:**
- Create: `/Users/dardan/Documents/lash-her/frontend/src/app/(site)/learn/page.tsx`
- Create: `/Users/dardan/Documents/lash-her/frontend/src/app/(site)/learn/[courseSlug]/[lessonSlug]/page.tsx`
- Create: `/Users/dardan/Documents/lash-her/frontend/src/components/learn/course-library.tsx`
- Create: `/Users/dardan/Documents/lash-her/frontend/src/components/learn/lesson-player.tsx`
- Create: `/Users/dardan/Documents/lash-her/frontend/src/components/learn/progress-sidebar.tsx`
- Test: `/Users/dardan/Documents/lash-her/frontend/tests/learn.spec.ts`

- [ ] **Step 1: Write Playwright tests**
Tests cover unauthenticated redirect/sign-in prompt, enrolled student sees course library, protected lesson renders signed Mux player data, progress update sends API request, revoked enrollment shows access denied.

- [ ] **Step 2: Implement `/learn`**
Fetch student enrollments from API and render course cards with progress percentage.

- [ ] **Step 3: Implement protected lesson page**
Fetch lesson detail and signed playback token from API. Render Mux-compatible player and module/lesson sidebar.

- [ ] **Step 4: Implement progress events**
Throttle video resume updates and send lesson completion events idempotently to the API.

- [ ] **Step 5: Verify**
Run from `/Users/dardan/Documents/lash-her/frontend`:
```bash
npx playwright test tests/learn.spec.ts --project=chromium
npm run build
```

- [ ] **Step 6: Commit**
Run from `/Users/dardan/Documents/lash-her`:
```bash
git add frontend
git commit -m "feat(frontend): add student learning experience"
```

## Phase 6: End-to-End Verification and Launch Readiness

### Task 15: Add integration test matrix and deployment docs

**Files:**
- Create: `/Users/dardan/workspace/lash-her-course-api/docs/deployment.md`
- Create: `/Users/dardan/workspace/lash-her-course-admin/docs/deployment.md`
- Create: `/Users/dardan/Documents/lash-her/docs/course-platform-integration.md`
- Modify: README files in API and admin repos

- [ ] **Step 1: Document required environment variables**
Document Clerk, Helcim, Mux, PostgreSQL, marketing/admin URLs, webhook secrets, and CORS origins for each app.

- [ ] **Step 2: Document webhook setup**
Include exact webhook endpoints:
```text
POST https://api-domain.example/v1/webhooks/helcim
POST https://api-domain.example/v1/webhooks/mux
```

- [ ] **Step 3: Document E2E smoke flow**
Smoke flow: create course in admin, upload video, publish course, view sales page, start checkout, confirm Helcim webhook in test mode, verify enrollment, watch lesson, update progress, manually mark refund/revoke, verify access denied.

- [ ] **Step 4: Verify all apps**
Run:
```bash
cd /Users/dardan/workspace/lash-her-course-api && npm test && npm run build
cd /Users/dardan/workspace/lash-her-course-admin && npm run lint && npm run build
cd /Users/dardan/Documents/lash-her/frontend && npm run lint && npm run build && npx playwright test --project=chromium
```

- [ ] **Step 5: Commit docs in each repo**
Run the appropriate `git add` and `git commit` in each repository using conventional commit messages:
```bash
cd /Users/dardan/workspace/lash-her-course-api && git add docs README.md && git commit -m "docs(api): add deployment guide"
cd /Users/dardan/workspace/lash-her-course-admin && git add docs README.md && git commit -m "docs(admin): add deployment guide"
cd /Users/dardan/Documents/lash-her && git add docs/course-platform-integration.md && git commit -m "docs: add course platform integration guide"
```

## Final Acceptance Checklist

- [ ] API owns course content, pricing, payments, enrollments, video authorization, progress, and admin authorization.
- [ ] Browser Helcim success alone never grants enrollment.
- [ ] Helcim webhook handling verifies signatures and is idempotent.
- [ ] Mux playback tokens are short-lived and entitlement-gated.
- [ ] Clerk authenticates; API authorizes.
- [ ] Admin dashboard cannot bypass API authorization.
- [ ] Marketing frontend renders course sales and student learning UI using API data.
- [ ] Progress supports video resume and lesson completion.
- [ ] Manual refund/revocation workflow records admin action, notes, and Helcim references.
- [ ] OpenAPI/generated TypeScript contract is available to admin and marketing apps.
- [ ] API tests pass.
- [ ] Admin build passes.
- [ ] Marketing frontend lint, build, and relevant Playwright tests pass.
