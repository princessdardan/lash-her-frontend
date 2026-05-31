# Booking and Training Calendar Configuration Guide

This guide is based on the current code implementation, schemas, and tests in this repository. It intentionally does not rely on external platform documentation.

The app has two separate scheduling paths:

1. **Service booking** uses the app's own slot picker, Sanity booking settings, private PostgreSQL holds, Square checkout, and Google Calendar event creation after payment reconciliation.
2. **Training intro-call scheduling** uses paid training enrollment records and one-time scheduling tokens. After a token is verified, the app shows a Google Calendar Appointment Schedule URL configured on the Sanity `trainingProgram` document.

Do not mix the two paths. The training schedule route does not use `BookingFlow`, `/api/booking/availability`, or app-owned holds.

## Source files to trust

Use these files as the source of truth when changing or verifying this flow:

- Service booking settings schema: `src/sanity/schemas/documents/booking-settings.ts`
- Service schema: `src/sanity/schemas/documents/service.ts`
- Booking settings and training projections: `src/data/loaders.ts`
- Booking public pages: `src/app/(site)/booking/page.tsx`, `src/app/(site)/services/[slug]/booking/page.tsx`
- Booking client flow: `src/components/booking/booking-flow.tsx`
- Booking API routes: `src/app/api/booking/availability/route.ts`, `src/app/api/booking/holds/route.ts`, `src/app/api/booking/checkout/route.ts`
- Google Calendar OAuth and events: `src/app/api/booking/oauth/start/route.ts`, `src/app/api/booking/oauth/callback/route.ts`, `src/lib/booking/google-calendar.ts`
- Service booking Square checkout: `src/lib/booking/square-service-checkout.ts`, `src/lib/env/private-checkout.ts`
- Training program schema: `src/sanity/schemas/documents/training-program.ts`
- Training programs overview schema: `src/sanity/schemas/documents/training-programs-page.ts`
- Training schedule route: `src/app/(site)/training-programs/[slug]/schedule/page.tsx`
- Training token eligibility: `src/lib/booking/paid-training-context.ts`, `src/lib/commerce/training-enrollment-store.ts`
- Training scheduling URL builder and commerce rules: `src/lib/training-checkout.ts`
- Training payment notification email: `src/lib/commerce/training-payment-email.ts`
- Training route contract tests: `src/app/(site)/training-programs/[slug]/schedule/page.test.ts`

## Configure service booking

The current implementation intentionally blocks direct appointment creation. `src/app/api/booking/create/route.ts` always returns `Appointments require secure payment before Calendar confirmation.` for valid JSON requests. Configure and test the hold -> checkout -> reconciliation path instead.

### 1. Run from the repository root

All package scripts are defined in the root `package.json`. Use the repository root for setup, validation, and local testing:

```bash
npm install
npm run db:migrate
npm run dev
```

Use these checks after environment or schema changes:

```bash
node scripts/validate-sanity-env.mjs
npm run build
npx sanity schema deploy
```

Implementation notes from the repo:

- `npm run build` runs `node scripts/validate-sanity-env.mjs` first through the `prebuild` script.
- `npm run db:migrate` applies private PostgreSQL migrations through `scripts/migrate-private-db.ts`.
- `npx sanity schema deploy` is needed only after changing source schemas in `src/sanity/schemas/**`.

### 2. Configure required environment variables

Service booking needs private database access, Google Calendar OAuth, Square service-booking checkout, and email/payment support.

Set these server-side variables where the booking flow should run:

```text
DATABASE_URL=

GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=
BOOKING_ADMIN_SETUP_SECRET=
KV_REST_API_URL=
KV_REST_API_TOKEN=

SERVICE_BOOKING_SQUARE_ENABLED=true
SQUARE_ENVIRONMENT=sandbox | production
SQUARE_ACCESS_TOKEN=
SQUARE_LOCATION_ID=
SQUARE_WEBHOOK_SIGNATURE_KEY=
SQUARE_SERVICE_BOOKING_RETURN_URL=https://<domain>/api/booking/square/return
SQUARE_SERVICE_BOOKING_WEBHOOK_URL=https://<domain>/api/webhooks/square

PAYMENT_GATEWAY_MODE=live
CHECKOUT_SECRET_ENCRYPTION_KEY=
RESEND_API_KEY=
RESEND_WEBHOOK_SECRET=
RESEND_SEGMENT_MARKETING_ID=
FROM_EMAIL=
ADMIN_EMAIL=
```

Implementation notes from the code:

- `src/sanity/env.ts` requires the Google OAuth and KV variables through `getBookingEnv()`.
- `src/lib/env/private-checkout.ts` returns `null` from `getSquareServiceBookingEnv()` unless `SERVICE_BOOKING_SQUARE_ENABLED=true`.
- When Square service booking is enabled, `SQUARE_ENVIRONMENT` must be exactly `sandbox` or `production`.
- `SQUARE_SERVICE_BOOKING_RETURN_URL` and `SQUARE_SERVICE_BOOKING_WEBHOOK_URL` must parse as valid URLs.
- `PAYMENT_GATEWAY_MODE=mock` is for local/dev mock payment flows only. Keep production on `live`.
- Product checkout and standard training checkout are Helcim-backed; do not add `NEXT_PUBLIC_SQUARE_*` variables.

### 3. Connect Google Calendar OAuth

The service booking flow reads and writes Google Calendar events with OAuth.

1. Ensure the Google and KV variables above are present.
2. Open the setup route in the target environment:

   ```text
   /api/booking/oauth/start?secret=<BOOKING_ADMIN_SETUP_SECRET>
   ```

3. Complete Google consent with the calendar account that should own booking events.
4. The callback route stores the Google refresh token through `saveGoogleRefreshToken()`.
5. A successful callback returns:

   ```text
   Google Calendar booking OAuth is connected
   ```

Security rule from the repo: treat the setup URL as sensitive because it contains `BOOKING_ADMIN_SETUP_SECRET`.

### 4. Create or update the Sanity `bookingSettings` document

The public `/booking` page and `/services/[slug]/booking` page both require `loaders.getBookingSettings()` to return a document. If it is missing, those routes call `notFound()`.

In Studio, create/update **Booking Settings** with these fields:

| Field                   | Code field             | Required behavior                                                                                      |
| ----------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------ |
| Google Calendar ID      | `calendarId`           | Required. Use `primary` or a specific calendar ID. Availability and event creation use this value.     |
| Booking Horizon Days    | `bookingHorizonDays`   | Integer 1-180. Availability searches from now to this horizon.                                         |
| Minimum Lead Time Hours | `minimumLeadTimeHours` | Integer 0-720. Slots before this lead time are not bookable.                                           |
| Booking Timezone        | `timezone`             | Required. Used on holds and booking summaries. Default is `America/Toronto`.                           |
| Buffer Minutes          | `bufferMinutes`        | Integer 0-120. Applied before and after service bookings.                                              |
| Slot Interval Minutes   | `slotIntervalMinutes`  | Integer 5-120. Controls slot spacing.                                                                  |
| Hours of Operation      | `hoursOfOperation`     | Exactly seven day records. Each day has `day`, `isOpen`, `opensAt`, `closesAt`. Times must be `HH:mm`. |
| Client Intake Questions | `intakeQuestions`      | Optional array. Question IDs must match `^[a-z0-9-]+$`; input type is `text`, `textarea`, or `select`. |
| Marketing Opt-in Label  | `marketingOptInLabel`  | Required label rendered in `BookingFlow`.                                                              |

The app reads only these projected settings in `src/data/loaders.ts`:

```groq
calendarId,
bookingHorizonDays,
minimumLeadTimeHours,
timezone,
bufferMinutes,
slotIntervalMinutes,
hoursOfOperation[]{ _key, day, isOpen, opensAt, closesAt },
"intakeQuestions": coalesce(intakeQuestions[]{ _key, id, label, inputType, required, options }, []),
marketingOptInLabel
```

### 5. Configure bookable Sanity `service` documents

Only services with valid payment fields are shown as bookable. `loaders.getBookableServices()` filters services through `isPaymentConfiguredService()`.

For each bookable service, configure:

| Field                 | Code field        | Required behavior                                                                                                     |
| --------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| Title                 | `title`           | Required. Used as booking label.                                                                                      |
| Slug                  | `slug.current`    | Required. Used in `/services/<slug>/booking`.                                                                         |
| Description           | `description`     | Required. Used in service config and UI.                                                                              |
| Available for booking | `isAvailable`     | Required in schema, but current bookable filtering depends on pricing. Keep this aligned with editorial availability. |
| Duration Minutes      | `durationMinutes` | Required integer 15-240. Used to calculate slot end time.                                                             |
| Full Price            | `fullPrice`       | Required positive number for bookable services. Must be greater than deposit.                                         |
| Deposit Amount        | `depositAmount`   | Required positive number for bookable services. Must be less than full price.                                         |
| Currency              | `currency`        | Read-only `CAD`.                                                                                                      |

A service is bookable only when:

```ts
depositAmount > 0 && fullPrice > 0 && depositAmount < fullPrice;
```

### 6. Verify service booking URLs

The canonical service booking URL is:

```text
/services/<service-slug>/booking
```

The legacy `/booking` route still exists and can redirect old query shapes through `resolveBookingShim()`, but current service listing/detail CTAs should use `/services/<slug>/booking`.

At runtime:

1. `/services/<slug>/booking` loads booking settings, the selected bookable service, and all bookable services.
2. It renders `BookingFlow` with `initialServiceSlug`, `servicePayment`, and `services`.
3. The UI fetches `/api/booking/availability` for slots.
4. The UI posts to `/api/booking/holds` with customer details, selected slot, selected service, intake answers, and payment selection.
5. The UI posts to `/api/booking/checkout` with the returned hold reference.
6. `/api/booking/checkout` creates or reuses a Square payment link and returns `checkoutUrl`.

### 7. Confirm booking API behavior

Use these implementation checks when diagnosing configuration:

- `/api/booking/availability` returns `{ error: "A valid service is required" }` when no service slug is supplied.
- `/api/booking/availability` returns `{ error: "Booking is not configured" }` when settings, service, calendar ID, or horizon are invalid.
- `/api/booking/holds` validates name, email, phone, service slug, selected start time, required intake answers, and final slot availability.
- `/api/booking/checkout` requires a held, unexpired appointment hold and a configured payment selection.
- Square checkout throws `Square service booking checkout is not enabled` when `SERVICE_BOOKING_SQUARE_ENABLED` is not `true`.

## Add Google Calendar booking pages to training programs

Training intro-call scheduling is configured on each `trainingProgram` document. It is not a general public booking page.

### 1. Understand the training scheduling flow

The code creates a secure schedule link only after training payment is finalized.

1. Training checkout validates the Sanity training program using `validateTrainingCheckoutRequest()`.
2. Paid training finalization calls `getOrIssueTrainingSchedulingTokenForPaidOrder()`.
3. The token is valid for 14 days (`TRAINING_SCHEDULING_LINK_TTL_DAYS` and `SCHEDULING_TOKEN_TTL_DAYS`).
4. The payment email sends a link labeled **Schedule Training Call**.
5. The confirmation page also calls `getOrIssueTrainingSchedulingTokenForPaidOrder()` and renders a **Schedule Training Call** link after the order is verified.
6. Those links are built by `buildTrainingScheduleUrl()` as:

   ```text
   /training-programs/<program-slug>/schedule?token=<scheduling-token>
   ```

7. The schedule page verifies the token server-side before rendering any Google Appointment Schedule URL.

### 2. Configure the training program for online checkout

In Studio, open the `trainingProgram` document and configure the **Checkout** group.

The Google Appointment Schedule fields are hidden unless `checkoutEnabled` is true.

Required checkout fields for purchasable training programs:

| Field                      | Code field                 | Required behavior                                                                                         |
| -------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------- |
| Enable Online Checkout     | `checkoutEnabled`          | Must be `true` for checkout and schedule fields.                                                          |
| Price                      | `price`                    | Required positive number when checkout is enabled.                                                        |
| Manual Discount Price      | `discountPrice`            | Optional; must be lower than `price` when present.                                                        |
| Available for checkout     | `isAvailable`              | Must be boolean when checkout is enabled. The app only treats the program as purchasable when it is true. |
| Checkout CTA Label         | `checkoutCtaLabel`         | Optional. Defaults to `Enroll Now` in code.                                                               |
| Post-Purchase Instructions | `postPurchaseInstructions` | Optional. Projected for training pages.                                                                   |

The code sets training currency to `CAD` in GROQ projections rather than in the Sanity schema.

### 3. Add the Google Calendar Appointment Schedule URL

On the same `trainingProgram` document, set:

| Field                                   | Code field                              | Behavior                                                                                  |
| --------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------- |
| Intro Call Appointment Schedule URL     | `introCallAppointmentScheduleUrl`       | Public Google Calendar Appointment Schedule URL shown only after paid token verification. |
| Intro Call Appointment Schedule Display | `introCallAppointmentScheduleEmbedMode` | `link` or `embed`. Defaults to `link` through the loader.                                 |
| Intro Call Scheduling Instructions      | `introCallSchedulingInstructions`       | Optional text shown above the schedule UI.                                                |

The URL must pass both schema validation and route validation:

```text
https://calendar.google.com/calendar/appointments/schedules/...
```

The route rejects anything that is not:

- `https:` protocol
- `calendar.google.com` hostname
- a path starting with `/calendar/appointments/schedules/`

If the field is missing or invalid, a paid student sees the safe **Scheduling Unavailable** shell instead of the appointment URL.

### 4. Choose link or embed mode

Use `introCallAppointmentScheduleEmbedMode` to decide how verified students see the appointment schedule:

- `link`: renders a button labeled **Open Google Appointment Schedule** with `target="_blank"` and `rel="noopener noreferrer"`.
- `embed`: renders a larger desktop-only `<iframe>` using the schedule URL and a title of `Google Appointment Schedule for <program title>`. On mobile widths, the route avoids the cramped inline Google Calendar frame and renders Google's **Button with popup** scheduling button instead.

The route normalizes any non-`embed` value to `link`:

```ts
const embedMode =
  program.introCallAppointmentScheduleEmbedMode === "embed" ? "embed" : "link";
```

### 5. Add the program to the training programs page

The overview page is driven by the singleton `trainingProgramsPage` document.

In Studio:

1. Open **Training Programs Overview**.
2. Add the configured `trainingProgram` document to the `trainingPrograms` reference array.
3. Publish the overview and program documents.

`loaders.getTrainingProgramsPageData()` dereferences that array and includes the schedule-related fields in the projection:

```groq
introCallAppointmentScheduleUrl,
"introCallAppointmentScheduleEmbedMode": coalesce(introCallAppointmentScheduleEmbedMode, "link"),
introCallSchedulingInstructions
```

The overview route `/training-programs` renders the referenced programs. The actual booking/scheduling page is still the protected route:

```text
/training-programs/<program-slug>/schedule?token=<scheduling-token>
```

Do not add the raw Google Appointment Schedule URL directly to public overview CTAs. The implemented pattern keeps the Google schedule behind paid token verification.

Current overview-card behavior in `src/components/custom/training-programs-section.tsx` is:

- CTA label: `program.primaryCta?.label ?? program.checkoutCtaLabel ?? "View Details"`
- CTA href: `/training-programs/${program.slug}`
- `checkoutEnabled` adds an **Enrollment Open** badge and switches the button variant to primary.

Current detail-page behavior in `src/app/(site)/training-programs/[slug]/page.tsx` is:

- `getTrainingCta()` returns `/training-programs/<slug>/checkout` only when the program is purchasable.
- If checkout is disabled, it uses `checkoutDisabledBookingCta` when safe, otherwise falls back to `Book a Call` and `#contact`.
- The detail page does not link directly to `introCallAppointmentScheduleUrl`.

### 6. Verify token and route behavior

The schedule route intentionally disables static caching and indexing:

```ts
export const revalidate = 0;
export const dynamic = "force-dynamic";
noStore();
robots: { index: false, follow: false }
```

It accepts only one query parameter: `token`. Any additional or different search parameter calls `notFound()`.

Eligibility requires all of the following:

- The token is non-empty.
- `findPendingTrainingEnrollmentByToken()` finds a pending enrollment for the token hash.
- The enrollment `programSnapshot.slug` matches the route slug.
- The checkout order status is `paid`.
- `tokenExpiresAt` exists and is still in the future.
- The training program has a valid `introCallAppointmentScheduleUrl`.

If any check fails, the page shows **Scheduling Unavailable** with a `/contact` CTA and does not expose order IDs, checkout emails, or the appointment schedule URL.

## Manual QA checklist

Use this checklist after configuration changes.

### Service booking

1. Open `/services/<service-slug>/booking` for a service with valid `fullPrice`, `depositAmount`, and `durationMinutes`.
2. Confirm the page renders the service title and booking flow.
3. Confirm availability loads from `/api/booking/availability?service=<slug>`.
4. Select a slot and fill required customer/intake fields.
5. Submit the hold step and confirm `/api/booking/holds` returns a hold reference.
6. Continue to checkout and confirm `/api/booking/checkout` returns a Square checkout URL.
7. After payment reconciliation, verify the appointment is finalized into the configured Google Calendar.

### Training intro-call schedule

1. Configure a `trainingProgram` with `checkoutEnabled=true`, valid checkout price fields, and a valid `introCallAppointmentScheduleUrl`.
2. Add the program to `trainingProgramsPage.trainingPrograms` if it should appear on `/training-programs`.
3. Complete or simulate the training payment flow so the app issues a scheduling token.
4. Open `/training-programs/<program-slug>/schedule?token=<token>`.
5. Confirm the page renders **Schedule Training Call** and either the link button or iframe based on `introCallAppointmentScheduleEmbedMode`. For `embed`, verify the iframe appears on desktop and the Google **Button with popup** appears on mobile.
6. Open the same route without a token and confirm it shows **Scheduling Unavailable**.
7. Open the route with an extra query parameter and confirm it 404s.

## Common configuration mistakes

- Creating a `trainingProgram` schedule URL while `checkoutEnabled` is false. The schedule fields are hidden and the paid-token route expects the training purchase flow.
- Using a Google URL that is not under `calendar.google.com/calendar/appointments/schedules/`.
- Adding the Google Appointment Schedule URL to public CTAs instead of using the protected schedule route.
- Expecting training intro-call scheduling to use `BookingFlow`; the schedule route explicitly does not import it.
- Missing the singleton `bookingSettings` document, which makes public booking pages unavailable.
- Enabling Square service booking without all required server-only Square variables.
- Setting service `depositAmount` greater than or equal to `fullPrice`; those services are not bookable.
- Treating Sanity as storage for private booking, payment, enrollment, or customer submission data. The repo stores those records in PostgreSQL.
