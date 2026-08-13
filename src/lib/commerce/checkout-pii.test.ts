import { execFileSync } from "node:child_process";
import test from "node:test";

test("checkout IP encryption is authenticated and round trips only valid IPs", () => {
  const script = String.raw`
    import assert from "node:assert/strict";
    import { decryptCheckoutIp, encryptCheckoutIp } from "./src/lib/commerce/checkout-pii.ts";

    const ciphertext = encryptCheckoutIp("203.0.113.10");
    assert.notEqual(ciphertext.includes("203.0.113.10"), true);
    assert.equal(decryptCheckoutIp(ciphertext), "203.0.113.10");
    const parts = ciphertext.split(":");
    parts[3] = Buffer.from("tampered").toString("base64");
    assert.throws(() => decryptCheckoutIp(parts.join(":")));
    assert.throws(() => encryptCheckoutIp("not-an-ip"));
  `;
  execFileSync(
    "./node_modules/.bin/tsx",
    ["--conditions=react-server", "--eval", script],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NEXT_PUBLIC_SANITY_DATASET: "test",
        NEXT_PUBLIC_SANITY_PROJECT_ID: "test-project",
        CHECKOUT_PII_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      },
      stdio: "pipe",
    },
  );
});
