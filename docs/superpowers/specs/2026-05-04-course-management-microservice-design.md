# Course Management Microservice Design

Date: 2026-05-04
Status: Approved design for implementation planning

## Purpose

Build a self-paced online course platform for Lash Her that behaves like a creator-commerce course product while staying attached to the existing marketing site. The launch version sells and delivers video courses only. It does not include live cohorts, downloads, subscriptions, broad product bundles, Apple login, automated refund initiation, or full business analytics.

## Existing Project Context

The existing marketing frontend lives locally at `/Users/dardan/Documents/lash-her/frontend` and remotely at `https://github.com/princessdardan/lash-her-frontend`. It is a Next.js App Router site deployed on Vercel, backed by Sanity CMS for marketing content, Resend for forms/email, and Vercel Analytics/Speed Insights. Current public routes include home, training, training-program detail, gallery, contact, and embedded Sanity Studio. No existing auth or payment implementation was found.

## High-Level Architecture

The system will use three separately owned applications:

1. **Course API microservice**: Fastify service backed by PostgreSQL, hosted on Railway/Render/Fly-style infrastructure. It owns course content, canonical pricing, checkout/order state, payment confirmation, enrollments, Mux video authorization, progress, admin authorization, and operational audit logs.
2. **Existing marketing frontend**: Next.js/Vercel app that owns public course sales pages and protected student learning UI. It displays API data and calls API endpoints, but it never decides access or pricing authority.
3. **Admin dashboard**: Separate Next.js app on Vercel and a subdomain. It manages courses, modules, lessons, video uploads, publish state, enrollments, and manual refund/revocation workflows.

The API is the entitlement authority. The browser, marketing frontend, Clerk session alone, HelcimPay.js browser success response, Sanity content, and Mux playback IDs are not trusted as proof of access.

## Source Control and Deployment

The API microservice and admin dashboard will live in separate repositories from the existing marketing frontend. Because this creates contract drift risk, the API must expose versioned endpoints and publish an OpenAPI contract or generated TypeScript client consumed by both frontend apps.

Deployment ownership:

- Marketing frontend: existing Vercel deployment.
- Admin dashboard: Vercel deployment on an admin subdomain.
- Course API: long-running service on Railway, Render, Fly, or equivalent.
- Database: PostgreSQL managed by the API hosting stack or an attached managed provider.

## Auth and Authorization

Clerk will provide social OAuth login for students and admins. Launch providers are Google and Facebook/Instagram. Apple login is deferred.

The API must verify Clerk-issued tokens on every protected request and map Clerk user IDs to internal user records. Clerk authenticates identity; the API enforces authorization.

Student authorization rules:

- Students may view public course/catalog data without enrollment only where explicitly exposed.
- Students may access protected lesson data, signed Mux playback tokens, and progress endpoints only for active enrollments.
- Progress writes require an authenticated user and an active enrollment for the lesson's course.

Admin authorization rules:

- MVP supports multiple admins with the same permissions.
- Admin access must be enforced server-side by explicit allowlist, Clerk metadata, or Clerk organization membership.
- The admin frontend must not be the only access-control layer.

## Course Content Model

The API owns course content for the course platform. Sanity remains the marketing CMS but is not the source of truth for paid course structure.

Core content model:

- Course: title, slug, description, pricing, publish state, ordering, and sales metadata needed by the frontend.
- Module: belongs to course, has title, order, and publish state.
- Lesson: belongs to module, has title, order, body/description, publish state, and optional video asset.
- Video asset: references Mux upload/asset/playback state and belongs to a lesson.

Launch content is self-paced video courses only. No live sessions, cohorts, quizzes, certificates, comments, assignments, downloads, bundles, subscriptions, or payment plans are in MVP scope.

## Video Delivery with Mux

Mux will handle protected video storage and playback.

Admin upload flow:

1. Admin requests a video upload for a lesson.
2. API creates a Mux direct upload and stores the upload/video asset record.
3. Admin dashboard uploads directly to Mux.
4. Mux webhooks update processing status in the API.
5. Lessons can only expose playable video once the asset is ready and published.

Student playback flow:

1. Student opens a protected lesson route in the marketing frontend.
2. Frontend requests lesson/player data from the API with Clerk auth.
3. API verifies enrollment and lesson publish state.
4. API issues a short-lived signed Mux playback token.
5. Frontend plays the video using the signed token.

Public or reusable playback identifiers must not function as authorization.

## Payments with HelcimPay.js

HelcimPay.js is the launch payment integration. Allowed methods are credit card plus digital wallets if Helcim supports them for the checkout session. ACH is not in launch scope.

Checkout flow:

1. Frontend requests checkout for a course using an internal course/product ID.
2. API calculates the authoritative price and currency from its database.
3. API creates an internal order in a pending state.
4. API initializes HelcimPay.js server-side and stores the `secretToken` with the order/session.
5. API returns only the checkout token needed by the frontend.
6. Frontend renders the HelcimPay.js iframe.
7. Browser `SUCCESS` responses may be sent back to the API for validation and recording, but they do not grant enrollment.
8. Enrollment is created only after trusted Helcim webhook/confirmation handling verifies the transaction, amount, currency, and order mapping.

Fulfillment must be idempotent by internal order and Helcim transaction ID. Helcim webhook signatures must be verified, and webhook raw body handling must be preserved in Fastify before JSON parsing changes the payload. If Helcim webhook payloads are insufficient, the API must perform a transaction lookup before confirmation.

## Orders, Enrollments, and Refunds

Payment state and enrollment state are related but separate.

Order states should cover at least pending checkout, payment confirmed, enrolled, failed/cancelled, refunded, and revoked. Enrollment states should cover active, revoked, and refunded.

Refund workflow for MVP:

1. Admin performs the money movement manually in Helcim.
2. Admin opens the dashboard and marks the enrollment/order as refunded or revoked.
3. API records notes, admin identity, timestamp, and external Helcim transaction/refund references.
4. Revoked/refunded enrollments lose protected lesson and playback access.

The MVP will not initiate refunds through the Helcim API.

## Student Learning UI

The existing marketing frontend owns sales pages and student course UI.

Expected customer-facing routes may include:

- Public course sales/catalog route such as `/courses/[slug]`.
- Student course library route such as `/learn`.
- Protected lesson route such as `/learn/[courseSlug]/[lessonSlug]`.

Final route names can be decided during implementation planning, but the ownership is fixed: the marketing frontend renders the customer-facing course experience and calls the API for data, authorization, checkout session creation, playback token creation, and progress updates.

## Progress Tracking

MVP includes both lesson completion and video resume progress.

Progress data:

- Last watched position per user and lesson.
- Completion state per user and lesson.
- Derived course completion percentage from completed lessons.

The frontend reports video progress and lesson completion events. The API validates the user's active enrollment before accepting progress writes. The API should tolerate duplicate/out-of-order events and avoid regressing progress accidentally.

## Admin Dashboard Scope

The separate Next.js admin dashboard will manage launch operations:

- Course/module/lesson create, edit, ordering, publish/unpublish.
- Mux direct-upload initiation and video processing status display.
- Course pricing and sales metadata used by the API and frontend.
- Enrollment/order lookup.
- Manual refund/revocation marking with notes and external references.
- Minimal operational analytics and failure visibility.

All admin actions call protected API endpoints and are authorized by the API.

## API Surface

The Fastify API should expose versioned endpoint groups:

- Public catalog/course endpoints for sales pages.
- Student endpoints for enrolled course library, lesson access, signed playback tokens, checkout initiation, and progress writes.
- Admin endpoints for content management, enrollment/order operations, and operational monitoring.
- Webhook endpoints for Helcim and Mux.
- Health/readiness endpoints for hosting and monitoring.

The API contract must be published as OpenAPI or generated TypeScript types/client so separate repos stay synchronized.

## Operational Analytics and Auditability

MVP analytics are operational, not broad business analytics.

Required operational records:

- Order and enrollment state transitions.
- Helcim webhook receipt, verification result, transaction lookup result, and fulfillment result.
- Mux webhook receipt and video processing state.
- Failed webhook processing with retry/reconciliation visibility.
- Admin actions, especially publish/unpublish, revoke, refund marking, and video changes.
- Student progress health at the course/lesson level.

Business analytics such as attribution, full funnel reporting, AOV, revenue dashboards, and marketing campaign analysis are deferred.

## Security Requirements

- API is the sole entitlement authority.
- Clerk tokens must be verified server-side by the API.
- Admin permissions must be enforced server-side.
- Course prices and currencies must be computed server-side.
- Helcim webhook signatures and transaction data must be verified before enrollment.
- Payment fulfillment must be idempotent.
- Mux playback tokens must be short-lived and issued only after entitlement checks.
- Raw card data must never touch the app; HelcimPay.js iframe keeps PCI scope reduced.
- API endpoints must apply CORS, rate limiting, input validation, and structured error handling.
- Webhooks must store enough information for replay detection, retries, and manual reconciliation.

## Non-Goals for Launch

- Apple login.
- ACH payments.
- Subscriptions, memberships, payment plans, bundles, upsells, or order bumps.
- Live cohorts or scheduled classes.
- Quizzes, certificates, comments, assignments, or community features.
- Automated refund initiation through Helcim API.
- Full business analytics and attribution dashboard.
- Sanity as the source of truth for paid course content.
- A separate student learning app on `learn.lashher.com`.

## Open Implementation Decisions

These do not block the architecture, but must be resolved during implementation planning:

- Exact hosting provider among Railway, Render, Fly, or equivalent.
- Exact route names in the marketing frontend.
- Exact admin subdomain.
- Whether admin access uses Clerk metadata, Clerk organizations, or an API-side allowlist.
- ORM/query layer for PostgreSQL.
- API contract generation tool.
- Logging/alerting provider for failed Helcim and Mux workflows.
- Whether Facebook and Instagram are one Clerk provider flow or require separate configuration constraints.

## Acceptance Criteria for the Design

- The API owns course content, pricing, payments, enrollments, video authorization, progress, and admin authorization.
- The marketing frontend owns public sales pages and protected student learning UI only.
- The admin dashboard is separate, protected, and uses API authorization.
- Helcim payment confirmation, not browser success alone, grants enrollment.
- Mux signed playback tokens are issued only after entitlement checks.
- Progress tracking includes lesson completion and video resume position.
- Refund handling keeps Helcim money movement and API enrollment state aligned manually for MVP.
- Separate repos are protected from contract drift through versioned APIs and published contracts.
