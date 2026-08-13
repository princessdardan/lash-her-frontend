import assert from "node:assert/strict";
import test from "node:test";
import { createChitChatsClient } from "./chitchats-client";
import type { ChitChatsConfig } from "./config";

const config: ChitChatsConfig = {
  accessToken: "access-token",
  baseUrl: "https://staging.chitchats.com/api/v1/clients/client-123",
  clientId: "client-123",
  environment: "staging",
  quoteSigningSecret: "quote-signing-secret-with-safe-length",
  trackedPostageTypes: new Set(["chit_chats_canada_tracked"]),
  usShippingEnabled: false,
};

test("creates a Chit Chats shipment using the documented client-scoped contract", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const client = createChitChatsClient(config, (async (url, init) => {
    requestUrl = String(url);
    requestInit = init;
    return Response.json(
      { shipment: { id: "shipment-1", status: "unpaid", rates: [] } },
      { status: 201 },
    );
  }) as typeof fetch);

  const shipment = await client.createShipment({
    recipient: {
      name: "Client Name",
      email: "client@example.com",
      phone: "+14165550100",
      line1: "100 Test Street",
      city: "Toronto",
      province: "ON",
      postalCode: "M5V 1A1",
      country: "Canada",
      countryCode: "CA",
    },
    packageSnapshot: {
      profileId: "profile-1",
      profileSlug: "small-mailer",
      packageType: "thick_envelope",
      lengthCm: 23,
      widthCm: 15,
      heightCm: 4,
      tareWeightGrams: 40,
      totalWeightGrams: 100,
    },
    customsLines: [
      {
        productId: "product-1",
        sku: "SKU-1",
        description: "Lash cleanser",
        quantity: 1,
        unitValueCents: 2400,
        unitWeightGrams: 60,
        countryOfOrigin: "CA",
      },
    ],
    merchandiseValueCents: 2400,
    orderReference: "lhq-reference",
    signatureRequested: false,
  });

  assert.equal(shipment.id, "shipment-1");
  assert.equal(requestUrl, `${config.baseUrl}/shipments`);
  assert.equal(requestInit?.method, "POST");
  assert.equal(
    new Headers(requestInit?.headers).get("Authorization"),
    "access-token",
  );
  const body = JSON.parse(String(requestInit?.body)) as Record<string, unknown>;
  assert.equal(body.order_id, "lhq-reference");
  assert.equal(body.postage_type, "unknown");
  assert.equal(body.insurance_requested, true);
  assert.equal(body.value, "24.00");
  assert.deepEqual(body.line_items, [
    {
      quantity: 1,
      description: "Lash cleanser",
      value_amount: "24.00",
      currency_code: "cad",
      sku_code: "SKU-1",
      origin_country: "CA",
      weight_unit: "g",
      weight: 60,
    },
  ]);
});

test("uses documented shipment lifecycle endpoints and response shapes", async () => {
  const requests: Array<{ method: string; url: string; body: unknown }> = [];
  const client = createChitChatsClient(config, (async (url, init) => {
    requests.push({
      method: init?.method ?? "GET",
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (String(url).includes("?limit=")) {
      return Response.json([
        { id: "shipment-1", status: "unpaid", order_id: "lhq-reference" },
      ]);
    }
    return Response.json({ shipment: { id: "shipment-1", status: "ready" } });
  }) as typeof fetch);

  assert.equal(
    (await client.findShipments("lhq-reference"))[0]?.id,
    "shipment-1",
  );
  await client.refreshShipment("shipment-1", {
    packageType: "parcel",
    weightGrams: 200,
    lengthCm: 30,
    widthCm: 20,
    heightCm: 10,
    shipDate: "today",
    signatureRequested: false,
  });
  await client.buyShipment("shipment-1", {
    postageType: "chit_chats_canada_tracked",
  });
  await client.refundShipment("shipment-1");

  assert.deepEqual(
    requests.map(({ method, url }) => [method, url]),
    [
      ["GET", `${config.baseUrl}/shipments?limit=100&page=1&q=lhq-reference`],
      ["PATCH", `${config.baseUrl}/shipments/shipment-1/refresh`],
      ["PATCH", `${config.baseUrl}/shipments/shipment-1/buy`],
      ["PATCH", `${config.baseUrl}/shipments/shipment-1/refund`],
    ],
  );
  assert.deepEqual(requests[2]?.body, {
    postage_type: "chit_chats_canada_tracked",
  });
});
