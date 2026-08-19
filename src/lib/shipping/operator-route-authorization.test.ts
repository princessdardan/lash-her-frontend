import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const ownerGatedRoutes = [
  "../../app/api/admin/orders/[orderId]/address-change/route.ts",
  "../../app/api/admin/orders/[orderId]/shipping-decision/route.ts",
  "../../app/api/admin/orders/[orderId]/shipping/manual-review/route.ts",
  "../../app/api/admin/address-changes/[requestId]/apply/route.ts",
] as const;

test("operator shipping routes require the configured fulfillment owner", () => {
  for (const relativePath of ownerGatedRoutes) {
    const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
    assert.match(source, /assertConfiguredFulfillmentOwner\(actor\.user\.id\)/);
  }
});

test("manual case creation uses the owner-authorized operator entrypoint", () => {
  const source = readFileSync(
    new URL(
      "../../app/api/admin/orders/[orderId]/shipping-cases/route.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(source, /openProductShippingCaseAsOperator/);
  assert.doesNotMatch(source, /openProductShippingCase\s*\(/);
});

test("shipping-case actions submit the rendered state version", () => {
  const route = readFileSync(
    new URL(
      "../../app/api/admin/shipping-cases/[caseId]/action/route.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const controls = readFileSync(
    new URL(
      "../../components/admin/fulfillment-operation-controls.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(route, /expectedStateVersion/);
  assert.match(controls, /expectedStateVersion:\s*item\.stateVersion/);
});
