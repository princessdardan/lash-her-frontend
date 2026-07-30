export interface BookingDestinationSnapshot {
  assignmentId: string;
  connectionId: string;
  providerCalendarId: string;
}

export function getBookingDestinationChangeError(input: {
  acceptsBookings: boolean;
  confirmedReplacementAssignmentId: string | null;
  currentDestination: BookingDestinationSnapshot | null;
  requestedConnectionId: string;
  requestedProviderCalendarId: string;
}): string | null {
  const current = input.currentDestination;
  const targetsCurrentDestination =
    current !== null &&
    current.connectionId === input.requestedConnectionId &&
    current.providerCalendarId === input.requestedProviderCalendarId;

  if (input.confirmedReplacementAssignmentId !== null) {
    if (
      current === null ||
      targetsCurrentDestination ||
      current.assignmentId !== input.confirmedReplacementAssignmentId
    ) {
      return "The booking destination changed. Refresh and confirm the replacement again";
    }
  }

  if (targetsCurrentDestination && !input.acceptsBookings) {
    return "Move the booking destination before changing this calendar to busy-only";
  }

  if (
    input.acceptsBookings &&
    current !== null &&
    !targetsCurrentDestination &&
    input.confirmedReplacementAssignmentId === null
  ) {
    return "Confirm the existing booking destination replacement before saving";
  }

  return null;
}

export function getBookingDestinationDisableError(input: {
  acceptsBookings: boolean;
  status: "active" | "disabled";
}): string | null {
  return input.status === "active" && input.acceptsBookings
    ? "Move the booking destination before disabling this calendar assignment"
    : null;
}

export function getCalendarConnectionDisableError(
  activeBookingDestinationResourceNames: readonly string[],
): string | null {
  if (activeBookingDestinationResourceNames.length === 0) {
    return null;
  }

  const resourceNames = [...new Set(activeBookingDestinationResourceNames)];
  return `Move the booking destination for ${formatList(resourceNames)} before disabling this Google account`;
}

function formatList(values: readonly string[]): string {
  if (values.length === 1) {
    return values[0]!;
  }
  if (values.length === 2) {
    return `${values[0]} and ${values[1]}`;
  }
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}
