import "server-only";

import type { BookingRequestInput } from "./types";

export interface BookingActionSuccess {
  success: true;
  eventId: string;
}

export interface BookingActionFailure {
  success: false;
  error: string;
  fieldErrors?: Record<string, string>;
}

export type BookingActionResult = BookingActionSuccess | BookingActionFailure;

export async function createBooking(
  input: BookingRequestInput,
): Promise<BookingActionResult> {
  void input;

  return {
    success: false,
    error: "Appointments require secure payment before Calendar confirmation.",
  };
}
