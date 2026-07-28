import "server-only";

import { decryptCalendarCredential } from "@/lib/booking/calendar-credential-secret";
import { revokeGoogleTokenBestEffort } from "@/lib/booking/google-calendar";

export async function revokeEncryptedGoogleCredentialBestEffort(
  credentialCiphertext: string | null,
  revokeToken: (token: string) => Promise<void> = revokeGoogleTokenBestEffort,
): Promise<void> {
  if (credentialCiphertext === null) {
    return;
  }

  let refreshToken: string;
  try {
    refreshToken = decryptCalendarCredential(credentialCiphertext);
  } catch {
    return;
  }

  try {
    await revokeToken(refreshToken);
  } catch {
    // Local credential deletion remains authoritative when revocation fails.
  }
}
