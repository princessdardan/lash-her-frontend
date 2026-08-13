export function parseDeliveryMaxBusinessDays(
  description: string | null | undefined,
): number | null {
  if (!description) return null;
  const normalized = description.trim().toLowerCase();
  const range = normalized.match(
    /^(?:estimated\s+)?(?:delivery\s+in\s+)?(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\s+business\s+days?$/,
  );
  if (range) {
    const upper = Number(range[2]);
    return upper > 0 && upper <= 60 ? upper : null;
  }
  const single = normalized.match(
    /^(?:estimated\s+)?(?:delivery\s+in\s+)?(\d{1,2})\s+business\s+days?$/,
  );
  if (!single) return null;
  const value = Number(single[1]);
  return value > 0 && value <= 60 ? value : null;
}

export function signatureIsAvailable(
  description: string | null | undefined,
): boolean {
  if (!description) return false;
  return (
    /(?:available|included|required|yes|supported)/i.test(description) &&
    !/(?:not available|unavailable|not supported|no signature)/i.test(
      description,
    )
  );
}

export function isEquivalentSubstitution(input: {
  original: {
    deliveryMaxBusinessDays?: number;
    signatureRequired: boolean;
  };
  substitute: {
    tracked: boolean;
    insured: boolean;
    deliveryMaxBusinessDays?: number;
    signatureRequired: boolean;
  };
  introducesPickupDutyOrBrokerage: boolean;
}): boolean {
  const originalDays = input.original.deliveryMaxBusinessDays;
  const substituteDays = input.substitute.deliveryMaxBusinessDays;
  return Boolean(
    input.substitute.tracked &&
    input.substitute.insured &&
    originalDays !== undefined &&
    substituteDays !== undefined &&
    substituteDays <= originalDays &&
    !input.introducesPickupDutyOrBrokerage &&
    (!input.substitute.signatureRequired ||
      input.original.signatureRequired === input.substitute.signatureRequired),
  );
}
