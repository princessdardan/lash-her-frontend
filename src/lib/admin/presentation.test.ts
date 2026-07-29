import assert from "node:assert/strict";
import test from "node:test";

import { getAdminRoleLabel, toContractorTerminology } from "./presentation";

test("admin role labels keep internal values out of rendered copy", () => {
  assert.equal(getAdminRoleLabel("owner"), "Owner");
  assert.equal(getAdminRoleLabel("admin"), "Administrator");
  assert.equal(getAdminRoleLabel("employee"), "Contractor");
});

test("legacy employee terminology is replaced across visible text and identifiers", () => {
  const cases = [
    ["Employee", "Contractor"],
    ["Employees", "Contractors"],
    ["employees", "contractors"],
    ["EMPLOYEE", "CONTRACTOR"],
    ["EMPLOYEES", "CONTRACTORS"],
    ["Employee's calendar", "Contractor's calendar"],
    ["employee-owned calendar", "contractor-owned calendar"],
    [
      "employee_calendar_connection_created",
      "contractor_calendar_connection_created",
    ],
    ["No terminology change", "No terminology change"],
  ] as const;

  for (const [input, expected] of cases) {
    assert.equal(toContractorTerminology(input), expected);
  }
});
