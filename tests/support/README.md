# Calendar self-service browser fixtures

`admin-calendar-self-service.spec.ts` exercises the real employee OAuth start
route, one-time state consumption, callback, encrypted credential persistence,
calendar discovery, busy-only assignment, owner-only route denial, contractor
booking-destination promotion, and confirmed destination replacement.
Playwright starts the development server with
`google-calendar-fetch-fixture.cjs`, which handles only fixture codes and tokens
prefixed with `e2e-calendar-`. Every other request is passed to the original
network transport.

The deterministic suite requires only a migrated, isolated
`TEST_DATABASE_URL`. It seeds unique owner/employee identities, a provider
resource, and the employee-resource membership; issues Auth.js-compatible
encrypted session cookies; and removes the fixture records after the serial
workflow. For localhost URLs, `sslmode=disable` is added automatically.
Remote test databases require
`BOOKING_ADMIN_E2E_CONFIRM_ISOLATED_DATABASE=isolated`. If the inherited
`DATABASE_URL` resolves to the same target, the fixture refuses to start unless
`BOOKING_ADMIN_E2E_ALLOW_RUNTIME_DATABASE_MATCH=isolated` is also set.

The Playwright server uses that test URL as `DATABASE_URL` and supplies fixed
test-only Auth.js, OAuth, Redis-transport, and credential-encryption values.
OAuth state remains one-time and expiring, but its Upstash transport is handled
by the preload through short-lived files under the ignored `test-results`
directory so separate development-server workers share the same fixture state.
No production authentication bypass or test route is added.

The preload requires both a non-production `NODE_ENV` and
`BOOKING_ADMIN_E2E_GOOGLE_FIXTURE=1`. It throws during process startup if
fixture activation is attempted in production. Playwright does not reuse an
already-running development server, because an arbitrary server may not have
the preload installed. Stop any process already listening on port 3000 before
running the suite.

## Optional live Google smoke

`admin-calendar-self-service.live.spec.ts` retains a separate smoke path for a
real, isolated Google account and calendar. Complete employee authorization
manually before running it, then set:

- `BOOKING_ADMIN_E2E_LIVE_GOOGLE=1`
- `BOOKING_ADMIN_E2E_BASE_URL` to the isolated application origin
- `BOOKING_ADMIN_E2E_ISOLATED_LIVE_ORIGIN` to that same exact origin
- `BOOKING_ADMIN_E2E_CONFIRM_ISOLATED_LIVE_TARGET=mutate-isolated-live-calendar`
- `BOOKING_ADMIN_EMPLOYEE_STORAGE_STATE`
- `BOOKING_ADMIN_OWNER_STORAGE_STATE`
- `BOOKING_ADMIN_E2E_RESOURCE_NAME`
- `BOOKING_ADMIN_E2E_EMPLOYEE_CONNECTION_EMAIL`
- `BOOKING_ADMIN_E2E_GOOGLE_CALENDAR_LABEL`

Run the live mutation serially:

```sh
npx playwright test tests/admin-calendar-self-service.live.spec.ts \
  --project=chromium --workers=1
```

Do not point the live smoke at a production booking destination. It validates
or safely reuses the isolated resource’s existing booking destination without
disabling another assignment.
Before Playwright creates an authenticated browser context, the executable
target guard refuses production/preview runtimes, known or production-like
hosts, non-HTTPS remote origins, and remote hosts that are not explicitly named
for `e2e`, `test`, or `sandbox` use. The declared isolated origin must match the
browser target exactly. The live flag, isolated-target confirmation, employee
and owner storage states, and fixture identifiers remain separate opt-ins.

## Community customer and moderator browser coverage

Run the five P5-06 Chromium cases from a disposable frontend checkout with no
local `.env` files. Install each repository's locked dependencies first. The
runner needs Node.js 24, Google Chrome, OpenSSL, and PostgreSQL 16 tools on `PATH`.
Use Course `48dbb00f6e5be5061e044e145b0de166dfde231d` and Community
`2799fe45539530a2fdbff8cbbc1c9886e4e0d3a8` to reproduce the November 24 API
baseline. The required loopback ports are 3120 and 4107–4113.

```sh
COMMUNITY_E2E_COURSE_ROOT=/path/to/disposable-course-checkout \
COMMUNITY_E2E_COMMUNITY_ROOT=/path/to/disposable-community-checkout \
  sh tests/support/community-browser.sh
```

The runner migrates and seeds three databases in a disposable loopback
PostgreSQL cluster. It starts both API implementations, the real gateway and
private TLS proxy, and one Next.js server through the local launcher. Chromium
runs serially with one worker. The fixture uses seeded customer and Auth.js
sessions, a synthetic workload proof, local storage that checks signed object
requests, and a fresh gateway admission file. It exercises ordinary `/community`
and `/admin/community` routes with an active owner and verifies both other staff
roles are denied. The fixture also injects a malformed Community feed response
and a Course outage. It leaves service and browser logs in the printed temporary
path and stops its processes and PostgreSQL cluster at exit.

These local results apply to the pinned source and isolated fixture. Protected
staging requires its own verification of hosted identity, deployment bindings,
provider storage, and release admission.
