# Admin Dashboard V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the safe V1 admin dashboard foundation at `/admin` with managed auth, owner/operator roles, audit logging, privacy request tracking, request-linked owner exports, read-only domain workspaces, and an operations-inbox command center.

**Architecture:** Add a focused admin boundary under `src/lib/admin` for auth, permissions, audit, privacy cases, exports, and read models. Use Clerk for managed identity, private DB tables for internal admin roles/audit/privacy evidence, and server-rendered App Router pages that call UI-ready admin query functions.

**Tech Stack:** Next.js 16 App Router, React 18 server components, Clerk Next.js SDK, Drizzle ORM/PostgreSQL, Node test runner through `tsx`, Tailwind v4 CSS tokens.

---

## Scope

This plan implements the V1 safe foundation from `docs/superpowers/specs/2026-06-02-admin-dashboard-design.md`.

Included:

- Clerk-managed sign-in protection for `/admin`.
- Internal admin role resolution with `owner` and `operator` roles.
- New private DB tables for admin users, audit log entries, privacy requests, and privacy request events.
- Audit logging for sensitive admin access and actions.
- Read-only command center, revenue, orders, bookings, training, marketing, privacy, and audit screens.
- Owner-only full JSON export tied to active privacy requests.
- Friendly read models that separate product, service, training, marketing, and privacy language.

Excluded from V1:

- Direct private-record redaction or deletion execution.
- Broad CSV/report exports.
- Raw webhook payload display in normal UI.
- Direct booking creation.
- Raw payment provider field editing.
- Cross-domain notes/tags outside privacy request events.

## File Structure

Create or modify these files:

- Modify `package.json` and `package-lock.json`: add `@clerk/nextjs`.
- Modify `.env.local.example`: document Clerk keys and admin allowlist env vars.
- Modify `src/app/layout.tsx`: wrap app in `ClerkProvider`.
- Create `src/middleware.ts`: protect `/admin` through Clerk middleware.
- Modify `src/lib/private-db/schema.ts`: add admin role/status/request/event enums and admin tables.
- Modify `src/lib/private-db/schema.test.ts`: verify admin enum/table shape.
- Create `src/lib/env/admin.ts`: parse owner/operator allowlist env vars and environment label.
- Create `src/lib/env/admin.test.ts`: test allowlist parsing and normalization.
- Create `src/lib/admin/types.ts`: shared admin role, user, audit, privacy, read-model types.
- Create `src/lib/admin/admin-user-store.ts`: private DB persistence for admin users.
- Create `src/lib/admin/admin-user-store.test.ts`: test role bootstrap and disabled-user behavior through a fake repository.
- Create `src/lib/admin/auth.ts`: Clerk-backed admin resolution and owner/admin guards with dependency injection for tests.
- Create `src/lib/admin/auth.test.ts`: test anonymous, unapproved, owner, operator, and disabled-user cases.
- Create `src/lib/admin/permissions.ts`: role/action/domain policy.
- Create `src/lib/admin/permissions.test.ts`: test owner/operator allow and deny matrix.
- Create `src/lib/admin/audit-log.ts`: audit event writer.
- Create `src/lib/admin/audit-log.test.ts`: test metadata minimization and required fields.
- Create `src/lib/admin/privacy-requests.ts`: privacy case creation, event append, lookup, status transitions.
- Create `src/lib/admin/privacy-requests.test.ts`: test privacy request lifecycle.
- Create `src/lib/admin/read-models.ts`: pure mapping helpers for friendly statuses and UI rows.
- Create `src/lib/admin/read-models.test.ts`: test product/service/training/revenue/marketing row mapping.
- Create `src/lib/admin/queries.ts`: Drizzle-backed dashboard and domain query functions.
- Create `src/lib/admin/queries.test.ts`: test query composition through a fake repository and read-model mapping.
- Create `src/lib/admin/privacy-export.ts`: owner-only privacy export builder.
- Create `src/lib/admin/privacy-export.test.ts`: test request-linked export grouping and sensitive-field exclusion.
- Create `src/components/admin/admin-shell.tsx`: admin shell layout, side nav, environment/role display.
- Create `src/components/admin/admin-card.tsx`: reusable summary card.
- Create `src/components/admin/admin-table.tsx`: simple accessible table wrapper.
- Create `src/components/admin/status-pill.tsx`: status label component.
- Create `src/components/admin/operations-inbox.tsx`: command-center task list.
- Create `src/app/admin/(protected)/layout.tsx`: protected admin layout.
- Create `src/app/admin/(protected)/page.tsx`: command center page.
- Create `src/app/admin/(protected)/revenue/page.tsx`: unified purchase/revenue page.
- Create `src/app/admin/(protected)/orders/page.tsx`: product order list page.
- Create `src/app/admin/(protected)/bookings/page.tsx`: service booking list page.
- Create `src/app/admin/(protected)/training/page.tsx`: training enrollment list page.
- Create `src/app/admin/(protected)/marketing/page.tsx`: marketing intelligence page.
- Create `src/app/admin/(protected)/privacy/actions.ts`: server actions for privacy request creation and events.
- Create `src/app/admin/(protected)/privacy/page.tsx`: privacy request list/create page.
- Create `src/app/admin/(protected)/privacy/[id]/page.tsx`: privacy request detail page.
- Create `src/app/admin/(protected)/privacy/[id]/export/route.ts`: owner-only privacy export route.
- Create `src/app/admin/(protected)/privacy/[id]/export/route.test.ts`: route tests for owner/operator/export validation.
- Create `src/app/admin/(protected)/audit/page.tsx`: owner-only audit log page.
- Create `src/app/admin/not-authorized/page.tsx`: denied-access screen.
- Modify `README.md`: add admin dashboard setup notes.
- Modify `docs/launch-readiness-checklist.md`: replace the admin UI blocker with required verification evidence after implementation.

## Data Model Decisions

Use private DB tables, not Clerk metadata alone, for internal roles and audit linkage. Clerk provides identity; the private DB stores the app-specific role and status.

Bootstrap rules:

- `ADMIN_OWNER_EMAILS` is a comma-separated server-only allowlist.
- `ADMIN_OPERATOR_EMAILS` is a comma-separated server-only allowlist.
- On first admin access, if the Clerk primary email is in an allowlist, create or update the matching `admin_users` row with that role and status `active`.
- If an `admin_users` row exists with status `disabled`, deny access even if the email remains in the allowlist.
- If an email appears in both allowlists, owner wins.

Export format:

- V1 exports JSON with grouped records.
- The response uses `Content-Type: application/json` and `Content-Disposition: attachment; filename="privacy-export-<request-id>.json"`.
- Payment event export data is limited to safe summaries: event type, provider, processing status, amount, currency, provider status, processed timestamp, and created timestamp.

---

## Task 1: Add Clerk Dependency And Runtime Configuration

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.env.local.example`
- Modify: `src/app/layout.tsx`
- Create: `src/middleware.ts`

- [ ] **Step 1: Install Clerk SDK**

Run:

```bash
npm install @clerk/nextjs
```

Expected: `package.json` contains `@clerk/nextjs` under `dependencies`, and `package-lock.json` is updated.

- [ ] **Step 2: Document admin auth env vars**

Modify `.env.local.example` by inserting this block after the Sanity token section and before Email:

```dotenv
# Admin Dashboard Auth (Clerk)
# Create these in the Clerk dashboard for local, preview, and production environments.
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=replace_with_clerk_publishable_key
CLERK_SECRET_KEY=replace_with_clerk_secret_key
# Comma-separated server-only allowlists. Owner wins if an email appears in both lists.
ADMIN_OWNER_EMAILS=owner@example.com
ADMIN_OPERATOR_EMAILS=operator@example.com
```

- [ ] **Step 3: Wrap the root app with ClerkProvider**

Modify `src/app/layout.tsx`:

```tsx
import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import { draftMode } from "next/headers";
import type { ReactNode } from "react";
import { loaders } from "@/data/loaders";
import { Bebas_Neue, Inter } from "next/font/google";
import { VisualEditing } from "next-sanity/visual-editing";
import "./globals.css";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

const bebasNeue = Bebas_Neue({
  variable: "--font-bebas-neue",
  subsets: ["latin"],
  weight: ["400"],
  display: "swap",
});

export async function generateMetadata(): Promise<Metadata> {
  const metadata = await loaders.getMetaData();

  const title = metadata?.title ?? "Lash Her by Nataliea";
  const description =
    metadata?.description ??
    "Elevating beauty through bespoke lash artistry and professional education.";

  const ogImage = metadata?.ogImageUrl
    ? { url: metadata.ogImageUrl, width: 1200, height: 630, alt: title }
    : { url: "/og-default.jpg", width: 1200, height: 630, alt: title };

  return {
    metadataBase: new URL("https://lashher.com"),
    title: {
      default: title,
      template: "%s | Lash Her by Nataliea",
    },
    description,
    openGraph: {
      type: "website",
      locale: "en_US",
      siteName: "Lash Her by Nataliea",
      title,
      description,
      images: [ogImage],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [ogImage.url],
    },
  };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  const { isEnabled } = await draftMode();

  return (
    <ClerkProvider>
      <html lang="en">
        <body className={`${bebasNeue.variable} ${inter.variable} antialiased`}>
          {children}
          {isEnabled && <VisualEditing />}
          <SpeedInsights />
          <Analytics />
        </body>
      </html>
    </ClerkProvider>
  );
}
```

- [ ] **Step 4: Protect admin routes in middleware**

Create `src/middleware.ts`:

```ts
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

const isAdminRoute = createRouteMatcher(["/admin(.*)"]);

export default clerkMiddleware(async (auth, req) => {
  if (isAdminRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/(.*)",
  ],
};
```

- [ ] **Step 5: Verify TypeScript and lint**

Run:

```bash
npm run lint
```

Expected: lint passes without errors.

- [ ] **Step 6: Commit**

Run:

```bash
git status --short
git add package.json package-lock.json .env.local.example src/app/layout.tsx src/middleware.ts
git commit -m "feat: add managed admin auth foundation"
```

Expected: commit succeeds after user has authorized committing.

---

## Task 2: Add Admin Private DB Schema

**Files:**
- Modify: `src/lib/private-db/schema.ts`
- Modify: `src/lib/private-db/schema.test.ts`

- [ ] **Step 1: Write failing schema tests**

Append these tests to `src/lib/private-db/schema.test.ts` and update the import list to include `adminAuditLogs`, `adminAuditAction`, `adminRole`, `adminUserStatus`, `adminUsers`, `privacyRequestEvents`, `privacyRequestEventType`, `privacyRequests`, `privacyRequestStatus`, and `privacyRequestType`:

```ts
test("admin role and status enums support owner/operator access", () => {
  assert.deepEqual(adminRole.enumValues, ["owner", "operator"]);
  assert.deepEqual(adminUserStatus.enumValues, ["active", "disabled"]);
});

test("privacy request enums support V1 case tracking", () => {
  assert.deepEqual(privacyRequestType.enumValues, [
    "access_export",
    "correction",
    "deletion",
    "redaction",
    "privacy_inquiry",
  ]);
  assert.deepEqual(privacyRequestStatus.enumValues, [
    "open",
    "in_review",
    "exported",
    "pending_technical_action",
    "completed",
    "cancelled",
  ]);
  assert.deepEqual(privacyRequestEventType.enumValues, [
    "created",
    "note_added",
    "records_lookup",
    "export_requested",
    "export_completed",
    "export_failed",
    "decision_recorded",
    "status_changed",
  ]);
});

test("admin audit action enum covers sensitive access and export events", () => {
  assert.deepEqual(adminAuditAction.enumValues, [
    "admin_access",
    "customer_detail_view",
    "privacy_request_view",
    "privacy_records_lookup",
    "privacy_export_attempt",
    "privacy_export_completed",
    "privacy_export_failed",
    "troubleshooting_panel_view",
    "audit_log_view",
    "privacy_event_created",
  ]);
});

test("admin users schema stores provider identity and role", () => {
  const columnNames = Object.keys(adminUsers);

  assert.ok(columnNames.includes("providerUserId"));
  assert.ok(columnNames.includes("email"));
  assert.ok(columnNames.includes("emailNormalized"));
  assert.ok(columnNames.includes("displayName"));
  assert.ok(columnNames.includes("role"));
  assert.ok(columnNames.includes("status"));
  assert.ok(columnNames.includes("createdAt"));
  assert.ok(columnNames.includes("updatedAt"));
});

test("privacy request schema stores subject and case status", () => {
  const columnNames = Object.keys(privacyRequests);

  assert.ok(columnNames.includes("requestType"));
  assert.ok(columnNames.includes("status"));
  assert.ok(columnNames.includes("subjectEmail"));
  assert.ok(columnNames.includes("subjectEmailNormalized"));
  assert.ok(columnNames.includes("requesterName"));
  assert.ok(columnNames.includes("requesterNotes"));
  assert.ok(columnNames.includes("ownerDecision"));
  assert.ok(columnNames.includes("createdByAdminUserId"));
  assert.ok(columnNames.includes("assignedAdminUserId"));
  assert.ok(columnNames.includes("createdAt"));
  assert.ok(columnNames.includes("updatedAt"));
  assert.ok(columnNames.includes("completedAt"));
});

test("privacy request events schema stores append-only case history", () => {
  const columnNames = Object.keys(privacyRequestEvents);

  assert.ok(columnNames.includes("privacyRequestId"));
  assert.ok(columnNames.includes("actorAdminUserId"));
  assert.ok(columnNames.includes("eventType"));
  assert.ok(columnNames.includes("message"));
  assert.ok(columnNames.includes("metadata"));
  assert.ok(columnNames.includes("createdAt"));
});

test("admin audit logs schema stores minimal sensitive-action evidence", () => {
  const columnNames = Object.keys(adminAuditLogs);

  assert.ok(columnNames.includes("actorAdminUserId"));
  assert.ok(columnNames.includes("actorEmail"));
  assert.ok(columnNames.includes("actorRole"));
  assert.ok(columnNames.includes("action"));
  assert.ok(columnNames.includes("domain"));
  assert.ok(columnNames.includes("targetType"));
  assert.ok(columnNames.includes("targetId"));
  assert.ok(columnNames.includes("privacyRequestId"));
  assert.ok(columnNames.includes("reason"));
  assert.ok(columnNames.includes("ipAddress"));
  assert.ok(columnNames.includes("userAgent"));
  assert.ok(columnNames.includes("metadata"));
  assert.ok(columnNames.includes("createdAt"));
});
```

- [ ] **Step 2: Run schema test and verify failure**

Run:

```bash
npx tsx --test src/lib/private-db/schema.test.ts
```

Expected: FAIL with TypeScript import errors for missing admin schema exports.

- [ ] **Step 3: Add admin enums and interfaces**

Modify `src/lib/private-db/schema.ts` after existing enum declarations:

```ts
export const adminRole = pgEnum("admin_role", ["owner", "operator"]);

export const adminUserStatus = pgEnum("admin_user_status", ["active", "disabled"]);

export const privacyRequestType = pgEnum("privacy_request_type", [
  "access_export",
  "correction",
  "deletion",
  "redaction",
  "privacy_inquiry",
]);

export const privacyRequestStatus = pgEnum("privacy_request_status", [
  "open",
  "in_review",
  "exported",
  "pending_technical_action",
  "completed",
  "cancelled",
]);

export const privacyRequestEventType = pgEnum("privacy_request_event_type", [
  "created",
  "note_added",
  "records_lookup",
  "export_requested",
  "export_completed",
  "export_failed",
  "decision_recorded",
  "status_changed",
]);

export const adminAuditAction = pgEnum("admin_audit_action", [
  "admin_access",
  "customer_detail_view",
  "privacy_request_view",
  "privacy_records_lookup",
  "privacy_export_attempt",
  "privacy_export_completed",
  "privacy_export_failed",
  "troubleshooting_panel_view",
  "audit_log_view",
  "privacy_event_created",
]);

export type AdminRole = typeof adminRole.enumValues[number];
export type AdminUserStatus = typeof adminUserStatus.enumValues[number];
export type PrivacyRequestType = typeof privacyRequestType.enumValues[number];
export type PrivacyRequestStatus = typeof privacyRequestStatus.enumValues[number];
export type PrivacyRequestEventType = typeof privacyRequestEventType.enumValues[number];
export type AdminAuditAction = typeof adminAuditAction.enumValues[number];

export interface AdminAuditMetadata {
  [key: string]: unknown;
}

export interface PrivacyRequestEventMetadata {
  [key: string]: unknown;
}
```

- [ ] **Step 4: Add admin tables**

Modify `src/lib/private-db/schema.ts` after `marketingConsentEvents`:

```ts
export const adminUsers = pgTable(
  "admin_users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    providerUserId: text("provider_user_id").notNull().unique(),
    email: text("email").notNull(),
    emailNormalized: text("email_normalized").notNull().unique(),
    displayName: text("display_name"),
    role: adminRole("role").notNull(),
    status: adminUserStatus("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("admin_users_provider_user_id_idx").on(table.providerUserId),
    uniqueIndex("admin_users_email_normalized_idx").on(table.emailNormalized),
  ],
);

export const privacyRequests = pgTable(
  "privacy_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    requestType: privacyRequestType("request_type").notNull(),
    status: privacyRequestStatus("status").notNull().default("open"),
    subjectEmail: text("subject_email").notNull(),
    subjectEmailNormalized: text("subject_email_normalized").notNull(),
    requesterName: text("requester_name"),
    requesterNotes: text("requester_notes"),
    ownerDecision: text("owner_decision"),
    createdByAdminUserId: uuid("created_by_admin_user_id").references(() => adminUsers.id, { onDelete: "set null" }),
    assignedAdminUserId: uuid("assigned_admin_user_id").references(() => adminUsers.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("privacy_requests_subject_email_normalized_idx").on(table.subjectEmailNormalized),
    index("privacy_requests_status_idx").on(table.status),
  ],
);

export const privacyRequestEvents = pgTable(
  "privacy_request_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    privacyRequestId: uuid("privacy_request_id")
      .notNull()
      .references(() => privacyRequests.id, { onDelete: "cascade" }),
    actorAdminUserId: uuid("actor_admin_user_id").references(() => adminUsers.id, { onDelete: "set null" }),
    eventType: privacyRequestEventType("event_type").notNull(),
    message: text("message"),
    metadata: jsonb("metadata").$type<PrivacyRequestEventMetadata>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("privacy_request_events_request_created_idx").on(table.privacyRequestId, table.createdAt),
  ],
);

export const adminAuditLogs = pgTable(
  "admin_audit_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actorAdminUserId: uuid("actor_admin_user_id").references(() => adminUsers.id, { onDelete: "set null" }),
    actorEmail: text("actor_email").notNull(),
    actorRole: adminRole("actor_role").notNull(),
    action: adminAuditAction("action").notNull(),
    domain: text("domain").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    privacyRequestId: uuid("privacy_request_id").references(() => privacyRequests.id, { onDelete: "set null" }),
    reason: text("reason"),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    metadata: jsonb("metadata").$type<AdminAuditMetadata>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("admin_audit_logs_actor_created_idx").on(table.actorAdminUserId, table.createdAt),
    index("admin_audit_logs_privacy_request_idx").on(table.privacyRequestId),
    index("admin_audit_logs_target_idx").on(table.targetType, table.targetId),
  ],
);
```

- [ ] **Step 5: Run schema test and verify pass**

Run:

```bash
npx tsx --test src/lib/private-db/schema.test.ts
```

Expected: PASS.

- [ ] **Step 6: Generate migration**

Run:

```bash
npm run db:generate
```

Expected: one new SQL migration appears in `drizzle/` with admin enums and tables.

- [ ] **Step 7: Commit**

Run:

```bash
git status --short
git add src/lib/private-db/schema.ts src/lib/private-db/schema.test.ts drizzle
git commit -m "feat: add admin private db schema"
```

Expected: commit succeeds after user has authorized committing.

---

## Task 3: Add Admin Environment Parsing

**Files:**
- Create: `src/lib/env/admin.ts`
- Create: `src/lib/env/admin.test.ts`

- [ ] **Step 1: Write failing environment tests**

Create `src/lib/env/admin.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  getAdminEnvironmentLabel,
  parseAdminEmailAllowlists,
  resolveAllowedAdminRole,
} from "./admin";

test("parseAdminEmailAllowlists normalizes comma-separated emails", () => {
  const allowlists = parseAdminEmailAllowlists({
    ADMIN_OWNER_EMAILS: " Owner@Example.com,second@example.com ",
    ADMIN_OPERATOR_EMAILS: " Operator@Example.com ",
  });

  assert.deepEqual([...allowlists.ownerEmails], ["owner@example.com", "second@example.com"]);
  assert.deepEqual([...allowlists.operatorEmails], ["operator@example.com"]);
});

test("resolveAllowedAdminRole gives owner precedence", () => {
  const allowlists = parseAdminEmailAllowlists({
    ADMIN_OWNER_EMAILS: "owner@example.com,dual@example.com",
    ADMIN_OPERATOR_EMAILS: "operator@example.com,dual@example.com",
  });

  assert.equal(resolveAllowedAdminRole("dual@example.com", allowlists), "owner");
  assert.equal(resolveAllowedAdminRole("operator@example.com", allowlists), "operator");
  assert.equal(resolveAllowedAdminRole("unknown@example.com", allowlists), null);
});

test("getAdminEnvironmentLabel returns deployment context", () => {
  assert.equal(getAdminEnvironmentLabel({ VERCEL_ENV: "production" }), "production");
  assert.equal(getAdminEnvironmentLabel({ VERCEL_ENV: "preview" }), "preview");
  assert.equal(getAdminEnvironmentLabel({ NODE_ENV: "development" }), "local");
  assert.equal(getAdminEnvironmentLabel({}), "unknown");
});
```

- [ ] **Step 2: Run test and verify failure**

Run:

```bash
./node_modules/.bin/tsx --conditions=react-server --test src/lib/env/admin.test.ts
```

Expected: FAIL because `src/lib/env/admin.ts` does not exist.

- [ ] **Step 3: Implement admin env parsing**

Create `src/lib/env/admin.ts`:

```ts
import "server-only";

import type { AdminRole } from "@/lib/private-db/schema";

export interface AdminEmailAllowlists {
  ownerEmails: Set<string>;
  operatorEmails: Set<string>;
}

type AdminEnv = Pick<NodeJS.ProcessEnv, "ADMIN_OWNER_EMAILS" | "ADMIN_OPERATOR_EMAILS" | "NODE_ENV" | "VERCEL_ENV">;

export function getAdminEmailAllowlists(env: AdminEnv = process.env): AdminEmailAllowlists {
  return parseAdminEmailAllowlists(env);
}

export function parseAdminEmailAllowlists(env: AdminEnv): AdminEmailAllowlists {
  return {
    ownerEmails: parseEmailSet(env.ADMIN_OWNER_EMAILS),
    operatorEmails: parseEmailSet(env.ADMIN_OPERATOR_EMAILS),
  };
}

export function resolveAllowedAdminRole(
  email: string,
  allowlists: AdminEmailAllowlists,
): AdminRole | null {
  const normalized = normalizeAdminEmail(email);

  if (allowlists.ownerEmails.has(normalized)) {
    return "owner";
  }

  if (allowlists.operatorEmails.has(normalized)) {
    return "operator";
  }

  return null;
}

export function getAdminEnvironmentLabel(env: AdminEnv = process.env): "local" | "preview" | "production" | "unknown" {
  if (env.VERCEL_ENV === "production") {
    return "production";
  }

  if (env.VERCEL_ENV === "preview") {
    return "preview";
  }

  if (env.NODE_ENV === "development") {
    return "local";
  }

  return "unknown";
}

export function normalizeAdminEmail(email: string): string {
  return email.trim().toLowerCase();
}

function parseEmailSet(value: string | undefined): Set<string> {
  const emails = new Set<string>();

  for (const entry of (value ?? "").split(",")) {
    const normalized = normalizeAdminEmail(entry);

    if (normalized.length > 0) {
      emails.add(normalized);
    }
  }

  return emails;
}
```

- [ ] **Step 4: Run test and verify pass**

Run:

```bash
./node_modules/.bin/tsx --conditions=react-server --test src/lib/env/admin.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git status --short
git add src/lib/env/admin.ts src/lib/env/admin.test.ts
git commit -m "feat: add admin environment parsing"
```

Expected: commit succeeds after user has authorized committing.

---

## Task 4: Add Admin User Store And Auth Guards

**Files:**
- Create: `src/lib/admin/types.ts`
- Create: `src/lib/admin/admin-user-store.ts`
- Create: `src/lib/admin/admin-user-store.test.ts`
- Create: `src/lib/admin/auth.ts`
- Create: `src/lib/admin/auth.test.ts`

- [ ] **Step 1: Create shared admin types**

Create `src/lib/admin/types.ts`:

```ts
import type {
  AdminAuditAction,
  AdminRole,
  AdminUserStatus,
  PrivacyRequestEventType,
  PrivacyRequestStatus,
  PrivacyRequestType,
} from "@/lib/private-db/schema";

export type {
  AdminAuditAction,
  AdminRole,
  AdminUserStatus,
  PrivacyRequestEventType,
  PrivacyRequestStatus,
  PrivacyRequestType,
};

export interface AdminUserRecord {
  displayName: string | null;
  email: string;
  emailNormalized: string;
  id: string;
  providerUserId: string;
  role: AdminRole;
  status: AdminUserStatus;
}

export interface AdminActor {
  user: AdminUserRecord;
}

export class AdminAuthError extends Error {
  constructor(public readonly code: "unauthenticated" | "not_allowed" | "disabled" | "forbidden") {
    super(code);
    this.name = "AdminAuthError";
  }
}
```

- [ ] **Step 2: Write failing admin user store tests**

Create `src/lib/admin/admin-user-store.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { createAdminUserStore, type AdminUserRepository } from "./admin-user-store";

function createRepository(): AdminUserRepository & { rows: Map<string, any> } {
  const rows = new Map<string, any>();

  return {
    rows,
    async findByProviderUserId(providerUserId) {
      return [...rows.values()].find((row) => row.providerUserId === providerUserId) ?? null;
    },
    async upsertAllowedAdminUser(input) {
      const existing = [...rows.values()].find((row) => row.emailNormalized === input.emailNormalized);
      const row = {
        id: existing?.id ?? `admin-${rows.size + 1}`,
        providerUserId: input.providerUserId,
        email: input.email,
        emailNormalized: input.emailNormalized,
        displayName: input.displayName ?? null,
        role: input.role,
        status: existing?.status ?? "active",
      };
      rows.set(row.id, row);
      return row;
    },
  };
}

test("admin user store bootstraps allowlisted owner", async () => {
  const repository = createRepository();
  const store = createAdminUserStore(repository);

  const user = await store.findOrCreateAllowedAdminUser({
    allowedRole: "owner",
    displayName: "Owner Example",
    email: "Owner@Example.com",
    providerUserId: "clerk-owner",
  });

  assert.equal(user?.emailNormalized, "owner@example.com");
  assert.equal(user?.role, "owner");
  assert.equal(user?.status, "active");
});

test("admin user store denies disabled user even when allowlisted", async () => {
  const repository = createRepository();
  repository.rows.set("admin-1", {
    id: "admin-1",
    providerUserId: "clerk-disabled",
    email: "disabled@example.com",
    emailNormalized: "disabled@example.com",
    displayName: null,
    role: "owner",
    status: "disabled",
  });
  const store = createAdminUserStore(repository);

  const user = await store.findOrCreateAllowedAdminUser({
    allowedRole: "owner",
    displayName: null,
    email: "disabled@example.com",
    providerUserId: "clerk-disabled",
  });

  assert.equal(user?.status, "disabled");
});
```

- [ ] **Step 3: Run store test and verify failure**

Run:

```bash
./node_modules/.bin/tsx --conditions=react-server --test src/lib/admin/admin-user-store.test.ts
```

Expected: FAIL because `src/lib/admin/admin-user-store.ts` does not exist.

- [ ] **Step 4: Implement admin user store**

Create `src/lib/admin/admin-user-store.ts`:

```ts
import "server-only";

import { eq } from "drizzle-orm";

import { getPrivateDb } from "@/lib/private-db/client";
import { adminUsers, type AdminRole } from "@/lib/private-db/schema";
import { normalizeAdminEmail } from "@/lib/env/admin";

import type { AdminUserRecord } from "./types";

export interface FindOrCreateAllowedAdminUserInput {
  allowedRole: AdminRole;
  displayName: string | null;
  email: string;
  providerUserId: string;
}

export interface AdminUserRepository {
  findByProviderUserId(providerUserId: string): Promise<AdminUserRecord | null>;
  upsertAllowedAdminUser(input: {
    displayName: string | null;
    email: string;
    emailNormalized: string;
    providerUserId: string;
    role: AdminRole;
  }): Promise<AdminUserRecord>;
}

export interface AdminUserStore {
  findOrCreateAllowedAdminUser(input: FindOrCreateAllowedAdminUserInput): Promise<AdminUserRecord | null>;
}

export function createAdminUserStore(repository: AdminUserRepository): AdminUserStore {
  return {
    async findOrCreateAllowedAdminUser(input) {
      const existing = await repository.findByProviderUserId(input.providerUserId);

      if (existing?.status === "disabled") {
        return existing;
      }

      return repository.upsertAllowedAdminUser({
        displayName: input.displayName,
        email: input.email.trim(),
        emailNormalized: normalizeAdminEmail(input.email),
        providerUserId: input.providerUserId,
        role: input.allowedRole,
      });
    },
  };
}

export function createDrizzleAdminUserRepository(): AdminUserRepository {
  const db = getPrivateDb();

  return {
    async findByProviderUserId(providerUserId) {
      const rows = await db
        .select()
        .from(adminUsers)
        .where(eq(adminUsers.providerUserId, providerUserId))
        .limit(1);

      return rows[0] ?? null;
    },
    async upsertAllowedAdminUser(input) {
      const rows = await db
        .insert(adminUsers)
        .values({
          displayName: input.displayName,
          email: input.email,
          emailNormalized: input.emailNormalized,
          providerUserId: input.providerUserId,
          role: input.role,
          status: "active",
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: adminUsers.emailNormalized,
          set: {
            displayName: input.displayName,
            email: input.email,
            providerUserId: input.providerUserId,
            role: input.role,
            updatedAt: new Date(),
          },
        })
        .returning();

      return rows[0];
    },
  };
}

export function getAdminUserStore(): AdminUserStore {
  return createAdminUserStore(createDrizzleAdminUserRepository());
}
```

- [ ] **Step 5: Run store test and verify pass**

Run:

```bash
./node_modules/.bin/tsx --conditions=react-server --test src/lib/admin/admin-user-store.test.ts
```

Expected: PASS.

- [ ] **Step 6: Write failing auth guard tests**

Create `src/lib/admin/auth.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { createAdminAuth } from "./auth";
import { AdminAuthError, type AdminUserRecord } from "./types";

const ownerUser: AdminUserRecord = {
  displayName: "Owner",
  email: "owner@example.com",
  emailNormalized: "owner@example.com",
  id: "admin-owner",
  providerUserId: "clerk-owner",
  role: "owner",
  status: "active",
};

test("requireAdmin rejects anonymous sessions", async () => {
  const auth = createAdminAuth({
    getAllowlists: () => ({ ownerEmails: new Set(), operatorEmails: new Set() }),
    getSessionUser: async () => null,
    userStore: { findOrCreateAllowedAdminUser: async () => null },
  });

  await assert.rejects(
    () => auth.requireAdmin(),
    (error) => error instanceof AdminAuthError && error.code === "unauthenticated",
  );
});

test("requireAdmin rejects signed-in users outside allowlists", async () => {
  const auth = createAdminAuth({
    getAllowlists: () => ({ ownerEmails: new Set(), operatorEmails: new Set() }),
    getSessionUser: async () => ({ displayName: "Visitor", email: "visitor@example.com", providerUserId: "clerk-visitor" }),
    userStore: { findOrCreateAllowedAdminUser: async () => null },
  });

  await assert.rejects(
    () => auth.requireAdmin(),
    (error) => error instanceof AdminAuthError && error.code === "not_allowed",
  );
});

test("requireAdmin returns allowlisted owner", async () => {
  const auth = createAdminAuth({
    getAllowlists: () => ({ ownerEmails: new Set(["owner@example.com"]), operatorEmails: new Set() }),
    getSessionUser: async () => ({ displayName: "Owner", email: "owner@example.com", providerUserId: "clerk-owner" }),
    userStore: { findOrCreateAllowedAdminUser: async () => ownerUser },
  });

  const actor = await auth.requireAdmin();

  assert.equal(actor.user.role, "owner");
});

test("requireOwner rejects operator", async () => {
  const auth = createAdminAuth({
    getAllowlists: () => ({ ownerEmails: new Set(), operatorEmails: new Set(["operator@example.com"]) }),
    getSessionUser: async () => ({ displayName: "Operator", email: "operator@example.com", providerUserId: "clerk-operator" }),
    userStore: {
      findOrCreateAllowedAdminUser: async () => ({
        ...ownerUser,
        email: "operator@example.com",
        emailNormalized: "operator@example.com",
        id: "admin-operator",
        providerUserId: "clerk-operator",
        role: "operator",
      }),
    },
  });

  await assert.rejects(
    () => auth.requireOwner(),
    (error) => error instanceof AdminAuthError && error.code === "forbidden",
  );
});
```

- [ ] **Step 7: Run auth test and verify failure**

Run:

```bash
./node_modules/.bin/tsx --conditions=react-server --test src/lib/admin/auth.test.ts
```

Expected: FAIL because `src/lib/admin/auth.ts` does not exist.

- [ ] **Step 8: Implement auth guards**

Create `src/lib/admin/auth.ts`:

```ts
import "server-only";

import { currentUser } from "@clerk/nextjs/server";

import { getAdminEmailAllowlists, type AdminEmailAllowlists, resolveAllowedAdminRole } from "@/lib/env/admin";

import { getAdminUserStore, type AdminUserStore } from "./admin-user-store";
import { AdminAuthError, type AdminActor } from "./types";

interface SessionUser {
  displayName: string | null;
  email: string;
  providerUserId: string;
}

interface AdminAuthDependencies {
  getAllowlists: () => AdminEmailAllowlists;
  getSessionUser: () => Promise<SessionUser | null>;
  userStore: AdminUserStore;
}

export interface AdminAuthService {
  requireAdmin(): Promise<AdminActor>;
  requireOwner(): Promise<AdminActor>;
}

export function createAdminAuth(dependencies: AdminAuthDependencies): AdminAuthService {
  return {
    async requireAdmin() {
      const sessionUser = await dependencies.getSessionUser();

      if (sessionUser === null) {
        throw new AdminAuthError("unauthenticated");
      }

      const allowedRole = resolveAllowedAdminRole(sessionUser.email, dependencies.getAllowlists());

      if (allowedRole === null) {
        throw new AdminAuthError("not_allowed");
      }

      const user = await dependencies.userStore.findOrCreateAllowedAdminUser({
        allowedRole,
        displayName: sessionUser.displayName,
        email: sessionUser.email,
        providerUserId: sessionUser.providerUserId,
      });

      if (user === null) {
        throw new AdminAuthError("not_allowed");
      }

      if (user.status === "disabled") {
        throw new AdminAuthError("disabled");
      }

      return { user };
    },
    async requireOwner() {
      const actor = await this.requireAdmin();

      if (actor.user.role !== "owner") {
        throw new AdminAuthError("forbidden");
      }

      return actor;
    },
  };
}

export function getAdminAuth(): AdminAuthService {
  return createAdminAuth({
    getAllowlists: getAdminEmailAllowlists,
    getSessionUser: getClerkSessionUser,
    userStore: getAdminUserStore(),
  });
}

async function getClerkSessionUser(): Promise<SessionUser | null> {
  const user = await currentUser();

  if (!user) {
    return null;
  }

  const primaryEmail = user.emailAddresses.find((email) => email.id === user.primaryEmailAddressId)
    ?? user.emailAddresses[0];

  if (!primaryEmail) {
    return null;
  }

  return {
    displayName: [user.firstName, user.lastName].filter(Boolean).join(" ") || user.fullName || null,
    email: primaryEmail.emailAddress,
    providerUserId: user.id,
  };
}
```

- [ ] **Step 9: Run auth and store tests**

Run:

```bash
./node_modules/.bin/tsx --conditions=react-server --test src/lib/admin/auth.test.ts src/lib/admin/admin-user-store.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit**

Run:

```bash
git status --short
git add src/lib/admin/types.ts src/lib/admin/admin-user-store.ts src/lib/admin/admin-user-store.test.ts src/lib/admin/auth.ts src/lib/admin/auth.test.ts
git commit -m "feat: add admin auth guards"
```

Expected: commit succeeds after user has authorized committing.

---

## Task 5: Add Permissions And Audit Logging

**Files:**
- Create: `src/lib/admin/permissions.ts`
- Create: `src/lib/admin/permissions.test.ts`
- Create: `src/lib/admin/audit-log.ts`
- Create: `src/lib/admin/audit-log.test.ts`

- [ ] **Step 1: Write failing permission tests**

Create `src/lib/admin/permissions.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { canAdmin } from "./permissions";

test("owner can export privacy data and review audit logs", () => {
  assert.equal(canAdmin({ role: "owner", action: "privacy:export" }), true);
  assert.equal(canAdmin({ role: "owner", action: "audit:view" }), true);
});

test("operator can view operations but cannot export or review audit logs", () => {
  assert.equal(canAdmin({ role: "operator", action: "orders:view" }), true);
  assert.equal(canAdmin({ role: "operator", action: "bookings:view" }), true);
  assert.equal(canAdmin({ role: "operator", action: "training:view" }), true);
  assert.equal(canAdmin({ role: "operator", action: "marketing:view" }), true);
  assert.equal(canAdmin({ role: "operator", action: "privacy:export" }), false);
  assert.equal(canAdmin({ role: "operator", action: "audit:view" }), false);
  assert.equal(canAdmin({ role: "operator", action: "privacy:decision" }), false);
});
```

- [ ] **Step 2: Run permission tests and verify failure**

Run:

```bash
./node_modules/.bin/tsx --conditions=react-server --test src/lib/admin/permissions.test.ts
```

Expected: FAIL because `src/lib/admin/permissions.ts` does not exist.

- [ ] **Step 3: Implement permissions**

Create `src/lib/admin/permissions.ts`:

```ts
import type { AdminRole } from "./types";

export type AdminPermissionAction =
  | "admin:view"
  | "orders:view"
  | "bookings:view"
  | "training:view"
  | "marketing:view"
  | "revenue:view"
  | "privacy:view"
  | "privacy:create"
  | "privacy:event:create"
  | "privacy:decision"
  | "privacy:export"
  | "audit:view"
  | "troubleshooting:view";

const OWNER_ONLY_ACTIONS = new Set<AdminPermissionAction>([
  "privacy:decision",
  "privacy:export",
  "audit:view",
]);

export function canAdmin(input: { action: AdminPermissionAction; role: AdminRole }): boolean {
  if (input.role === "owner") {
    return true;
  }

  if (OWNER_ONLY_ACTIONS.has(input.action)) {
    return false;
  }

  return input.role === "operator";
}
```

- [ ] **Step 4: Run permission tests and verify pass**

Run:

```bash
./node_modules/.bin/tsx --conditions=react-server --test src/lib/admin/permissions.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write failing audit log tests**

Create `src/lib/admin/audit-log.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { createAuditLogService, type AuditLogRepository } from "./audit-log";

const actor = {
  user: {
    displayName: "Owner",
    email: "owner@example.com",
    emailNormalized: "owner@example.com",
    id: "admin-owner",
    providerUserId: "clerk-owner",
    role: "owner" as const,
    status: "active" as const,
  },
};

test("audit log service stores required actor and target fields", async () => {
  const entries: any[] = [];
  const repository: AuditLogRepository = {
    async createAuditLogEntry(entry) {
      entries.push(entry);
      return { id: "audit-1" };
    },
  };
  const service = createAuditLogService(repository);

  await service.record({
    action: "privacy_export_attempt",
    actor,
    domain: "privacy",
    metadata: { count: 3, customerEmail: "client@example.com", rawPayload: { secret: "hidden" } },
    privacyRequestId: "privacy-1",
    reason: "Customer access request",
    targetId: "privacy-1",
    targetType: "privacy_request",
  });

  assert.equal(entries[0].actorAdminUserId, "admin-owner");
  assert.equal(entries[0].actorEmail, "owner@example.com");
  assert.equal(entries[0].actorRole, "owner");
  assert.equal(entries[0].action, "privacy_export_attempt");
  assert.equal(entries[0].privacyRequestId, "privacy-1");
  assert.deepEqual(entries[0].metadata, { count: 3 });
});
```

- [ ] **Step 6: Run audit tests and verify failure**

Run:

```bash
./node_modules/.bin/tsx --conditions=react-server --test src/lib/admin/audit-log.test.ts
```

Expected: FAIL because `src/lib/admin/audit-log.ts` does not exist.

- [ ] **Step 7: Implement audit log service**

Create `src/lib/admin/audit-log.ts`:

```ts
import "server-only";

import { desc } from "drizzle-orm";

import { getPrivateDb } from "@/lib/private-db/client";
import { adminAuditLogs, type AdminAuditAction, type AdminAuditMetadata, type AdminRole } from "@/lib/private-db/schema";

import type { AdminActor } from "./types";

export interface AuditLogEntryInput {
  action: AdminAuditAction;
  actor: AdminActor;
  domain: string;
  ipAddress?: string;
  metadata?: AdminAuditMetadata;
  privacyRequestId?: string;
  reason?: string;
  targetId?: string;
  targetType?: string;
  userAgent?: string;
}

interface AuditLogInsert {
  action: AdminAuditAction;
  actorAdminUserId: string;
  actorEmail: string;
  actorRole: AdminRole;
  domain: string;
  ipAddress?: string;
  metadata?: AdminAuditMetadata;
  privacyRequestId?: string;
  reason?: string;
  targetId?: string;
  targetType?: string;
  userAgent?: string;
}

export interface AuditLogRepository {
  createAuditLogEntry(entry: AuditLogInsert): Promise<{ id: string }>;
}

export function createAuditLogService(repository: AuditLogRepository) {
  return {
    async record(input: AuditLogEntryInput): Promise<{ id: string }> {
      return repository.createAuditLogEntry({
        action: input.action,
        actorAdminUserId: input.actor.user.id,
        actorEmail: input.actor.user.emailNormalized,
        actorRole: input.actor.user.role,
        domain: input.domain,
        ipAddress: input.ipAddress,
        metadata: sanitizeAuditMetadata(input.metadata),
        privacyRequestId: input.privacyRequestId,
        reason: input.reason,
        targetId: input.targetId,
        targetType: input.targetType,
        userAgent: input.userAgent,
      });
    },
  };
}

export function createDrizzleAuditLogRepository(): AuditLogRepository {
  const db = getPrivateDb();

  return {
    async createAuditLogEntry(entry) {
      const rows = await db.insert(adminAuditLogs).values(entry).returning({ id: adminAuditLogs.id });

      return rows[0];
    },
  };
}

export function getAuditLogService() {
  return createAuditLogService(createDrizzleAuditLogRepository());
}

export async function listRecentAuditLogEntries(limit = 50) {
  const db = getPrivateDb();

  return db.select().from(adminAuditLogs).orderBy(desc(adminAuditLogs.createdAt)).limit(limit);
}

function sanitizeAuditMetadata(metadata: AdminAuditMetadata | undefined): AdminAuditMetadata | undefined {
  if (!metadata) {
    return undefined;
  }

  const sanitized: AdminAuditMetadata = {};

  for (const [key, value] of Object.entries(metadata)) {
    const lowerKey = key.toLowerCase();

    if (lowerKey.includes("email") || lowerKey.includes("payload") || lowerKey.includes("token") || lowerKey.includes("secret")) {
      continue;
    }

    sanitized[key] = value;
  }

  return sanitized;
}
```

- [ ] **Step 8: Run audit and permission tests**

Run:

```bash
./node_modules/.bin/tsx --conditions=react-server --test src/lib/admin/permissions.test.ts src/lib/admin/audit-log.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

Run:

```bash
git status --short
git add src/lib/admin/permissions.ts src/lib/admin/permissions.test.ts src/lib/admin/audit-log.ts src/lib/admin/audit-log.test.ts
git commit -m "feat: add admin permissions and audit logging"
```

Expected: commit succeeds after user has authorized committing.

---

## Task 6: Add Privacy Request Lifecycle Service

**Files:**
- Create: `src/lib/admin/privacy-requests.ts`
- Create: `src/lib/admin/privacy-requests.test.ts`

- [ ] **Step 1: Write failing privacy lifecycle tests**

Create `src/lib/admin/privacy-requests.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { createPrivacyRequestService, type PrivacyRequestRepository } from "./privacy-requests";

const actor = {
  user: {
    displayName: "Owner",
    email: "owner@example.com",
    emailNormalized: "owner@example.com",
    id: "admin-owner",
    providerUserId: "clerk-owner",
    role: "owner" as const,
    status: "active" as const,
  },
};

function createRepository(): PrivacyRequestRepository & { events: any[]; requests: any[] } {
  const events: any[] = [];
  const requests: any[] = [];

  return {
    events,
    requests,
    async createPrivacyRequest(input) {
      const request = {
        id: "privacy-1",
        completedAt: null,
        ownerDecision: null,
        status: "open",
        ...input,
      };
      requests.push(request);
      return request;
    },
    async createPrivacyRequestEvent(input) {
      events.push({ id: `event-${events.length + 1}`, ...input });
      return { id: `event-${events.length}` };
    },
    async findPrivacyRequestById(id) {
      return requests.find((request) => request.id === id) ?? null;
    },
    async listPrivacyRequestEvents(privacyRequestId) {
      return events.filter((event) => event.privacyRequestId === privacyRequestId);
    },
    async updatePrivacyRequestStatus(id, status, completedAt) {
      const request = requests.find((row) => row.id === id);
      request.status = status;
      request.completedAt = completedAt;
      return request;
    },
  };
}

test("privacy request service creates request and created event", async () => {
  const repository = createRepository();
  const service = createPrivacyRequestService(repository);

  const request = await service.createRequest({
    actor,
    requestType: "access_export",
    requesterName: "Client Example",
    requesterNotes: "Customer asked for records",
    subjectEmail: " Client@Example.com ",
  });

  assert.equal(request.subjectEmailNormalized, "client@example.com");
  assert.equal(repository.events[0].eventType, "created");
  assert.equal(repository.events[0].actorAdminUserId, "admin-owner");
});

test("privacy request service records status changes", async () => {
  const repository = createRepository();
  const service = createPrivacyRequestService(repository);
  const request = await service.createRequest({
    actor,
    requestType: "access_export",
    subjectEmail: "client@example.com",
  });

  await service.changeStatus({ actor, privacyRequestId: request.id, status: "exported" });

  assert.equal(repository.requests[0].status, "exported");
  assert.equal(repository.events.at(-1).eventType, "status_changed");
});
```

- [ ] **Step 2: Run privacy tests and verify failure**

Run:

```bash
./node_modules/.bin/tsx --conditions=react-server --test src/lib/admin/privacy-requests.test.ts
```

Expected: FAIL because `src/lib/admin/privacy-requests.ts` does not exist.

- [ ] **Step 3: Implement privacy request service**

Create `src/lib/admin/privacy-requests.ts`:

```ts
import "server-only";

import { desc, eq } from "drizzle-orm";

import { normalizeAdminEmail } from "@/lib/env/admin";
import { getPrivateDb } from "@/lib/private-db/client";
import {
  privacyRequestEvents,
  privacyRequests,
  type PrivacyRequestEventMetadata,
  type PrivacyRequestEventType,
  type PrivacyRequestStatus,
  type PrivacyRequestType,
} from "@/lib/private-db/schema";

import type { AdminActor } from "./types";

type PrivacyRequestRow = typeof privacyRequests.$inferSelect;
type PrivacyRequestEventRow = typeof privacyRequestEvents.$inferSelect;

export interface CreatePrivacyRequestInput {
  actor: AdminActor;
  requestType: PrivacyRequestType;
  requesterName?: string;
  requesterNotes?: string;
  subjectEmail: string;
}

export interface ChangePrivacyRequestStatusInput {
  actor: AdminActor;
  privacyRequestId: string;
  status: PrivacyRequestStatus;
}

export interface AddPrivacyRequestEventInput {
  actor: AdminActor;
  eventType: PrivacyRequestEventType;
  message?: string;
  metadata?: PrivacyRequestEventMetadata;
  privacyRequestId: string;
}

export interface PrivacyRequestRepository {
  createPrivacyRequest(input: {
    createdByAdminUserId: string;
    requestType: PrivacyRequestType;
    requesterName?: string;
    requesterNotes?: string;
    subjectEmail: string;
    subjectEmailNormalized: string;
  }): Promise<PrivacyRequestRow>;
  createPrivacyRequestEvent(input: {
    actorAdminUserId: string;
    eventType: PrivacyRequestEventType;
    message?: string;
    metadata?: PrivacyRequestEventMetadata;
    privacyRequestId: string;
  }): Promise<{ id: string }>;
  findPrivacyRequestById(id: string): Promise<PrivacyRequestRow | null>;
  listPrivacyRequestEvents(privacyRequestId: string): Promise<PrivacyRequestEventRow[]>;
  updatePrivacyRequestStatus(id: string, status: PrivacyRequestStatus, completedAt: Date | null): Promise<PrivacyRequestRow>;
}

export function createPrivacyRequestService(repository: PrivacyRequestRepository) {
  return {
    async addEvent(input: AddPrivacyRequestEventInput): Promise<{ id: string }> {
      return repository.createPrivacyRequestEvent({
        actorAdminUserId: input.actor.user.id,
        eventType: input.eventType,
        message: input.message,
        metadata: input.metadata,
        privacyRequestId: input.privacyRequestId,
      });
    },
    async changeStatus(input: ChangePrivacyRequestStatusInput): Promise<PrivacyRequestRow> {
      const completedAt = input.status === "completed" ? new Date() : null;
      const request = await repository.updatePrivacyRequestStatus(input.privacyRequestId, input.status, completedAt);
      await repository.createPrivacyRequestEvent({
        actorAdminUserId: input.actor.user.id,
        eventType: "status_changed",
        message: `Status changed to ${input.status}`,
        metadata: { status: input.status },
        privacyRequestId: input.privacyRequestId,
      });
      return request;
    },
    async createRequest(input: CreatePrivacyRequestInput): Promise<PrivacyRequestRow> {
      const request = await repository.createPrivacyRequest({
        createdByAdminUserId: input.actor.user.id,
        requestType: input.requestType,
        requesterName: cleanOptionalText(input.requesterName),
        requesterNotes: cleanOptionalText(input.requesterNotes),
        subjectEmail: input.subjectEmail.trim(),
        subjectEmailNormalized: normalizeAdminEmail(input.subjectEmail),
      });

      await repository.createPrivacyRequestEvent({
        actorAdminUserId: input.actor.user.id,
        eventType: "created",
        message: "Privacy request created",
        metadata: { requestType: input.requestType },
        privacyRequestId: request.id,
      });

      return request;
    },
    async getRequestWithEvents(id: string): Promise<{ events: PrivacyRequestEventRow[]; request: PrivacyRequestRow } | null> {
      const request = await repository.findPrivacyRequestById(id);

      if (!request) {
        return null;
      }

      return {
        events: await repository.listPrivacyRequestEvents(id),
        request,
      };
    },
  };
}

export function createDrizzlePrivacyRequestRepository(): PrivacyRequestRepository {
  const db = getPrivateDb();

  return {
    async createPrivacyRequest(input) {
      const rows = await db.insert(privacyRequests).values(input).returning();
      return rows[0];
    },
    async createPrivacyRequestEvent(input) {
      const rows = await db.insert(privacyRequestEvents).values(input).returning({ id: privacyRequestEvents.id });
      return rows[0];
    },
    async findPrivacyRequestById(id) {
      const rows = await db.select().from(privacyRequests).where(eq(privacyRequests.id, id)).limit(1);
      return rows[0] ?? null;
    },
    async listPrivacyRequestEvents(privacyRequestId) {
      return db
        .select()
        .from(privacyRequestEvents)
        .where(eq(privacyRequestEvents.privacyRequestId, privacyRequestId))
        .orderBy(desc(privacyRequestEvents.createdAt));
    },
    async updatePrivacyRequestStatus(id, status, completedAt) {
      const rows = await db
        .update(privacyRequests)
        .set({ completedAt, status, updatedAt: new Date() })
        .where(eq(privacyRequests.id, id))
        .returning();
      return rows[0];
    },
  };
}

export function getPrivacyRequestService() {
  return createPrivacyRequestService(createDrizzlePrivacyRequestRepository());
}

function cleanOptionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : undefined;
}
```

- [ ] **Step 4: Run privacy request tests and verify pass**

Run:

```bash
./node_modules/.bin/tsx --conditions=react-server --test src/lib/admin/privacy-requests.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git status --short
git add src/lib/admin/privacy-requests.ts src/lib/admin/privacy-requests.test.ts
git commit -m "feat: add privacy request service"
```

Expected: commit succeeds after user has authorized committing.

---

## Task 7: Add Admin Read Models And Queries

**Files:**
- Create: `src/lib/admin/read-models.ts`
- Create: `src/lib/admin/read-models.test.ts`
- Create: `src/lib/admin/queries.ts`
- Create: `src/lib/admin/queries.test.ts`

- [ ] **Step 1: Write failing read-model tests**

Create `src/lib/admin/read-models.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  describeCalendarFinalizationStatus,
  describeCheckoutStatus,
  getPurchaseDomainFromPurpose,
  moneyFromCents,
  toOperationsInboxItem,
} from "./read-models";

test("moneyFromCents formats CAD cents", () => {
  assert.equal(moneyFromCents(12345, "CAD"), "$123.45 CAD");
});

test("getPurchaseDomainFromPurpose separates shared checkout table flows", () => {
  assert.equal(getPurchaseDomainFromPurpose("product"), "product");
  assert.equal(getPurchaseDomainFromPurpose("training"), "training");
  assert.equal(getPurchaseDomainFromPurpose("appointment_deposit"), "service");
  assert.equal(getPurchaseDomainFromPurpose("appointment_full"), "service");
  assert.equal(getPurchaseDomainFromPurpose("appointment_custom_partial"), "service");
});

test("status descriptions use friendly operational language", () => {
  assert.equal(describeCheckoutStatus("paid"), "Paid");
  assert.equal(describeCheckoutStatus("verification_failed"), "Payment needs review");
  assert.equal(describeCalendarFinalizationStatus("paid_unbookable_rebooking_pending"), "Paid, rebooking needed");
});

test("operations inbox item explains what happened and the safe next action", () => {
  const item = toOperationsInboxItem({
    createdAt: new Date("2026-06-02T12:00:00Z"),
    domain: "booking",
    href: "/admin/bookings/hold-1",
    id: "hold-1",
    reason: "Calendar finalization failed",
    severity: "high",
    title: "Booking needs manual follow-up",
  });

  assert.equal(item.nextAction, "Open the record and review the troubleshooting panel before contacting the customer.");
});
```

- [ ] **Step 2: Run read-model tests and verify failure**

Run:

```bash
./node_modules/.bin/tsx --conditions=react-server --test src/lib/admin/read-models.test.ts
```

Expected: FAIL because `src/lib/admin/read-models.ts` does not exist.

- [ ] **Step 3: Implement read-model helpers**

Create `src/lib/admin/read-models.ts`:

```ts
import "server-only";

import type { CalendarFinalizationStatus, CheckoutOrderPurpose, CheckoutOrderStatus } from "@/lib/private-db/schema";

export type PurchaseDomain = "product" | "service" | "training";
export type InboxDomain = "booking" | "marketing" | "order" | "privacy" | "training";
export type InboxSeverity = "high" | "medium" | "low";

export interface OperationsInboxSource {
  createdAt: Date;
  domain: InboxDomain;
  href: string;
  id: string;
  reason: string;
  severity: InboxSeverity;
  title: string;
}

export interface OperationsInboxItem extends OperationsInboxSource {
  nextAction: string;
}

export function moneyFromCents(amountCents: number, currency: string): string {
  const amount = new Intl.NumberFormat("en-CA", {
    currency,
    style: "currency",
  }).format(amountCents / 100);

  return `${amount} ${currency}`;
}

export function getPurchaseDomainFromPurpose(purpose: CheckoutOrderPurpose): PurchaseDomain {
  if (purpose === "product") {
    return "product";
  }

  if (purpose === "training") {
    return "training";
  }

  return "service";
}

export function describeCheckoutStatus(status: CheckoutOrderStatus): string {
  const labels: Record<CheckoutOrderStatus, string> = {
    cancelled: "Cancelled",
    paid: "Paid",
    pending: "Payment pending",
    refunded: "Refunded",
    verification_failed: "Payment needs review",
  };

  return labels[status];
}

export function describeCalendarFinalizationStatus(status: CalendarFinalizationStatus): string {
  const labels: Record<CalendarFinalizationStatus, string> = {
    booked: "Booked",
    failed: "Calendar failed",
    manual_rebooked: "Manually rebooked",
    manual_review: "Manual review",
    not_required: "Not required",
    paid_calendar_pending: "Paid, calendar pending",
    paid_unbookable_rebooking_pending: "Paid, rebooking needed",
    pending: "Calendar pending",
    refund_required: "Refund required",
    refunded: "Refunded",
  };

  return labels[status];
}

export function toOperationsInboxItem(source: OperationsInboxSource): OperationsInboxItem {
  return {
    ...source,
    nextAction: getNextAction(source.domain),
  };
}

function getNextAction(domain: InboxDomain): string {
  if (domain === "privacy") {
    return "Open the privacy request, confirm the requester details, and record the next case event.";
  }

  if (domain === "marketing") {
    return "Open the contact or submission and review the source before taking marketing action.";
  }

  return "Open the record and review the troubleshooting panel before contacting the customer.";
}
```

- [ ] **Step 4: Run read-model tests and verify pass**

Run:

```bash
./node_modules/.bin/tsx --conditions=react-server --test src/lib/admin/read-models.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write failing query tests**

Create `src/lib/admin/queries.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { createAdminQueryService, type AdminQueryRepository } from "./queries";

const now = new Date("2026-06-02T12:00:00Z");

const repository: AdminQueryRepository = {
  async listRecentOrders() {
    return [
      {
        amountCents: 4500,
        createdAt: now,
        currency: "CAD",
        customerEmail: "client@example.com",
        customerName: "Client Example",
        id: "order-db-1",
        orderId: "lh-product-1",
        purpose: "product",
        status: "paid",
      },
    ];
  },
  async listAttentionBookings() {
    return [
      {
        createdAt: now,
        customerSnapshot: { email: "booking@example.com", name: "Booking Client", phone: "555" },
        finalizationStatus: "failed",
        id: "hold-1",
        publicReference: "LH-HOLD-1",
        selectedStart: now,
        status: "booking_failed",
      },
    ];
  },
  async listMarketingSummaryRows() {
    return [{ contacts: 10, source: "contact_popup", submissions: 14, unsubscribes: 1 }];
  },
  async listPrivacyRequests() {
    return [{ id: "privacy-1", requestType: "access_export", status: "open", subjectEmailNormalized: "client@example.com" }];
  },
};

test("admin query service builds command center inbox and summaries", async () => {
  const service = createAdminQueryService(repository);

  const data = await service.getCommandCenterData();

  assert.equal(data.inboxItems[0].domain, "booking");
  assert.equal(data.cards.openPrivacyRequests, 1);
  assert.equal(data.cards.recentRevenueCents, 4500);
});

test("admin query service maps revenue rows by purchase domain", async () => {
  const service = createAdminQueryService(repository);

  const rows = await service.listRevenueRows();

  assert.deepEqual(rows, [
    {
      amount: "$45.00 CAD",
      amountCents: 4500,
      createdAt: now,
      customerName: "Client Example",
      domain: "product",
      href: "/admin/orders/order-db-1",
      orderId: "lh-product-1",
      status: "Paid",
    },
  ]);
});
```

- [ ] **Step 6: Run query tests and verify failure**

Run:

```bash
./node_modules/.bin/tsx --conditions=react-server --test src/lib/admin/queries.test.ts
```

Expected: FAIL because `src/lib/admin/queries.ts` does not exist.

- [ ] **Step 7: Implement query service and fake-friendly repository interface**

Create `src/lib/admin/queries.ts`:

```ts
import "server-only";

import { desc, inArray, ne } from "drizzle-orm";

import { getPrivateDb } from "@/lib/private-db/client";
import {
  appointmentHolds,
  checkoutOrders,
  marketingConsentEvents,
  marketingContacts,
  marketingContactSubmissions,
  privacyRequests,
  type AppointmentHoldCustomerSnapshot,
  type CalendarFinalizationStatus,
  type CheckoutOrderPurpose,
  type CheckoutOrderStatus,
} from "@/lib/private-db/schema";

import {
  describeCalendarFinalizationStatus,
  describeCheckoutStatus,
  getPurchaseDomainFromPurpose,
  moneyFromCents,
  toOperationsInboxItem,
  type OperationsInboxItem,
  type PurchaseDomain,
} from "./read-models";

interface RecentOrderRow {
  amountCents: number;
  createdAt: Date;
  currency: string;
  customerEmail: string;
  customerName: string;
  id: string;
  orderId: string;
  purpose: CheckoutOrderPurpose;
  status: CheckoutOrderStatus;
}

interface AttentionBookingRow {
  createdAt: Date;
  customerSnapshot: AppointmentHoldCustomerSnapshot;
  finalizationStatus: CalendarFinalizationStatus;
  id: string;
  publicReference: string;
  selectedStart: Date;
  status: string;
}

interface MarketingSummaryRow {
  contacts: number;
  source: string;
  submissions: number;
  unsubscribes: number;
}

interface PrivacyRequestSummaryRow {
  id: string;
  requestType: string;
  status: string;
  subjectEmailNormalized: string;
}

export interface AdminQueryRepository {
  listAttentionBookings(): Promise<AttentionBookingRow[]>;
  listMarketingSummaryRows(): Promise<MarketingSummaryRow[]>;
  listPrivacyRequests(): Promise<PrivacyRequestSummaryRow[]>;
  listRecentOrders(): Promise<RecentOrderRow[]>;
}

export interface CommandCenterData {
  cards: {
    marketingSources: number;
    openPrivacyRequests: number;
    recentOrders: number;
    recentRevenueCents: number;
  };
  inboxItems: OperationsInboxItem[];
}

export interface RevenueRow {
  amount: string;
  amountCents: number;
  createdAt: Date;
  customerName: string;
  domain: PurchaseDomain;
  href: string;
  orderId: string;
  status: string;
}

export function createAdminQueryService(repository: AdminQueryRepository) {
  return {
    async getCommandCenterData(): Promise<CommandCenterData> {
      const [orders, bookings, marketing, privacy] = await Promise.all([
        repository.listRecentOrders(),
        repository.listAttentionBookings(),
        repository.listMarketingSummaryRows(),
        repository.listPrivacyRequests(),
      ]);

      return {
        cards: {
          marketingSources: marketing.length,
          openPrivacyRequests: privacy.filter((request) => request.status !== "completed" && request.status !== "cancelled").length,
          recentOrders: orders.length,
          recentRevenueCents: orders.reduce((total, order) => total + order.amountCents, 0),
        },
        inboxItems: bookings.map((booking) => toOperationsInboxItem({
          createdAt: booking.createdAt,
          domain: "booking",
          href: `/admin/bookings/${booking.id}`,
          id: booking.id,
          reason: describeCalendarFinalizationStatus(booking.finalizationStatus),
          severity: "high",
          title: "Booking needs manual follow-up",
        })),
      };
    },
    async listRevenueRows(): Promise<RevenueRow[]> {
      const orders = await repository.listRecentOrders();

      return orders.map((order) => {
        const domain = getPurchaseDomainFromPurpose(order.purpose);
        return {
          amount: moneyFromCents(order.amountCents, order.currency),
          amountCents: order.amountCents,
          createdAt: order.createdAt,
          customerName: order.customerName,
          domain,
          href: getRevenueRowHref(domain, order.id),
          orderId: order.orderId,
          status: describeCheckoutStatus(order.status),
        };
      });
    },
  };
}

export function createDrizzleAdminQueryRepository(): AdminQueryRepository {
  const db = getPrivateDb();

  return {
    async listAttentionBookings() {
      return db
        .select({
          createdAt: appointmentHolds.createdAt,
          customerSnapshot: appointmentHolds.customerSnapshot,
          finalizationStatus: appointmentHolds.finalizationStatus,
          id: appointmentHolds.id,
          publicReference: appointmentHolds.publicReference,
          selectedStart: appointmentHolds.selectedStart,
          status: appointmentHolds.status,
        })
        .from(appointmentHolds)
        .where(inArray(appointmentHolds.status, ["booking_failed", "manual_followup", "paid_unbookable_rebooking_pending", "refund_required"]))
        .orderBy(desc(appointmentHolds.updatedAt))
        .limit(25);
    },
    async listMarketingSummaryRows() {
      const submissions = await db.select().from(marketingContactSubmissions).orderBy(desc(marketingContactSubmissions.submittedAt)).limit(100);
      const contacts = await db.select().from(marketingContacts).orderBy(desc(marketingContacts.updatedAt)).limit(100);
      const events = await db.select().from(marketingConsentEvents).orderBy(desc(marketingConsentEvents.occurredAt)).limit(100);
      const sources = new Map<string, MarketingSummaryRow>();

      for (const submission of submissions) {
        const row = sources.get(submission.source) ?? { contacts: 0, source: submission.source, submissions: 0, unsubscribes: 0 };
        row.submissions += 1;
        sources.set(submission.source, row);
      }

      for (const contact of contacts) {
        const row = sources.get(contact.source) ?? { contacts: 0, source: contact.source, submissions: 0, unsubscribes: 0 };
        row.contacts += 1;
        sources.set(contact.source, row);
      }

      for (const event of events) {
        if (event.eventType === "unsubscribe") {
          const row = sources.get(event.source) ?? { contacts: 0, source: event.source, submissions: 0, unsubscribes: 0 };
          row.unsubscribes += 1;
          sources.set(event.source, row);
        }
      }

      return [...sources.values()];
    },
    async listPrivacyRequests() {
      return db
        .select({
          id: privacyRequests.id,
          requestType: privacyRequests.requestType,
          status: privacyRequests.status,
          subjectEmailNormalized: privacyRequests.subjectEmailNormalized,
        })
        .from(privacyRequests)
        .orderBy(desc(privacyRequests.createdAt))
        .limit(50);
    },
    async listRecentOrders() {
      return db
        .select({
          amountCents: checkoutOrders.amountCents,
          createdAt: checkoutOrders.createdAt,
          currency: checkoutOrders.currency,
          customerEmail: checkoutOrders.customerEmail,
          customerName: checkoutOrders.customerName,
          id: checkoutOrders.id,
          orderId: checkoutOrders.orderId,
          purpose: checkoutOrders.purpose,
          status: checkoutOrders.status,
        })
        .from(checkoutOrders)
        .where(ne(checkoutOrders.status, "pending"))
        .orderBy(desc(checkoutOrders.createdAt))
        .limit(100);
    },
  };
}

export function getAdminQueryService() {
  return createAdminQueryService(createDrizzleAdminQueryRepository());
}

function getRevenueRowHref(domain: PurchaseDomain, id: string): string {
  if (domain === "product") {
    return `/admin/orders/${id}`;
  }

  if (domain === "training") {
    return `/admin/training/${id}`;
  }

  return `/admin/bookings/${id}`;
}
```

- [ ] **Step 8: Run read model and query tests**

Run:

```bash
./node_modules/.bin/tsx --conditions=react-server --test src/lib/admin/read-models.test.ts src/lib/admin/queries.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

Run:

```bash
git status --short
git add src/lib/admin/read-models.ts src/lib/admin/read-models.test.ts src/lib/admin/queries.ts src/lib/admin/queries.test.ts
git commit -m "feat: add admin read models"
```

Expected: commit succeeds after user has authorized committing.

---

## Task 8: Add Privacy Export Builder

**Files:**
- Create: `src/lib/admin/privacy-export.ts`
- Create: `src/lib/admin/privacy-export.test.ts`

- [ ] **Step 1: Write failing export tests**

Create `src/lib/admin/privacy-export.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { createPrivacyExportService, type PrivacyExportRepository } from "./privacy-export";

const actor = {
  user: {
    displayName: "Owner",
    email: "owner@example.com",
    emailNormalized: "owner@example.com",
    id: "admin-owner",
    providerUserId: "clerk-owner",
    role: "owner" as const,
    status: "active" as const,
  },
};

test("privacy export requires active request and groups safe records", async () => {
  const auditEvents: any[] = [];
  const repository: PrivacyExportRepository = {
    async findPrivacyRequest(id) {
      return { id, status: "open", subjectEmailNormalized: "client@example.com" };
    },
    async findSubjectRecords(emailNormalized) {
      return {
        consentEvents: [{ eventType: "opt_in", emailNormalized, occurredAt: new Date("2026-06-01T12:00:00Z") }],
        marketingContacts: [{ emailNormalized, source: "contact_popup" }],
        paymentEvents: [{ eventType: "payment.paid", payloadSanitized: { raw: "excluded" }, processingStatus: "processed" }],
        submissions: [{ emailNormalized, source: "contact_popup", payload: { message: "Hello" } }],
        orders: [{ orderId: "lh-product-1", customerEmail: "client@example.com", amountCents: 4500 }],
        appointmentHolds: [],
        trainingEnrollments: [],
      };
    },
    async recordAuditEvent(input) {
      auditEvents.push(input);
    },
  };
  const service = createPrivacyExportService(repository);

  const result = await service.buildExport({
    actor,
    privacyRequestId: "privacy-1",
    reason: "Customer access request",
  });

  assert.equal(result.subjectEmailNormalized, "client@example.com");
  assert.equal(result.records.paymentEvents[0].eventType, "payment.paid");
  assert.equal("payloadSanitized" in result.records.paymentEvents[0], false);
  assert.deepEqual(auditEvents.map((event) => event.action), ["privacy_export_attempt", "privacy_export_completed"]);
});

test("privacy export rejects completed request", async () => {
  const repository: PrivacyExportRepository = {
    async findPrivacyRequest(id) {
      return { id, status: "completed", subjectEmailNormalized: "client@example.com" };
    },
    async findSubjectRecords() {
      throw new Error("should not query records");
    },
    async recordAuditEvent() {},
  };
  const service = createPrivacyExportService(repository);

  await assert.rejects(
    service.buildExport({ actor, privacyRequestId: "privacy-1", reason: "Customer access request" }),
    /Privacy request is not active/,
  );
});
```

- [ ] **Step 2: Run export tests and verify failure**

Run:

```bash
./node_modules/.bin/tsx --conditions=react-server --test src/lib/admin/privacy-export.test.ts
```

Expected: FAIL because `src/lib/admin/privacy-export.ts` does not exist.

- [ ] **Step 3: Implement privacy export service**

Create `src/lib/admin/privacy-export.ts`:

```ts
import "server-only";

import { eq, inArray, sql } from "drizzle-orm";

import { normalizeAdminEmail } from "@/lib/env/admin";
import { getPrivateDb } from "@/lib/private-db/client";
import {
  appointmentHolds,
  checkoutOrders,
  checkoutPaymentEvents,
  marketingConsentEvents,
  marketingContacts,
  marketingContactSubmissions,
  privacyRequests,
  trainingEnrollments,
} from "@/lib/private-db/schema";

import type { AuditLogEntryInput } from "./audit-log";
import { getAuditLogService } from "./audit-log";
import type { AdminActor } from "./types";

interface PrivacyExportRequestRow {
  id: string;
  status: string;
  subjectEmailNormalized: string;
}

interface SubjectRecords {
  appointmentHolds: Record<string, unknown>[];
  consentEvents: Record<string, unknown>[];
  marketingContacts: Record<string, unknown>[];
  orders: Record<string, unknown>[];
  paymentEvents: Record<string, unknown>[];
  submissions: Record<string, unknown>[];
  trainingEnrollments: Record<string, unknown>[];
}

export interface PrivacyExportRepository {
  findPrivacyRequest(id: string): Promise<PrivacyExportRequestRow | null>;
  findSubjectRecords(emailNormalized: string): Promise<SubjectRecords>;
  recordAuditEvent(input: AuditLogEntryInput): Promise<void>;
}

export interface BuildPrivacyExportInput {
  actor: AdminActor;
  privacyRequestId: string;
  reason: string;
}

export function createPrivacyExportService(repository: PrivacyExportRepository) {
  return {
    async buildExport(input: BuildPrivacyExportInput) {
      const reason = input.reason.trim();

      if (reason.length < 5) {
        throw new Error("Export reason is required");
      }

      const request = await repository.findPrivacyRequest(input.privacyRequestId);

      if (!request) {
        throw new Error("Privacy request not found");
      }

      if (request.status === "completed" || request.status === "cancelled") {
        throw new Error("Privacy request is not active");
      }

      await repository.recordAuditEvent({
        action: "privacy_export_attempt",
        actor: input.actor,
        domain: "privacy",
        privacyRequestId: request.id,
        reason,
        targetId: request.id,
        targetType: "privacy_request",
      });

      try {
        const records = await repository.findSubjectRecords(request.subjectEmailNormalized);
        const exportPackage = {
          generatedAt: new Date().toISOString(),
          generatedBy: input.actor.user.emailNormalized,
          privacyRequestId: request.id,
          reason,
          records: sanitizeSubjectRecords(records),
          subjectEmailNormalized: request.subjectEmailNormalized,
        };

        await repository.recordAuditEvent({
          action: "privacy_export_completed",
          actor: input.actor,
          domain: "privacy",
          metadata: { sectionCount: Object.keys(exportPackage.records).length },
          privacyRequestId: request.id,
          reason,
          targetId: request.id,
          targetType: "privacy_request",
        });

        return exportPackage;
      } catch (error) {
        await repository.recordAuditEvent({
          action: "privacy_export_failed",
          actor: input.actor,
          domain: "privacy",
          metadata: { error: error instanceof Error ? error.message : "Unknown export error" },
          privacyRequestId: request.id,
          reason,
          targetId: request.id,
          targetType: "privacy_request",
        });
        throw error;
      }
    },
  };
}

export function createDrizzlePrivacyExportRepository(): PrivacyExportRepository {
  const db = getPrivateDb();
  const audit = getAuditLogService();

  return {
    async findPrivacyRequest(id) {
      const rows = await db
        .select({
          id: privacyRequests.id,
          status: privacyRequests.status,
          subjectEmailNormalized: privacyRequests.subjectEmailNormalized,
        })
        .from(privacyRequests)
        .where(eq(privacyRequests.id, id))
        .limit(1);

      return rows[0] ?? null;
    },
    async findSubjectRecords(emailNormalized) {
      const [contacts, submissions, consentEvents, orders, holds, enrollments] = await Promise.all([
        db.select().from(marketingContacts).where(eq(marketingContacts.emailNormalized, emailNormalized)),
        db.select().from(marketingContactSubmissions).where(eq(marketingContactSubmissions.emailNormalized, emailNormalized)),
        db.select().from(marketingConsentEvents).where(eq(marketingConsentEvents.emailNormalized, emailNormalized)),
        db.select().from(checkoutOrders).where(eq(sql`lower(${checkoutOrders.customerEmail})`, emailNormalized)),
        db.select().from(appointmentHolds),
        db.select().from(trainingEnrollments).where(eq(trainingEnrollments.checkoutEmail, emailNormalized)),
      ]);
      const orderIds = orders.map((order) => order.id);
      const paymentEvents = orderIds.length > 0
        ? await db.select().from(checkoutPaymentEvents).where(inArray(checkoutPaymentEvents.orderId, orderIds))
        : [];

      return {
        appointmentHolds: holds.filter((hold) => normalizeAdminEmail(hold.customerSnapshot.email) === emailNormalized),
        consentEvents,
        marketingContacts: contacts,
        orders,
        paymentEvents,
        submissions,
        trainingEnrollments: enrollments,
      };
    },
    async recordAuditEvent(input) {
      await audit.record(input);
    },
  };
}

export function getPrivacyExportService() {
  return createPrivacyExportService(createDrizzlePrivacyExportRepository());
}

function sanitizeSubjectRecords(records: SubjectRecords): SubjectRecords {
  return {
    ...records,
    paymentEvents: records.paymentEvents.map((event) => ({
      amountCents: event.amountCents,
      createdAt: event.createdAt,
      currency: event.currency,
      eventType: event.eventType,
      paymentProvider: event.paymentProvider,
      processingStatus: event.processingStatus,
      providerStatus: event.providerStatus,
      status: event.status,
    })),
  };
}
```

- [ ] **Step 4: Run export tests and verify pass**

Run:

```bash
./node_modules/.bin/tsx --conditions=react-server --test src/lib/admin/privacy-export.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git status --short
git add src/lib/admin/privacy-export.ts src/lib/admin/privacy-export.test.ts
git commit -m "feat: add request-linked privacy exports"
```

Expected: commit succeeds after user has authorized committing.

---

## Task 9: Add Admin UI Components And Shell

**Files:**
- Create: `src/components/admin/admin-shell.tsx`
- Create: `src/components/admin/admin-card.tsx`
- Create: `src/components/admin/admin-table.tsx`
- Create: `src/components/admin/status-pill.tsx`
- Create: `src/components/admin/operations-inbox.tsx`
- Create: `src/app/admin/(protected)/layout.tsx`
- Create: `src/app/admin/not-authorized/page.tsx`

- [ ] **Step 1: Create reusable admin card**

Create `src/components/admin/admin-card.tsx`:

```tsx
import type { ReactNode } from "react";

interface AdminCardProps {
  children?: ReactNode;
  label: string;
  value: ReactNode;
}

export function AdminCard({ children, label, value }: AdminCardProps) {
  return (
    <section className="rounded-2xl border border-lh-line bg-white p-5 shadow-sm">
      <p className="font-smallcaps text-sm uppercase tracking-[0.18em] text-lh-muted">{label}</p>
      <div className="mt-2 text-3xl font-semibold text-lh-shadow">{value}</div>
      {children ? <div className="mt-3 text-sm text-lh-muted">{children}</div> : null}
    </section>
  );
}
```

- [ ] **Step 2: Create status pill**

Create `src/components/admin/status-pill.tsx`:

```tsx
interface StatusPillProps {
  tone?: "attention" | "neutral" | "success";
  children: React.ReactNode;
}

const tones = {
  attention: "border-lh-accent-soft bg-lh-light-soft text-lh-accent",
  neutral: "border-lh-line bg-lh-neutral-2 text-lh-muted",
  success: "border-lh-primary-soft bg-lh-primary-soft text-lh-primary",
};

export function StatusPill({ children, tone = "neutral" }: StatusPillProps) {
  return (
    <span className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] ${tones[tone]}`}>
      {children}
    </span>
  );
}
```

- [ ] **Step 3: Create table wrapper**

Create `src/components/admin/admin-table.tsx`:

```tsx
import type { ReactNode } from "react";

interface AdminTableProps {
  children: ReactNode;
  caption: string;
}

export function AdminTable({ caption, children }: AdminTableProps) {
  return (
    <div className="overflow-hidden rounded-2xl border border-lh-line bg-white">
      <table className="w-full border-collapse text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        {children}
      </table>
    </div>
  );
}
```

- [ ] **Step 4: Create operations inbox component**

Create `src/components/admin/operations-inbox.tsx`:

```tsx
import Link from "next/link";

import type { OperationsInboxItem } from "@/lib/admin/read-models";

import { StatusPill } from "./status-pill";

interface OperationsInboxProps {
  items: OperationsInboxItem[];
}

export function OperationsInbox({ items }: OperationsInboxProps) {
  if (items.length === 0) {
    return (
      <section className="rounded-2xl border border-lh-line bg-white p-6">
        <h2 className="font-heading text-3xl uppercase tracking-[0.08em]">Operations inbox</h2>
        <p className="mt-3 text-lh-muted">No urgent operational issues are currently flagged.</p>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-lh-line bg-white p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="font-heading text-3xl uppercase tracking-[0.08em]">Operations inbox</h2>
          <p className="mt-2 text-sm text-lh-muted">Urgent records with a clear next action.</p>
        </div>
        <StatusPill tone="attention">{items.length} active</StatusPill>
      </div>
      <div className="mt-6 divide-y divide-lh-line">
        {items.map((item) => (
          <Link key={item.id} href={item.href} className="block py-4 transition hover:bg-lh-neutral-2/60">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-semibold text-lh-shadow">{item.title}</p>
                <p className="mt-1 text-sm text-lh-muted">{item.reason}</p>
                <p className="mt-2 text-sm text-lh-shadow">{item.nextAction}</p>
              </div>
              <StatusPill tone={item.severity === "high" ? "attention" : "neutral"}>{item.domain}</StatusPill>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
```

- [ ] **Step 5: Create admin shell**

Create `src/components/admin/admin-shell.tsx`:

```tsx
import Link from "next/link";
import type { ReactNode } from "react";

import type { AdminActor } from "@/lib/admin/types";

const navItems = [
  { href: "/admin", label: "Command Center" },
  { href: "/admin/revenue", label: "Revenue" },
  { href: "/admin/orders", label: "Products / Orders" },
  { href: "/admin/bookings", label: "Services / Bookings" },
  { href: "/admin/training", label: "Training" },
  { href: "/admin/marketing", label: "Marketing" },
  { href: "/admin/privacy", label: "Privacy Requests" },
  { href: "/admin/audit", label: "Audit Log" },
];

interface AdminShellProps {
  actor: AdminActor;
  children: ReactNode;
  environmentLabel: string;
}

export function AdminShell({ actor, children, environmentLabel }: AdminShellProps) {
  return (
    <div className="min-h-screen bg-lh-neutral-2 text-lh-shadow">
      <div className="mx-auto flex min-h-screen max-w-[1500px]">
        <aside className="hidden w-72 shrink-0 border-r border-lh-line bg-white px-6 py-8 lg:block">
          <Link href="/admin" className="font-heading text-4xl uppercase tracking-[0.08em] text-lh-primary">
            Lash Her Admin
          </Link>
          <nav className="mt-10 space-y-1" aria-label="Admin navigation">
            {navItems.map((item) => (
              <Link key={item.href} href={item.href} className="block rounded-xl px-3 py-2 text-sm font-medium text-lh-shadow transition hover:bg-lh-neutral-2">
                {item.label}
              </Link>
            ))}
          </nav>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="border-b border-lh-line bg-white px-5 py-4 md:px-8">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm text-lh-muted">{environmentLabel}</p>
                <p className="font-semibold">{actor.user.email}</p>
              </div>
              <div className="rounded-full border border-lh-line px-4 py-2 text-sm uppercase tracking-[0.14em] text-lh-muted">
                {actor.user.role}
              </div>
            </div>
          </header>
          <main className="flex-1 px-5 py-8 md:px-8">{children}</main>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Create protected admin layout**

Create `src/app/admin/(protected)/layout.tsx`:

```tsx
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { AdminShell } from "@/components/admin/admin-shell";
import { getAdminAuth } from "@/lib/admin/auth";
import { AdminAuthError } from "@/lib/admin/types";
import { getAdminEnvironmentLabel } from "@/lib/env/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  try {
    const actor = await getAdminAuth().requireAdmin();

    return (
      <AdminShell actor={actor} environmentLabel={getAdminEnvironmentLabel()}>
        {children}
      </AdminShell>
    );
  } catch (error) {
    if (error instanceof AdminAuthError) {
      redirect("/admin/not-authorized");
    }
    throw error;
  }
}
```

- [ ] **Step 7: Create denied-access page**

Create `src/app/admin/not-authorized/page.tsx`:

```tsx
export default function AdminNotAuthorizedPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-lh-neutral-2 px-6">
      <section className="max-w-xl rounded-3xl border border-lh-line bg-white p-8 text-center shadow-sm">
        <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-muted">Admin access</p>
        <h1 className="mt-3 font-heading text-5xl uppercase tracking-[0.08em] text-lh-shadow">Not authorized</h1>
        <p className="mt-4 text-lh-muted">
          This account is signed in but is not approved for Lash Her admin access. Ask the owner to review the admin allowlist.
        </p>
      </section>
    </main>
  );
}
```

- [ ] **Step 8: Run lint**

Run:

```bash
npm run lint
```

Expected: PASS.

- [ ] **Step 9: Commit**

Run:

```bash
git status --short
git add src/components/admin "src/app/admin/(protected)/layout.tsx" src/app/admin/not-authorized/page.tsx
git commit -m "feat: add admin shell UI"
```

Expected: commit succeeds after user has authorized committing.

---

## Task 10: Add Read-Only Admin Pages

**Files:**
- Create: `src/app/admin/(protected)/page.tsx`
- Create: `src/app/admin/(protected)/revenue/page.tsx`
- Create: `src/app/admin/(protected)/orders/page.tsx`
- Create: `src/app/admin/(protected)/bookings/page.tsx`
- Create: `src/app/admin/(protected)/training/page.tsx`
- Create: `src/app/admin/(protected)/marketing/page.tsx`

- [ ] **Step 1: Create command center page**

Create `src/app/admin/(protected)/page.tsx`:

```tsx
import { AdminCard } from "@/components/admin/admin-card";
import { OperationsInbox } from "@/components/admin/operations-inbox";
import { getAdminQueryService } from "@/lib/admin/queries";
import { moneyFromCents } from "@/lib/admin/read-models";

export default async function AdminCommandCenterPage() {
  const data = await getAdminQueryService().getCommandCenterData();

  return (
    <div className="space-y-8">
      <div>
        <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-muted">Command Center</p>
        <h1 className="mt-2 font-heading text-6xl uppercase tracking-[0.08em] text-lh-shadow">Today&apos;s Operations</h1>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <AdminCard label="Recent revenue" value={moneyFromCents(data.cards.recentRevenueCents, "CAD")}>Last 30 paid or reviewed orders.</AdminCard>
        <AdminCard label="Recent orders" value={data.cards.recentOrders}>Product, service, and training purchases.</AdminCard>
        <AdminCard label="Marketing sources" value={data.cards.marketingSources}>Lead source summary groups.</AdminCard>
        <AdminCard label="Privacy cases" value={data.cards.openPrivacyRequests}>Open or in-review requests.</AdminCard>
      </div>
      <OperationsInbox items={data.inboxItems} />
    </div>
  );
}
```

- [ ] **Step 2: Create revenue page**

Create `src/app/admin/(protected)/revenue/page.tsx`:

```tsx
import Link from "next/link";

import { AdminTable } from "@/components/admin/admin-table";
import { StatusPill } from "@/components/admin/status-pill";
import { getAdminQueryService } from "@/lib/admin/queries";

export default async function AdminRevenuePage() {
  const rows = await getAdminQueryService().listRevenueRows();

  return (
    <div className="space-y-6">
      <div>
        <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-muted">Revenue</p>
        <h1 className="mt-2 font-heading text-6xl uppercase tracking-[0.08em] text-lh-shadow">Unified Purchases</h1>
      </div>
      <AdminTable caption="Unified purchases across product, service, and training">
        <thead className="bg-lh-neutral-2 text-xs uppercase tracking-[0.14em] text-lh-muted">
          <tr>
            <th className="px-4 py-3">Order</th>
            <th className="px-4 py-3">Domain</th>
            <th className="px-4 py-3">Customer</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3 text-right">Amount</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-lh-line">
          {rows.map((row) => (
            <tr key={row.orderId}>
              <td className="px-4 py-3"><Link className="font-semibold text-lh-primary" href={row.href}>{row.orderId}</Link></td>
              <td className="px-4 py-3"><StatusPill>{row.domain}</StatusPill></td>
              <td className="px-4 py-3">{row.customerName}</td>
              <td className="px-4 py-3">{row.status}</td>
              <td className="px-4 py-3 text-right font-semibold">{row.amount}</td>
            </tr>
          ))}
        </tbody>
      </AdminTable>
    </div>
  );
}
```

- [ ] **Step 3: Create simple domain pages**

Create `src/app/admin/(protected)/orders/page.tsx`:

```tsx
export default function AdminOrdersPage() {
  return <AdminDomainPage title="Products / Orders" description="Product purchases from the private checkout order table." />;
}

function AdminDomainPage({ description, title }: { description: string; title: string }) {
  return (
    <div className="rounded-3xl border border-lh-line bg-white p-8">
      <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-muted">Domain workspace</p>
      <h1 className="mt-2 font-heading text-6xl uppercase tracking-[0.08em] text-lh-shadow">{title}</h1>
      <p className="mt-4 max-w-2xl text-lh-muted">{description}</p>
    </div>
  );
}
```

Create `src/app/admin/(protected)/bookings/page.tsx`:

```tsx
export default function AdminBookingsPage() {
  return (
    <div className="rounded-3xl border border-lh-line bg-white p-8">
      <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-muted">Domain workspace</p>
      <h1 className="mt-2 font-heading text-6xl uppercase tracking-[0.08em] text-lh-shadow">Services / Bookings</h1>
      <p className="mt-4 max-w-2xl text-lh-muted">Service booking holds, payment reconciliation, and calendar finalization state.</p>
    </div>
  );
}
```

Create `src/app/admin/(protected)/training/page.tsx`:

```tsx
export default function AdminTrainingPage() {
  return (
    <div className="rounded-3xl border border-lh-line bg-white p-8">
      <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-muted">Domain workspace</p>
      <h1 className="mt-2 font-heading text-6xl uppercase tracking-[0.08em] text-lh-shadow">Training</h1>
      <p className="mt-4 max-w-2xl text-lh-muted">Paid training enrollments, scheduling progress, and staff/customer follow-up state.</p>
    </div>
  );
}
```

Create `src/app/admin/(protected)/marketing/page.tsx`:

```tsx
export default function AdminMarketingPage() {
  return (
    <div className="rounded-3xl border border-lh-line bg-white p-8">
      <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-muted">Domain workspace</p>
      <h1 className="mt-2 font-heading text-6xl uppercase tracking-[0.08em] text-lh-shadow">Marketing</h1>
      <p className="mt-4 max-w-2xl text-lh-muted">Lead source quality, audience health, and training demand from private marketing records.</p>
    </div>
  );
}
```

- [ ] **Step 4: Run lint**

Run:

```bash
npm run lint
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git status --short
git add "src/app/admin/(protected)/page.tsx" "src/app/admin/(protected)/revenue/page.tsx" "src/app/admin/(protected)/orders/page.tsx" "src/app/admin/(protected)/bookings/page.tsx" "src/app/admin/(protected)/training/page.tsx" "src/app/admin/(protected)/marketing/page.tsx"
git commit -m "feat: add read-only admin pages"
```

Expected: commit succeeds after user has authorized committing.

---

## Task 11: Add Privacy Pages, Actions, And Export Route

**Files:**
- Create: `src/app/admin/(protected)/privacy/actions.ts`
- Create: `src/app/admin/(protected)/privacy/page.tsx`
- Create: `src/app/admin/(protected)/privacy/[id]/page.tsx`
- Create: `src/app/admin/(protected)/privacy/[id]/export/route.ts`
- Create: `src/app/admin/(protected)/privacy/[id]/export/route.test.ts`

- [ ] **Step 1: Write failing export route tests**

Create `src/app/admin/(protected)/privacy/[id]/export/route.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import { createPrivacyExportGetHandler } from "./src/app/admin/(protected)/privacy/[id]/export/route.ts";

  const owner = {
    user: {
      displayName: "Owner",
      email: "owner@example.com",
      emailNormalized: "owner@example.com",
      id: "admin-owner",
      providerUserId: "clerk-owner",
      role: "owner",
      status: "active",
    },
  };

  function createRequest(reason = "Customer access request") {
    return new Request(` + "`" + `https://lash.test/admin/privacy/privacy-1/export?reason=${encodeURIComponent(reason)}` + "`" + `);
  }
`;

test("privacy export route rejects operator", () => {
  runScenario(`
    const handler = createPrivacyExportGetHandler({
      requireOwner: async () => { throw new Error("forbidden"); },
      buildExport: async () => { throw new Error("should not export"); },
    });

    const response = await handler(createRequest(), { params: Promise.resolve({ id: "privacy-1" }) });

    assert.equal(response.status, 403);
  `);
});

test("privacy export route requires reason", () => {
  runScenario(`
    const handler = createPrivacyExportGetHandler({
      requireOwner: async () => owner,
      buildExport: async () => { throw new Error("should not export"); },
    });

    const response = await handler(createRequest(""), { params: Promise.resolve({ id: "privacy-1" }) });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Export reason is required" });
  `);
});

test("privacy export route returns attachment json", () => {
  runScenario(`
    const handler = createPrivacyExportGetHandler({
      requireOwner: async () => owner,
      buildExport: async (input) => ({ privacyRequestId: input.privacyRequestId, reason: input.reason, records: {} }),
    });

    const response = await handler(createRequest(), { params: Promise.resolve({ id: "privacy-1" }) });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/json");
    assert.equal(response.headers.get("content-disposition"), "attachment; filename=\"privacy-export-privacy-1.json\"");
    assert.deepEqual(await response.json(), { privacyRequestId: "privacy-1", reason: "Customer access request", records: {} });
  `);
});

function runScenario(assertions: string): void {
  const scenario = `${helperScript}\nvoid (async () => {\n${assertions}\n})()`;
  const env = { ...process.env };
  env.NEXT_PUBLIC_SANITY_DATASET = "test";
  env.NEXT_PUBLIC_SANITY_PROJECT_ID = "test-project";
  execFileSync("./node_modules/.bin/tsx", ["--conditions=react-server", "--eval", scenario], {
    cwd: process.cwd(),
    env,
    stdio: "pipe",
  });
}
```

- [ ] **Step 2: Run route tests and verify failure**

Run:

```bash
./node_modules/.bin/tsx --conditions=react-server --test "src/app/admin/(protected)/privacy/[id]/export/route.test.ts"
```

Expected: FAIL because export route does not exist.

- [ ] **Step 3: Implement export route**

Create `src/app/admin/(protected)/privacy/[id]/export/route.ts`:

```ts
import { getAdminAuth } from "@/lib/admin/auth";
import { getPrivacyExportService } from "@/lib/admin/privacy-export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

interface PrivacyExportRouteDependencies {
  buildExport: typeof getPrivacyExportService extends () => infer Service
    ? Service extends { buildExport: infer BuildExport }
      ? BuildExport
      : never
    : never;
  requireOwner: typeof getAdminAuth extends () => infer Service
    ? Service extends { requireOwner: infer RequireOwner }
      ? RequireOwner
      : never
    : never;
}

const defaultDependencies: PrivacyExportRouteDependencies = {
  buildExport: (input) => getPrivacyExportService().buildExport(input),
  requireOwner: () => getAdminAuth().requireOwner(),
};

export const GET = createPrivacyExportGetHandler(defaultDependencies);

export function createPrivacyExportGetHandler(dependencies: PrivacyExportRouteDependencies) {
  return async function privacyExportGetHandler(req: Request, context: RouteContext): Promise<Response> {
    let actor;

    try {
      actor = await dependencies.requireOwner();
    } catch {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    const { id } = await context.params;
    const reason = new URL(req.url).searchParams.get("reason")?.trim() ?? "";

    if (reason.length < 5) {
      return Response.json({ error: "Export reason is required" }, { status: 400 });
    }

    try {
      const exportPackage = await dependencies.buildExport({
        actor,
        privacyRequestId: id,
        reason,
      });

      return Response.json(exportPackage, {
        headers: {
          "content-disposition": `attachment; filename="privacy-export-${id}.json"`,
        },
      });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Privacy export failed" },
        { status: 400 },
      );
    }
  };
}
```

- [ ] **Step 4: Run route tests and verify pass**

Run:

```bash
./node_modules/.bin/tsx --conditions=react-server --test "src/app/admin/(protected)/privacy/[id]/export/route.test.ts"
```

Expected: PASS.

- [ ] **Step 5: Create privacy server actions**

Create `src/app/admin/(protected)/privacy/actions.ts`:

```ts
"use server";

import { revalidatePath } from "next/cache";

import { getAdminAuth } from "@/lib/admin/auth";
import { getPrivacyRequestService } from "@/lib/admin/privacy-requests";
import type { PrivacyRequestType } from "@/lib/admin/types";

export async function createPrivacyRequestAction(formData: FormData): Promise<void> {
  const actor = await getAdminAuth().requireAdmin();
  const requestType = parsePrivacyRequestType(formData.get("requestType"));
  const subjectEmail = String(formData.get("subjectEmail") ?? "").trim();
  const requesterName = String(formData.get("requesterName") ?? "").trim();
  const requesterNotes = String(formData.get("requesterNotes") ?? "").trim();

  if (subjectEmail.length === 0) {
    throw new Error("Subject email is required");
  }

  await getPrivacyRequestService().createRequest({
    actor,
    requestType,
    requesterName,
    requesterNotes,
    subjectEmail,
  });

  revalidatePath("/admin/privacy");
}

export async function addPrivacyRequestEventAction(formData: FormData): Promise<void> {
  const actor = await getAdminAuth().requireAdmin();
  const privacyRequestId = String(formData.get("privacyRequestId") ?? "").trim();
  const message = String(formData.get("message") ?? "").trim();

  if (privacyRequestId.length === 0 || message.length === 0) {
    throw new Error("Privacy request id and message are required");
  }

  await getPrivacyRequestService().addEvent({
    actor,
    eventType: "note_added",
    message,
    privacyRequestId,
  });

  revalidatePath(`/admin/privacy/${privacyRequestId}`);
}

function parsePrivacyRequestType(value: FormDataEntryValue | null): PrivacyRequestType {
  if (
    value === "access_export"
    || value === "correction"
    || value === "deletion"
    || value === "redaction"
    || value === "privacy_inquiry"
  ) {
    return value;
  }

  return "access_export";
}
```

- [ ] **Step 6: Create privacy list page**

Create `src/app/admin/(protected)/privacy/page.tsx`:

```tsx
import { createPrivacyRequestAction } from "./actions";

export default function AdminPrivacyPage() {
  return (
    <div className="grid gap-8 xl:grid-cols-[1fr_420px]">
      <section className="rounded-3xl border border-lh-line bg-white p-8">
        <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-muted">Privacy</p>
        <h1 className="mt-2 font-heading text-6xl uppercase tracking-[0.08em] text-lh-shadow">Privacy Requests</h1>
        <p className="mt-4 max-w-2xl text-lh-muted">Track access, correction, deletion, redaction, and privacy inquiry cases. V1 records decisions and exports; redaction and deletion execution stay outside the dashboard.</p>
      </section>
      <form action={createPrivacyRequestAction} className="rounded-3xl border border-lh-line bg-white p-6">
        <h2 className="font-heading text-3xl uppercase tracking-[0.08em]">Create request</h2>
        <label className="mt-5 block text-sm font-semibold" htmlFor="requestType">Request type</label>
        <select id="requestType" name="requestType" className="mt-2 w-full rounded-xl border border-lh-line px-3 py-2">
          <option value="access_export">Access / export</option>
          <option value="correction">Correction</option>
          <option value="deletion">Deletion</option>
          <option value="redaction">Redaction</option>
          <option value="privacy_inquiry">Privacy inquiry</option>
        </select>
        <label className="mt-4 block text-sm font-semibold" htmlFor="subjectEmail">Subject email</label>
        <input id="subjectEmail" name="subjectEmail" type="email" required className="mt-2 w-full rounded-xl border border-lh-line px-3 py-2" />
        <label className="mt-4 block text-sm font-semibold" htmlFor="requesterName">Requester name</label>
        <input id="requesterName" name="requesterName" className="mt-2 w-full rounded-xl border border-lh-line px-3 py-2" />
        <label className="mt-4 block text-sm font-semibold" htmlFor="requesterNotes">Notes</label>
        <textarea id="requesterNotes" name="requesterNotes" className="mt-2 min-h-28 w-full rounded-xl border border-lh-line px-3 py-2" />
        <button type="submit" className="mt-5 rounded-full bg-lh-primary px-5 py-3 text-sm font-semibold uppercase tracking-[0.14em] text-white">Create case</button>
      </form>
    </div>
  );
}
```

- [ ] **Step 7: Create privacy detail page**

Create `src/app/admin/(protected)/privacy/[id]/page.tsx`:

```tsx
import { notFound } from "next/navigation";

import { getAdminAuth } from "@/lib/admin/auth";
import { getPrivacyRequestService } from "@/lib/admin/privacy-requests";

import { addPrivacyRequestEventAction } from "../actions";

export const runtime = "nodejs";

type PageProps = { params: Promise<{ id: string }> };

export default async function AdminPrivacyRequestDetailPage({ params }: PageProps) {
  await getAdminAuth().requireAdmin();
  const { id } = await params;
  const result = await getPrivacyRequestService().getRequestWithEvents(id);

  if (!result) {
    notFound();
  }

  return (
    <div className="space-y-8">
      <section className="rounded-3xl border border-lh-line bg-white p-8">
        <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-muted">Privacy case</p>
        <h1 className="mt-2 font-heading text-5xl uppercase tracking-[0.08em] text-lh-shadow">{result.request.subjectEmailNormalized}</h1>
        <p className="mt-3 text-lh-muted">Status: {result.request.status}</p>
        <a className="mt-5 inline-flex rounded-full bg-lh-primary px-5 py-3 text-sm font-semibold uppercase tracking-[0.14em] text-white" href={`/admin/privacy/${result.request.id}/export?reason=Customer%20access%20request`}>
          Download owner export
        </a>
      </section>
      <form action={addPrivacyRequestEventAction} className="rounded-3xl border border-lh-line bg-white p-6">
        <input type="hidden" name="privacyRequestId" value={result.request.id} />
        <label className="block text-sm font-semibold" htmlFor="message">Add case note</label>
        <textarea id="message" name="message" required className="mt-2 min-h-28 w-full rounded-xl border border-lh-line px-3 py-2" />
        <button type="submit" className="mt-4 rounded-full border border-lh-line px-5 py-3 text-sm font-semibold uppercase tracking-[0.14em]">Add note</button>
      </form>
      <section className="rounded-3xl border border-lh-line bg-white p-6">
        <h2 className="font-heading text-3xl uppercase tracking-[0.08em]">Case history</h2>
        <div className="mt-4 divide-y divide-lh-line">
          {result.events.map((event) => (
            <article key={event.id} className="py-4">
              <p className="font-semibold">{event.eventType}</p>
              {event.message ? <p className="mt-1 text-lh-muted">{event.message}</p> : null}
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
```

- [ ] **Step 8: Run tests and lint**

Run:

```bash
./node_modules/.bin/tsx --conditions=react-server --test "src/app/admin/(protected)/privacy/[id]/export/route.test.ts"
npm run lint
```

Expected: both commands pass.

- [ ] **Step 9: Commit**

Run:

```bash
git status --short
git add "src/app/admin/(protected)/privacy"
git commit -m "feat: add privacy request UI and export route"
```

Expected: commit succeeds after user has authorized committing.

---

## Task 12: Add Audit Page, Documentation, And Final Verification

**Files:**
- Create: `src/app/admin/(protected)/audit/page.tsx`
- Modify: `README.md`
- Modify: `docs/launch-readiness-checklist.md`

- [ ] **Step 1: Create owner-only audit page**

Create `src/app/admin/(protected)/audit/page.tsx`:

```tsx
import { AdminTable } from "@/components/admin/admin-table";
import { getAdminAuth } from "@/lib/admin/auth";
import { listRecentAuditLogEntries } from "@/lib/admin/audit-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AdminAuditPage() {
  await getAdminAuth().requireOwner();
  const rows = await listRecentAuditLogEntries(100);

  return (
    <div className="space-y-6">
      <div>
        <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-muted">Owner only</p>
        <h1 className="mt-2 font-heading text-6xl uppercase tracking-[0.08em] text-lh-shadow">Audit Log</h1>
      </div>
      <AdminTable caption="Recent admin audit log entries">
        <thead className="bg-lh-neutral-2 text-xs uppercase tracking-[0.14em] text-lh-muted">
          <tr>
            <th className="px-4 py-3">When</th>
            <th className="px-4 py-3">Actor</th>
            <th className="px-4 py-3">Action</th>
            <th className="px-4 py-3">Domain</th>
            <th className="px-4 py-3">Target</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-lh-line">
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="px-4 py-3">{row.createdAt.toISOString()}</td>
              <td className="px-4 py-3">{row.actorEmail}</td>
              <td className="px-4 py-3">{row.action}</td>
              <td className="px-4 py-3">{row.domain}</td>
              <td className="px-4 py-3">{row.targetType ? `${row.targetType}:${row.targetId ?? ""}` : "-"}</td>
            </tr>
          ))}
        </tbody>
      </AdminTable>
    </div>
  );
}
```

- [ ] **Step 2: Update README admin setup notes**

Modify `README.md` by adding this subsection after the Private database environment section:

```md
### Admin dashboard

The private operations dashboard lives at `/admin` and uses Clerk for managed authentication. Configure these server/runtime variables in each environment:

- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
- `CLERK_SECRET_KEY`
- `ADMIN_OWNER_EMAILS`
- `ADMIN_OPERATOR_EMAILS`

`ADMIN_OWNER_EMAILS` and `ADMIN_OPERATOR_EMAILS` are comma-separated allowlists. Owner access is required for privacy exports and audit-log review. Operator access can view operational records needed for day-to-day work but cannot run full exports or review sensitive audit logs.

Admin roles, privacy cases, and audit entries are stored in the private PostgreSQL database. Run generated Drizzle migrations before opening `/admin` in an environment.
```

- [ ] **Step 3: Update launch checklist admin gate**

Modify `docs/launch-readiness-checklist.md` line 94 from:

```md
- [ ] No dashboard/admin UI is added for private records until access control, audit logging, and retention policy are approved.
```

to:

```md
- [ ] Admin dashboard access control, owner/operator allowlists, audit logging, and retention/privacy operating policy are verified before private records are reviewed in `/admin`.
```

- [ ] **Step 4: Run focused unit and route tests**

Run:

```bash
./node_modules/.bin/tsx --conditions=react-server --test src/lib/env/admin.test.ts src/lib/admin/admin-user-store.test.ts src/lib/admin/auth.test.ts src/lib/admin/permissions.test.ts src/lib/admin/audit-log.test.ts src/lib/admin/privacy-requests.test.ts src/lib/admin/read-models.test.ts src/lib/admin/queries.test.ts src/lib/admin/privacy-export.test.ts "src/app/admin/(protected)/privacy/[id]/export/route.test.ts"
```

Expected: PASS.

- [ ] **Step 5: Run full unit suite**

Run:

```bash
npm run test:unit
```

Expected: PASS.

- [ ] **Step 6: Run lint**

Run:

```bash
npm run lint
```

Expected: PASS.

- [ ] **Step 7: Run build**

Run:

```bash
npm run build
```

Expected: PASS. If it fails at `prebuild`, verify `NEXT_PUBLIC_SANITY_DATASET` matches the environment rules in `AGENTS.md`.

- [ ] **Step 8: Manual smoke test in local dev**

Run:

```bash
npm run dev
```

Open `http://localhost:3000/admin` with Clerk local keys and an email in `ADMIN_OWNER_EMAILS`.

Expected:

- Owner reaches the command center.
- `/admin/revenue` renders.
- `/admin/privacy` renders create request form.
- Created privacy request appears in the private DB.
- `/admin/audit` renders for owner.
- An email in `ADMIN_OPERATOR_EMAILS` can open domain pages and cannot open `/admin/audit`.

- [ ] **Step 9: Commit**

Run:

```bash
git status --short
git add "src/app/admin/(protected)/audit/page.tsx" README.md docs/launch-readiness-checklist.md
git commit -m "feat: document admin dashboard operations"
```

Expected: commit succeeds after user has authorized committing.

---

## Execution Notes

- Do not run `npm run db:migrate` against staging or production until the private DB migration runbook checks are complete.
- Do not expose `CLERK_SECRET_KEY`, `ADMIN_OWNER_EMAILS`, `ADMIN_OPERATOR_EMAILS`, or `DATABASE_URL` in screenshots, chat, tickets, or commits.
- Keep `/admin` server-rendered and dynamic because it reads private operational data.
- Do not add browser-visible `NEXT_PUBLIC_` variables for private database, admin allowlists, or export controls.
- If a file touched by this work contains unrelated user changes, preserve those changes and make the smallest compatible edit.

## Verification Matrix

Run these before claiming implementation complete:

```bash
./node_modules/.bin/tsx --conditions=react-server --test src/lib/env/admin.test.ts src/lib/admin/admin-user-store.test.ts src/lib/admin/auth.test.ts src/lib/admin/permissions.test.ts src/lib/admin/audit-log.test.ts src/lib/admin/privacy-requests.test.ts src/lib/admin/read-models.test.ts src/lib/admin/queries.test.ts src/lib/admin/privacy-export.test.ts "src/app/admin/(protected)/privacy/[id]/export/route.test.ts"
npm run test:unit
npm run lint
npm run build
```

Expected: all commands pass, or failures are documented with exact output and a follow-up fix plan.
