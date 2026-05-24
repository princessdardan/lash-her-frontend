import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CHECKOUT_EMAIL_MAX_LENGTH,
  CHECKOUT_SHIPPING_LINE_MAX_LENGTH,
  isValidCheckoutEmail,
  parseCheckoutText,
  parseOptionalCheckoutText,
} from "./checkout-validation";

describe("checkout validation helpers", () => {
  it("validates and normalizes checkout emails", () => {
    assert.equal(isValidCheckoutEmail(" Client@Example.COM "), true);
    assert.equal(isValidCheckoutEmail("client.example.com"), false);
    assert.equal(isValidCheckoutEmail("client@"), false);
    assert.equal(isValidCheckoutEmail(`client${String.fromCharCode(10)}@example.com`), false);
    assert.equal(isValidCheckoutEmail(`${"a".repeat(CHECKOUT_EMAIL_MAX_LENGTH)}@example.com`), false);
  });

  it("rejects empty, oversized, and control-character address text", () => {
    assert.equal(parseCheckoutText("  646   Oakwood   Avenue  ", CHECKOUT_SHIPPING_LINE_MAX_LENGTH), "646 Oakwood Avenue");
    assert.equal(parseCheckoutText("   ", CHECKOUT_SHIPPING_LINE_MAX_LENGTH), null);
    assert.equal(parseCheckoutText("x".repeat(CHECKOUT_SHIPPING_LINE_MAX_LENGTH + 1), CHECKOUT_SHIPPING_LINE_MAX_LENGTH), null);
    assert.equal(parseCheckoutText(`646${String.fromCharCode(10)}Oakwood`, CHECKOUT_SHIPPING_LINE_MAX_LENGTH), null);
  });

  it("allows blank optional address text but rejects invalid provided text", () => {
    assert.equal(parseOptionalCheckoutText("   ", CHECKOUT_SHIPPING_LINE_MAX_LENGTH), undefined);
    assert.equal(parseOptionalCheckoutText(" Suite   2 ", CHECKOUT_SHIPPING_LINE_MAX_LENGTH), "Suite 2");
    assert.equal(parseOptionalCheckoutText(`Suite${String.fromCharCode(9)}2`, CHECKOUT_SHIPPING_LINE_MAX_LENGTH), null);
  });
});
