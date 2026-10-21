import { HighLevelError, normalizeEmail, normalizePhone } from "./contract";

export interface ProviderContact {
  id: string;
  locationId: string;
  email?: string;
  phone?: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  dnd?: boolean;
  dndSettings?: Record<
    string,
    { status?: string; code?: string; message?: string }
  >;
  customFields?: { id: string; value?: unknown }[];
}
export function selectContact(
  email: string,
  emailMatches: ProviderContact[],
  phoneMatches: ProviderContact[],
): ProviderContact | null {
  if (emailMatches.length > 1 || phoneMatches.length > 1)
    throw new HighLevelError("identity_conflict");
  const emailMatch = emailMatches[0];
  const phoneMatch = phoneMatches[0];
  if (emailMatch && phoneMatch && emailMatch.id !== phoneMatch.id)
    throw new HighLevelError("identity_conflict");
  const match = emailMatch ?? phoneMatch;
  if (match?.email && normalizeEmail(match.email) !== normalizeEmail(email))
    throw new HighLevelError("identity_conflict");
  return match ?? null;
}
export function providerBlocked(
  contact: ProviderContact,
  channel: "email" | "sms",
): boolean {
  if (contact.dnd === true) return true;
  return Object.entries(contact.dndSettings ?? {}).some(
    ([key, value]) =>
      key.toLowerCase() === channel &&
      ["active", "permanent"].includes(value.status ?? ""),
  );
}
export function assertMappedIdentity(
  contact: ProviderContact,
  location: string,
  email: string,
  phone?: string | null,
): void {
  if (!contact.id || contact.locationId !== location)
    throw new HighLevelError("provider_tenant_mismatch");
  if (contact.email && normalizeEmail(contact.email) !== normalizeEmail(email))
    throw new HighLevelError("identity_changed_in_crm");
  if (phone && contact.phone && normalizePhone(contact.phone) !== phone)
    throw new HighLevelError("phone_changed_in_crm");
}
