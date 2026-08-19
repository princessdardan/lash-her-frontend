import { execFileSync } from "node:child_process";
import test from "node:test";

test("shipping customer tokens contain 256 bits and use purpose-separated HMACs", () => {
  const script = String.raw`
    import assert from "node:assert/strict";
    import { hashShippingCustomerToken, issueShippingCustomerToken } from "./src/lib/shipping/customer-token.ts";

    const token = issueShippingCustomerToken();
    assert.equal(Buffer.from(token, "base64url").length, 32);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(
      hashShippingCustomerToken(token, "decision"),
      hashShippingCustomerToken(token, "address-change"),
    );
    assert.equal(hashShippingCustomerToken(token, "decision").length, 64);
  `;
  execFileSync(
    "./node_modules/.bin/tsx",
    ["--conditions=react-server", "--eval", script],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SHIPPING_DECISION_TOKEN_SECRET:
          "decision-secret-at-least-thirty-two-bytes",
        ADDRESS_CHANGE_TOKEN_SECRET: "address-secret-at-least-thirty-two-bytes",
      },
      stdio: "pipe",
    },
  );
});
