import assert from "node:assert/strict";
import test from "node:test";

import {
  getCalendarOwnershipTransferError,
  getEmployeeAssignmentDisableError,
  getEmployeeDisconnectError,
} from "./calendar-self-service-policy";

test("employee calendar mutations enforce connection and resource isolation", () => {
  assert.match(
    getEmployeeAssignmentDisableError({
      acceptsBookings: false,
      connectionOwnedByActor: false,
      resourceAssignedToActor: true,
    }) ?? "",
    /outside this contractor's access/,
  );
  assert.match(
    getEmployeeAssignmentDisableError({
      acceptsBookings: false,
      connectionOwnedByActor: true,
      resourceAssignedToActor: false,
    }) ?? "",
    /outside this contractor's access/,
  );
  assert.equal(
    getEmployeeAssignmentDisableError({
      acceptsBookings: false,
      connectionOwnedByActor: true,
      resourceAssignedToActor: true,
    }),
    null,
  );
});

test("employees cannot disable or disconnect an active booking destination", () => {
  assert.match(
    getEmployeeAssignmentDisableError({
      acceptsBookings: true,
      connectionOwnedByActor: true,
      resourceAssignedToActor: true,
    }) ?? "",
    /receives bookings/,
  );
  assert.match(
    getEmployeeDisconnectError([{ acceptsBookings: true }]) ?? "",
    /Move the active booking destination/,
  );
  assert.equal(getEmployeeDisconnectError([{ acceptsBookings: false }]), null);
});

test("ownership transfer requires every active assignment resource", () => {
  assert.equal(
    getCalendarOwnershipTransferError({
      activeAssignmentResourceIds: ["resource-a"],
      employeeResourceIds: ["resource-a", "resource-b"],
    }),
    null,
  );
  assert.match(
    getCalendarOwnershipTransferError({
      activeAssignmentResourceIds: ["resource-a", "resource-b"],
      employeeResourceIds: ["resource-a"],
    }) ?? "",
    /Every active calendar assignment/,
  );
});
