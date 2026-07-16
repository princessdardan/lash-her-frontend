export const LEGACY_BOOKING_MODEL_VERSION = 1 as const;
export const OPERATIONAL_BOOKING_MODEL_VERSION = 2 as const;

export type BookingModelVersion =
  | typeof LEGACY_BOOKING_MODEL_VERSION
  | typeof OPERATIONAL_BOOKING_MODEL_VERSION;

export interface BookingModelVersionSource {
  bookingModelVersion?: number | null;
}

export class UnsupportedBookingModelVersionError extends Error {
  readonly bookingModelVersion: unknown;

  constructor(bookingModelVersion: unknown) {
    super(`Unsupported booking model version: ${String(bookingModelVersion)}`);
    this.name = "UnsupportedBookingModelVersionError";
    this.bookingModelVersion = bookingModelVersion;
  }
}

/**
 * Rows written before booking_model_version existed are treated as V1. Any
 * explicit value outside the supported set fails closed instead of silently
 * entering the legacy path.
 */
export function resolveBookingModelVersion(
  source: BookingModelVersionSource,
): BookingModelVersion {
  const version = source.bookingModelVersion;

  if (version === undefined || version === null || version === 1) {
    return LEGACY_BOOKING_MODEL_VERSION;
  }

  if (version === 2) {
    return OPERATIONAL_BOOKING_MODEL_VERSION;
  }

  throw new UnsupportedBookingModelVersionError(version);
}

export function isOperationalBooking(
  source: BookingModelVersionSource,
): boolean {
  return resolveBookingModelVersion(source) === OPERATIONAL_BOOKING_MODEL_VERSION;
}

export function dispatchBookingModel<TLegacy, TOperational>(
  source: BookingModelVersionSource,
  handlers: {
    legacy: () => TLegacy;
    operational: () => TOperational;
  },
): TLegacy | TOperational {
  return resolveBookingModelVersion(source) === LEGACY_BOOKING_MODEL_VERSION
    ? handlers.legacy()
    : handlers.operational();
}
