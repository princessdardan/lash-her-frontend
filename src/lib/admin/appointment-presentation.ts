const SENSITIVE_ATTRIBUTION_KEYS = new Set([
  "squareteammemberid",
  "teammemberid",
]);

export function toAdminAppointmentSnapshotPresentation(input: {
  intake: unknown;
  offering: unknown;
  provider: unknown;
}): {
  intake: unknown;
  offering: unknown;
  provider: unknown;
} {
  return {
    offering: redactSquareAttributionIdentifiers(input.offering),
    provider: redactSquareAttributionIdentifiers(input.provider),
    intake: redactSquareAttributionIdentifiers(input.intake),
  };
}

function redactSquareAttributionIdentifiers(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSquareAttributionIdentifiers);
  }

  if (!isPlainRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !isSensitiveAttributionKey(key))
      .map(([key, nestedValue]) => [
        key,
        redactSquareAttributionIdentifiers(nestedValue),
      ]),
  );
}

function isSensitiveAttributionKey(key: string): boolean {
  return SENSITIVE_ATTRIBUTION_KEYS.has(
    key.toLowerCase().replaceAll(/[^a-z0-9]/g, ""),
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
