export function canGoogleCalendarAcceptBookings(accessRole: string): boolean {
  return accessRole === "owner" || accessRole === "writer";
}

export function canGoogleCalendarContributeBusy(accessRole: string): boolean {
  return accessRole === "freeBusyReader"
    || accessRole === "reader"
    || canGoogleCalendarAcceptBookings(accessRole);
}

export function getCalendarAssignmentAccessError(input: {
  acceptsBookings: boolean;
  accessRole: string | null;
}): string | null {
  if (
    input.accessRole === null
    || !canGoogleCalendarContributeBusy(input.accessRole)
  ) {
    return "The selected calendar is not available with free/busy access";
  }
  if (
    input.acceptsBookings
    && !canGoogleCalendarAcceptBookings(input.accessRole)
  ) {
    return "The booking calendar requires Google writer or owner access";
  }
  return null;
}
