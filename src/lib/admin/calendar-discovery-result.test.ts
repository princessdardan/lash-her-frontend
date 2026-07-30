import assert from "node:assert/strict";
import test from "node:test";

import { loadCalendarDiscoveryResult } from "./calendar-discovery-result";

test("calendar discovery keeps a genuine empty result distinct from failure", async () => {
  assert.deepEqual(await loadCalendarDiscoveryResult(async () => []), {
    calendars: [],
    kind: "ready",
  });
  assert.deepEqual(
    await loadCalendarDiscoveryResult(async () => {
      throw new Error("Google unavailable");
    }),
    { kind: "error" },
  );
});
