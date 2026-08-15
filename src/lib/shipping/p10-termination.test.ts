import assert from "node:assert/strict";
import test from "node:test";

import { parseP10PolicyAmendment } from "./p10-termination";

test("P-10 pre-cap amendment requires notice at 350 and execution at 360", () => {
  assert.deepEqual(
    parseP10PolicyAmendment("p10-v2", {
      p10TerminationNoticeDays: 350,
      p10DefaultExecutionDays: 360,
      p10HardCapDays: 365,
    }),
    {
      version: "p10-v2",
      noticeDays: 350,
      executionDays: 360,
      hardCapDays: 365,
    },
  );
  assert.equal(
    parseP10PolicyAmendment("legacy", {
      p10WarningDays: [335, 350],
      p10HardCapDays: 365,
    }),
    null,
  );
});
