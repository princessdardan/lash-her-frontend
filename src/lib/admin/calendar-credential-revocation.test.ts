import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("encrypted calendar revocation never weakens authoritative local deletion", () => {
  const source = String.raw`
    import assert from "node:assert/strict";
    import credentialSecret from "./src/lib/booking/calendar-credential-secret.ts";
    import revocation from "./src/lib/admin/calendar-credential-revocation.ts";

    process.env.BOOKING_CALENDAR_CREDENTIAL_ENCRYPTION_KEY =
      Buffer.alloc(32, 41).toString("base64");

    const { encryptCalendarCredential } = credentialSecret;
    const { revokeEncryptedGoogleCredentialBestEffort } = revocation;
    const revoked = [];

    await revokeEncryptedGoogleCredentialBestEffort(
      encryptCalendarCredential("refresh-token"),
      async (token) => revoked.push(token),
    );
    await revokeEncryptedGoogleCredentialBestEffort(
      "malformed-ciphertext",
      async () => {
        throw new Error("must not be called");
      },
    );
    await revokeEncryptedGoogleCredentialBestEffort(
      encryptCalendarCredential("unavailable-token"),
      async () => {
        throw new Error("Google unavailable");
      },
    );

    assert.deepEqual(revoked, ["refresh-token"]);
  `;

  const result = spawnSync(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", "--eval", source],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        NEXT_PUBLIC_SANITY_DATASET: "test",
        NEXT_PUBLIC_SANITY_PROJECT_ID: "test-project",
      },
      stdio: "pipe",
    },
  );

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});
