// Proxy/wrapper for the dynamic-route no-show tests.
//
// The actual test file lives at `[id]/no-show/route.test.ts`. Node's test runner
// treats paths passed to `--test` as globs, so the `[id]` segment is interpreted
// as a character class and the file is silently skipped when running a focused
// command like:
//
//   npx tsx --test "src/app/api/admin/appointments/[id]/no-show/route.test.ts"
//
// Import the real test module here so the suite can be run with a non-bracketed
// focused path, e.g.:
//
//   npx tsx --test "src/app/api/admin/appointments/no-show-route-proxy.test.ts"
//
// ESM module caching ensures the tests are registered exactly once even when
// both this proxy and the original file are discovered during a full run.
import "./[id]/no-show/route.test.ts";
