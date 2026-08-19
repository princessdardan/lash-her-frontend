import assert from "node:assert/strict";
import test from "node:test";

import { renderCustomerDecisionConditions } from "./presentation";

test("service substitution presentation renders exact terms safely", () => {
  const html = renderCustomerDecisionConditions(
    "service_substitution",
    "address-change/request/shipment/source/service-substitution",
    {
      originalPostageType: "original<script>",
      substitutePostageType: "tracked-insured",
      substituteAmountCents: 1_234,
    },
  );
  assert.match(html, /original&lt;script&gt;/);
  assert.match(html, /tracked-insured/);
  assert.match(html, /\$12\.34/);
  assert.match(html, /only to these exact terms/);
  assert.doesNotMatch(html, /<script>/);
});

test("signature presentation states that preparation waits for acceptance", () => {
  assert.match(
    renderCustomerDecisionConditions("signature_requirement", "scope", {}),
    /resume only if you accept/,
  );
});
