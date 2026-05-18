# BOOKING LIBRARY

## OVERVIEW

Booking domain logic validates requests, checks Google Calendar availability, creates calendar events, stores operational idempotency state, and audits marketing consent choices.

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Booking orchestration | `booking-service.ts` | Full create-booking pipeline and failure mapping. |
| Input validation | `booking-validation.ts`, `types.ts` | Request shape, booking type, answers, lead-time rules. |
| Availability | `availability.ts` | Calendar availability window and conflict calculations. |
| Google Calendar | `google-calendar.ts`, `google-calendar-event-payload.ts` | External event fetch/insert boundary. |
| Operational locks | `operational-store.ts` | Idempotency and calendar lock persistence. |
| Paid training context | `paid-training-context.ts` | Scheduling-token lookup for paid training bookings. |
| Email | `email.ts` | Booking notification content. |

## CONVENTIONS

- `createBooking` is the service surface used by `src/app/api/booking/create/route.ts`.
- Booking types are constrained to training calls and in-person appointments.
- The service acquires idempotency and calendar locks before event insertion.
- Marketing opt-in/audit writes use private DB-backed marketing contact storage, not Sanity.
- Unit coverage lives next to behavior files as `*.test.ts` and uses Node test via `tsx --test`.

## ANTI-PATTERNS

- Do not bypass availability or lock checks when creating calendar events.
- Do not expose raw Google/Upstash errors to API clients.
- Do not treat paid training scheduling tokens as public identifiers; resolve through the paid-training context path.
- Do not move booking consent records into Sanity.
