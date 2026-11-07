import { runWriterAdmissionWithParent } from "@/lib/writer-admission/action";
import { markWriterOperationUncertain } from "@/lib/writer-admission/context";
import "server-only";

import { decryptCalendarCredential } from "@/lib/booking/calendar-credential-secret";
import { revokeGoogleTokenBestEffort } from "@/lib/booking/google-calendar";

async function revokeEncryptedGoogleCredentialBestEffortWork(
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
    markWriterOperationUncertain();
    return;
  }

  try {
    await revokeToken(refreshToken);
  } catch {
    markWriterOperationUncertain();
    // Local credential deletion remains authoritative when revocation fails.
  }
}

export async function revokeEncryptedGoogleCredentialBestEffort(
  ...args: Parameters<typeof revokeEncryptedGoogleCredentialBestEffortWork>
) {
  return runWriterAdmissionWithParent("recovery", () =>
    revokeEncryptedGoogleCredentialBestEffortWork(...args),
  );
}
