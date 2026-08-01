import type { AppointmentStatus } from "@/lib/private-db/schema";

export function getAttendanceTransitionError(input: {
  currentStatus: AppointmentStatus;
  nextStatus: "completed" | "no_show";
  now: Date;
  selectedEnd: Date;
}): string | null {
  if (input.currentStatus === input.nextStatus) return null;
  if (input.currentStatus !== "confirmed") {
    return "Only confirmed appointments can be completed or marked no-show";
  }
  if (input.selectedEnd > input.now) {
    return "Attendance can only be recorded after the appointment end time";
  }
  return null;
}
