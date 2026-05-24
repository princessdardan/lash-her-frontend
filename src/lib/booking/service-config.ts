import type { TService } from "@/types";
import type { BookingSettings, BookingType, BookingTypeConfig } from "./types";

export const SERVICE_BOOKING_TYPE: BookingType = "in-person-appointment";

export function toServiceBookingTypeConfig(
  settings: BookingSettings,
  service: Pick<TService, "description" | "durationMinutes" | "title">,
): BookingTypeConfig {
  return {
    type: SERVICE_BOOKING_TYPE,
    label: service.title,
    description: service.description,
    durationMinutes: service.durationMinutes,
    slotIntervalMinutes: settings.slotIntervalMinutes,
    bufferMinutes: settings.bufferMinutes,
    questions: settings.intakeQuestions,
  };
}
