import assert from "node:assert/strict";
import test from "node:test";

import { localDateTimeToUtc } from "./local-time";

test("converts Toronto local time to an absolute instant", () => {
  assert.equal(
    localDateTimeToUtc("2026-07-10T09:30", "America/Toronto").toISOString(),
    "2026-07-10T13:30:00.000Z",
  );
});

test("rejects a nonexistent DST wall time", () => {
  assert.throws(
    () => localDateTimeToUtc("2026-03-08T02:30", "America/Toronto"),
    /does not exist/,
  );
});
