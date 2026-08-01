export function getEmployeeAssignmentDisableError(input: {
  acceptsBookings: boolean;
  connectionOwnedByActor: boolean;
  resourceAssignedToActor: boolean;
}): string | null {
  if (!input.connectionOwnedByActor || !input.resourceAssignedToActor) {
    return "Calendar assignment is outside this contractor's access";
  }
  if (input.acceptsBookings) {
    return "Contractors cannot disable a calendar that receives bookings";
  }
  return null;
}

export function getEmployeeDisconnectError(
  activeAssignments: ReadonlyArray<{ acceptsBookings: boolean }>,
): string | null {
  return activeAssignments.some((assignment) => assignment.acceptsBookings)
    ? "Move the active booking destination before this account can be disconnected"
    : null;
}

export function getCalendarOwnershipTransferError(input: {
  activeAssignmentResourceIds: readonly string[];
  employeeResourceIds: readonly string[];
}): string | null {
  const employeeResources = new Set(input.employeeResourceIds);
  return input.activeAssignmentResourceIds.some(
    (resourceId) => !employeeResources.has(resourceId),
  )
    ? "Every active calendar assignment must belong to a resource assigned to that contractor"
    : null;
}
