import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { AdminAuthError, type AdminAuthErrorCode } from "@/lib/admin/types";
import { createShippingLabelHandler } from "../orders/[orderId]/shipping/label/handler";

const request = () =>
  new NextRequest(
    "https://staging.example.test/api/admin/orders/order-1/shipping/label?shipmentId=shipment-1&expectedStateVersion=2",
  );
const context = () => ({ params: Promise.resolve({ orderId: "order-1" }) });

for (const code of [
  "unauthenticated",
  "forbidden",
  "disabled",
  "identity_conflict",
  "not_allowed",
  "unverified_email",
] satisfies AdminAuthErrorCode[]) {
  test(`label API returns ${code === "unauthenticated" ? 401 : 403} for ${code} before shipment/provider access`, async () => {
    let touched = false;
    const unexpected = () => {
      touched = true;
      throw new Error("must not be called");
    };
    const handler = createShippingLabelHandler({
      requirePermission: async (permission) => {
        assert.equal(permission, "fulfillment:manage");
        throw new AdminAuthError(code);
      },
      getShipmentForOrderReference: unexpected,
      getChitChatsConfig: unexpected,
      createChitChatsClient: unexpected,
      fetch: unexpected,
    });
    const response = await handler(request(), context());
    assert.equal(response.status, code === "unauthenticated" ? 401 : 403);
    assert.deepEqual(await response.json(), {
      error: code === "unauthenticated" ? "Unauthorized" : "Forbidden",
    });
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(touched, false);
  });
}

test("label API preserves unexpected authentication failures", async () => {
  const outage = new Error("database unavailable");
  const handler = createShippingLabelHandler({
    requirePermission: async () => {
      throw outage;
    },
  });
  await assert.rejects(
    handler(request(), context()),
    (error) => error === outage,
  );
});

test("authorized label requests still validate shipment generation before store access", async () => {
  let lookedUp = false;
  const handler = createShippingLabelHandler({
    requirePermission: async () => ({}) as never,
    getShipmentForOrderReference: async () => {
      lookedUp = true;
      return null;
    },
  });
  const invalid = new NextRequest(
    "https://staging.example.test/api/admin/orders/order-1/shipping/label",
  );
  assert.equal((await handler(invalid, context())).status, 400);
  assert.equal(lookedUp, false);
  assert.equal((await handler(request(), context())).status, 404);
  assert.equal(lookedUp, true);
});

test("authorized label download preserves generation lookup and private PDF response", async () => {
  const handler = createShippingLabelHandler({
    requirePermission: async () => ({}) as never,
    getShipmentForOrderReference: async (orderId, reference) => {
      assert.equal(orderId, "order-1");
      assert.deepEqual(reference, {
        shipmentId: "shipment-1",
        stateVersion: 2,
      });
      return { providerShipmentId: "provider-1" } as never;
    },
    getChitChatsConfig: () =>
      ({ baseUrl: "https://carrier.example.test" }) as never,
    createChitChatsClient: () =>
      ({
        getShipment: async (id: string) => {
          assert.equal(id, "provider-1");
          return {
            postage_label_pdf_url:
              "https://carrier.example.test/labels/shipments/label.pdf",
          };
        },
      }) as never,
    fetch: async (url, init) => {
      assert.equal(
        String(url),
        "https://carrier.example.test/labels/shipments/label.pdf",
      );
      assert.equal(init?.redirect, "error");
      assert.equal(init?.cache, "no-store");
      return new Response("%PDF-1.7", {
        headers: { "content-type": "application/pdf" },
      });
    },
  });
  const response = await handler(request(), context());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/pdf");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(await response.text(), "%PDF-1.7");
});
