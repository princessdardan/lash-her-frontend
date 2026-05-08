# Google Calendar Booking System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an instant-confirmed booking system where Sanity config drives the booking UI and Google Calendar is the only booking source of truth.

**Architecture:** The implementation adds Sanity booking configuration and marketing opt-in schemas, pure slot-generation helpers, a Google Calendar server client, Upstash Redis for OAuth token/lock/idempotency operational state, Next.js API routes for availability and booking creation, and a reusable booking UI. Booking writes acquire a short whole-calendar lock, re-check Google Calendar, create a guest event, send a branded Resend confirmation, and optionally store a marketing opt-in record.

**Tech Stack:** Next.js 16 App Router, React 18, TypeScript strict, Sanity v4/next-sanity, Google Calendar API through `googleapis`, Upstash Redis REST through `@upstash/redis`, Resend, Node `crypto`, `tsx --test` unit tests, Playwright E2E.

---

## First-release scope locked by this plan

- Operational store: Upstash Redis, configured with `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.
- Google auth: personal Gmail OAuth using `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, and a protected setup route gated by `BOOKING_ADMIN_SETUP_SECRET`.
- Calendar scope: use `https://www.googleapis.com/auth/calendar.events` for event read/write and guest invite creation.
- Shared calendar: one configured calendar ID from Sanity, with the marker title defaulting to `Available for booking`.
- Booking types: `training-call` and `in-person-appointment`.
- Booking record: Google Calendar event only.
- Sanity records: booking config and marketing opt-ins only.
- No payment, Google Meet, self-serve cancellation, self-serve rescheduling, approval workflow, separate availability calendar, or availability-window splitting.

If any of these locked choices are not acceptable, stop before Task 1 and revise this plan.

## File structure

### Create

- `frontend/src/sanity/schemas/documents/booking-settings.ts` — singleton booking configuration.
- `frontend/src/sanity/schemas/documents/booking-marketing-opt-in.ts` — marketing opt-in records created only with explicit consent.
- `frontend/src/lib/booking/types.ts` — shared booking interfaces and discriminated unions.
- `frontend/src/lib/booking/availability.ts` — pure slot-generation and conflict-subtraction helpers.
- `frontend/src/lib/booking/availability.test.ts` — unit tests for availability rules.
- `frontend/src/lib/booking/operational-store.ts` — server-only Upstash token, lock, and idempotency helpers.
- `frontend/src/lib/booking/google-calendar.ts` — server-only Google OAuth and Calendar API wrapper.
- `frontend/src/lib/booking/google-calendar.test.ts` — unit tests for event payload shaping.
- `frontend/src/lib/booking/booking-validation.ts` — request parsing and validation helpers.
- `frontend/src/lib/booking/booking-validation.test.ts` — unit tests for request validation.
- `frontend/src/lib/booking/booking-service.ts` — server-only booking orchestration.
- `frontend/src/lib/booking/email.ts` — branded booking confirmation email wrapper around Resend.
- `frontend/src/app/api/booking/availability/route.ts` — returns slots for one booking type.
- `frontend/src/app/api/booking/create/route.ts` — creates instant-confirmed bookings.
- `frontend/src/app/api/booking/oauth/start/route.ts` — protected OAuth setup redirect.
- `frontend/src/app/api/booking/oauth/callback/route.ts` — OAuth callback that stores refresh token.
- `frontend/src/app/(site)/booking/page.tsx` — shared booking page.
- `frontend/src/components/booking/booking-flow.tsx` — client booking wizard.
- `frontend/src/components/booking/booking-entry-link.tsx` — reusable embedded entry link with optional preselected type.
- `frontend/tests/booking.spec.ts` — Playwright coverage for shared booking page and stale-slot failure.

### Modify

- `frontend/package.json` — add `googleapis`, `@upstash/redis`, and `test:unit`.
- `frontend/src/sanity/schemas/index.ts` — register booking schemas.
- `frontend/src/sanity/structure/index.ts` — add Booking Settings and Booking Marketing Opt-ins sections.
- `frontend/src/data/loaders.ts` — add booking settings loader.
- `frontend/src/types/index.ts` — add booking config and opt-in shapes.
- `frontend/src/sanity/env.ts` — add lazy booking env accessors.
- `frontend/src/app/api/revalidate/route.ts` — add booking cache tags.
- Existing page or CMS content can point CTAs at `/booking?type=training-call` or `/booking?type=in-person-appointment`; this plan does not hardcode new navigation.

---

### Task 1: Add dependencies and unit test runner

**Files:**
- Modify: `frontend/package.json`

- [ ] **Step 1: Add dependencies and unit test script**

In `frontend/package.json`, add these dependencies:

```json
{
  "dependencies": {
    "@sanity/icons": "^3.7.4",
    "@upstash/redis": "^1.35.8",
    "googleapis": "^144.0.0"
  },
  "scripts": {
    "test:unit": "tsx --test \"src/**/*.test.ts\""
  }
}
```

Keep all existing dependencies and scripts. The scripts block should still include `test`: `playwright test`.

- [ ] **Step 2: Install packages**

Run from `frontend`:

```bash
npm install
```

Expected: `node_modules` updates successfully and package metadata reflects `googleapis`, `@upstash/redis`, and `@sanity/icons`.

- [ ] **Step 3: Verify the unit runner starts**

Run from `frontend`:

```bash
npm run test:unit
```

Expected: it exits 0 if tests exist, or reports no matching tests before Task 4 creates the first booking tests.

- [ ] **Step 4: Commit**

```bash
git add frontend/package.json frontend/package-lock.json
git commit -m "test: add booking unit test dependencies"
```

---

### Task 2: Add Sanity booking schemas and Studio structure

**Files:**
- Create: `frontend/src/sanity/schemas/documents/booking-settings.ts`
- Create: `frontend/src/sanity/schemas/documents/booking-marketing-opt-in.ts`
- Modify: `frontend/src/sanity/schemas/index.ts`
- Modify: `frontend/src/sanity/structure/index.ts`

- [ ] **Step 1: Create booking settings schema**

Create `frontend/src/sanity/schemas/documents/booking-settings.ts`:

```ts
import { CalendarIcon } from "@sanity/icons";
import { defineArrayMember, defineField, defineType } from "sanity";

const BOOKING_TYPE_OPTIONS = [
  { title: "Training sign-up call", value: "training-call" },
  { title: "In-person appointment", value: "in-person-appointment" },
];

export const bookingSettings = defineType({
  name: "bookingSettings",
  title: "Booking Settings",
  type: "document",
  icon: CalendarIcon,
  fields: [
    defineField({
      name: "calendarId",
      title: "Google Calendar ID",
      type: "string",
      description: "Use primary for the connected Gmail primary calendar, or a specific Google Calendar ID.",
      initialValue: "primary",
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: "availabilityMarkerTitle",
      title: "Availability Marker Title",
      type: "string",
      initialValue: "Available for booking",
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: "bookingHorizonDays",
      title: "Booking Horizon Days",
      type: "number",
      initialValue: 30,
      validation: (rule) => rule.required().integer().min(1).max(180),
    }),
    defineField({
      name: "minimumLeadTimeHours",
      title: "Minimum Lead Time Hours",
      type: "number",
      initialValue: 24,
      validation: (rule) => rule.required().integer().min(0).max(720),
    }),
    defineField({
      name: "timezone",
      title: "Booking Timezone",
      type: "string",
      initialValue: "America/Toronto",
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: "bookingTypes",
      title: "Booking Types",
      type: "array",
      validation: (rule) => rule.required().min(2).max(2),
      of: [
        defineArrayMember({
          name: "bookingTypeConfig",
          type: "object",
          fields: [
            defineField({
              name: "type",
              type: "string",
              options: { list: BOOKING_TYPE_OPTIONS, layout: "radio" },
              validation: (rule) => rule.required(),
            }),
            defineField({
              name: "label",
              type: "string",
              validation: (rule) => rule.required(),
            }),
            defineField({
              name: "description",
              type: "text",
              rows: 3,
              validation: (rule) => rule.required(),
            }),
            defineField({
              name: "durationMinutes",
              type: "number",
              validation: (rule) => rule.required().integer().min(15).max(60),
            }),
            defineField({
              name: "slotIntervalMinutes",
              type: "number",
              validation: (rule) => rule.required().integer().min(5).max(60),
            }),
            defineField({
              name: "bufferBeforeMinutes",
              type: "number",
              initialValue: 0,
              validation: (rule) => rule.required().integer().min(0).max(60),
            }),
            defineField({
              name: "bufferAfterMinutes",
              type: "number",
              initialValue: 0,
              validation: (rule) => rule.required().integer().min(0).max(60),
            }),
            defineField({
              name: "questions",
              title: "Type-specific Questions",
              type: "array",
              of: [
                defineArrayMember({
                  name: "bookingQuestion",
                  type: "object",
                  fields: [
                    defineField({ name: "id", type: "string", validation: (rule) => rule.required().regex(/^[a-z0-9-]+$/) }),
                    defineField({ name: "label", type: "string", validation: (rule) => rule.required() }),
                    defineField({
                      name: "inputType",
                      type: "string",
                      options: { list: ["text", "textarea", "select"], layout: "radio" },
                      validation: (rule) => rule.required(),
                    }),
                    defineField({ name: "required", type: "boolean", initialValue: false }),
                    defineField({
                      name: "options",
                      type: "array",
                      of: [defineArrayMember({ type: "string" })],
                      hidden: ({ parent }) => parent?.inputType !== "select",
                    }),
                  ],
                }),
              ],
            }),
          ],
        }),
      ],
    }),
    defineField({
      name: "marketingOptInLabel",
      title: "Marketing Opt-in Label",
      type: "string",
      initialValue: "I agree to receive occasional updates from Lash Her by Nataliea.",
      validation: (rule) => rule.required(),
    }),
  ],
});
```

- [ ] **Step 2: Create marketing opt-in schema**

Create `frontend/src/sanity/schemas/documents/booking-marketing-opt-in.ts`:

```ts
import { EnvelopeIcon } from "@sanity/icons";
import { defineArrayMember, defineField, defineType } from "sanity";

export const bookingMarketingOptIn = defineType({
  name: "bookingMarketingOptIn",
  title: "Booking Marketing Opt-in",
  type: "document",
  icon: EnvelopeIcon,
  fields: [
    defineField({ name: "name", type: "string", validation: (rule) => rule.required() }),
    defineField({ name: "email", type: "string", validation: (rule) => rule.required().email() }),
    defineField({ name: "phone", type: "string", validation: (rule) => rule.required() }),
    defineField({
      name: "bookingType",
      type: "string",
      options: {
        list: [
          { title: "Training sign-up call", value: "training-call" },
          { title: "In-person appointment", value: "in-person-appointment" },
        ],
        layout: "radio",
      },
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: "answers",
      type: "array",
      of: [
        defineArrayMember({
          name: "bookingAnswer",
          type: "object",
          fields: [
            defineField({ name: "questionId", type: "string", validation: (rule) => rule.required() }),
            defineField({ name: "questionLabel", type: "string", validation: (rule) => rule.required() }),
            defineField({ name: "answer", type: "text", validation: (rule) => rule.required() }),
          ],
        }),
      ],
    }),
  ],
  preview: {
    select: { title: "name", subtitle: "email" },
  },
});
```

- [ ] **Step 3: Register schemas**

Modify `frontend/src/sanity/schemas/index.ts`:

```ts
import { bookingSettings } from "./documents/booking-settings";
import { bookingMarketingOptIn } from "./documents/booking-marketing-opt-in";
```

Add both document types in the `schemaTypes` document section after `mainMenu`:

```ts
bookingSettings,
bookingMarketingOptIn,
```

- [ ] **Step 4: Add Studio navigation**

Modify `frontend/src/sanity/structure/index.ts` by adding a Booking section after the Pages divider:

```ts
S.listItem()
  .title("Booking")
  .child(
    S.list()
      .title("Booking")
      .items([
        S.listItem()
          .title("Booking Settings")
          .id("bookingSettings")
          .child(S.document().schemaType("bookingSettings").documentId("bookingSettings")),
        S.documentTypeListItem("bookingMarketingOptIn").title("Marketing Opt-ins"),
      ])
  ),
S.divider(),
```

- [ ] **Step 5: Verify schema build**

Run from `frontend`:

```bash
npm run build
```

Expected: build reaches the existing project build behavior without schema import errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/sanity/schemas/documents/booking-settings.ts frontend/src/sanity/schemas/documents/booking-marketing-opt-in.ts frontend/src/sanity/schemas/index.ts frontend/src/sanity/structure/index.ts
git commit -m "feat(booking): add booking sanity schemas"
```

---

### Task 3: Add booking types, loader, and environment helpers

**Files:**
- Create: `frontend/src/lib/booking/types.ts`
- Modify: `frontend/src/types/index.ts`
- Modify: `frontend/src/data/loaders.ts`
- Modify: `frontend/src/sanity/env.ts`
- Modify: `frontend/src/app/api/revalidate/route.ts`

- [ ] **Step 1: Create booking domain types**

Create `frontend/src/lib/booking/types.ts`:

```ts
export type BookingType = "training-call" | "in-person-appointment";

export type BookingQuestionInputType = "text" | "textarea" | "select";

export interface BookingQuestion {
  _key?: string;
  id: string;
  label: string;
  inputType: BookingQuestionInputType;
  required: boolean;
  options?: string[];
}

export interface BookingTypeConfig {
  _key?: string;
  type: BookingType;
  label: string;
  description: string;
  durationMinutes: number;
  slotIntervalMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  questions: BookingQuestion[];
}

export interface BookingSettings {
  calendarId: string;
  availabilityMarkerTitle: string;
  bookingHorizonDays: number;
  minimumLeadTimeHours: number;
  timezone: string;
  bookingTypes: BookingTypeConfig[];
  marketingOptInLabel: string;
}

export interface CalendarEventWindow {
  id: string;
  title: string;
  start: Date;
  end: Date;
}

export interface BookingSlot {
  start: string;
  end: string;
}

export interface BookingAnswerInput {
  questionId: string;
  answer: string;
}

export interface BookingRequestInput {
  bookingType: BookingType;
  start: string;
  name: string;
  email: string;
  phone: string;
  answers: BookingAnswerInput[];
  marketingOptIn: boolean;
  idempotencyKey: string;
}
```

- [ ] **Step 2: Re-export page-facing types**

Modify `frontend/src/types/index.ts` by adding near the shared types:

```ts
export type {
  BookingAnswerInput,
  BookingQuestion,
  BookingQuestionInputType,
  BookingRequestInput,
  BookingSettings,
  BookingSlot,
  BookingType,
  BookingTypeConfig,
  CalendarEventWindow,
} from "@/lib/booking/types";
```

- [ ] **Step 3: Add loader**

Modify `frontend/src/data/loaders.ts` imports:

```ts
import type { BookingSettings } from "@/lib/booking/types";
```

Add this function before `export const loaders`:

```ts
async function getBookingSettings(): Promise<BookingSettings | null> {
  const query = groq`*[_type == "bookingSettings"][0]{
    calendarId,
    availabilityMarkerTitle,
    bookingHorizonDays,
    minimumLeadTimeHours,
    timezone,
    marketingOptInLabel,
    bookingTypes[]{
      _key,
      type,
      label,
      description,
      durationMinutes,
      slotIntervalMinutes,
      bufferBeforeMinutes,
      bufferAfterMinutes,
      questions[]{ _key, id, label, inputType, required, options }
    }
  }`;
  return client.fetch<BookingSettings | null>(query, {}, { next: { tags: ["bookingSettings"] } });
}
```

Add `getBookingSettings` to `loaders`.

- [ ] **Step 4: Add lazy env helpers**

Modify `frontend/src/sanity/env.ts`:

```ts
export function getBookingEnv(): {
  googleClientId: string;
  googleClientSecret: string;
  googleRedirectUri: string;
  bookingAdminSetupSecret: string;
  upstashRedisRestUrl: string;
  upstashRedisRestToken: string;
} {
  return {
    googleClientId: assertValue(process.env.GOOGLE_CLIENT_ID, "Missing env var: GOOGLE_CLIENT_ID"),
    googleClientSecret: assertValue(process.env.GOOGLE_CLIENT_SECRET, "Missing env var: GOOGLE_CLIENT_SECRET"),
    googleRedirectUri: assertValue(process.env.GOOGLE_REDIRECT_URI, "Missing env var: GOOGLE_REDIRECT_URI"),
    bookingAdminSetupSecret: assertValue(process.env.BOOKING_ADMIN_SETUP_SECRET, "Missing env var: BOOKING_ADMIN_SETUP_SECRET"),
    upstashRedisRestUrl: assertValue(process.env.UPSTASH_REDIS_REST_URL, "Missing env var: UPSTASH_REDIS_REST_URL"),
    upstashRedisRestToken: assertValue(process.env.UPSTASH_REDIS_REST_TOKEN, "Missing env var: UPSTASH_REDIS_REST_TOKEN"),
  };
}
```

- [ ] **Step 5: Add revalidation tag support**

Modify `frontend/src/app/api/revalidate/route.ts` so its type/tag map includes:

```ts
bookingSettings: "bookingSettings",
```

- [ ] **Step 6: Verify types**

Run from `frontend`:

```bash
npm run lint
```

Expected: no new lint errors from the booking loader/types/env changes.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/booking/types.ts frontend/src/types/index.ts frontend/src/data/loaders.ts frontend/src/sanity/env.ts frontend/src/app/api/revalidate/route.ts
git commit -m "feat(booking): add booking config loader"
```

---

### Task 4: Build pure availability helpers with tests

**Files:**
- Create: `frontend/src/lib/booking/availability.test.ts`
- Create: `frontend/src/lib/booking/availability.ts`

- [ ] **Step 1: Write failing availability tests**

Create `frontend/src/lib/booking/availability.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { buildBookingSlots, isSlotAvailable } from "./availability";
import type { BookingTypeConfig, CalendarEventWindow } from "./types";

const bookingType: BookingTypeConfig = {
  type: "training-call",
  label: "Training sign-up call",
  description: "Discuss training options.",
  durationMinutes: 30,
  slotIntervalMinutes: 15,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  questions: [],
};

const availability: CalendarEventWindow = {
  id: "available-1",
  title: "Available for booking",
  start: new Date("2026-05-10T14:00:00.000Z"),
  end: new Date("2026-05-10T16:00:00.000Z"),
};

test("buildBookingSlots creates interval starts inside an availability window", () => {
  const slots = buildBookingSlots({
    availabilityWindows: [availability],
    busyEvents: [],
    bookingType,
    now: new Date("2026-05-09T12:00:00.000Z"),
    horizonEnd: new Date("2026-05-20T12:00:00.000Z"),
    minimumLeadTimeHours: 24,
  });

  assert.deepEqual(slots.slice(0, 3), [
    { start: "2026-05-10T14:00:00.000Z", end: "2026-05-10T14:30:00.000Z" },
    { start: "2026-05-10T14:15:00.000Z", end: "2026-05-10T14:45:00.000Z" },
    { start: "2026-05-10T14:30:00.000Z", end: "2026-05-10T15:00:00.000Z" },
  ]);
});

test("buildBookingSlots subtracts busy events and buffers", () => {
  const slots = buildBookingSlots({
    availabilityWindows: [availability],
    busyEvents: [{ id: "busy-1", title: "Fresha", start: new Date("2026-05-10T14:30:00.000Z"), end: new Date("2026-05-10T15:00:00.000Z") }],
    bookingType: { ...bookingType, bufferBeforeMinutes: 15, bufferAfterMinutes: 15 },
    now: new Date("2026-05-09T12:00:00.000Z"),
    horizonEnd: new Date("2026-05-20T12:00:00.000Z"),
    minimumLeadTimeHours: 24,
  });

  assert.equal(slots.some((slot) => slot.start === "2026-05-10T14:00:00.000Z"), false);
  assert.equal(slots.some((slot) => slot.start === "2026-05-10T15:15:00.000Z"), true);
});

test("isSlotAvailable validates a selected slot against current calendar state", () => {
  assert.equal(isSlotAvailable({
    requestedStart: new Date("2026-05-10T15:15:00.000Z"),
    availabilityWindows: [availability],
    busyEvents: [],
    bookingType,
    now: new Date("2026-05-09T12:00:00.000Z"),
    horizonEnd: new Date("2026-05-20T12:00:00.000Z"),
    minimumLeadTimeHours: 24,
  }), true);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run from `frontend`:

```bash
npm run test:unit -- src/lib/booking/availability.test.ts
```

Expected: FAIL with module-not-found for `./availability`.

- [ ] **Step 3: Implement availability helpers**

Create `frontend/src/lib/booking/availability.ts`:

```ts
import type { BookingSlot, BookingTypeConfig, CalendarEventWindow } from "./types";

interface BuildBookingSlotsInput {
  availabilityWindows: CalendarEventWindow[];
  busyEvents: CalendarEventWindow[];
  bookingType: BookingTypeConfig;
  now: Date;
  horizonEnd: Date;
  minimumLeadTimeHours: number;
}

interface IsSlotAvailableInput extends BuildBookingSlotsInput {
  requestedStart: Date;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * MINUTE_MS);
}

function overlaps(startA: Date, endA: Date, startB: Date, endB: Date): boolean {
  return startA < endB && startB < endA;
}

function isWithinWindow(start: Date, end: Date, window: CalendarEventWindow): boolean {
  return start >= window.start && end <= window.end;
}

function adjustedBusyEvent(event: CalendarEventWindow, bookingType: BookingTypeConfig): CalendarEventWindow {
  return {
    ...event,
    start: addMinutes(event.start, -bookingType.bufferBeforeMinutes),
    end: addMinutes(event.end, bookingType.bufferAfterMinutes),
  };
}

export function buildBookingSlots(input: BuildBookingSlotsInput): BookingSlot[] {
  const earliestStart = new Date(input.now.getTime() + input.minimumLeadTimeHours * HOUR_MS);
  const busyEvents = input.busyEvents.map((event) => adjustedBusyEvent(event, input.bookingType));
  const slots: BookingSlot[] = [];

  for (const window of input.availabilityWindows) {
    let cursor = new Date(Math.max(window.start.getTime(), earliestStart.getTime()));
    const intervalMs = input.bookingType.slotIntervalMinutes * MINUTE_MS;

    while (cursor < window.end && cursor < input.horizonEnd) {
      const slotEnd = addMinutes(cursor, input.bookingType.durationMinutes);
      const fitsWindow = isWithinWindow(cursor, slotEnd, window);
      const withinHorizon = slotEnd <= input.horizonEnd;
      const hasConflict = busyEvents.some((event) => overlaps(cursor, slotEnd, event.start, event.end));

      if (fitsWindow && withinHorizon && !hasConflict) {
        slots.push({ start: cursor.toISOString(), end: slotEnd.toISOString() });
      }

      cursor = new Date(cursor.getTime() + intervalMs);
    }
  }

  return slots.sort((a, b) => a.start.localeCompare(b.start));
}

export function isSlotAvailable(input: IsSlotAvailableInput): boolean {
  const requestedStartIso = input.requestedStart.toISOString();
  return buildBookingSlots(input).some((slot) => slot.start === requestedStartIso);
}
```

- [ ] **Step 4: Verify tests pass**

Run from `frontend`:

```bash
npm run test:unit -- src/lib/booking/availability.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/booking/availability.ts frontend/src/lib/booking/availability.test.ts
git commit -m "feat(booking): add availability slot generation"
```

---

### Task 5: Add operational store and Google Calendar client

**Files:**
- Create: `frontend/src/lib/booking/operational-store.ts`
- Create: `frontend/src/lib/booking/google-calendar.ts`
- Create: `frontend/src/lib/booking/google-calendar.test.ts`

- [ ] **Step 1: Write Google event payload tests**

Create `frontend/src/lib/booking/google-calendar.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { buildBookingEventPayload } from "./google-calendar";

test("buildBookingEventPayload adds guest and avoids Meet data", () => {
  const payload = buildBookingEventPayload({
    bookingTypeLabel: "Training sign-up call",
    start: new Date("2026-05-10T14:00:00.000Z"),
    end: new Date("2026-05-10T14:30:00.000Z"),
    timezone: "America/Toronto",
    customer: { name: "Jane Client", email: "jane@example.com", phone: "555-555-5555" },
    answers: [{ questionLabel: "Goal", answer: "Training details" }],
  });

  assert.equal(payload.summary, "Lash Her booking: Training sign-up call — Jane Client");
  assert.deepEqual(payload.attendees, [{ email: "jane@example.com", displayName: "Jane Client" }]);
  assert.equal("conferenceData" in payload, false);
  assert.match(payload.description ?? "", /555-555-5555/);
  assert.match(payload.description ?? "", /Goal: Training details/);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run from `frontend`:

```bash
npm run test:unit -- src/lib/booking/google-calendar.test.ts
```

Expected: FAIL with module-not-found for `./google-calendar`.

- [ ] **Step 3: Implement operational store**

Create `frontend/src/lib/booking/operational-store.ts`:

```ts
import "server-only";

import { Redis } from "@upstash/redis";

import { getBookingEnv } from "@/sanity/env";

const TOKEN_KEY = "booking:google-refresh-token";
const CALENDAR_LOCK_KEY = "booking:calendar-lock";

function getRedis(): Redis {
  const env = getBookingEnv();
  return new Redis({ url: env.upstashRedisRestUrl, token: env.upstashRedisRestToken });
}

export async function getGoogleRefreshToken(): Promise<string | null> {
  return getRedis().get<string>(TOKEN_KEY);
}

export async function saveGoogleRefreshToken(refreshToken: string): Promise<void> {
  await getRedis().set(TOKEN_KEY, refreshToken);
}

export async function acquireCalendarLock(lockId: string, ttlSeconds: number): Promise<boolean> {
  const result = await getRedis().set(CALENDAR_LOCK_KEY, lockId, { nx: true, ex: ttlSeconds });
  return result === "OK";
}

export async function releaseCalendarLock(lockId: string): Promise<void> {
  const redis = getRedis();
  const current = await redis.get<string>(CALENDAR_LOCK_KEY);
  if (current === lockId) {
    await redis.del(CALENDAR_LOCK_KEY);
  }
}

export async function claimIdempotencyKey(idempotencyKey: string, ttlSeconds: number): Promise<boolean> {
  const result = await getRedis().set(`booking:idempotency:${idempotencyKey}`, "claimed", { nx: true, ex: ttlSeconds });
  return result === "OK";
}
```

- [ ] **Step 4: Implement Google Calendar client**

Create `frontend/src/lib/booking/google-calendar.ts`:

```ts
import "server-only";

import { google, calendar_v3 } from "googleapis";

import { getBookingEnv } from "@/sanity/env";
import type { CalendarEventWindow } from "./types";
import { getGoogleRefreshToken } from "./operational-store";

interface BookingEventPayloadInput {
  bookingTypeLabel: string;
  start: Date;
  end: Date;
  timezone: string;
  customer: { name: string; email: string; phone: string };
  answers: Array<{ questionLabel: string; answer: string }>;
}

export function createOAuthClient() {
  const env = getBookingEnv();
  return new google.auth.OAuth2(env.googleClientId, env.googleClientSecret, env.googleRedirectUri);
}

export function getOAuthConsentUrl(state: string): string {
  const client = createOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/calendar.events"],
    state,
  });
}

export async function getAuthorizedCalendarClient(): Promise<calendar_v3.Calendar> {
  const refreshToken = await getGoogleRefreshToken();
  if (!refreshToken) {
    throw new Error("Google Calendar is not connected");
  }

  const oauthClient = createOAuthClient();
  oauthClient.setCredentials({ refresh_token: refreshToken });
  return google.calendar({ version: "v3", auth: oauthClient });
}

export function buildBookingEventPayload(input: BookingEventPayloadInput): calendar_v3.Schema$Event {
  const answerLines = input.answers.map((answer) => `${answer.questionLabel}: ${answer.answer}`).join("\n");
  const description = [
    `Customer: ${input.customer.name}`,
    `Email: ${input.customer.email}`,
    `Phone: ${input.customer.phone}`,
    answerLines ? `\nAnswers:\n${answerLines}` : "",
    "\nChanges: contact Nataliea to cancel or reschedule.",
  ].filter(Boolean).join("\n");

  return {
    summary: `Lash Her booking: ${input.bookingTypeLabel} — ${input.customer.name}`,
    description,
    start: { dateTime: input.start.toISOString(), timeZone: input.timezone },
    end: { dateTime: input.end.toISOString(), timeZone: input.timezone },
    attendees: [{ email: input.customer.email, displayName: input.customer.name }],
    reminders: { useDefault: true },
  };
}

export async function listCalendarEvents(input: { calendarId: string; timeMin: Date; timeMax: Date }): Promise<CalendarEventWindow[]> {
  const calendar = await getAuthorizedCalendarClient();
  const response = await calendar.events.list({
    calendarId: input.calendarId,
    timeMin: input.timeMin.toISOString(),
    timeMax: input.timeMax.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
  });

  return (response.data.items ?? []).flatMap((event) => {
    const startValue = event.start?.dateTime ?? event.start?.date;
    const endValue = event.end?.dateTime ?? event.end?.date;
    if (!event.id || !startValue || !endValue) return [];
    return [{ id: event.id, title: event.summary ?? "", start: new Date(startValue), end: new Date(endValue) }];
  });
}

export async function insertBookingEvent(input: { calendarId: string; event: calendar_v3.Schema$Event }): Promise<string> {
  const calendar = await getAuthorizedCalendarClient();
  const response = await calendar.events.insert({
    calendarId: input.calendarId,
    requestBody: input.event,
    sendUpdates: "all",
  });

  if (!response.data.id) {
    throw new Error("Google Calendar did not return an event ID");
  }

  return response.data.id;
}
```

- [ ] **Step 5: Verify tests pass**

Run from `frontend`:

```bash
npm run test:unit -- src/lib/booking/google-calendar.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/booking/operational-store.ts frontend/src/lib/booking/google-calendar.ts frontend/src/lib/booking/google-calendar.test.ts
git commit -m "feat(booking): add calendar integration helpers"
```

---

### Task 6: Add request validation and booking orchestration

**Files:**
- Create: `frontend/src/lib/booking/booking-validation.test.ts`
- Create: `frontend/src/lib/booking/booking-validation.ts`
- Create: `frontend/src/lib/booking/booking-service.ts`
- Create: `frontend/src/lib/booking/email.ts`

- [ ] **Step 1: Write validation tests**

Create `frontend/src/lib/booking/booking-validation.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { findBookingTypeConfig, validateBookingRequest } from "./booking-validation";
import type { BookingSettings } from "./types";

const settings: BookingSettings = {
  calendarId: "primary",
  availabilityMarkerTitle: "Available for booking",
  bookingHorizonDays: 30,
  minimumLeadTimeHours: 24,
  timezone: "America/Toronto",
  marketingOptInLabel: "I agree to receive updates.",
  bookingTypes: [{
    type: "training-call",
    label: "Training sign-up call",
    description: "Discuss training.",
    durationMinutes: 30,
    slotIntervalMinutes: 15,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    questions: [{ id: "goal", label: "Goal", inputType: "text", required: true }],
  }],
};

test("findBookingTypeConfig returns matching config", () => {
  assert.equal(findBookingTypeConfig(settings, "training-call").label, "Training sign-up call");
});

test("validateBookingRequest rejects missing required dynamic answer", () => {
  const result = validateBookingRequest({
    bookingType: "training-call",
    start: "2026-05-10T14:00:00.000Z",
    name: "Jane",
    email: "jane@example.com",
    phone: "555-555-5555",
    answers: [],
    marketingOptIn: false,
    idempotencyKey: "abc123",
  }, settings);

  assert.equal(result.success, false);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run from `frontend`:

```bash
npm run test:unit -- src/lib/booking/booking-validation.test.ts
```

Expected: FAIL with module-not-found for `./booking-validation`.

- [ ] **Step 3: Implement validation helpers**

Create `frontend/src/lib/booking/booking-validation.ts`:

```ts
import type { BookingRequestInput, BookingSettings, BookingType, BookingTypeConfig } from "./types";

interface ValidationSuccess {
  success: true;
  data: BookingRequestInput;
  bookingTypeConfig: BookingTypeConfig;
}

interface ValidationFailure {
  success: false;
  fieldErrors: Record<string, string>;
}

type ValidationResult = ValidationSuccess | ValidationFailure;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BOOKING_TYPES: BookingType[] = ["training-call", "in-person-appointment"];

export function findBookingTypeConfig(settings: BookingSettings, bookingType: BookingType): BookingTypeConfig {
  const config = settings.bookingTypes.find((candidate) => candidate.type === bookingType);
  if (!config) throw new Error(`Missing booking type config: ${bookingType}`);
  return config;
}

function isBookingType(value: string): value is BookingType {
  return BOOKING_TYPES.includes(value as BookingType);
}

export function validateBookingRequest(input: BookingRequestInput, settings: BookingSettings): ValidationResult {
  const fieldErrors: Record<string, string> = {};

  if (!isBookingType(input.bookingType)) fieldErrors.bookingType = "Choose a valid booking type";
  if (!input.name.trim()) fieldErrors.name = "Name is required";
  if (!EMAIL_PATTERN.test(input.email)) fieldErrors.email = "Enter a valid email address";
  if (!input.phone.trim()) fieldErrors.phone = "Phone number is required";
  if (Number.isNaN(new Date(input.start).getTime())) fieldErrors.start = "Choose a valid time";
  if (!input.idempotencyKey.trim()) fieldErrors.idempotencyKey = "Missing booking request key";

  if (Object.keys(fieldErrors).length > 0 || !isBookingType(input.bookingType)) {
    return { success: false, fieldErrors };
  }

  const bookingTypeConfig = findBookingTypeConfig(settings, input.bookingType);
  for (const question of bookingTypeConfig.questions) {
    const answer = input.answers.find((candidate) => candidate.questionId === question.id);
    if (question.required && !answer?.answer.trim()) {
      fieldErrors[`answers.${question.id}`] = `${question.label} is required`;
    }
  }

  if (Object.keys(fieldErrors).length > 0) return { success: false, fieldErrors };
  return { success: true, data: input, bookingTypeConfig };
}
```

- [ ] **Step 4: Implement booking email helper**

Create `frontend/src/lib/booking/email.ts`:

```ts
import "server-only";

import { Resend } from "resend";

import type { BookingTypeConfig } from "./types";

const resend = new Resend(process.env.RESEND_API_KEY);

interface SendBookingConfirmationInput {
  customer: { name: string; email: string; phone: string };
  bookingType: BookingTypeConfig;
  start: Date;
  end: Date;
  timezone: string;
}

export async function sendBookingConfirmationEmail(input: SendBookingConfirmationInput): Promise<void> {
  const formattedStart = new Intl.DateTimeFormat("en-CA", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: input.timezone,
  }).format(input.start);

  await resend.emails.send({
    from: "Lash Her by Nataliea <hello@lashher.com>",
    to: [input.customer.email],
    subject: `Your ${input.bookingType.label} is confirmed`,
    html: `<p>Hi ${input.customer.name},</p><p>Your ${input.bookingType.label} is confirmed for ${formattedStart}.</p><p>Please contact Nataliea if you need to cancel or reschedule.</p>`,
  });
}
```

- [ ] **Step 5: Implement booking orchestration**

Create `frontend/src/lib/booking/booking-service.ts`:

```ts
import "server-only";

import { nanoid } from "nanoid";

import { formClient } from "@/sanity/lib/form-client";
import { loaders } from "@/data/loaders";
import { buildBookingEventPayload, insertBookingEvent, listCalendarEvents } from "./google-calendar";
import { acquireCalendarLock, claimIdempotencyKey, releaseCalendarLock } from "./operational-store";
import { isSlotAvailable } from "./availability";
import { validateBookingRequest } from "./booking-validation";
import { sendBookingConfirmationEmail } from "./email";
import type { BookingRequestInput, CalendarEventWindow } from "./types";

interface BookingActionSuccess { success: true; eventId: string }
interface BookingActionFailure { success: false; error: string; fieldErrors?: Record<string, string> }
export type BookingActionResult = BookingActionSuccess | BookingActionFailure;

function partitionEvents(events: CalendarEventWindow[], markerTitle: string): { availabilityWindows: CalendarEventWindow[]; busyEvents: CalendarEventWindow[] } {
  return {
    availabilityWindows: events.filter((event) => event.title.trim() === markerTitle),
    busyEvents: events.filter((event) => event.title.trim() !== markerTitle),
  };
}

export async function createBooking(input: BookingRequestInput): Promise<BookingActionResult> {
  const settings = await loaders.getBookingSettings();
  if (!settings) return { success: false, error: "Booking is not configured yet. Please contact Nataliea." };

  const validation = validateBookingRequest(input, settings);
  if (!validation.success) return { success: false, error: "Please fix the form errors and try again.", fieldErrors: validation.fieldErrors };

  const claimed = await claimIdempotencyKey(input.idempotencyKey, 60 * 30);
  if (!claimed) return { success: false, error: "This booking request was already submitted. Please refresh and try again if needed." };

  const lockId = nanoid();
  const locked = await acquireCalendarLock(lockId, 20);
  if (!locked) return { success: false, error: "Another booking is being confirmed. Please try again in a moment." };

  try {
    const now = new Date();
    const horizonEnd = new Date(now.getTime() + settings.bookingHorizonDays * 24 * 60 * 60 * 1000);
    const selectedStart = new Date(input.start);
    const selectedEnd = new Date(selectedStart.getTime() + validation.bookingTypeConfig.durationMinutes * 60_000);
    const events = await listCalendarEvents({ calendarId: settings.calendarId, timeMin: now, timeMax: horizonEnd });
    const { availabilityWindows, busyEvents } = partitionEvents(events, settings.availabilityMarkerTitle);
    const available = isSlotAvailable({
      requestedStart: selectedStart,
      availabilityWindows,
      busyEvents,
      bookingType: validation.bookingTypeConfig,
      now,
      horizonEnd,
      minimumLeadTimeHours: settings.minimumLeadTimeHours,
    });

    if (!available) return { success: false, error: "That time is no longer available. Please choose another slot." };

    const answersWithLabels = validation.bookingTypeConfig.questions.map((question) => ({
      questionId: question.id,
      questionLabel: question.label,
      answer: input.answers.find((candidate) => candidate.questionId === question.id)?.answer ?? "",
    })).filter((answer) => answer.answer.trim() !== "");

    const eventId = await insertBookingEvent({
      calendarId: settings.calendarId,
      event: buildBookingEventPayload({
        bookingTypeLabel: validation.bookingTypeConfig.label,
        start: selectedStart,
        end: selectedEnd,
        timezone: settings.timezone,
        customer: { name: input.name, email: input.email, phone: input.phone },
        answers: answersWithLabels,
      }),
    });

    if (input.marketingOptIn) {
      await formClient.create({
        _type: "bookingMarketingOptIn",
        name: input.name,
        email: input.email,
        phone: input.phone,
        bookingType: input.bookingType,
        answers: answersWithLabels,
      });
    }

    try {
      await sendBookingConfirmationEmail({
        customer: { name: input.name, email: input.email, phone: input.phone },
        bookingType: validation.bookingTypeConfig,
        start: selectedStart,
        end: selectedEnd,
        timezone: settings.timezone,
      });
    } catch (err) {
      console.error("[createBooking] Resend confirmation failed after Calendar insert:", err instanceof Error ? err.message : String(err));
    }

    return { success: true, eventId };
  } catch (err) {
    console.error("[createBooking] Booking failed:", err instanceof Error ? err.message : String(err));
    return { success: false, error: "Booking could not be completed. Please contact Nataliea." };
  } finally {
    await releaseCalendarLock(lockId);
  }
}
```

- [ ] **Step 6: Verify unit tests pass**

Run from `frontend`:

```bash
npm run test:unit -- src/lib/booking/booking-validation.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/booking/booking-validation.ts frontend/src/lib/booking/booking-validation.test.ts frontend/src/lib/booking/booking-service.ts frontend/src/lib/booking/email.ts
git commit -m "feat(booking): add booking orchestration"
```

---

### Task 7: Add booking API routes and OAuth setup routes

**Files:**
- Create: `frontend/src/app/api/booking/availability/route.ts`
- Create: `frontend/src/app/api/booking/create/route.ts`
- Create: `frontend/src/app/api/booking/oauth/start/route.ts`
- Create: `frontend/src/app/api/booking/oauth/callback/route.ts`

- [ ] **Step 1: Create availability API route**

Create `frontend/src/app/api/booking/availability/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";

import { loaders } from "@/data/loaders";
import { buildBookingSlots } from "@/lib/booking/availability";
import { listCalendarEvents } from "@/lib/booking/google-calendar";
import type { BookingType, CalendarEventWindow } from "@/lib/booking/types";

function partitionEvents(events: CalendarEventWindow[], markerTitle: string) {
  return {
    availabilityWindows: events.filter((event) => event.title.trim() === markerTitle),
    busyEvents: events.filter((event) => event.title.trim() !== markerTitle),
  };
}

export async function GET(req: NextRequest) {
  const type = req.nextUrl.searchParams.get("type") as BookingType | null;
  const settings = await loaders.getBookingSettings();
  if (!settings || !type) return NextResponse.json({ error: "Booking is not configured" }, { status: 400 });

  const bookingType = settings.bookingTypes.find((candidate) => candidate.type === type);
  if (!bookingType) return NextResponse.json({ error: "Invalid booking type" }, { status: 400 });

  try {
    const now = new Date();
    const horizonEnd = new Date(now.getTime() + settings.bookingHorizonDays * 24 * 60 * 60 * 1000);
    const events = await listCalendarEvents({ calendarId: settings.calendarId, timeMin: now, timeMax: horizonEnd });
    const { availabilityWindows, busyEvents } = partitionEvents(events, settings.availabilityMarkerTitle);
    const slots = buildBookingSlots({ availabilityWindows, busyEvents, bookingType, now, horizonEnd, minimumLeadTimeHours: settings.minimumLeadTimeHours });
    return NextResponse.json({ slots });
  } catch (err) {
    console.error("[booking availability] failed:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "Availability is temporarily unavailable" }, { status: 503 });
  }
}
```

- [ ] **Step 2: Create booking API route**

Create `frontend/src/app/api/booking/create/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";

import { createBooking } from "@/lib/booking/booking-service";
import type { BookingRequestInput } from "@/lib/booking/types";

export async function POST(req: NextRequest) {
  const body = (await req.json()) as BookingRequestInput;
  const result = await createBooking(body);
  if (!result.success) {
    return NextResponse.json(result, { status: result.fieldErrors ? 400 : 409 });
  }
  return NextResponse.json(result);
}
```

- [ ] **Step 3: Create OAuth start route**

Create `frontend/src/app/api/booking/oauth/start/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { nanoid } from "nanoid";

import { getBookingEnv } from "@/sanity/env";
import { getOAuthConsentUrl } from "@/lib/booking/google-calendar";

export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  const env = getBookingEnv();
  if (secret !== env.bookingAdminSetupSecret) {
    return new Response("Not found", { status: 404 });
  }

  const state = nanoid();
  const response = NextResponse.redirect(getOAuthConsentUrl(state));
  response.cookies.set("booking_oauth_state", state, { httpOnly: true, sameSite: "lax", secure: true, path: "/", maxAge: 600 });
  return response;
}
```

- [ ] **Step 4: Create OAuth callback route**

Create `frontend/src/app/api/booking/oauth/callback/route.ts`:

```ts
import { NextRequest } from "next/server";

import { createOAuthClient } from "@/lib/booking/google-calendar";
import { saveGoogleRefreshToken } from "@/lib/booking/operational-store";

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const cookieState = req.cookies.get("booking_oauth_state")?.value;
  if (!code || !state || state !== cookieState) {
    return new Response("Invalid OAuth callback", { status: 400 });
  }

  const oauthClient = createOAuthClient();
  const { tokens } = await oauthClient.getToken(code);
  if (!tokens.refresh_token) {
    return new Response("Google did not return a refresh token. Retry setup and approve offline access.", { status: 400 });
  }

  await saveGoogleRefreshToken(tokens.refresh_token);
  return new Response("Google Calendar connected. You can close this tab.", { status: 200 });
}
```

- [ ] **Step 5: Verify route typing**

Run from `frontend`:

```bash
npm run lint
```

Expected: no new lint errors from booking routes.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/app/api/booking
git commit -m "feat(booking): add booking api routes"
```

---

### Task 8: Add booking page and client flow

**Files:**
- Create: `frontend/src/app/(site)/booking/page.tsx`
- Create: `frontend/src/components/booking/booking-flow.tsx`
- Create: `frontend/src/components/booking/booking-entry-link.tsx`

- [ ] **Step 1: Create shared booking page**

Create `frontend/src/app/(site)/booking/page.tsx`:

```tsx
import { notFound } from "next/navigation";

import { BookingFlow } from "@/components/booking/booking-flow";
import { loaders } from "@/data/loaders";
import type { BookingType } from "@/lib/booking/types";

export const revalidate = 1800;

interface BookingPageProps {
  searchParams: Promise<{ type?: string }>;
}

function normalizeType(type?: string): BookingType | undefined {
  if (type === "training-call" || type === "in-person-appointment") return type;
  return undefined;
}

export default async function BookingPage({ searchParams }: BookingPageProps) {
  const settings = await loaders.getBookingSettings();
  if (!settings) notFound();

  const params = await searchParams;
  return (
    <main className="bg-brand-pink min-h-screen py-12">
      <BookingFlow settings={settings} initialBookingType={normalizeType(params.type)} />
    </main>
  );
}
```

- [ ] **Step 2: Create booking flow component**

Create `frontend/src/components/booking/booking-flow.tsx`:

```tsx
"use client";

import { nanoid } from "nanoid";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { BookingAnswerInput, BookingSettings, BookingSlot, BookingType } from "@/lib/booking/types";

interface BookingFlowProps {
  settings: BookingSettings;
  initialBookingType?: BookingType;
}

interface SubmitState {
  type: "idle" | "loading" | "success" | "error";
  message: string;
}

export function BookingFlow({ settings, initialBookingType }: BookingFlowProps) {
  const [bookingType, setBookingType] = useState<BookingType>(initialBookingType ?? settings.bookingTypes[0]?.type ?? "training-call");
  const selectedConfig = useMemo(() => settings.bookingTypes.find((candidate) => candidate.type === bookingType) ?? settings.bookingTypes[0], [bookingType, settings.bookingTypes]);
  const [slots, setSlots] = useState<BookingSlot[]>([]);
  const [selectedSlot, setSelectedSlot] = useState<string>("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [marketingOptIn, setMarketingOptIn] = useState(false);
  const [submitState, setSubmitState] = useState<SubmitState>({ type: "idle", message: "" });

  useEffect(() => {
    let active = true;
    async function loadSlots() {
      const response = await fetch(`/api/booking/availability?type=${bookingType}`);
      const body = (await response.json()) as { slots?: BookingSlot[]; error?: string };
      if (!active) return;
      setSlots(body.slots ?? []);
      setSelectedSlot("");
    }
    void loadSlots();
    return () => { active = false; };
  }, [bookingType]);

  if (!selectedConfig) return null;

  async function submitBooking(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitState({ type: "loading", message: "Confirming your booking..." });
    const answerPayload: BookingAnswerInput[] = Object.entries(answers).map(([questionId, answer]) => ({ questionId, answer }));
    const response = await fetch("/api/booking/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookingType, start: selectedSlot, name, email, phone, answers: answerPayload, marketingOptIn, idempotencyKey: nanoid() }),
    });
    const body = (await response.json()) as { success: boolean; error?: string };
    if (body.success) {
      setSubmitState({ type: "success", message: "Your booking is confirmed. Check your email for details and a Google Calendar invitation." });
      return;
    }
    setSubmitState({ type: "error", message: body.error ?? "Booking could not be completed. Please contact Nataliea." });
  }

  return (
    <section className="mx-auto max-w-4xl px-4">
      <div className="rounded-lg border border-brand-red bg-white p-6 text-black shadow-sm">
        <h1 className="font-heading text-3xl text-brand-red">Book with Lash Her</h1>
        <form onSubmit={submitBooking} className="mt-8 space-y-8">
          <Field>
            <FieldLabel htmlFor="booking-type">Booking type</FieldLabel>
            <select id="booking-type" value={bookingType} onChange={(event) => setBookingType(event.target.value as BookingType)} className="form-input">
              {settings.bookingTypes.map((typeConfig) => <option key={typeConfig.type} value={typeConfig.type}>{typeConfig.label}</option>)}
            </select>
          </Field>

          <Field>
            <FieldLabel htmlFor="slot">Available time</FieldLabel>
            <select id="slot" value={selectedSlot} onChange={(event) => setSelectedSlot(event.target.value)} required className="form-input">
              <option value="">Choose a time</option>
              {slots.map((slot) => <option key={slot.start} value={slot.start}>{new Date(slot.start).toLocaleString()}</option>)}
            </select>
            {slots.length === 0 && <FieldError>No available times are currently listed. Please check again later.</FieldError>}
          </Field>

          <FieldGroup className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <Field><FieldLabel htmlFor="name">Name*</FieldLabel><Input id="name" required value={name} onChange={(event) => setName(event.target.value)} /></Field>
            <Field><FieldLabel htmlFor="email">Email*</FieldLabel><Input id="email" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></Field>
            <Field><FieldLabel htmlFor="phone">Phone*</FieldLabel><Input id="phone" type="tel" required value={phone} onChange={(event) => setPhone(event.target.value)} /></Field>
          </FieldGroup>

          {selectedConfig.questions.map((question) => (
            <Field key={question.id}>
              <FieldLabel htmlFor={`question-${question.id}`}>{question.label}{question.required ? "*" : ""}</FieldLabel>
              {question.inputType === "textarea" ? (
                <Textarea id={`question-${question.id}`} required={question.required} value={answers[question.id] ?? ""} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} />
              ) : question.inputType === "select" ? (
                <select id={`question-${question.id}`} required={question.required} value={answers[question.id] ?? ""} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} className="form-input">
                  <option value="">Choose an option</option>
                  {(question.options ?? []).map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
              ) : (
                <Input id={`question-${question.id}`} required={question.required} value={answers[question.id] ?? ""} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} />
              )}
            </Field>
          ))}

          <label className="flex items-start gap-3 text-sm text-black">
            <input type="checkbox" checked={marketingOptIn} onChange={(event) => setMarketingOptIn(event.target.checked)} />
            <span>{settings.marketingOptInLabel}</span>
          </label>

          <Button type="submit" disabled={submitState.type === "loading" || !selectedSlot} className="btn-primary-red">Confirm booking</Button>
          <div aria-live="polite" role="status">{submitState.message}</div>
        </form>
      </div>
    </section>
  );
}
```

- [ ] **Step 3: Create reusable entry link**

Create `frontend/src/components/booking/booking-entry-link.tsx`:

```tsx
import Link from "next/link";

import type { BookingType } from "@/lib/booking/types";

interface BookingEntryLinkProps {
  bookingType?: BookingType;
  children: React.ReactNode;
  className?: string;
}

export function BookingEntryLink({ bookingType, children, className }: BookingEntryLinkProps) {
  const href = bookingType ? `/booking?type=${bookingType}` : "/booking";
  return <Link href={href} className={className}>{children}</Link>;
}
```

- [ ] **Step 4: Verify booking page compiles**

Run from `frontend`:

```bash
npm run lint
```

Expected: no new lint errors from booking components/page.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/'(site)'/booking/page.tsx frontend/src/components/booking/booking-flow.tsx frontend/src/components/booking/booking-entry-link.tsx
git commit -m "feat(booking): add booking page flow"
```

---

### Task 9: Add Playwright booking coverage

**Files:**
- Create: `frontend/tests/booking.spec.ts`

- [ ] **Step 1: Write booking E2E tests**

Create `frontend/tests/booking.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

test.describe("Booking page", () => {
  test("renders booking flow and handles unavailable slots", async ({ page }) => {
    await page.route("**/api/booking/availability?type=training-call", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ slots: [] }) });
    });

    await page.goto("/booking?type=training-call");
    await expect(page.getByRole("heading", { name: /book with lash her/i })).toBeVisible();
    await expect(page.getByText(/no available times/i)).toBeVisible();
  });

  test("submits selected slot and shows confirmation", async ({ page }) => {
    await page.route("**/api/booking/availability?type=training-call", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ slots: [{ start: "2026-05-10T14:00:00.000Z", end: "2026-05-10T14:30:00.000Z" }] }) });
    });
    await page.route("**/api/booking/create", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, eventId: "event-1" }) });
    });

    await page.goto("/booking?type=training-call");
    await page.getByLabel(/available time/i).selectOption("2026-05-10T14:00:00.000Z");
    await page.getByLabel(/^name/i).fill("Jane Client");
    await page.getByLabel(/^email/i).fill("jane@example.com");
    await page.getByLabel(/^phone/i).fill("555-555-5555");
    await page.getByRole("button", { name: /confirm booking/i }).click();
    await expect(page.getByText(/your booking is confirmed/i)).toBeVisible();
  });
});
```

- [ ] **Step 2: Run booking E2E test**

Run from `frontend`:

```bash
npx playwright test tests/booking.spec.ts --project=chromium
```

Expected: both tests pass.

- [ ] **Step 3: Commit**

```bash
git add frontend/tests/booking.spec.ts
git commit -m "test(booking): cover booking page flow"
```

---

### Task 10: Final verification and setup documentation

**Files:**
- Modify: `frontend/README.md`

- [ ] **Step 1: Document required booking env vars**

Append this section to `frontend/README.md`:

```md
## Booking setup

The Google Calendar booking system requires these server-side environment variables:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI`
- `BOOKING_ADMIN_SETUP_SECRET`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `RESEND_API_KEY`
- `SANITY_FORM_TOKEN`

Connect Nataliea's calendar by visiting `/api/booking/oauth/start?secret=<BOOKING_ADMIN_SETUP_SECRET>` in production and approving Google Calendar access. The connected calendar is configured in the Sanity `bookingSettings` singleton.
```

- [ ] **Step 2: Run unit tests**

Run from `frontend`:

```bash
npm run test:unit
```

Expected: all booking unit tests pass.

- [ ] **Step 3: Run related Playwright test**

Run from `frontend`:

```bash
npx playwright test tests/booking.spec.ts --project=chromium
```

Expected: booking E2E passes.

- [ ] **Step 4: Run lint and build**

Run from `frontend`:

```bash
npm run lint
npm run build
```

Expected: lint and build pass. If build fails because production env vars are unavailable in local development, verify that the failing code path uses lazy env access and does not assert booking env at module import time.

- [ ] **Step 5: Commit**

```bash
git add frontend/README.md
git commit -m "docs(booking): document calendar setup"
```

---

## Full verification checklist

Run from `frontend` before opening a PR:

```bash
npm run lint
npm run test:unit
npx playwright test tests/booking.spec.ts --project=chromium
npm run build
```

Expected: all commands pass with exit code 0.

## Implementation notes

- Keep Google Calendar as the only booking record. Do not add Sanity booking-history documents.
- Keep OAuth and Redis access inside server-only modules.
- Do not use in-memory locks; Vercel/serverless instances cannot coordinate through memory.
- Do not request Google Meet conference data in v1.
- Do not store appointment date/time in `bookingMarketingOptIn` unless the design is revised and approved.
