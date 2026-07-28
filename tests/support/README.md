# Calendar self-service browser fixtures

`admin-calendar-self-service.spec.ts` exercises the real employee OAuth start
route, one-time state consumption, callback, encrypted credential persistence,
calendar discovery, busy-only assignment, owner-only route denial, and owner
promotion. Playwright starts the development server with
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

Do not point the live smoke at a production booking destination. It disables a
prior assignment with the configured test label so the scenario is repeatable,
then promotes that isolated calendar to the resource’s write destination.
Before Playwright creates an authenticated browser context, the executable
target guard refuses production/preview runtimes, known or production-like
hosts, non-HTTPS remote origins, and remote hosts that are not explicitly named
for `e2e`, `test`, or `sandbox` use. The declared isolated origin must match the
browser target exactly. The live flag, isolated-target confirmation, employee
and owner storage states, and fixture identifiers remain separate opt-ins.
