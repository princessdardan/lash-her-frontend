import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";

const baseEnv = {
  NEXT_PUBLIC_SANITY_DATASET: "test",
  NEXT_PUBLIC_SANITY_PROJECT_ID: "test-project",
};

describe("checkout secret encryption", () => {
  it("round-trips secrets without deterministic ciphertext", () => {
    runCheckoutSecretScenario(`
            import { decryptCheckoutSecret, encryptCheckoutSecret } from "./src/lib/commerce/checkout-secret.ts";

      const secretToken = "checkout-secret-token";
      const firstCiphertext = encryptCheckoutSecret(secretToken);
      const secondCiphertext = encryptCheckoutSecret(secretToken);

      assert.match(firstCiphertext, /^v1:[^:]+:[^:]+:[^:]+$/);
      assert.notEqual(firstCiphertext, secretToken);
      assert.notEqual(firstCiphertext, secondCiphertext);
      assert.equal(decryptCheckoutSecret(firstCiphertext), secretToken);
      assert.equal(decryptCheckoutSecret(secondCiphertext), secretToken);
    `);
  });

  it("rejects malformed ciphertext", () => {
    runCheckoutSecretScenario(`
            import { decryptCheckoutSecret } from "./src/lib/commerce/checkout-secret.ts";

      assert.throws(
        () => decryptCheckoutSecret("secret-token"),
        /Malformed checkout secret ciphertext/,
      );
      assert.throws(
        () => decryptCheckoutSecret("v1:not-base64:also-bad:still-bad"),
        /Malformed checkout secret ciphertext/,
      );
    `);
  });

  it("rejects missing and malformed encryption keys", () => {
    runCheckoutSecretScenario(
      `
                import { encryptCheckoutSecret } from "./src/lib/commerce/checkout-secret.ts";

        assert.throws(
          () => encryptCheckoutSecret("secret-token"),
          /Missing env var: CHECKOUT_SECRET_ENCRYPTION_KEY/,
        );
      `,
      null,
    );

    runCheckoutSecretScenario(
      `
                import { encryptCheckoutSecret } from "./src/lib/commerce/checkout-secret.ts";

        assert.throws(
          () => encryptCheckoutSecret("secret-token"),
          /CHECKOUT_SECRET_ENCRYPTION_KEY must be base64-encoded 32 bytes/,
        );
      `,
      Buffer.from("too-short").toString("base64"),
    );
  });
});

function runCheckoutSecretScenario(
  script: string,
  encryptionKey: string | null = randomBytes(32).toString("base64"),
): void {
  const originalDataset = process.env.NEXT_PUBLIC_SANITY_DATASET;
  const originalProjectId = process.env.NEXT_PUBLIC_SANITY_PROJECT_ID;
  const originalEncryptionKey = process.env.CHECKOUT_SECRET_ENCRYPTION_KEY;

  try {
    process.env.NEXT_PUBLIC_SANITY_DATASET = baseEnv.NEXT_PUBLIC_SANITY_DATASET;
    process.env.NEXT_PUBLIC_SANITY_PROJECT_ID = baseEnv.NEXT_PUBLIC_SANITY_PROJECT_ID;
    if (encryptionKey === null) {
      delete process.env.CHECKOUT_SECRET_ENCRYPTION_KEY;
    } else {
      process.env.CHECKOUT_SECRET_ENCRYPTION_KEY = encryptionKey;
    }

    const scenario = `import assert from "node:assert/strict";\n${script}`;
    execFileSync(
      "./node_modules/.bin/tsx",
      ["--conditions=react-server", "--eval", scenario],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: "pipe",
      },
    );
  } finally {
    restoreEnvValue("NEXT_PUBLIC_SANITY_DATASET", originalDataset);
    restoreEnvValue("NEXT_PUBLIC_SANITY_PROJECT_ID", originalProjectId);
    restoreEnvValue("CHECKOUT_SECRET_ENCRYPTION_KEY", originalEncryptionKey);
  }
}

function restoreEnvValue(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}
