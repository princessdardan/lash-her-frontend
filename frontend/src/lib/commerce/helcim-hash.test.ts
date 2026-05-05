import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { createHelcimResponseHash, validateHelcimResponseHash } from "./helcim-hash";
import type { HelcimPaySuccessPayload } from "./helcim-types";

const secretToken = "secret-token";
const payload: HelcimPaySuccessPayload = {
  data: {
    amount: 125,
    approved: true,
    cardToken: null,
    currency: "CAD",
    transactionId: "txn_123",
  },
  hash: "",
};

describe("HelcimPay response hash validation", () => {
  it("matches Helcim's JSON response hash format", () => {
    const expectedHash = createHash("sha256")
      .update(`${JSON.stringify(payload.data)}${secretToken}`)
      .digest("hex");

    assert.equal(createHelcimResponseHash(payload.data, secretToken), expectedHash);
    assert.equal(
      validateHelcimResponseHash({ ...payload, hash: expectedHash }, secretToken),
      true,
    );
  });

  it("rejects mismatched response hashes", () => {
    assert.equal(validateHelcimResponseHash({ ...payload, hash: "f".repeat(64) }, secretToken), false);
  });

  it("rejects invalid response hash values without throwing", () => {
    assert.equal(validateHelcimResponseHash({ ...payload, hash: "not-hex" }, secretToken), false);
  });
});
