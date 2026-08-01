import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  type CalendarDestinationReplacementApproval,
  isCalendarDestinationReplacementApprovalExact,
} from "./calendar-assignment-form";

const requestedReplacement: CalendarDestinationReplacementApproval = {
  currentAssignmentId: "assignment-current",
  targetCalendarId: "calendar-new",
  targetConnectionId: "connection-new",
  targetResourceId: "resource-1",
};

test("calendar destination approval is exact for the current and target records", () => {
  assert.equal(
    isCalendarDestinationReplacementApprovalExact(
      { ...requestedReplacement },
      requestedReplacement,
    ),
    true,
  );

  for (const approved of [
    {
      ...requestedReplacement,
      currentAssignmentId: "assignment-stale",
    },
    {
      ...requestedReplacement,
      targetCalendarId: "calendar-other",
    },
    {
      ...requestedReplacement,
      targetConnectionId: "connection-other",
    },
    {
      ...requestedReplacement,
      targetResourceId: "resource-other",
    },
    null,
  ]) {
    assert.equal(
      isCalendarDestinationReplacementApprovalExact(
        approved,
        requestedReplacement,
      ),
      false,
    );
  }
});

test("calendar destination replacement uses an accessible dialog instead of a native confirmation", async () => {
  const source = await readFile(
    new URL("./calendar-assignment-form.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /@radix-ui\/react-dialog/);
  assert.match(source, /<Dialog\.Title/);
  assert.match(source, /<Dialog\.Description/);
  assert.match(source, /confirmedReplacementAssignmentId/);
  assert.doesNotMatch(source, /window\.confirm/);
});
