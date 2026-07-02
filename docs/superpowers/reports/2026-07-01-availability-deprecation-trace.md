# Availability Route DEP0169 Trace

## Commands

- `rg "url\.parse|from ['\"]url['\"]|require\(['\"]url['\"]\)" src tests scripts next.config.ts`
- `NODE_OPTIONS=--trace-deprecation npx tsx --test src/app/api/booking/availability/route.test.ts`

## Finding

`src/app/api/booking/availability/route.ts` parses request URLs with `new URL(req.url).searchParams`, not deprecated `url.parse()`.

## Source

No DEP0169 trace reproduced during focused route tests.

## Remediation

No application code change is needed unless an app-owned `url.parse()` stack frame is found. Existing availability route behavior remains unchanged.
