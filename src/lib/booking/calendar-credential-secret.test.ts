import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";

const baseEnv = {
  NEXT_PUBLIC_SANITY_DATASET: "test",
  NEXT_PUBLIC_SANITY_PROJECT_ID: "test-project",
};

describe("calendar credential encryption", () => {
  it("round-trips credentials with nondeterministic ciphertext", () => {
    runScenario(`
      import { decryptCalendarCredential, encryptCalendarCredential } from "./src/lib/booking/calendar-credential-secret.ts";

      const credential = "google-refresh-token";
      const first = encryptCalendarCredential(credential);
      const second = encryptCalendarCredential(credential);

      assert.match(first, /^v1:[^:]+:[^:]+:[^:]+$/);
      assert.notEqual(first, credential);
      assert.notEqual(first, second);
      assert.equal(decryptCalendarCredential(first), credential);
      assert.equal(decryptCalendarCredential(second), credential);
    `);
  });

  it("rejects empty credentials and malformed ciphertext", () => {
    runScenario(`
      import { decryptCalendarCredential, encryptCalendarCredential } from "./src/lib/booking/calendar-credential-secret.ts";

      assert.throws(() => encryptCalendarCredential("  "), /cannot be empty/);
      assert.throws(
        () => decryptCalendarCredential("not-ciphertext"),
        /Malformed calendar credential ciphertext/,
      );
      assert.throws(
        () => decryptCalendarCredential("v1:not-base64:also-bad:still-bad"),
        /Malformed calendar credential ciphertext/,
      );
    `);
  });

  it("rejects missing and malformed dedicated encryption keys", () => {
    runScenario(
      `
        import { encryptCalendarCredential } from "./src/lib/booking/calendar-credential-secret.ts";
        assert.throws(
          () => encryptCalendarCredential("credential"),
          /Missing env var: BOOKING_CALENDAR_CREDENTIAL_ENCRYPTION_KEY/,
        );
      `,
      null,
    );

    runScenario(
      `
        import { encryptCalendarCredential } from "./src/lib/booking/calendar-credential-secret.ts";
        assert.throws(
          () => encryptCalendarCredential("credential"),
          /BOOKING_CALENDAR_CREDENTIAL_ENCRYPTION_KEY must be base64-encoded 32 bytes/,
        );
      `,
      Buffer.from("too-short").toString("base64"),
    );
  });

  it("does not decrypt with a different key", () => {
    const firstKey = randomBytes(32).toString("base64");
    const secondKey = randomBytes(32).toString("base64");

    runScenario(`
      import { decryptCalendarCredential, encryptCalendarCredential } from "./src/lib/booking/calendar-credential-secret.ts";
      const ciphertext = encryptCalendarCredential("credential");
      process.env.BOOKING_CALENDAR_CREDENTIAL_ENCRYPTION_KEY = "${secondKey}";
      assert.throws(() => decryptCalendarCredential(ciphertext));
    `, firstKey);
  });
});

function runScenario(
  script: string,
  encryptionKey: string | null = randomBytes(32).toString("base64"),
): void {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...baseEnv,
    NODE_ENV: process.env.NODE_ENV,
  };

  if (encryptionKey === null) {
    delete env.BOOKING_CALENDAR_CREDENTIAL_ENCRYPTION_KEY;
  } else {
    env.BOOKING_CALENDAR_CREDENTIAL_ENCRYPTION_KEY = encryptionKey;
  }

  execFileSync(
    "./node_modules/.bin/tsx",
    [
      "--conditions=react-server",
      "--eval",
      `import assert from "node:assert/strict";\n${script}`,
    ],
    {
      cwd: process.cwd(),
      env,
      stdio: "pipe",
    },
  );
}
