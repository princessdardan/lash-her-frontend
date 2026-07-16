import "server-only";

export type ServiceBookingModelMode = "dual" | "legacy" | "operational";

export function getServiceBookingModelMode(
  env: {
    [key: string]: string | undefined;
    SERVICE_BOOKING_MODEL_MODE?: string;
  } = process.env,
): ServiceBookingModelMode {
  const value = env.SERVICE_BOOKING_MODEL_MODE?.trim().toLowerCase();

  if (value === undefined || value.length === 0) {
    return "dual";
  }

  if (value === "legacy" || value === "dual" || value === "operational") {
    return value;
  }

  throw new Error(
    "SERVICE_BOOKING_MODEL_MODE must be legacy, dual, or operational",
  );
}

export function permitsLegacyBookingCreation(
  mode: ServiceBookingModelMode,
): boolean {
  return mode !== "operational";
}

export function permitsOperationalBookingCreation(
  mode: ServiceBookingModelMode,
): boolean {
  return mode !== "legacy";
}
